import { compare, equityHoldem, evaluateHoldem } from "@poker-apprentice/hand-evaluator";
import { assertUniqueCards, createDeck, type Card } from "../domain/cards";
import { holdemRunoutCount } from "../domain/math";

export interface EquityCombo {
  readonly cards: readonly [Card, Card];
  readonly weight: number;
}

export type EquityCalculationMode = "auto" | "exact" | "monte-carlo";
export type EquityProvenance = "EXACT_MATH" | "ESTIMATE";

export const HAND_STRENGTH_LABELS = ["High card", "Pair", "Two pair", "Trips", "Straight", "Flush", "Full house", "Quads", "Straight flush"] as const;

export interface RangeStrengthProfile {
  readonly comboCount: number;
  readonly weightedComboCount: number;
  readonly nutComboCount: number;
  readonly weightedNutCombos: number;
  readonly nutDensity: number;
  readonly topFiveComboCount: number;
  readonly weightedTopFiveCombos: number;
  readonly topFiveDensity: number;
  readonly categoryWeightedCombos: Readonly<Record<(typeof HAND_STRENGTH_LABELS)[number], number>>;
}

export interface RangeStrengthComparison {
  readonly provenance: "EXACT_MATH";
  readonly basis: "CURRENT_BOARD_PUBLIC_RANGES";
  readonly legalComboCount: number;
  readonly topFiveCutoffComboCount: number;
  readonly topFiveCutoffPercentage: number;
  readonly hero: RangeStrengthProfile;
  readonly opponent: RangeStrengthProfile;
  readonly notes: readonly string[];
}

export interface EquityWorkerRequest {
  readonly id: string;
  /** Concrete hero hand retained for the original convenient API. */
  readonly hero?: readonly [Card, Card];
  readonly heroRange?: readonly EquityCombo[];
  readonly opponentRange: readonly EquityCombo[];
  readonly board: readonly Card[];
  readonly deadCards?: readonly Card[];
  readonly mode?: EquityCalculationMode;
  readonly iterations?: number;
  readonly seed?: number;
  /** Maximum pair × runout scenarios allowed for exact enumeration. */
  readonly maximumExactScenarios?: number;
}

export interface EquityWorkerResponse {
  readonly id: string;
  readonly provenance: EquityProvenance;
  readonly method: "exact-enumeration" | "monte-carlo";
  /** Exact runouts per legal concrete pair, when enumerated. */
  readonly runoutCount?: number;
  /** Total pair/runout scenarios evaluated, or Monte Carlo samples. */
  readonly scenarioCount: number;
  readonly pairCount: number;
  readonly totalPairWeight: number;
  /** Compatibility field: exact runouts per pair or Monte Carlo sample count. */
  readonly iterations: number;
  readonly sampleCount?: number;
  readonly seed?: number;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly equity: number;
  readonly standardError?: number;
  readonly confidence95?: readonly [number, number];
  readonly rangeStrengthComparison?: RangeStrengthComparison;
  readonly notes: readonly string[];
}

interface WeightedPair {
  readonly hero: readonly [Card, Card];
  readonly opponent: readonly [Card, Card];
  readonly weight: number;
}

const DEFAULT_SEED = 0x51f15e;
const DEFAULT_MONTE_CARLO_SAMPLES = 10_000;
const DEFAULT_MAXIMUM_EXACT_SCENARIOS = 2_000_000;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function validateWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("Range weight must be in [0, 1]");
}

function filterRange(combos: readonly EquityCombo[], blocked: ReadonlySet<Card>): readonly EquityCombo[] {
  return combos.filter((combo) => {
    validateWeight(combo.weight);
    return combo.weight > 0 && combo.cards[0] !== combo.cards[1] && combo.cards.every((value) => !blocked.has(value));
  });
}

type EvaluatedHand = ReturnType<typeof evaluateHoldem>;

interface EvaluatedCombo {
  readonly cards: readonly [Card, Card];
  readonly evaluation: EvaluatedHand;
}

function evaluatedLegalCombos(board: readonly Card[], deadCards: readonly Card[]): readonly EvaluatedCombo[] {
  const blocked = new Set<Card>([...board, ...deadCards]);
  const available = createDeck().filter((value) => !blocked.has(value));
  const result: EvaluatedCombo[] = [];
  for (let first = 0; first < available.length - 1; first += 1) {
    for (let second = first + 1; second < available.length; second += 1) {
      const left = available[first];
      const right = available[second];
      if (left === undefined || right === undefined) throw new Error("Legal-combo enumeration invariant failed");
      result.push({ cards: [left, right], evaluation: evaluateHoldem({ holeCards: [left, right], communityCards: [...board] }) });
    }
  }
  return result.sort((left, right) => compare(left.evaluation, right.evaluation));
}

function emptyCategories(): Record<(typeof HAND_STRENGTH_LABELS)[number], number> {
  return Object.fromEntries(HAND_STRENGTH_LABELS.map((label) => [label, 0])) as Record<(typeof HAND_STRENGTH_LABELS)[number], number>;
}

function strengthProfile(
  combos: readonly EquityCombo[],
  blocked: ReadonlySet<Card>,
  board: readonly Card[],
  nutEvaluation: EvaluatedHand,
  topFiveCutoff: EvaluatedHand,
): RangeStrengthProfile {
  const legal = filterRange(combos, blocked);
  const categoryWeightedCombos = emptyCategories();
  let nutComboCount = 0;
  let weightedNutCombos = 0;
  let topFiveComboCount = 0;
  let weightedTopFiveCombos = 0;
  let weightedComboCount = 0;
  for (const combo of legal) {
    const evaluation = evaluateHoldem({ holeCards: [...combo.cards], communityCards: [...board] });
    const category = HAND_STRENGTH_LABELS.at(evaluation.strength);
    if (category === undefined) throw new Error(`Unknown hand-strength category ${evaluation.strength}`);
    categoryWeightedCombos[category] += combo.weight;
    weightedComboCount += combo.weight;
    if (compare(evaluation, nutEvaluation) === 0) {
      nutComboCount += 1;
      weightedNutCombos += combo.weight;
    }
    if (compare(evaluation, topFiveCutoff) <= 0) {
      topFiveComboCount += 1;
      weightedTopFiveCombos += combo.weight;
    }
  }
  return {
    comboCount: legal.length,
    weightedComboCount,
    nutComboCount,
    weightedNutCombos,
    nutDensity: weightedComboCount === 0 ? 0 : weightedNutCombos / weightedComboCount,
    topFiveComboCount,
    weightedTopFiveCombos,
    topFiveDensity: weightedComboCount === 0 ? 0 : weightedTopFiveCombos / weightedComboCount,
    categoryWeightedCombos,
  };
}

export function calculateRangeStrengthComparison(request: Pick<EquityWorkerRequest, "heroRange" | "opponentRange" | "board" | "deadCards">): RangeStrengthComparison | undefined {
  if (request.heroRange === undefined || request.board.length < 3) return undefined;
  const deadCards = request.deadCards ?? [];
  assertUniqueCards([...request.board, ...deadCards]);
  const universe = evaluatedLegalCombos(request.board, deadCards);
  const nut = universe[0];
  const nominalCutoffIndex = Math.max(0, Math.ceil(universe.length * 0.05) - 1);
  const cutoff = universe[nominalCutoffIndex];
  if (nut === undefined || cutoff === undefined) throw new RangeError("No legal combos remain for range-strength comparison");
  const topFiveCutoffComboCount = universe.filter(({ evaluation }) => compare(evaluation, cutoff.evaluation) <= 0).length;
  const blocked = new Set<Card>([...request.board, ...deadCards]);
  return {
    provenance: "EXACT_MATH",
    basis: "CURRENT_BOARD_PUBLIC_RANGES",
    legalComboCount: universe.length,
    topFiveCutoffComboCount,
    topFiveCutoffPercentage: topFiveCutoffComboCount / universe.length,
    hero: strengthProfile(request.heroRange, blocked, request.board, nut.evaluation, cutoff.evaluation),
    opponent: strengthProfile(request.opponentRange, blocked, request.board, nut.evaluation, cutoff.evaluation),
    notes: [
      "Current made-hand strength is evaluated on the visible board; future-card equity is not part of this profile.",
      "The top-5% benchmark is the hand-rank cutoff for the strongest five percent of all board- and dead-card-legal two-card combos; ties at the cutoff are included.",
    ],
  };
}

function preparePairs(request: EquityWorkerRequest): { readonly pairs: readonly WeightedPair[]; readonly totalWeight: number; readonly known: readonly Card[] } {
  if (request.board.length > 5) throw new RangeError("Board cannot exceed five cards");
  if ((request.hero === undefined) === (request.heroRange === undefined)) {
    throw new RangeError("Supply exactly one of hero or heroRange");
  }
  const known = [...request.board, ...(request.deadCards ?? [])];
  assertUniqueCards(known);
  const blocked = new Set(known);
  let heroRange: readonly EquityCombo[];
  if (request.hero !== undefined) {
    assertUniqueCards([...request.hero, ...known]);
    heroRange = [{ cards: request.hero, weight: 1 }];
  } else {
    heroRange = filterRange(request.heroRange ?? [], blocked);
  }
  const opponentRange = filterRange(request.opponentRange, blocked);
  const pairs: WeightedPair[] = [];
  let totalWeight = 0;
  for (const hero of heroRange) {
    for (const opponent of opponentRange) {
      if (hero.cards.some((value) => opponent.cards.includes(value))) continue;
      const weight = hero.weight * opponent.weight;
      if (weight <= 0) continue;
      pairs.push({ hero: hero.cards, opponent: opponent.cards, weight });
      totalWeight += weight;
    }
  }
  if (pairs.length === 0 || totalWeight <= 0) throw new RangeError("No legal weighted hero/villain combo pairs remain after card removal");
  return { pairs, totalWeight, known };
}

function weightedChoice(pairs: readonly WeightedPair[], totalWeight: number, random: () => number): WeightedPair {
  let roll = random() * totalWeight;
  for (const pair of pairs) {
    roll -= pair.weight;
    if (roll <= 0) return pair;
  }
  const fallback = pairs.at(-1);
  if (fallback === undefined) throw new RangeError("Weighted pair set is empty");
  return fallback;
}

function* chooseCards(cards: readonly Card[], count: number, start = 0, chosen: Card[] = []): Generator<readonly Card[]> {
  if (chosen.length === count) {
    yield [...chosen];
    return;
  }
  const remaining = count - chosen.length;
  for (let index = start; index <= cards.length - remaining; index += 1) {
    const value = cards[index];
    if (value === undefined) throw new Error("Runout enumeration invariant failed");
    chosen.push(value);
    yield* chooseCards(cards, count, index + 1, chosen);
    chosen.pop();
  }
}

function compareShowdown(hero: readonly [Card, Card], opponent: readonly [Card, Card], board: readonly Card[]): -1 | 0 | 1 {
  return compare(
    evaluateHoldem({ holeCards: [...hero], communityCards: [...board] }),
    evaluateHoldem({ holeCards: [...opponent], communityCards: [...board] }),
  );
}

function enumerateWithDeadCards(pair: WeightedPair, board: readonly Card[], deadCards: readonly Card[]): { readonly wins: number; readonly ties: number; readonly total: number; readonly equity: number } {
  const excluded = new Set<Card>([...pair.hero, ...pair.opponent, ...board, ...deadCards]);
  const available = createDeck().filter((value) => !excluded.has(value));
  const cardsToCome = 5 - board.length;
  let wins = 0;
  let ties = 0;
  let total = 0;
  for (const runout of chooseCards(available, cardsToCome)) {
    const result = compareShowdown(pair.hero, pair.opponent, [...board, ...runout]);
    if (result < 0) wins += 1;
    else if (result === 0) ties += 1;
    total += 1;
  }
  return { wins, ties, total, equity: total === 0 ? 0 : (wins + ties / 2) / total };
}

function exactEquity(request: EquityWorkerRequest, prepared: ReturnType<typeof preparePairs>, runoutCount: number, scenarioCount: number): EquityWorkerResponse {
  let weightedWins = 0;
  let weightedTies = 0;
  let weightedLosses = 0;
  let weightedEquity = 0;
  let weightedTotals = 0;
  const deadCards = request.deadCards ?? [];
  for (const pair of prepared.pairs) {
    const result = deadCards.length === 0
      ? equityHoldem([[...pair.hero], [...pair.opponent]], [...request.board], { maximumEvaluations: Math.max(2, runoutCount * 2) })[0]
      : enumerateWithDeadCards(pair, request.board, deadCards);
    if (result === undefined) throw new Error("Equity engine omitted the hero result");
    weightedWins += pair.weight * result.wins;
    weightedTies += pair.weight * result.ties;
    weightedLosses += pair.weight * (result.total - result.wins - result.ties);
    weightedEquity += pair.weight * result.equity;
    weightedTotals += pair.weight * result.total;
  }
  return {
    id: request.id,
    provenance: "EXACT_MATH",
    method: "exact-enumeration",
    runoutCount,
    scenarioCount,
    pairCount: prepared.pairs.length,
    totalPairWeight: prepared.totalWeight,
    iterations: Math.round(weightedTotals / prepared.totalWeight),
    wins: weightedWins / prepared.totalWeight,
    ties: weightedTies / prepared.totalWeight,
    losses: weightedLosses / prepared.totalWeight,
    equity: weightedEquity / prepared.totalWeight,
    notes: [
      "Every legal concrete combo pair and board runout was enumerated within the configured budget.",
      ...(deadCards.length === 0 ? ["Runouts were enumerated by @poker-apprentice/hand-evaluator equityHoldem."] : ["Dead-card-aware runouts were enumerated explicitly and scored with evaluateHoldem."]),
    ],
  };
}

function monteCarloEquity(request: EquityWorkerRequest, prepared: ReturnType<typeof preparePairs>): EquityWorkerResponse {
  const iterations = request.iterations ?? DEFAULT_MONTE_CARLO_SAMPLES;
  if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new RangeError("Iterations must be a positive integer");
  const seed = request.seed ?? DEFAULT_SEED;
  const random = seededRandom(seed);
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const pair = weightedChoice(prepared.pairs, prepared.totalWeight, random);
    const excluded = new Set<Card>([...prepared.known, ...pair.hero, ...pair.opponent]);
    const available = createDeck().filter((value) => !excluded.has(value));
    const needed = 5 - request.board.length;
    for (let index = 0; index < needed; index += 1) {
      const swap = index + Math.floor(random() * (available.length - index));
      const left = available[index];
      const right = available[swap];
      if (left === undefined || right === undefined) throw new Error("Runout sampling failed");
      available[index] = right;
      available[swap] = left;
    }
    const board = [...request.board, ...available.slice(0, needed)];
    const result = compareShowdown(pair.hero, pair.opponent, board);
    const share = result < 0 ? 1 : result === 0 ? 0.5 : 0;
    if (result < 0) wins += 1;
    else if (result === 0) ties += 1;
    else losses += 1;
    sum += share;
    sumSquares += share * share;
  }
  const equity = sum / iterations;
  const sampleVariance = iterations <= 1 ? 0 : Math.max(0, (sumSquares - iterations * equity * equity) / (iterations - 1));
  const standardError = Math.sqrt(sampleVariance / iterations);
  return {
    id: request.id,
    provenance: "ESTIMATE",
    method: "monte-carlo",
    scenarioCount: iterations,
    pairCount: prepared.pairs.length,
    totalPairWeight: prepared.totalWeight,
    iterations,
    sampleCount: iterations,
    seed,
    wins,
    ties,
    losses,
    equity,
    standardError,
    confidence95: [Math.max(0, equity - 1.96 * standardError), Math.min(1, equity + 1.96 * standardError)],
    notes: ["Monte Carlo output is a seeded estimate, not solver strategy or exact enumeration."],
  };
}

export function calculateEquity(request: EquityWorkerRequest): EquityWorkerResponse {
  const prepared = preparePairs(request);
  const maximumExactScenarios = request.maximumExactScenarios ?? DEFAULT_MAXIMUM_EXACT_SCENARIOS;
  if (!Number.isSafeInteger(maximumExactScenarios) || maximumExactScenarios <= 0) {
    throw new RangeError("Maximum exact scenario budget must be a positive integer");
  }
  const runoutCount = holdemRunoutCount(request.board.length, request.deadCards?.length ?? 0);
  const scenarioCount = runoutCount * prepared.pairs.length;
  const mode = request.mode ?? "auto";
  const rangeStrengthComparison = calculateRangeStrengthComparison(request);
  const withRangeStrength = (response: EquityWorkerResponse): EquityWorkerResponse => ({
    ...response,
    ...(rangeStrengthComparison === undefined ? {} : { rangeStrengthComparison }),
  });
  if (mode === "monte-carlo") return withRangeStrength(monteCarloEquity(request, prepared));
  if (scenarioCount <= maximumExactScenarios) return withRangeStrength(exactEquity(request, prepared, runoutCount, scenarioCount));
  if (mode === "exact") {
    throw new RangeError(`Exact equity requires ${scenarioCount} scenarios, exceeding the configured budget of ${maximumExactScenarios}`);
  }
  return withRangeStrength({
    ...monteCarloEquity(request, prepared),
    notes: [
      `Exact enumeration requires ${scenarioCount} scenarios, above the configured budget of ${maximumExactScenarios}.`,
      "Monte Carlo output is a seeded estimate, not solver strategy or exact enumeration.",
    ],
  });
}

const workerScope = globalThis as typeof globalThis & {
  postMessage?: (value: EquityWorkerResponse) => void;
  onmessage?: ((event: MessageEvent<EquityWorkerRequest>) => void) | null;
};

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  workerScope.onmessage = (event) => workerScope.postMessage?.(calculateEquity(event.data));
}
