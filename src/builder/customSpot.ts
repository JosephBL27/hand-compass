import { actionKey, type PokerAction } from "../domain/actions";
import { standardActionTree, type ActionTreeConfig, type SizingCandidate, type SizingCandidateScope, type StreetSizingRules } from "../domain/actionTree";
import { assertUniqueCards, card, createDeck, type Card } from "../domain/cards";
import { createCashConfig, validateGameConfig, type GameConfig } from "../domain/config";
import { bb, bbToNumber, type BB } from "../domain/money";
import { allCombos, comboId, createRange, weightedComboCount, type WeightedRange } from "../domain/ranges";
import { PokerRulesEngine, type PokerState, type Street } from "../domain/rules";
import { positionLabel, seatId, seatIndex, type PlayerCount, type SeatId } from "../domain/seats";

export type CustomActionInput =
  | { readonly kind: "fold" | "check" }
  | { readonly kind: "call"; readonly amountBB?: number }
  | { readonly kind: "bet" | "raise" | "jam"; readonly toBB: number };

export type CustomSizingInput =
  | { readonly type: "pot-fraction"; readonly fraction: number; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "raise-multiple"; readonly multiple: number; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "raise-to"; readonly toBB: number; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "all-in"; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean };

export interface CustomActionTreeInput {
  readonly preflopUnopened?: readonly CustomSizingInput[];
  readonly preflopFacingRaise?: readonly CustomSizingInput[];
  readonly flop?: readonly CustomSizingInput[];
  readonly turn?: readonly CustomSizingInput[];
  readonly river?: readonly CustomSizingInput[];
}

export interface CustomRangeComboInput {
  readonly cards: readonly [string, string];
  readonly weight: number;
}

export interface CustomSpotExpected {
  readonly actorSeatIndex?: number | null;
  readonly street?: Street;
  readonly board?: readonly string[];
  readonly potBB?: number;
  readonly currentBetBB?: number;
  readonly remainingStacksBB?: readonly number[];
  readonly totalContributionsBB?: readonly number[];
}

export interface CustomSpotSpec {
  readonly playerCount: PlayerCount;
  /** Zero-based clockwise seat index. */
  readonly buttonIndex: number;
  readonly heroSeatIndex: number;
  readonly startingStacksBB: readonly number[];
  readonly smallBlindBB?: number;
  readonly anteBB?: number;
  readonly bigBlindAnteBB?: number;
  readonly straddleBB?: number;
  readonly rake?: { readonly enabled: boolean; readonly percentage: number; readonly capBB: number; readonly noFlopNoDrop: boolean };
  readonly seed?: number;
  /** Keys are zero-based seat indexes. Omitted seats are dealt deterministic unknown cards. */
  readonly fixedHoleCards?: Readonly<Record<string, readonly [string, string]>>;
  /** Cards to be dealt in order as streets advance. */
  readonly futureBoard?: readonly string[];
  readonly deadCards?: readonly string[];
  /** Public combo priors keyed by zero-based seat index. Omitted seats use the full 1,326-combo prior. */
  readonly ranges?: Readonly<Record<string, readonly CustomRangeComboInput[]>>;
  /** Optional fixed sizing tree. Omitted street rules inherit the standard local tree. */
  readonly actionTree?: CustomActionTreeInput;
  readonly actions: readonly CustomActionInput[];
  readonly expected?: CustomSpotExpected;
}

export interface CustomSpotValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly state?: PokerState;
  readonly summary?: {
    readonly street: Street;
    readonly actor: string;
    readonly board: readonly Card[];
    readonly potBB: number;
    readonly currentBetBB: number;
    readonly remainingStacksBB: readonly number[];
    readonly totalContributionsBB: readonly number[];
    readonly actionCount: number;
  };
}

export interface PreparedCustomSpot {
  readonly config: GameConfig;
  readonly heroSeatId: SeatId;
  readonly state: PokerState;
  readonly ranges: Readonly<Record<SeatId, WeightedRange>>;
  readonly actionTree: ActionTreeConfig;
  readonly deadCards: readonly Card[];
  readonly seed: number;
  readonly issues: readonly string[];
  readonly summary: NonNullable<CustomSpotValidation["summary"]>;
}

function finiteNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite nonnegative number.`);
  return value;
}

function parseCards(values: readonly string[] | undefined, label: string): readonly Card[] {
  return (values ?? []).map((value, index) => {
    try {
      return card(value);
    } catch {
      throw new RangeError(`${label} card ${index + 1} is invalid: ${value}`);
    }
  });
}

function buildConfig(spec: CustomSpotSpec): GameConfig {
  if (![4, 5, 6, 7, 8].includes(spec.playerCount)) throw new RangeError("playerCount must be 4–8.");
  if (spec.startingStacksBB.length !== spec.playerCount) throw new RangeError(`startingStacksBB must contain exactly ${spec.playerCount} values.`);
  const base = createCashConfig(spec.playerCount);
  const stacks = Object.fromEntries(spec.startingStacksBB.map((value, index) => {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Starting stack for seat ${index} must be positive.`);
    return [seatId(index), bb(value)];
  })) as Record<SeatId, BB>;
  return validateGameConfig({
    ...base,
    smallBlindBB: bb(spec.smallBlindBB ?? 0.5),
    anteBB: bb(spec.anteBB ?? 0),
    bigBlindAnteBB: bb(spec.bigBlindAnteBB ?? 0),
    ...(spec.straddleBB === undefined ? {} : { straddleBB: bb(spec.straddleBB) }),
    startingStacksBB: stacks,
    rake: spec.rake === undefined ? base.rake : {
      enabled: spec.rake.enabled,
      percentage: spec.rake.percentage,
      capBB: bb(spec.rake.capBB),
      noFlopNoDrop: spec.rake.noFlopNoDrop,
    },
    actionTreeId: "custom-spot",
    strategyProviderId: "unassigned",
  });
}

function fixedHoles(spec: CustomSpotSpec): Readonly<Partial<Record<SeatId, readonly [Card, Card]>>> {
  const output: Partial<Record<SeatId, readonly [Card, Card]>> = {};
  for (const [rawIndex, cards] of Object.entries(spec.fixedHoleCards ?? {})) {
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= spec.playerCount) throw new RangeError(`Fixed-hole seat index is invalid: ${rawIndex}`);
    const parsed = parseCards(cards, `Seat ${index} hole`);
    if (parsed.length !== 2) throw new RangeError(`Seat ${index} needs exactly two hole cards.`);
    output[seatId(index)] = [parsed[0]!, parsed[1]!];
  }
  return output;
}

function sizingCandidate(input: CustomSizingInput): SizingCandidate {
  if (input.type === "all-in") return input;
  if (input.type === "pot-fraction") {
    if (!Number.isFinite(input.fraction) || input.fraction <= 0) throw new RangeError("Pot-fraction sizing must be positive.");
    return input;
  }
  if (input.type === "raise-multiple") {
    if (!Number.isFinite(input.multiple) || input.multiple <= 1) throw new RangeError("Raise multiple must be greater than 1.");
    return input;
  }
  if (!Number.isFinite(input.toBB) || input.toBB <= 0) throw new RangeError("Raise-to sizing must be positive.");
  return {
    type: "raise-to",
    toBB: bb(input.toBB),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.rootOnly === undefined ? {} : { rootOnly: input.rootOnly }),
  };
}

function fixedSizingRule(inputs: readonly CustomSizingInput[] | undefined, fallback: StreetSizingRules): StreetSizingRules {
  return inputs === undefined ? fallback : { mode: "fixed", candidates: inputs.map(sizingCandidate) };
}

export function customActionTree(spec: CustomSpotSpec): ActionTreeConfig {
  return {
    id: "custom-spot",
    preflop: {
      unopened: fixedSizingRule(spec.actionTree?.preflopUnopened, standardActionTree.preflop.unopened),
      facingRaise: fixedSizingRule(spec.actionTree?.preflopFacingRaise, standardActionTree.preflop.facingRaise),
    },
    flop: fixedSizingRule(spec.actionTree?.flop, standardActionTree.flop),
    turn: fixedSizingRule(spec.actionTree?.turn, standardActionTree.turn),
    river: fixedSizingRule(spec.actionTree?.river, standardActionTree.river),
  };
}

function publicRanges(spec: CustomSpotSpec, holes: Readonly<Partial<Record<SeatId, readonly [Card, Card]>>>): Readonly<Record<SeatId, WeightedRange>> {
  const parsed: Partial<Record<SeatId, WeightedRange>> = {};
  for (const [rawIndex, entries] of Object.entries(spec.ranges ?? {})) {
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= spec.playerCount) throw new RangeError(`Range seat index is invalid: ${rawIndex}`);
    const range = createRange(entries.map((entry, comboIndex) => {
      if (!Number.isFinite(entry.weight) || entry.weight < 0 || entry.weight > 1) throw new RangeError(`Range seat ${index} combo ${comboIndex + 1} weight must be in [0, 1].`);
      const cards = parseCards(entry.cards, `Range seat ${index} combo ${comboIndex + 1}`);
      if (cards.length !== 2) throw new RangeError(`Range seat ${index} combo ${comboIndex + 1} needs two cards.`);
      return { cards: [cards[0]!, cards[1]!] as const, weight: entry.weight };
    }));
    if (weightedComboCount(range) <= 0) throw new RangeError(`Range seat ${index} has no positive-weight combos.`);
    parsed[seatId(index)] = range;
  }
  for (let index = 0; index < spec.playerCount; index += 1) {
    const id = seatId(index);
    const range = parsed[id] ?? allCombos();
    const held = holes[id];
    if (held !== undefined && (range.get(comboId(...held))?.weight ?? 0) <= 0) {
      throw new RangeError(`Fixed hole cards for seat ${index} are absent from that seat's positive-weight public range.`);
    }
    parsed[id] = range;
  }
  return parsed as Record<SeatId, WeightedRange>;
}

function translateAction(input: CustomActionInput, legal: readonly PokerAction[]): PokerAction {
  if (input.kind === "fold" || input.kind === "check") return { kind: input.kind };
  if (input.kind === "call") {
    const issued = legal.find((action): action is Extract<PokerAction, { kind: "call" }> => action.kind === "call");
    if (issued === undefined) return { kind: "call", amount: bb(input.amountBB ?? 0) };
    if (input.amountBB !== undefined && issued.amount !== bb(input.amountBB)) return { kind: "call", amount: bb(input.amountBB) };
    return issued;
  }
  if ("toBB" in input) {
    finiteNonnegative(input.toBB, `${input.kind} target`);
    return { kind: input.kind, to: bb(input.toBB) };
  }
  throw new RangeError("Unknown custom action shape.");
}

function exactArrayIssues(label: string, supplied: readonly number[] | undefined, actual: readonly number[], playerCount: number): readonly string[] {
  if (supplied === undefined) return [];
  if (supplied.length !== playerCount) return [`${label} must contain exactly ${playerCount} values.`];
  return supplied.flatMap((value, index) => value === actual[index] ? [] : [`${label}[${index}] expected ${value} BB, but the legal replay produces ${actual[index]} BB.`]);
}

function expectedIssues(state: PokerState, expected: CustomSpotExpected | undefined): readonly string[] {
  if (expected === undefined) return [];
  const issues: string[] = [];
  if (expected.actorSeatIndex !== undefined) {
    const expectedActor = expected.actorSeatIndex === null ? null : seatId(expected.actorSeatIndex);
    if (state.actor !== expectedActor) issues.push(`Actor expected ${String(expectedActor)}, but legal replay produces ${String(state.actor)}.`);
  }
  if (expected.street !== undefined && state.street !== expected.street) issues.push(`Street expected ${expected.street}, but legal replay produces ${state.street}.`);
  if (expected.board !== undefined) {
    const board = parseCards(expected.board, "Expected board");
    if (board.length !== state.board.length || board.some((value, index) => value !== state.board[index])) issues.push(`Board expected ${board.join(" ") || "empty"}, but legal replay produces ${state.board.join(" ") || "empty"}.`);
  }
  if (expected.potBB !== undefined && bb(expected.potBB) !== state.potBB) issues.push(`Pot expected ${expected.potBB} BB, but legal replay produces ${bbToNumber(state.potBB)} BB.`);
  if (expected.currentBetBB !== undefined && bb(expected.currentBetBB) !== state.currentBetBB) issues.push(`Current bet expected ${expected.currentBetBB} BB, but legal replay produces ${bbToNumber(state.currentBetBB)} BB.`);
  issues.push(...exactArrayIssues("remainingStacksBB", expected.remainingStacksBB, state.players.map(({ stackBB }) => bbToNumber(stackBB)), state.config.playerCount));
  issues.push(...exactArrayIssues("totalContributionsBB", expected.totalContributionsBB, state.players.map(({ totalContributionBB }) => bbToNumber(totalContributionBB)), state.config.playerCount));
  return issues;
}

export function prepareCustomSpot(spec: CustomSpotSpec): PreparedCustomSpot {
  if (!Number.isSafeInteger(spec.buttonIndex) || spec.buttonIndex < 0 || spec.buttonIndex >= spec.playerCount) throw new RangeError("buttonIndex is outside the table.");
  if (!Number.isSafeInteger(spec.heroSeatIndex) || spec.heroSeatIndex < 0 || spec.heroSeatIndex >= spec.playerCount) throw new RangeError("heroSeatIndex is outside the table.");
  const seed = spec.seed ?? 20_260_827;
  if (!Number.isSafeInteger(seed)) throw new RangeError("seed must be a safe integer.");
  const actionTree = customActionTree(spec);
  const initialConfig = buildConfig(spec);
  const config = { ...initialConfig, actionTreeId: actionTree.id };
  const holes = fixedHoles(spec);
  const futureBoard = parseCards(spec.futureBoard, "Future board");
  const deadCards = parseCards(spec.deadCards, "Dead");
  if (futureBoard.length > 5) throw new RangeError("futureBoard cannot contain more than five cards.");
  const knownCards = [...Object.values(holes).filter((value): value is readonly [Card, Card] => value !== undefined).flat(), ...futureBoard, ...deadCards];
  assertUniqueCards(knownCards);
  const ranges = publicRanges(spec, holes);
  const deck = createDeck().filter((candidate) => !deadCards.includes(candidate));
  const engine = new PokerRulesEngine();
  let state = engine.create(config, { buttonIndex: spec.buttonIndex, holeCards: holes, futureBoard, deck, dealUnknownHoleCards: true });
  for (let index = 0; index < spec.actions.length; index += 1) {
    if (state.actor === null || state.terminal !== undefined) throw new RangeError(`Action ${index + 1} is supplied after the hand has ended.`);
    const input = spec.actions[index]!;
    const target = "toBB" in input ? [bb(input.toBB)] : [];
    const legal = engine.legalActions(state, target);
    const action = translateAction(input, legal);
    if (!legal.some((candidate) => actionKey(candidate) === actionKey(action))) {
      const actor = positionLabel(seatIndex(state.actor), state.buttonIndex, state.config.playerCount);
      throw new RangeError(`Action ${index + 1} (${actionKey(action)}) is illegal for ${actor}; legal actions are ${legal.map(actionKey).join(", ")}.`);
    }
    state = engine.dispatch(state, action);
  }
  const issues = expectedIssues(state, spec.expected);
  return {
    config,
    heroSeatId: seatId(spec.heroSeatIndex),
    state,
    ranges,
    actionTree,
    deadCards,
    seed,
    issues,
    summary: {
      street: state.street,
      actor: state.actor === null ? "Hand complete" : positionLabel(seatIndex(state.actor), state.buttonIndex, state.config.playerCount),
      board: state.board,
      potBB: bbToNumber(state.potBB),
      currentBetBB: bbToNumber(state.currentBetBB),
      remainingStacksBB: state.players.map(({ stackBB }) => bbToNumber(stackBB)),
      totalContributionsBB: state.players.map(({ totalContributionBB }) => bbToNumber(totalContributionBB)),
      actionCount: state.actionHistory.length,
    },
  };
}

export function validateCustomSpot(spec: CustomSpotSpec): CustomSpotValidation {
  try {
    const prepared = prepareCustomSpot(spec);
    return {
      valid: prepared.issues.length === 0,
      issues: prepared.issues,
      state: prepared.state,
      summary: prepared.summary,
    };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export function parseAndValidateCustomSpot(json: string): CustomSpotValidation {
  try {
    return validateCustomSpot(parseCustomSpotJson(json));
  } catch (error) {
    return { valid: false, issues: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function parseCustomSpotJson(json: string): CustomSpotSpec {
  const value = JSON.parse(json) as CustomSpotSpec;
  if (value === null || typeof value !== "object" || !Array.isArray(value.actions)) {
    throw new RangeError("Custom spot JSON must be an object with an actions array.");
  }
  return value;
}
