import { actionKey, type PokerAction } from "../src/domain/actions";
import { BB_SCALE, type BB } from "../src/domain/money";
import type { PokerState, Street } from "../src/domain/rules";
import type { RegisteredStrategyProvider } from "../src/domain/providerRegistry";
import type {
  StrategyProvenance,
  StrategyProvider,
  StrategyResult,
} from "../src/domain/strategy";
import {
  BUNDLED_SOLVED_PROVIDER_ID,
  configureAndProbeLocalSolver,
  createAcceptanceProviderRegistry,
  createTrainerSession,
  DEFAULT_LOCAL_SOLVER_ENDPOINT,
  LOCAL_SOLVER_PROVIDER_ID,
} from "../src/app/sessionAdapter";
import type { DecisionMath, DrillSnapshot } from "../src/session/types";

/**
 * Safe default: 100 broad hands through the bundled provider's honest fallback.
 * Bounded live-sidecar example:
 * POKER_FULL_HAND_SMOKE_LOCAL=required POKER_FULL_HAND_SMOKE_HANDS=5 node --import tsx scripts/smoke-full-hands.ts
 */
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};

type LocalMode = "auto" | "off" | "required";

interface SmokeConfiguration {
  readonly handCount: number;
  readonly seed: number;
  readonly localMode: LocalMode;
  readonly endpoint: string;
  readonly probeTimeoutMs: number;
  readonly handTimeoutMs: number;
}

interface ProviderCallStats {
  readonly total: number;
  readonly byStreet: Readonly<Record<Street, number>>;
  readonly byProvenance: Readonly<Record<StrategyProvenance, number>>;
  readonly heuristicFallbacks: number;
}

interface MutableProviderCallStats {
  total: number;
  byStreet: Record<Street, number>;
  byProvenance: Record<StrategyProvenance, number>;
  heuristicFallbacks: number;
}

interface SmokeStats {
  handsStarted: number;
  handsCompleted: number;
  heroDecisions: number;
  nonFoldHeroActions: number;
  foldHeroActions: number;
  heroActionsByKind: Record<PokerAction["kind"], number>;
  maxHeroDecisionsInHand: number;
  byTableSize: Record<string, number>;
  decisionsByStreet: Record<Street, number>;
  revealsByProvenance: Record<StrategyProvenance, number>;
  terminals: Record<"fold" | "showdown", number>;
}

interface LocalProbeSummary {
  readonly attempted: boolean;
  readonly listening: boolean;
  readonly status: "available" | "error" | "skipped";
  readonly message: string;
}

const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river"];
const PROVENANCES: readonly StrategyProvenance[] = ["SOLVED", "EXACT_MATH", "INTERPOLATED", "HEURISTIC"];
const LEAKED_STRATEGY_KEYS = ["\"comboPolicy\"", "\"evBB\"", "\"frequency\"", "\"publicRanges\"", "\"reveal\""] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function integerFromEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const source = process.env[name];
  if (source === undefined || source.trim() === "") return fallback;
  const value = Number(source);
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} must be a safe integer in [${minimum}, ${maximum}].`);
  return value;
}

function localModeFromEnv(): LocalMode {
  // Live exact postflop solves are opt-in because a 50-hand breadth run can be expensive.
  const value = (process.env.POKER_FULL_HAND_SMOKE_LOCAL ?? "off").trim().toLowerCase();
  invariant(value === "auto" || value === "off" || value === "required",
    "POKER_FULL_HAND_SMOKE_LOCAL must be auto, off, or required.");
  return value;
}

function configuration(): SmokeConfiguration {
  return {
    handCount: integerFromEnv("POKER_FULL_HAND_SMOKE_HANDS", 100, 5, 2_000),
    seed: integerFromEnv("POKER_FULL_HAND_SMOKE_SEED", 20_260_903, 0, 0x7fff_ffff),
    localMode: localModeFromEnv(),
    endpoint: process.env.POKER_SOLVER_ENDPOINT ?? DEFAULT_LOCAL_SOLVER_ENDPOINT,
    probeTimeoutMs: integerFromEnv("POKER_FULL_HAND_SMOKE_PROBE_TIMEOUT_MS", 180_000, 100, 900_000),
    handTimeoutMs: integerFromEnv("POKER_FULL_HAND_SMOKE_HAND_TIMEOUT_MS", 180_000, 100, 900_000),
  };
}

function emptyStreetCounts(): Record<Street, number> {
  return { preflop: 0, flop: 0, turn: 0, river: 0 };
}

function emptyProvenanceCounts(): Record<StrategyProvenance, number> {
  return { SOLVED: 0, EXACT_MATH: 0, INTERPOLATED: 0, HEURISTIC: 0 };
}

function createStats(): SmokeStats {
  return {
    handsStarted: 0,
    handsCompleted: 0,
    heroDecisions: 0,
    nonFoldHeroActions: 0,
    foldHeroActions: 0,
    heroActionsByKind: { fold: 0, check: 0, call: 0, bet: 0, raise: 0, jam: 0 },
    maxHeroDecisionsInHand: 0,
    byTableSize: {},
    decisionsByStreet: emptyStreetCounts(),
    revealsByProvenance: emptyProvenanceCounts(),
    terminals: { fold: 0, showdown: 0 },
  };
}

/** Small deterministic generator so failures reproduce from one reported seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function nextInteger(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function assertFixedBB(value: number, label: string, allowNegative = false): asserts value is BB {
  invariant(Number.isSafeInteger(value), `${label} is not a safe fixed-point BB integer: ${value}.`);
  if (!allowNegative) invariant(value >= 0, `${label} is negative: ${value}.`);
}

function assertExactValue(
  value: { readonly provenance: string; readonly value: number; readonly formula: string; readonly inputs: Readonly<Record<string, number>> },
  expected: number,
  label: string,
): void {
  invariant(value.provenance === "EXACT_MATH", `${label} lost EXACT_MATH provenance.`);
  invariant(Number.isFinite(value.value), `${label} is not finite.`);
  invariant(Math.abs(value.value - expected) <= 1e-12, `${label} expected ${expected}, received ${value.value}.`);
  invariant(value.formula.trim().length > 0, `${label} has no formula.`);
  invariant(Object.values(value.inputs).every(Number.isFinite), `${label} has non-finite inputs.`);
}

function assertDecisionMath(math: DecisionMath, state: PokerState): void {
  assertFixedBB(math.potAtDecisionBB, "decisionMath.potAtDecisionBB");
  assertFixedBB(math.contestablePotAtDecisionBB, "decisionMath.contestablePotAtDecisionBB");
  assertFixedBB(math.excludedFromActorContestBB, "decisionMath.excludedFromActorContestBB");
  assertFixedBB(math.amountToCallBB, "decisionMath.amountToCallBB");
  assertFixedBB(math.effectiveStackBB, "decisionMath.effectiveStackBB");
  invariant(math.potAtDecisionBB === state.potBB, "Decision pot differs from the rules ledger pot.");
  invariant(math.contestablePotAtDecisionBB + math.excludedFromActorContestBB === math.potAtDecisionBB,
    "Contestable and excluded pot layers do not reconstruct the decision pot.");

  const call = state.actor === null
    ? undefined
    : state.players.find(({ id }) => id === state.actor);
  invariant(call !== undefined, "Decision actor is missing from the player ledger.");
  const expectedCall = Math.min(Math.max(0, state.currentBetBB - call.streetContributionBB), call.stackBB);
  invariant(math.amountToCallBB === expectedCall, `Decision call amount expected ${expectedCall}, received ${math.amountToCallBB}.`);

  const liveOpponents = state.players.filter((player) => player.id !== state.actor && player.status !== "folded");
  invariant(math.perOpponent.length === liveOpponents.length, "Per-opponent effective-stack rows are incomplete.");
  for (const row of math.perOpponent) {
    const opponent = liveOpponents.find(({ id }) => id === row.seatId);
    invariant(opponent !== undefined, `Effective-stack row references non-live opponent ${row.seatId}.`);
    const expectedEffectiveStack = Math.min(call.stackBB, opponent.stackBB);
    invariant(row.effectiveStackBB === expectedEffectiveStack,
      `Effective stack for ${row.seatId} expected ${expectedEffectiveStack}, received ${row.effectiveStackBB}.`);
    invariant(row.wagerCapable === (opponent.status === "active" && opponent.stackBB > 0),
      `Wager-capable flag is wrong for ${row.seatId}.`);
    if (row.currentSPR !== undefined) {
      assertExactValue(row.currentSPR, expectedEffectiveStack / state.potBB, `SPR versus ${row.seatId}`);
    }
  }

  if (expectedCall > 0) {
    invariant(math.potOdds !== undefined, "A priced decision is missing pot odds.");
    const expectedEquity = expectedCall / (math.contestablePotAtDecisionBB + expectedCall);
    assertExactValue(math.potOdds, expectedEquity, "Raw pot odds");
    invariant(math.potOdds.requiredEquity === math.potOdds.value, "Pot-odds value and required-equity alias diverged.");
    invariant(Math.abs((math.potOdds.potToCallRatio ?? Number.NaN) - math.contestablePotAtDecisionBB / expectedCall) <= 1e-12,
      "Pot-to-call ratio is incorrect.");
    invariant(math.potOdds.ratio.pot === math.contestablePotAtDecisionBB / BB_SCALE,
      "Pot-odds ratio pot input is incorrect.");
    invariant(math.potOdds.ratio.call === expectedCall / BB_SCALE,
      "Pot-odds ratio call input is incorrect.");
  } else {
    invariant(math.potOdds === undefined, "A free decision should not publish call pot odds.");
  }

  if (math.rakeAdjustedPotOdds !== undefined) {
    invariant(math.projectedRakeIfNoFurtherBettingBB !== undefined,
      "Rake-adjusted pot odds are missing the projected rake input.");
    const expected = expectedCall
      / (math.contestablePotAtDecisionBB + expectedCall - math.projectedRakeIfNoFurtherBettingBB);
    assertExactValue(math.rakeAdjustedPotOdds, expected, "Rake-adjusted pot odds");
  }
  if (math.currentSPR !== undefined) {
    assertExactValue(math.currentSPR, math.effectiveStackBB / state.potBB, "Selected current SPR");
  }
}

function visibleCards(state: PokerState): readonly string[] {
  return [...state.board, ...state.players.flatMap((player) => player.holeCards ?? [])];
}

function assertState(snapshot: DrillSnapshot, expectedStartingTotalBB: BB, label: string): void {
  const state = snapshot.state;
  invariant(state !== null, `${label}: session has no rules state.`);
  invariant(state.players.length === state.config.playerCount, `${label}: player-count mismatch.`);
  invariant(state.buttonIndex >= 0 && state.buttonIndex < state.config.playerCount, `${label}: invalid button index.`);
  invariant(state.futureBoard.length === 0 && state.deck.length === 0,
    `${label}: private deck or future board leaked into the public snapshot.`);

  const expectedBoardLength: Readonly<Record<Street, number>> = { preflop: 0, flop: 3, turn: 4, river: 5 };
  invariant(state.board.length === expectedBoardLength[state.street],
    `${label}: ${state.street} board has ${state.board.length} cards.`);
  const cards = visibleCards(state);
  invariant(new Set(cards).size === cards.length, `${label}: visible cards collide.`);

  for (const player of state.players) {
    const startingStack = state.config.startingStacksBB[player.id];
    invariant(startingStack !== undefined, `${label}: ${player.id} has no configured starting stack.`);
    assertFixedBB(player.stackBB, `${label}.${player.id}.stackBB`);
    assertFixedBB(player.streetContributionBB, `${label}.${player.id}.streetContributionBB`);
    assertFixedBB(player.totalContributionBB, `${label}.${player.id}.totalContributionBB`);
    invariant(player.totalContributionBB >= player.streetContributionBB,
      `${label}: ${player.id} street contribution exceeds its hand contribution.`);
    invariant(player.stackBB + player.totalContributionBB === startingStack,
      `${label}: ${player.id} does not conserve its starting stack.`);
    if (player.status === "all-in") invariant(player.stackBB === 0, `${label}: ${player.id} is all-in with chips behind.`);
    if (player.id !== snapshot.heroSeatId && !(state.terminal?.type === "showdown" && player.status !== "folded")) {
      invariant(player.holeCards === undefined, `${label}: opponent ${player.id} hole cards leaked before showdown.`);
    }
  }

  assertFixedBB(state.potBB, `${label}.potBB`);
  assertFixedBB(state.currentBetBB, `${label}.currentBetBB`);
  assertFixedBB(state.lastFullRaiseBB, `${label}.lastFullRaiseBB`);
  const contributionTotal = sum(state.players.map(({ totalContributionBB }) => totalContributionBB));
  const stackTotal = sum(state.players.map(({ stackBB }) => stackBB));
  invariant(state.potBB === contributionTotal, `${label}: pot differs from gross contributions.`);
  invariant(stackTotal + state.potBB === expectedStartingTotalBB,
    `${label}: chips disappeared or appeared before settlement.`);

  invariant(new Set(state.pending).size === state.pending.length, `${label}: pending actor list has duplicates.`);
  for (const seat of state.pending) {
    const player = state.players.find(({ id }) => id === seat);
    invariant(player?.status === "active", `${label}: pending seat ${seat} cannot act.`);
  }
  if (state.actor !== null) {
    invariant(state.pending.includes(state.actor), `${label}: actor ${state.actor} is not pending.`);
    invariant(state.players.find(({ id }) => id === state.actor)?.status === "active", `${label}: actor ${state.actor} is not active.`);
  } else {
    invariant(state.terminal !== undefined, `${label}: nonterminal state has no actor.`);
  }

  let priorPot = 0;
  for (const [index, record] of state.actionHistory.entries()) {
    assertFixedBB(record.potAfterBB, `${label}.history[${index}].potAfterBB`);
    invariant(record.potAfterBB >= priorPot, `${label}: contribution pot decreased in action history.`);
    priorPot = record.potAfterBB;
  }
  if (state.actionHistory.length > 0) {
    invariant(state.actionHistory.at(-1)?.potAfterBB === state.potBB,
      `${label}: latest action-history pot differs from current pot.`);
  }
}

function assertNoDecisionLeak(snapshot: DrillSnapshot, label: string): void {
  invariant(snapshot.phase === "AWAITING_HERO", `${label}: leakage check requires an awaiting-Hero snapshot.`);
  invariant(snapshot.reveal === undefined, `${label}: reveal exists before Hero acts.`);
  const serialized = JSON.stringify(snapshot);
  for (const key of LEAKED_STRATEGY_KEYS) {
    invariant(!serialized.includes(key), `${label}: private strategy field ${key} leaked before Hero acted.`);
  }
  invariant(snapshot.state?.players.filter((player) => player.id !== snapshot.heroSeatId)
    .every((player) => player.holeCards === undefined), `${label}: opponent cards leaked before Hero acted.`);
}

function assertLegalActions(snapshot: DrillSnapshot, label: string): void {
  invariant(snapshot.legalActions.length > 0, `${label}: Hero received no legal actions.`);
  const keys = snapshot.legalActions.map(actionKey);
  invariant(new Set(keys).size === keys.length, `${label}: legal actions contain duplicates.`);
  for (const action of snapshot.legalActions) {
    if (action.kind === "call") assertFixedBB(action.amount, `${label}.${actionKey(action)}`);
    if (action.kind === "bet" || action.kind === "raise" || action.kind === "jam") {
      assertFixedBB(action.to, `${label}.${actionKey(action)}`);
    }
  }
  const call = snapshot.legalActions.find((action) => action.kind === "call");
  const check = snapshot.legalActions.find((action) => action.kind === "check");
  invariant((snapshot.decisionMath?.amountToCallBB ?? 0) > 0 ? call !== undefined && check === undefined : check !== undefined && call === undefined,
    `${label}: check/call legal actions disagree with the exact call amount.`);
}

function chooseNonFoldAction(
  actions: readonly PokerAction[],
  handIndex: number,
  decisionIndex: number,
  random: () => number,
): PokerAction {
  const nonFold = actions.filter(({ kind }) => kind !== "fold");
  const passive = nonFold.find(({ kind }) => kind === "check" || kind === "call");
  const aggression = nonFold.filter(({ kind }) => kind === "bet" || kind === "raise" || kind === "jam");
  // Eight hands out of each ten favor check/call so the suite reaches later
  // streets repeatedly. The other two deliberately exercise sizing and jam
  // branches. This gives both street depth and action-family breadth instead
  // of ending most hands preflop with an all-in.
  if (handIndex % 10 < 8 && passive !== undefined) return passive;
  const selectionMode = (handIndex + decisionIndex) % 4;
  const action = selectionMode === 0
    ? passive ?? aggression[0]
    : selectionMode === 1
      ? aggression.find(({ kind }) => kind !== "jam") ?? aggression[0] ?? passive
      : selectionMode === 2
        ? aggression.find(({ kind }) => kind === "jam") ?? aggression.at(-1) ?? passive
        : nonFold[nextInteger(random, 0, Math.max(0, nonFold.length - 1))]
          ?? actions.find(({ kind }) => kind === "fold");
  invariant(action !== undefined, "No legal Hero action was available.");
  return action;
}

function assertStrategyResult(result: StrategyResult, label: string): void {
  invariant(PROVENANCES.includes(result.provenance), `${label}: unknown provenance ${result.provenance}.`);
  const actionKeys = result.actions.map(({ action }) => actionKey(action));
  invariant(new Set(actionKeys).size === actionKeys.length, `${label}: revealed strategy repeats an action.`);
  for (const item of result.actions) {
    if (item.frequency !== undefined) {
      invariant(Number.isFinite(item.frequency) && item.frequency >= 0 && item.frequency <= 1,
        `${label}: invalid revealed action frequency.`);
    }
    if (item.evBB !== undefined) assertFixedBB(item.evBB, `${label}.evBB`, true);
  }
  if (result.provenance === "HEURISTIC") {
    invariant(result.actions.every(({ frequency, evBB }) => frequency === undefined && evBB === undefined),
      `${label}: HEURISTIC top-level advice manufactured frequency or EV precision.`);
    invariant(result.convergence === undefined, `${label}: HEURISTIC advice manufactured solver convergence.`);
    invariant(result.comboPolicy?.every((row) => row.actions.every(({ evBB }) => evBB === undefined)) ?? true,
      `${label}: HEURISTIC combo policy manufactured EV precision.`);
  }
}

function assertReveal(snapshot: DrillSnapshot, chosen: PokerAction, math: DecisionMath, label: string): StrategyProvenance {
  invariant(snapshot.phase === "REVEALED", `${label}: accepted Hero action did not enter REVEALED phase.`);
  const reveal = snapshot.reveal;
  invariant(reveal !== undefined, `${label}: accepted Hero action has no reveal.`);
  invariant(actionKey(reveal.chosenAction) === actionKey(chosen), `${label}: reveal changed the chosen Hero action.`);
  invariant(JSON.stringify(reveal.decisionMath) === JSON.stringify(math), `${label}: reveal changed decision-time math.`);
  assertStrategyResult(reveal.strategy, label);
  return reveal.strategy.provenance;
}

function assertSettlement(snapshot: DrillSnapshot, expectedStartingTotalBB: BB, label: string): void {
  invariant(snapshot.phase === "TERMINAL", `${label}: settlement check requires TERMINAL phase.`);
  invariant(snapshot.state?.terminal !== undefined, `${label}: terminal snapshot lacks a rules terminal.`);
  const settlement = snapshot.settlement;
  invariant(settlement !== undefined, `${label}: terminal snapshot lacks a settlement ledger.`);
  invariant(settlement.conserved === true, `${label}: settlement is not marked conserved.`);
  for (const [seat, value] of Object.entries(settlement.payoutsBB)) assertFixedBB(value, `${label}.payouts.${seat}`);
  for (const [seat, value] of Object.entries(settlement.finalStacksBB)) assertFixedBB(value, `${label}.finalStacks.${seat}`);
  assertFixedBB(settlement.rakeBB, `${label}.rakeBB`);
  assertFixedBB(settlement.totalBeforeBB, `${label}.totalBeforeBB`);
  assertFixedBB(settlement.totalPlayerStacksAfterBB, `${label}.totalPlayerStacksAfterBB`);
  assertFixedBB(settlement.totalAfterIncludingRakeBB, `${label}.totalAfterIncludingRakeBB`);
  invariant(settlement.totalBeforeBB === expectedStartingTotalBB, `${label}: settlement start total is wrong.`);
  invariant(settlement.totalAfterIncludingRakeBB === expectedStartingTotalBB,
    `${label}: final stacks plus rake do not conserve the starting chips.`);
  invariant(sum(Object.values(settlement.finalStacksBB)) === settlement.totalPlayerStacksAfterBB,
    `${label}: final-stack sum differs from the settlement total.`);
  invariant(settlement.totalPlayerStacksAfterBB + settlement.rakeBB === settlement.totalAfterIncludingRakeBB,
    `${label}: final stacks plus rake differ from the final total.`);
  invariant(sum(Object.values(settlement.payoutsBB)) + settlement.rakeBB === settlement.potBB,
    `${label}: payouts plus rake differ from the terminal pot.`);
  invariant(settlement.terminalType === snapshot.state.terminal.type,
    `${label}: rules terminal and settlement terminal disagree.`);
}

function recordingProvider(entry: RegisteredStrategyProvider, stats: MutableProviderCallStats): RegisteredStrategyProvider {
  const source = entry.provider;
  const provider: StrategyProvider = {
    id: source.id,
    async getStrategy(query, context) {
      const result = await source.getStrategy(query, context);
      stats.total += 1;
      stats.byStreet[query.street] += 1;
      stats.byProvenance[result.provenance] += 1;
      if (result.provenance === "HEURISTIC" && result.notes?.some((note) => /fallback|No exact node/iu.test(note))) {
        stats.heuristicFallbacks += 1;
      }
      return result;
    },
  };
  return { ...entry, provider };
}

async function endpointIsListening(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function selectProvider(config: SmokeConfiguration): Promise<{
  readonly registry: ReturnType<typeof createAcceptanceProviderRegistry>;
  readonly providerId: string;
  readonly probe: LocalProbeSummary;
  readonly calls: MutableProviderCallStats;
}> {
  const registry = createAcceptanceProviderRegistry();
  const listening = config.localMode === "off" ? false : await endpointIsListening(config.endpoint);
  let providerId = BUNDLED_SOLVED_PROVIDER_ID;
  let probe: LocalProbeSummary = {
    attempted: false,
    listening,
    status: "skipped",
    message: config.localMode === "off"
      ? "Local solver disabled for this run."
      : "No listening loopback sidecar; exercised bundled solved-pack plus explicit HEURISTIC fallback instead.",
  };

  if (listening) {
    const result = await configureAndProbeLocalSolver(registry, config.endpoint, { timeoutMs: config.probeTimeoutMs });
    probe = { attempted: true, listening: true, status: result.status, message: result.message };
    if (result.status === "available") providerId = LOCAL_SOLVER_PROVIDER_ID;
  }
  if (config.localMode === "required") {
    invariant(listening, `Required local solver is not listening at ${config.endpoint}.`);
    invariant(probe.status === "available", `Required local solver probe failed: ${probe.message}`);
  }

  const entry = registry.get(providerId);
  invariant(entry !== undefined && entry.availability.state === "AVAILABLE", `Selected provider ${providerId} is unavailable.`);
  const calls: MutableProviderCallStats = {
    total: 0,
    byStreet: emptyStreetCounts(),
    byProvenance: emptyProvenanceCounts(),
    heuristicFallbacks: 0,
  };
  registry.unregister(providerId);
  registry.register(recordingProvider(entry, calls));
  return { registry, providerId, probe, calls };
}

async function playHand(
  handIndex: number,
  config: SmokeConfiguration,
  selected: Awaited<ReturnType<typeof selectProvider>>,
  random: () => number,
  stats: SmokeStats,
): Promise<void> {
  const playerCount = (4 + (handIndex % 5)) as 4 | 5 | 6 | 7 | 8;
  const buttonIndex = nextInteger(random, 0, playerCount - 1);
  const startingStacksBB = Array.from({ length: playerCount }, () => nextInteger(random, 20, 200));
  const handSeed = nextInteger(random, 0, 0x7fff_ffff);
  const expectedStartingTotalBB = (sum(startingStacksBB) * BB_SCALE) as BB;
  const label = `hand ${handIndex + 1}/${config.handCount} (${playerCount}-handed, seed ${handSeed}, button ${buttonIndex}, stacks ${startingStacksBB.join("/")})`;
  stats.handsStarted += 1;
  stats.byTableSize[playerCount] = (stats.byTableSize[playerCount] ?? 0) + 1;

  const controller = await createTrainerSession("Off", {
    registry: selected.registry,
    activeProviderId: selected.providerId,
    drillMode: "Full hand",
    context: { signal: AbortSignal.timeout(config.handTimeoutMs) },
    fullHand: { playerCount, startingStacksBB, buttonIndex, seed: handSeed },
  });
  let snapshot = controller.snapshot;
  let decisionsThisHand = 0;
  let safety = 0;
  while (snapshot.phase !== "TERMINAL") {
    safety += 1;
    invariant(safety <= 100, `${label}: exceeded 100 Hero decision/reveal transitions.`);
    invariant(snapshot.phase !== "BLOCKED", `${label}: BLOCKED ${snapshot.blocked?.code ?? "UNKNOWN"}: ${snapshot.blocked?.reason ?? "no reason"}`);
    invariant(snapshot.phase === "AWAITING_HERO", `${label}: unexpected phase ${snapshot.phase}.`);
    assertState(snapshot, expectedStartingTotalBB, `${label} decision ${decisionsThisHand + 1}`);
    assertNoDecisionLeak(snapshot, `${label} decision ${decisionsThisHand + 1}`);
    assertLegalActions(snapshot, `${label} decision ${decisionsThisHand + 1}`);
    invariant(snapshot.decisionMath !== undefined, `${label}: awaiting-Hero snapshot lacks decision math.`);
    const decisionMath = snapshot.decisionMath;
    assertDecisionMath(decisionMath, snapshot.state!);
    const street = snapshot.state!.street;
    stats.decisionsByStreet[street] += 1;
    stats.heroDecisions += 1;
    decisionsThisHand += 1;

    const action = chooseNonFoldAction(snapshot.legalActions, handIndex, decisionsThisHand, random);
    stats.heroActionsByKind[action.kind] += 1;
    if (action.kind === "fold") stats.foldHeroActions += 1;
    else stats.nonFoldHeroActions += 1;
    const submitted = controller.session.submitHeroAction(action);
    invariant(submitted.accepted, `${label}: legal Hero action ${actionKey(action)} was rejected: ${submitted.reason ?? "no reason"}.`);
    snapshot = submitted.snapshot;
    assertState(snapshot, expectedStartingTotalBB, `${label} reveal ${decisionsThisHand}`);
    const provenance = assertReveal(snapshot, action, decisionMath, `${label} reveal ${decisionsThisHand}`);
    stats.revealsByProvenance[provenance] += 1;

    snapshot = await controller.session.continue({ signal: AbortSignal.timeout(config.handTimeoutMs) });
    invariant(snapshot.phase !== "BLOCKED", `${label}: BLOCKED ${snapshot.blocked?.code ?? "UNKNOWN"}: ${snapshot.blocked?.reason ?? "no reason"}`);
  }

  assertState(snapshot, expectedStartingTotalBB, `${label} terminal`);
  assertSettlement(snapshot, expectedStartingTotalBB, `${label} terminal`);
  stats.terminals[snapshot.state!.terminal!.type] += 1;
  stats.handsCompleted += 1;
  stats.maxHeroDecisionsInHand = Math.max(stats.maxHeroDecisionsInHand, decisionsThisHand);
}

async function main(): Promise<void> {
  const config = configuration();
  const selected = await selectProvider(config);
  const random = mulberry32(config.seed);
  const stats = createStats();
  const startedAt = performance.now();

  for (let handIndex = 0; handIndex < config.handCount; handIndex += 1) {
    await playHand(handIndex, config, selected, random, stats);
  }

  invariant(stats.handsCompleted === config.handCount, "Not every started hand reached terminal settlement.");
  invariant(stats.nonFoldHeroActions === stats.heroDecisions,
    `Hero folded ${stats.foldHeroActions} times despite a legal non-fold action being expected at every Hold'em decision.`);
  invariant([4, 5, 6, 7, 8].every((size) => (stats.byTableSize[size] ?? 0) > 0),
    `A requested table size received no hands: ${JSON.stringify(stats.byTableSize)}.`);
  invariant(STREETS.every((street) => stats.decisionsByStreet[street] > 0),
    `Street coverage incomplete: ${JSON.stringify(stats.decisionsByStreet)}.`);

  const providerCalls: ProviderCallStats = {
    total: selected.calls.total,
    byStreet: selected.calls.byStreet,
    byProvenance: selected.calls.byProvenance,
    heuristicFallbacks: selected.calls.heuristicFallbacks,
  };
  console.log(JSON.stringify({
    status: "PASS",
    configuration: config,
    provider: {
      selectedProviderId: selected.providerId,
      localProbe: selected.probe,
      calls: providerCalls,
    },
    coverage: stats,
    assertions: {
      strategyHiddenBeforeEveryHeroDecision: true,
      everySubmittedActionIssuedByLegalActionSet: true,
      everyHandReachedTerminalWithoutBlocked: true,
      fixedPointPotAndPerSeatChipsConservedAtEverySnapshot: true,
      settlementPayoutsPlusRakeConservedExactly: true,
      potOddsAndSprRecomputedAtEveryHeroDecision: true,
      heuristicAdviceCarriedNoTopLevelFrequencyEvOrConvergence: true,
    },
    elapsedSeconds: (performance.now() - startedAt) / 1_000,
  }, null, 2));
}

await main();
