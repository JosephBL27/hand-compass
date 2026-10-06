import { actionKey, type PokerAction } from "../domain/actions";
import { standardActionTree, type ActionTreeConfig } from "../domain/actionTree";
import { card, createDeck, RANKS, SUITS, type Card, type Rank } from "../domain/cards";
import { createCashConfig } from "../domain/config";
import type { RngMode } from "../domain/grading";
import { deterministicHash } from "../domain/hash";
import { bb, bbFromUnits, type BB } from "../domain/money";
import { allCombos, type WeightedCombo, type WeightedRange } from "../domain/ranges";
import { PokerRulesEngine, type PokerState, type Street } from "../domain/rules";
import { positionLabel, seatId, type PlayerCount, type SeatId } from "../domain/seats";
import type { StrategyProvider } from "../domain/strategy";
import { createScenarioCatalog, type ScenarioCatalog } from "./catalog";
import { ReplayRng } from "./rng";
import { prepareFullHand, ScenarioValidationError } from "./scenario";
import type { FullHandInput, NodeScenarioDefinition, PotType, SeatRangeMap } from "./types";

export type GeneratedRangeProfile = "focused" | "broad";
export const GENERATED_STACK_DEPTHS = [20, 40, 75, 100, 150, 200] as const;
export const GENERATED_POT_FAMILIES = ["SRP", "3-bet", "limped", "multiway"] as const satisfies readonly PotType[];
const STREETS = ["preflop", "flop", "turn", "river"] as const;
const TABLES = [4, 5, 6, 7, 8] as const;

/** A finite, repeatable training deck, not a database of solved equilibria. */
export interface GeneratedScenarioOptions {
  readonly seed?: number;
  /** 1 yields 480 distinct replayed nodes; each extra variant adds a fresh card/position orbit. */
  readonly variantsPerFamily?: number;
  readonly tableSizes?: readonly PlayerCount[];
  readonly stackDepthsBB?: readonly number[];
  readonly streets?: readonly Street[];
  readonly potFamilies?: readonly (typeof GENERATED_POT_FAMILIES)[number][];
  readonly rangeProfile?: GeneratedRangeProfile;
  readonly actionTree?: ActionTreeConfig;
}

const combos = [...allCombos().values()];
const rankValue = new Map(RANKS.map((rank, index) => [rank, index + 2]));

function handGroup(combo: WeightedCombo): string {
  const left = combo.cards[0][0] as Rank;
  const right = combo.cards[1][0] as Rank;
  if (left === right) return `${left}${right}`;
  const highFirst = rankValue.get(left)! > rankValue.get(right)!;
  return `${highFirst ? left : right}${highFirst ? right : left}${combo.cards[0][1] === combo.cards[1][1] ? "s" : "o"}`;
}

// These are deliberately authored laboratory inputs. No opening frequency,
// equilibrium claim, or post-replay Bayesian conditioning is inferred from them.
const focusedGroups: Readonly<Record<"open" | "defend" | "three-bet", readonly string[]>> = {
  open: ["AA", "KK", "QQ", "JJ", "TT", "99", "88", "77", "AKs", "AQs", "AJs", "ATs", "A5s", "KQs", "KJs", "QJs", "JTs", "T9s", "98s", "AQo"],
  defend: ["QQ", "JJ", "TT", "99", "88", "77", "66", "55", "AQs", "AJs", "ATs", "A5s", "A4s", "KQs", "KJs", "QJs", "QTs", "JTs", "T9s", "98s", "87s", "AQo"],
  "three-bet": ["AA", "KK", "QQ", "JJ", "TT", "AKs", "AQs", "AJs", "KQs", "A5s", "A4s", "AKo", "AQo"],
};

const cachedRanges = new Map<string, WeightedRange>();

export function generatedPracticeRange(profile: GeneratedRangeProfile, role: "open" | "defend" | "three-bet"): WeightedRange {
  const key = `${profile}:${role}`;
  const cached = cachedRanges.get(key);
  if (cached !== undefined) return cached;
  const groups = new Set(focusedGroups[role]);
  const selected = combos.filter((combo) => {
    if (profile === "focused") return groups.has(handGroup(combo));
    const ranks = combo.cards.map((value) => rankValue.get(value[0] as Rank)!);
    const high = Math.max(...ranks);
    const low = Math.min(...ranks);
    const suited = combo.cards[0][1] === combo.cards[1][1];
    if (high === low) return true;
    if (role === "three-bet") return (high >= 13 && low >= 10) || (suited && high === 14);
    if (suited) return high >= 11 || (high - low <= 2 && low >= 4) || high === 14;
    return (high >= 12 && low >= 10) || (role === "defend" && high === 14 && low >= 8);
  });
  const range = new Map(selected.map((combo) => [combo.id, combo]));
  cachedRanges.set(key, range);
  return range;
}

// Texture-controlled boards rotate all four suits. Hero cards are subsequently
// sampled from the public profile subject to the complete private deal.
const boardTemplates: readonly (readonly string[])[] = [
  ["Qh", "8s", "4s", "2c", "Kd"], ["As", "7h", "2d", "Jc", "4h"],
  ["Ks", "9s", "3s", "4d", "Qh"], ["Jh", "Ts", "9d", "2h", "8c"],
  ["8c", "8h", "3s", "Kd", "2c"], ["7d", "5c", "2h", "6s", "Kc"],
  ["Ah", "Kd", "Qc", "Js", "2h"], ["Tc", "7c", "4h", "2c", "9d"],
  ["9s", "6h", "3c", "9d", "6c"], ["Kh", "8d", "2c", "As", "4s"],
  ["6s", "5s", "4d", "3c", "7h"], ["Qs", "Qd", "Jh", "2s", "Jc"],
  ["9c", "4h", "2s", "Td", "Ac"], ["Ac", "8c", "3d", "5h", "Kc"],
  ["Jd", "7s", "3h", "2d", "Qd"], ["Th", "6d", "2s", "8c", "5h"],
];

function boardFor(rng: ReplayRng): readonly Card[] {
  // Random runouts expand each new orbit beyond the texture-library boards.
  // The other two thirds retain deliberate paired, wet, dry, and draw-completing
  // textures, so rare-but-useful study families do not disappear into pure noise.
  if (rng.nextInteger(0, 2) === 0) {
    const deck = [...createDeck()];
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const other = rng.nextInteger(0, index);
      [deck[index], deck[other]] = [deck[other]!, deck[index]!];
    }
    return deck.slice(0, 5);
  }
  const template = boardTemplates[rng.nextInteger(0, boardTemplates.length - 1)]!;
  const rotation = rng.nextInteger(0, 3);
  return template.map((value) => card(`${value[0]}${SUITS[(SUITS.indexOf(value[1] as typeof SUITS[number]) + rotation) % 4]}`));
}

function requireAction(state: PokerState, kind: PokerAction["kind"], target?: BB): PokerAction {
  const actions = new PokerRulesEngine().legalActions(state, target === undefined ? [] : [target]);
  const action = actions.find((candidate) => candidate.kind === kind && (target === undefined || !("to" in candidate) || candidate.to === target));
  if (action === undefined) throw new ScenarioValidationError(`Generated replay cannot ${kind} at ${state.street}/${String(state.actor)} (${actions.map(actionKey).join(", ")})`);
  return action;
}

function passive(state: PokerState): PokerAction {
  const actions = new PokerRulesEngine().legalActions(state);
  const action = actions.find(({ kind }) => kind === "check") ?? actions.find(({ kind }) => kind === "call");
  if (action === undefined) throw new ScenarioValidationError("Generated replay has no check/call continuation");
  return action;
}

function rangeAssumption(profile: GeneratedRangeProfile): string {
  return `${profile === "focused" ? "Focused laboratory" : "Broad practice"} ranges are custom, equal-weight hand-class inputs at this decision, not solved preflop or equilibrium ranges. The legal replay establishes the pot and line; it does not establish those ranges. The solver, when available, solves exactly these declared inputs. Private cards and future board cards are not used to narrow the public ranges.`;
}

function makeDefinition(provider: StrategyProvider, rngMode: RngMode, options: GeneratedScenarioOptions, dimension: {
  readonly table: PlayerCount;
  readonly depth: number;
  readonly street: Street;
  readonly family: typeof GENERATED_POT_FAMILIES[number];
  readonly variant: number;
  readonly ordinal: number;
}): NodeScenarioDefinition {
  const seed = Number.parseInt(deterministicHash({ version: "generated-practice-v1", seed: options.seed ?? 20260905, ...dimension }), 16);
  const rng = new ReplayRng(seed);
  const tree = options.actionTree ?? standardActionTree;
  const profile = options.rangeProfile ?? "focused";
  const buttonIndex = rng.nextInteger(0, dimension.table - 1);
  const order = Array.from({ length: dimension.table }, (_, offset) => seatId((buttonIndex + 3 + offset) % dimension.table));
  // The opener must have a later seat able to defend. Rotating the legal order,
  // rather than assigning labels as action order, also covers blind battles.
  const openerIndex = rng.nextInteger(0, dimension.table - (dimension.family === "multiway" ? 3 : 2));
  const opener = order[openerIndex]!;
  const defenderIndex = dimension.family === "limped"
    ? dimension.table - 1
    : rng.nextInteger(openerIndex + 1, dimension.table - (dimension.family === "multiway" ? 2 : 1));
  const defender = order[defenderIndex]!;
  const third = dimension.family === "multiway" ? order[rng.nextInteger(defenderIndex + 1, dimension.table - 1)] : undefined;
  const live = [opener, defender, ...(third === undefined ? [] : [third])];
  const heroSeatId = dimension.street === "preflop"
    ? dimension.family === "3-bet" ? opener : (third ?? defender)
    : live[(dimension.ordinal + dimension.variant) % live.length]!;
  const ranges: SeatRangeMap = Object.fromEntries(order.map((seat) => [seat, generatedPracticeRange(profile, seat === opener ? "open" : seat === defender && dimension.family === "3-bet" ? "three-bet" : "defend")]));
  const config = { ...createCashConfig(dimension.table, bb(dimension.depth)), actionTreeId: tree.id, strategyProviderId: provider.id };
  const common: FullHandInput = {
    config, heroSeatId, buttonIndex, actionTree: tree, strategyProvider: provider, seed,
    ranges, futureBoard: boardFor(rng), rng: { mode: rngMode },
  };
  const prepared = prepareFullHand(common, new ReplayRng(seed));
  if (!prepared.available) throw new ScenarioValidationError(prepared.block.reason);
  const fixedHoleCards = Object.fromEntries(prepared.state.players.map((player) => [player.id, player.holeCards!])) as Record<SeatId, readonly [Card, Card]>;
  // Recreate with the recorded private deal so reconstruction is invariant to
  // future changes in rejection-sampler cost. Public ranges remain unchanged.
  const fixedCommon = { ...common, fixedHoleCards };
  const fixedPrepared = prepareFullHand(fixedCommon, new ReplayRng(seed));
  if (!fixedPrepared.available) throw new ScenarioValidationError(fixedPrepared.block.reason);
  const engine = new PokerRulesEngine();
  let state = fixedPrepared.state;
  const replay: PokerAction[] = [];
  const push = (action: PokerAction): void => { replay.push(action); state = engine.dispatch(state, action); };
  let opened = false;
  let threeBet = false;
  while (state.street === "preflop") {
    if (dimension.street === "preflop" && state.actor === heroSeatId && opened && (dimension.family !== "3-bet" || threeBet)) break;
    if (state.actor === null) throw new ScenarioValidationError("Generated hand terminated before its node");
    if (!live.includes(state.actor)) { push(requireAction(state, "fold")); continue; }
    if (state.actor === opener && !opened) {
      push(dimension.family === "limped" ? passive(state) : requireAction(state, "raise", bb(2.5)));
      opened = true;
    } else if (state.actor === defender && dimension.family === "3-bet" && !threeBet) {
      push(requireAction(state, "raise", bb(8)));
      threeBet = true;
    } else push(passive(state));
  }
  if (dimension.street !== "preflop") {
    // Prior streets use legal checks. Every selected later-street node can be
    // reached without exhausting a 20 BB player during construction.
    for (let guard = 0; state.street !== dimension.street && guard < 32; guard += 1) push(passive(state));
    if (state.street !== dimension.street) throw new ScenarioValidationError("Failed to reach requested generated street");
    const faceWager = (dimension.ordinal + dimension.variant) % 3 !== 0;
    let wagerMade = false;
    for (let guard = 0; guard < 16; guard += 1) {
      if (state.actor === heroSeatId && (!faceWager || wagerMade)) break;
      if (faceWager && !wagerMade && state.actor !== heroSeatId) {
        const shortest = Math.min(...state.players.filter(({ status }) => status === "active").map(({ stackBB }) => stackBB));
        const fractions = [0.25, 0.33, 0.5, 0.75, 1, 1.25];
        const fraction = fractions[(dimension.ordinal + dimension.variant) % fractions.length]!;
        const target = bbFromUnits(Math.round(Math.max(bb(1), Math.min(state.potBB * fraction, shortest * 0.35))));
        push(requireAction(state, "bet", target));
        wagerMade = true;
      } else push(passive(state));
    }
  }
  if (state.actor !== heroSeatId || state.street !== dimension.street || state.terminal) {
    throw new ScenarioValidationError("Generated scenario did not stop at the requested live Hero decision");
  }
  const heroPosition = positionLabel(Number(heroSeatId.slice(5)), buttonIndex, dimension.table);
  const opponents = state.players.filter(({ id, status }) => id !== heroSeatId && status !== "folded");
  const opponentLabel = opponents.map(({ id }) => positionLabel(Number(id.slice(5)), buttonIndex, dimension.table)).join(" / ");
  const facingWager = state.currentBetBB > (dimension.street === "preflop" ? bb(1) : 0);
  const familyName = { SRP: "Single-raised pots", "3-bet": "Three-bet pots", limped: "Limped pots", multiway: "Multiway decisions" }[dimension.family];
  return {
    ...fixedCommon,
    id: `practice-${profile}-${dimension.table}h-${dimension.depth}bb-${dimension.street}-${dimension.family.toLowerCase()}-${seed.toString(16)}`,
    presentation: {
      title: `${heroPosition} vs ${opponentLabel} · ${dimension.street} ${facingWager ? "defense" : "initiative"} · ${dimension.depth} BB`,
      family: familyName, rangeAssumption: rangeAssumption(profile), rangeProfile: profile,
    },
    replay,
    expected: { actor: heroSeatId, street: state.street, board: [...state.board], potBB: state.potBB, currentBetBB: state.currentBetBB },
    sourceTags: {
      preflopLine: dimension.family === "3-bet" ? "vs-3-bet" : dimension.family === "limped" ? "vs-limp" : dimension.family === "multiway" ? "multiway" : "vs-open",
      potType: dimension.family,
      strategicClasses: ["CUSTOM_RANGE_PRACTICE", ...(dimension.family === "multiway" ? ["MULTIWAY_DISCIPLINE"] : []), ...(facingWager && dimension.street !== "preflop" ? ["FACING_BET"] : []), ...(dimension.depth <= 40 ? ["SHORT_STACK"] : dimension.depth >= 150 ? ["DEEP_STACK"] : [])],
    },
  };
}

export function createGeneratedScenarioDefinitions(input: GeneratedScenarioOptions & {
  readonly strategyProvider: StrategyProvider;
  readonly rngMode?: RngMode;
}): readonly NodeScenarioDefinition[] {
  const variants = input.variantsPerFamily ?? 1;
  if (!Number.isSafeInteger(variants) || variants < 1 || variants > 20) throw new RangeError("Generated variants must be an integer from 1 to 20");
  const depths = input.stackDepthsBB ?? GENERATED_STACK_DEPTHS;
  if (depths.some((depth) => !Number.isFinite(depth) || depth < 20 || depth > 500)) throw new RangeError("Generated depths must be between 20 and 500 BB");
  const result: NodeScenarioDefinition[] = [];
  for (const variant of Array.from({ length: variants }, (_, index) => index)) {
    for (const table of input.tableSizes ?? TABLES) for (const depth of depths) for (const street of input.streets ?? STREETS) for (const family of input.potFamilies ?? GENERATED_POT_FAMILIES) {
      result.push(makeDefinition(input.strategyProvider, input.rngMode ?? "off", input, { table, depth, street, family, variant, ordinal: result.length }));
    }
  }
  return result;
}

export function generateScenarioCatalog(provider: StrategyProvider, rngMode: RngMode = "off", options: GeneratedScenarioOptions = {}): ScenarioCatalog {
  return createScenarioCatalog(createGeneratedScenarioDefinitions({ ...options, strategyProvider: provider, rngMode }));
}

export const createGeneratedScenarioCatalog = generateScenarioCatalog;
