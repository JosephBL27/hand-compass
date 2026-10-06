import { actionKey, type PokerAction } from "./actions";
import { assertUniqueCards, type Card } from "./cards";
import type { BB } from "./money";
import {
  comboId,
  createRange,
  normalizeRangeToUnitMass,
  removeCardsWithStats,
  weightedComboCount,
  type ComboId,
  type WeightedRange,
} from "./ranges";
import type { StrategyAction } from "./strategy";

/** Imported solver frequencies may drift by at most one tenth of one percent. */
export const COMBO_POLICY_ROUNDING_TOLERANCE = 0.001;

export interface ComboPolicyAction {
  readonly action: PokerAction;
  readonly frequency: number;
  readonly evBB?: BB;
}

export interface ComboPolicyRow {
  readonly cards: readonly [Card, Card];
  readonly weight: number;
  readonly actions: readonly ComboPolicyAction[];
}

export type ComboPolicy = readonly ComboPolicyRow[];

function assertUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${field} must be in [0, 1]`);
}

export function validateComboPolicy(policy: ComboPolicy, legalActions?: readonly PokerAction[]): ComboPolicy {
  if (policy.length === 0) throw new RangeError("Combo policy must contain at least one row");
  const legalKeys = legalActions === undefined ? null : new Set(legalActions.map(actionKey));
  const seenCombos = new Set<ComboId>();
  let totalPolicyWeight = 0;
  for (const row of policy) {
    assertUniqueCards(row.cards);
    assertUnitInterval(row.weight, "Combo weight");
    totalPolicyWeight += row.weight;
    const id = comboId(...row.cards);
    if (seenCombos.has(id)) throw new RangeError(`Duplicate combo-policy row: ${id}`);
    seenCombos.add(id);
    if (row.actions.length === 0) throw new RangeError(`Combo policy ${id} has no actions`);
    const seenActions = new Set<string>();
    let total = 0;
    for (const item of row.actions) {
      const key = actionKey(item.action);
      if (seenActions.has(key)) throw new RangeError(`Duplicate action ${key} for combo ${id}`);
      if (legalKeys !== null && !legalKeys.has(key)) throw new RangeError(`Illegal action ${key} for combo ${id}`);
      seenActions.add(key);
      assertUnitInterval(item.frequency, "Action frequency");
      if (item.evBB !== undefined && !Number.isFinite(item.evBB)) throw new RangeError("Action EV must be finite");
      total += item.frequency;
    }
    if (Math.abs(total - 1) > COMBO_POLICY_ROUNDING_TOLERANCE) {
      throw new RangeError(`Combo policy ${id} frequencies total ${total}, outside the ±${COMBO_POLICY_ROUNDING_TOLERANCE} rounding tolerance`);
    }
  }
  if (totalPolicyWeight <= 0) throw new RangeError("Combo policy must contain positive weighted mass");
  return policy;
}

export interface AvailableConditionedRange {
  readonly available: true;
  readonly posterior: WeightedRange;
  readonly priorWeightedMass: number;
  readonly cardFilteredWeightedMass: number;
  readonly retainedActionMass: number;
  readonly posteriorNormalizedMass: number;
  readonly priorComboCount: number;
  readonly cardFilteredComboCount: number;
  readonly posteriorComboCount: number;
  readonly removedCardComboCount: number;
  readonly removedCardWeightedMass: number;
}

export interface UnavailableConditionedRange {
  readonly available: false;
  readonly reason: string;
  /** The exact input object is returned so callers can prove no posterior mutation occurred. */
  readonly unchangedRange: WeightedRange;
}

export type ConditionedRangeResult = AvailableConditionedRange | UnavailableConditionedRange;

export function conditionRangeByAction(
  prior: WeightedRange,
  policy: ComboPolicy | undefined,
  observedAction: PokerAction,
  blockedCards: readonly Card[] = [],
): ConditionedRangeResult {
  if (policy === undefined || policy.length === 0) {
    return { available: false, reason: "Combo policy is unavailable; posterior range mutation is disabled.", unchangedRange: prior };
  }
  validateComboPolicy(policy);
  assertUniqueCards(blockedCards);
  const removal = removeCardsWithStats(prior, blockedCards);
  if (removal.range.size === 0) {
    return { available: false, reason: "No prior combos remain after known-card removal.", unchangedRange: prior };
  }
  const policyByCombo = new Map(policy.map((row) => [comboId(...row.cards), row]));
  const missing = [...removal.range].filter(([id, combo]) => combo.weight > 0 && !policyByCombo.has(id)).map(([id]) => id);
  if (missing.length > 0) {
    return {
      available: false,
      reason: `Combo policy is missing ${missing.length} positive-weight prior combo${missing.length === 1 ? "" : "s"}; posterior range mutation is disabled.`,
      unchangedRange: prior,
    };
  }
  const observedKey = actionKey(observedAction);
  const multiplied = new Map<ComboId, { readonly id: ComboId; readonly cards: readonly [Card, Card]; readonly weight: number }>();
  for (const [id, combo] of removal.range) {
    if (combo.weight <= 0) continue;
    const row = policyByCombo.get(id);
    if (row === undefined) throw new Error("Combo-policy coverage invariant failed");
    const likelihood = row.actions.find((item) => actionKey(item.action) === observedKey)?.frequency ?? 0;
    const weight = combo.weight * likelihood;
    if (weight > 0) multiplied.set(id, { ...combo, weight });
  }
  const retainedActionMass = weightedComboCount(multiplied);
  if (retainedActionMass <= 0) {
    return { available: false, reason: `Observed action ${observedKey} has zero probability in the supplied combo policy.`, unchangedRange: prior };
  }
  const posterior = normalizeRangeToUnitMass(multiplied);
  return {
    available: true,
    posterior,
    priorWeightedMass: weightedComboCount(prior),
    cardFilteredWeightedMass: weightedComboCount(removal.range),
    retainedActionMass,
    posteriorNormalizedMass: weightedComboCount(posterior),
    priorComboCount: prior.size,
    cardFilteredComboCount: removal.range.size,
    posteriorComboCount: posterior.size,
    removedCardComboCount: removal.removedComboCount,
    removedCardWeightedMass: removal.removedWeightedMass,
  };
}

export function aggregateComboPolicy(policy: ComboPolicy, legalActions?: readonly PokerAction[]): readonly StrategyAction[] {
  validateComboPolicy(policy, legalActions);
  const totalWeight = policy.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) throw new RangeError("Combo policy has no positive weighted mass");
  const orderedKeys = legalActions === undefined
    ? [...new Set(policy.flatMap((row) => row.actions.map((item) => actionKey(item.action))))]
    : legalActions.map(actionKey);
  const byKey = new Map<string, PokerAction>();
  for (const row of policy) for (const item of row.actions) byKey.set(actionKey(item.action), item.action);
  const aggregates: StrategyAction[] = [];
  for (const key of orderedKeys) {
    const action = byKey.get(key) ?? legalActions?.find((candidate) => actionKey(candidate) === key);
    if (action === undefined) continue;
    let reachMass = 0;
    let evMass = 0;
    let completeEv = true;
    for (const row of policy) {
      const item = row.actions.find((candidate) => actionKey(candidate.action) === key);
      if (item === undefined || item.frequency <= 0 || row.weight <= 0) continue;
      const actionMass = row.weight * item.frequency;
      reachMass += actionMass;
      if (item.evBB === undefined) completeEv = false;
      else evMass += actionMass * item.evBB;
    }
    if (reachMass <= 0) continue;
    const aggregate: { action: PokerAction; frequency: number; evBB?: BB } = {
      action,
      frequency: reachMass / totalWeight,
    };
    if (completeEv) aggregate.evBB = Math.round(evMass / reachMass) as BB;
    aggregates.push(aggregate);
  }
  return aggregates;
}

/**
 * Returns the exact action row for an already-known two-card holding. This is
 * deliberately separate from `aggregateComboPolicy`: a hand drill must never
 * grade one concrete combo against range-aggregate frequencies or EVs.
 */
export function strategyActionsForHeldCombo(
  policy: ComboPolicy | undefined,
  cards: readonly [Card, Card],
  legalActions?: readonly PokerAction[],
): readonly StrategyAction[] | undefined {
  if (policy === undefined || policy.length === 0) return undefined;
  validateComboPolicy(policy, legalActions);
  assertUniqueCards(cards);
  const id = comboId(...cards);
  const row = policy.find((candidate) => comboId(...candidate.cards) === id && candidate.weight > 0);
  if (row === undefined) return undefined;
  return row.actions.map((item) => ({
    action: item.action,
    frequency: item.frequency,
    ...(item.evBB === undefined ? {} : { evBB: item.evBB }),
  }));
}

function seededRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new RangeError("Sampling seed must be a safe integer");
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function weightedChoice<T>(items: readonly T[], weightOf: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  if (total <= 0) throw new RangeError("Cannot sample from zero weighted mass");
  let roll = random() * total;
  for (const item of items) {
    roll -= weightOf(item);
    if (roll <= 0) return item;
  }
  const fallback = items.at(-1);
  if (fallback === undefined) throw new RangeError("Cannot sample an empty collection");
  return fallback;
}

export interface AvailableComboActionSample {
  readonly available: true;
  readonly seed: number;
  readonly comboId: ComboId;
  readonly cards: readonly [Card, Card];
  readonly action: PokerAction;
  readonly actionFrequency: number;
  readonly eligibleComboCount: number;
  readonly removedCardComboCount: number;
}

export interface UnavailableComboActionSample {
  readonly available: false;
  readonly reason: string;
}

export type ComboActionSample = AvailableComboActionSample | UnavailableComboActionSample;

export interface AvailableHeldComboActionSample {
  readonly available: true;
  readonly comboId: ComboId;
  readonly cards: readonly [Card, Card];
  readonly action: PokerAction;
  readonly actionFrequency: number;
}

export interface UnavailableHeldComboActionSample {
  readonly available: false;
  readonly reason: string;
}

export type HeldComboActionSample = AvailableHeldComboActionSample | UnavailableHeldComboActionSample;

/**
 * Samples only from the policy row belonging to an already-dealt combo.
 * The caller owns RNG state: `roll` is a unit interval value and this pure
 * function never advances, seeds, or substitutes a random source.
 */
export function sampleActionForCombo(
  policy: ComboPolicy | undefined,
  cards: readonly [Card, Card],
  roll: number,
  legalActions?: readonly PokerAction[],
): HeldComboActionSample {
  if (policy === undefined || policy.length === 0) {
    return { available: false, reason: "Combo policy is unavailable; held-combo action automation is disabled." };
  }
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError("Action sampling roll must be in [0, 1)");
  validateComboPolicy(policy, legalActions);
  assertUniqueCards(cards);
  const id = comboId(...cards);
  const row = policy.find((candidate) => comboId(...candidate.cards) === id);
  if (row === undefined) return { available: false, reason: `Combo policy has no row for held combo ${id}.` };
  if (row.weight <= 0) return { available: false, reason: `Held combo ${id} has no positive policy weight.` };
  const positive = row.actions.filter((item) => item.frequency > 0);
  const total = positive.reduce((sum, item) => sum + item.frequency, 0);
  if (total <= 0) return { available: false, reason: `Held combo ${id} has no positive action mass.` };
  let remaining = roll * total;
  for (const item of positive) {
    remaining -= item.frequency;
    if (remaining < 0) {
      return { available: true, comboId: id, cards: row.cards, action: item.action, actionFrequency: item.frequency };
    }
  }
  const fallback = positive.at(-1);
  if (fallback === undefined) throw new Error("Positive held-combo action invariant failed");
  return { available: true, comboId: id, cards: row.cards, action: fallback.action, actionFrequency: fallback.frequency };
}

export function sampleComboThenAction(
  policy: ComboPolicy | undefined,
  input: {
    readonly seed: number;
    readonly heroCards?: readonly [Card, Card];
    readonly board?: readonly Card[];
    readonly deadCards?: readonly Card[];
  },
): ComboActionSample {
  if (policy === undefined || policy.length === 0) {
    return { available: false, reason: "Combo policy is unavailable; opponent-card and action automation is disabled." };
  }
  validateComboPolicy(policy);
  const blockedCards = [...(input.heroCards ?? []), ...(input.board ?? []), ...(input.deadCards ?? [])];
  assertUniqueCards(blockedCards);
  const prior = createRange(policy.map((row) => ({ cards: row.cards, weight: row.weight })));
  const removal = removeCardsWithStats(prior, blockedCards);
  const eligibleRows = policy.filter((row) => removal.range.has(comboId(...row.cards)) && row.weight > 0);
  if (eligibleRows.length === 0) {
    return { available: false, reason: "No positive-weight opponent combos remain after hero, board, and dead-card removal." };
  }
  const random = seededRandom(input.seed);
  const row = weightedChoice(eligibleRows, (candidate) => candidate.weight, random);
  const item = weightedChoice(row.actions, (candidate) => candidate.frequency, random);
  return {
    available: true,
    seed: input.seed,
    comboId: comboId(...row.cards),
    cards: row.cards,
    action: item.action,
    actionFrequency: item.frequency,
    eligibleComboCount: eligibleRows.length,
    removedCardComboCount: removal.removedComboCount,
  };
}
