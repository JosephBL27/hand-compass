import { assertUniqueCards, createDeck, type Card } from "../domain/cards";
import { comboId, removeCards, weightedComboCount, type WeightedCombo, type WeightedRange } from "../domain/ranges";
import { seatId, type PlayerCount, type SeatId } from "../domain/seats";
import type { ComboPolicy } from "../domain/comboPolicy";
import { ReplayRng } from "./rng";
import type { FixedHoleMap, SeatRangeMap } from "./types";

export interface HoleAssignmentSuccess {
  readonly available: true;
  readonly holeCards: Readonly<Record<SeatId, readonly [Card, Card]>>;
  readonly attempts: number;
}

export interface HoleAssignmentFailure {
  readonly available: false;
  readonly reason: string;
  readonly attempts: number;
}

export type HoleAssignmentResult = HoleAssignmentSuccess | HoleAssignmentFailure;

function positiveCombos(range: WeightedRange): readonly WeightedCombo[] {
  return [...range.values()].filter(({ weight }) => weight > 0);
}

function weightedComboAtRoll(combos: readonly WeightedCombo[], roll: number): WeightedCombo {
  const total = combos.reduce((sum, combo) => sum + combo.weight, 0);
  if (total <= 0) throw new RangeError("Cannot sample a zero-mass range");
  let remaining = roll * total;
  for (const combo of combos) {
    remaining -= combo.weight;
    if (remaining < 0) return combo;
  }
  const fallback = combos.at(-1);
  if (fallback === undefined) throw new Error("Weighted combo invariant failed");
  return fallback;
}

/**
 * Samples whole assignments independently from each seat's prior, rejecting
 * collisions only after all seats are drawn. Accepted assignments are thus
 * proportional to the product of their input weights.
 */
export function sampleJointHoleCards(input: {
  readonly playerCount: PlayerCount;
  readonly ranges: SeatRangeMap;
  readonly fixedHoleCards?: FixedHoleMap;
  readonly reservedCards?: readonly Card[];
  readonly maxAttempts?: number;
  readonly rng: ReplayRng;
}): HoleAssignmentResult {
  const maximum = input.maxAttempts ?? 10_000;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError("Assignment attempt cap must be a positive integer");
  const reserved = [...(input.reservedCards ?? [])];
  assertUniqueCards(reserved);
  const fixed: Partial<Record<SeatId, readonly [Card, Card]>> = {};
  const fixedCards = [...reserved];
  const rangedSeats: SeatId[] = [];
  const candidates = new Map<SeatId, readonly WeightedCombo[]>();
  for (let index = 0; index < input.playerCount; index += 1) {
    const id = seatId(index);
    const fixedHole = input.fixedHoleCards?.[id];
    if (fixedHole !== undefined) {
      assertUniqueCards(fixedHole);
      fixed[id] = fixedHole;
      fixedCards.push(...fixedHole);
      continue;
    }
    const range = input.ranges[id];
    if (range === undefined || weightedComboCount(range) <= 0) {
      return { available: false, reason: `Seat ${id} requires either fixed hole cards or a positive-mass range.`, attempts: 0 };
    }
    const combos = positiveCombos(range);
    if (combos.length === 0) return { available: false, reason: `Seat ${id} has no positive-weight hole-card combo.`, attempts: 0 };
    rangedSeats.push(id);
    candidates.set(id, combos);
  }
  try {
    assertUniqueCards(fixedCards);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), attempts: 0 };
  }
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const assignment: Partial<Record<SeatId, readonly [Card, Card]>> = { ...fixed };
    const drawnCards = [...fixedCards];
    for (const id of rangedSeats) {
      const combos = candidates.get(id);
      if (combos === undefined) throw new Error("Seat range candidate invariant failed");
      const sampled = weightedComboAtRoll(combos, input.rng.nextUnit());
      assignment[id] = sampled.cards;
      drawnCards.push(...sampled.cards);
    }
    if (new Set(drawnCards).size !== drawnCards.length) continue;
    return { available: true, holeCards: assignment as Record<SeatId, readonly [Card, Card]>, attempts: attempt };
  }
  return {
    available: false,
    reason: `No collision-free whole hole-card assignment was found within ${maximum} attempts; no fallback deal was used.`,
    attempts: maximum,
  };
}

export interface PolicyCoverageResult {
  readonly complete: boolean;
  readonly reason?: string;
  readonly coveredPositiveCombos: number;
  readonly requiredPositiveCombos: number;
  readonly mismatchedPositiveCombos: number;
}

/** Range-source weights are exact inputs; allow only harmless serialization noise. */
export const COMBO_POLICY_WEIGHT_TOLERANCE = 1e-6;

export function checkComboPolicyCoverage(
  range: WeightedRange,
  policy: ComboPolicy,
  publicBlockedCards: readonly Card[],
): PolicyCoverageResult {
  assertUniqueCards(publicBlockedCards);
  const cardFiltered = removeCards(range, publicBlockedCards);
  const required = [...cardFiltered.values()].filter(({ weight }) => weight > 0);
  const policyById = new Map(policy.filter(({ weight }) => weight > 0).map((row) => [comboId(...row.cards), row]));
  const missing = required.filter(({ id }) => !policyById.has(id));
  const mismatched = required.flatMap((combo) => {
    const row = policyById.get(combo.id);
    if (row === undefined || Math.abs(row.weight - combo.weight) <= COMBO_POLICY_WEIGHT_TOLERANCE) return [];
    return [{ combo, row }];
  });
  const issues = [
    ...(missing.length > 0
      ? [`Combo policy is missing ${missing.length} of ${required.length} positive-weight public range combos.`]
      : []),
    ...(mismatched.length > 0
      ? [`Combo policy has ${mismatched.length} source-weight mismatch${mismatched.length === 1 ? "" : "es"} among ${required.length} positive-weight public range combos (absolute tolerance ${COMBO_POLICY_WEIGHT_TOLERANCE}); ${mismatched.slice(0, 3).map(({ combo, row }) => `${combo.id} expected ${combo.weight}, received ${row.weight}`).join("; ")}.`]
      : []),
  ];
  return {
    complete: required.length > 0 && missing.length === 0 && mismatched.length === 0,
    ...(required.length === 0
      ? { reason: "No positive-weight public range combos remain after public card removal." }
      : issues.length > 0
        ? { reason: issues.join(" ") }
        : {}),
    coveredPositiveCombos: required.length - missing.length - mismatched.length,
    requiredPositiveCombos: required.length,
    mismatchedPositiveCombos: mismatched.length,
  };
}

export function shuffledAvailableDeck(
  rng: ReplayRng,
  blockedCards: readonly Card[],
): readonly Card[] {
  assertUniqueCards(blockedCards);
  const blocked = new Set(blockedCards);
  const deck = createDeck().filter((value) => !blocked.has(value));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng.nextUnit() * (index + 1));
    const current = deck[index];
    const other = deck[swap];
    if (current === undefined || other === undefined) throw new Error("Deck shuffle invariant failed");
    deck[index] = other;
    deck[swap] = current;
  }
  return deck;
}
