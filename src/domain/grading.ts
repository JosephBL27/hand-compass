import { actionKey, type PokerAction } from "./actions";
import { bbToNumber, type BB } from "./money";
import type { StrategyAction, StrategyResult } from "./strategy";

export interface GradingPolicy {
  readonly lowFrequencyBoundary: number;
  readonly goodMaxLossPctPot: number;
  readonly inaccuracyMaxLossPctPot: number;
  readonly mistakeMaxLossPctPot: number;
}

export const defaultGradingPolicy: GradingPolicy = {
  lowFrequencyBoundary: 0.035,
  goodMaxLossPctPot: 0.5,
  inaccuracyMaxLossPctPot: 2,
  mistakeMaxLossPctPot: 5,
};

export type RngMode = "off" | "high" | "low";

export interface RngBucket {
  readonly item: StrategyAction;
  readonly start: number;
  readonly end: number;
  readonly normalizedFrequency: number;
}

export type Grade =
  | { readonly mode: "EV"; readonly grade: "BEST MOVE" | "GOOD MOVE" | "INACCURACY" | "MISTAKE" | "BLUNDER"; readonly evLossBB: BB; readonly evLossPctPot: number; readonly policy?: GradingPolicy }
  | { readonly mode: "REFERENCE_ONLY"; readonly grade: "REFERENCE ACTION" | "SUPPORTED MIX" | "OUTSIDE REFERENCE" | "REFERENCE UNAVAILABLE" }
  | { readonly mode: "HEURISTIC"; readonly grade: "HEURISTIC BEST" | "HEURISTIC ACCEPTABLE" | "HEURISTIC QUESTIONABLE" };

export interface FrequencyPredictionPolicy {
  readonly excellentMaxDistance: number;
  readonly closeMaxDistance: number;
  readonly developingMaxDistance: number;
}

export const defaultFrequencyPredictionPolicy: FrequencyPredictionPolicy = {
  excellentMaxDistance: 0.025,
  closeMaxDistance: 0.075,
  developingMaxDistance: 0.15,
};

export interface FrequencyPredictionActionResult {
  readonly action: PokerAction;
  readonly predictedFrequency: number;
  readonly referenceFrequency: number;
  readonly absoluteError: number;
}

export interface FrequencyPredictionGrade {
  readonly grade: "EXCELLENT MIX" | "CLOSE MIX" | "DEVELOPING MIX" | "OFF TARGET";
  /** Half the L1 distance; 0 is exact and 1 is completely disjoint. */
  readonly totalVariationDistance: number;
  readonly meanAbsoluteError: number;
  readonly maximumAbsoluteError: number;
  readonly actions: readonly FrequencyPredictionActionResult[];
}

const REFERENCE_FREQUENCY_TOLERANCE = 0.001;

function genuineCompleteReferenceFrequencies(
  strategy: StrategyResult,
  legalActions: readonly PokerAction[] = strategy.actions.map(({ action }) => action),
): readonly (StrategyAction & { readonly frequency: number })[] | undefined {
  if (strategy.provenance !== "SOLVED" && strategy.provenance !== "INTERPOLATED") return undefined;
  if (legalActions.length === 0 || strategy.actions.length !== legalActions.length) return undefined;
  const legalKeys = legalActions.map(actionKey);
  if (new Set(legalKeys).size !== legalKeys.length) return undefined;
  const rowsByKey = new Map<string, StrategyAction>();
  for (const row of strategy.actions) {
    const key = actionKey(row.action);
    if (rowsByKey.has(key)) return undefined;
    rowsByKey.set(key, row);
  }
  const rows = legalKeys.map((key) => rowsByKey.get(key));
  if (rows.some((row) => row?.frequency === undefined || !Number.isFinite(row.frequency) || row.frequency < 0)) return undefined;
  const completeRows = rows as readonly (StrategyAction & { readonly frequency: number })[];
  const total = completeRows.reduce((sum, { frequency }) => sum + frequency, 0);
  if (total <= 0 || Math.abs(total - 1) > REFERENCE_FREQUENCY_TOLERANCE) return undefined;
  return completeRows;
}

function completeReferenceFrequencies(strategy: StrategyResult): readonly (StrategyAction & { readonly frequency: number })[] {
  const rows = genuineCompleteReferenceFrequencies(strategy);
  if (rows === undefined) {
    if (strategy.provenance !== "SOLVED" && strategy.provenance !== "INTERPOLATED") {
      throw new RangeError("Frequency prediction requires a SOLVED or explicitly INTERPOLATED reference.");
    }
    throw new RangeError("Frequency prediction requires a complete nonnegative reference frequency set totaling 100%.");
  }
  return rows;
}

export function gradeFrequencyPrediction(
  prediction: Readonly<Record<string, number>>,
  strategy: StrategyResult,
  legalActions: readonly PokerAction[] = strategy.actions.map(({ action }) => action),
  policy: FrequencyPredictionPolicy = defaultFrequencyPredictionPolicy,
): FrequencyPredictionGrade {
  const referenceRows = completeReferenceFrequencies(strategy);
  const legalKeys = new Set(legalActions.map(actionKey));
  for (const [key, value] of Object.entries(prediction)) {
    if (!legalKeys.has(key) && value !== 0) throw new RangeError(`Prediction contains unknown action ${key}.`);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Predicted frequencies must be in [0, 1].");
  }
  const predictedTotal = legalActions.reduce((sum, action) => sum + (prediction[actionKey(action)] ?? 0), 0);
  if (Math.abs(predictedTotal - 1) > 0.001) throw new RangeError("Predicted frequencies must total 100% within rounding tolerance.");
  const referenceTotal = referenceRows.reduce((sum, { frequency }) => sum + frequency, 0);
  const referenceByKey = new Map(referenceRows.map((row) => [actionKey(row.action), row.frequency / referenceTotal]));
  const actions = legalActions.map((action): FrequencyPredictionActionResult => {
    const predictedFrequency = (prediction[actionKey(action)] ?? 0) / predictedTotal;
    const referenceFrequency = referenceByKey.get(actionKey(action)) ?? 0;
    return { action, predictedFrequency, referenceFrequency, absoluteError: Math.abs(predictedFrequency - referenceFrequency) };
  });
  const totalVariationDistance = actions.reduce((sum, { absoluteError }) => sum + absoluteError, 0) / 2;
  const meanAbsoluteError = actions.length === 0 ? 0 : actions.reduce((sum, { absoluteError }) => sum + absoluteError, 0) / actions.length;
  const maximumAbsoluteError = Math.max(0, ...actions.map(({ absoluteError }) => absoluteError));
  const grade: FrequencyPredictionGrade["grade"] = totalVariationDistance <= policy.excellentMaxDistance
    ? "EXCELLENT MIX"
    : totalVariationDistance <= policy.closeMaxDistance
      ? "CLOSE MIX"
      : totalVariationDistance <= policy.developingMaxDistance
        ? "DEVELOPING MIX"
        : "OFF TARGET";
  return { grade, totalVariationDistance, meanAbsoluteError, maximumAbsoluteError, actions };
}

export function sampleStrategyActionByUnitRoll(strategy: StrategyResult, roll: number): StrategyAction {
  const rows = completeReferenceFrequencies(strategy).filter(({ frequency }) => frequency > 0);
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError("Frequency rollout must be in [0, 1).");
  const total = rows.reduce((sum, { frequency }) => sum + frequency, 0);
  let remaining = roll * total;
  for (const row of rows) {
    remaining -= row.frequency;
    if (remaining < 0) return row;
  }
  const fallback = rows.at(-1);
  if (fallback === undefined) throw new RangeError("Reference has no positive action frequency.");
  return fallback;
}

function aggressionRank(action: PokerAction): number {
  switch (action.kind) {
    case "fold": return 0;
    case "check": return 1;
    case "call": return 2;
    case "bet": return 3_000_000 + action.to;
    case "raise": return 4_000_000 + action.to;
    case "jam": return 9_000_000 + action.to;
  }
}

/**
 * Converts supplied frequencies into integer RNG buckets covering 1–100.
 * Frequencies are normalized because imported solutions commonly contain
 * harmless rounding drift. Missing, incomplete, heuristic, and non-normalized
 * source rows yield no buckets; zero frequencies receive no bucket.
 */
export function partitionStrategyFrequencies(
  strategy: StrategyResult,
  rngMode: Exclude<RngMode, "off">,
  legalActions: readonly PokerAction[] = strategy.actions.map(({ action }) => action),
): readonly RngBucket[] {
  const complete = genuineCompleteReferenceFrequencies(strategy, legalActions);
  if (complete === undefined) return [];
  const available = complete.filter(({ frequency }) => frequency > 0);
  const total = available.reduce((sum, item) => sum + item.frequency, 0);
  const ordered = [...available].sort((left, right) => {
    const difference = aggressionRank(left.action) - aggressionRank(right.action);
    if (difference !== 0) return rngMode === "high" ? difference : -difference;
    return actionKey(left.action).localeCompare(actionKey(right.action));
  });
  let cumulative = 0;
  let previousEnd = 0;
  return ordered.map((item, index) => {
    const normalizedFrequency = item.frequency / total;
    cumulative += normalizedFrequency;
    const end = index === ordered.length - 1 ? 100 : Math.max(previousEnd, Math.min(100, Math.round(cumulative * 100)));
    const bucket = { item, start: previousEnd + 1, end, normalizedFrequency };
    previousEnd = end;
    return bucket;
  }).filter(({ start, end }) => start <= end);
}

/** Selects the policy reference action without looking at action EV. */
export function selectReferenceAction(strategy: StrategyResult, rngMode: RngMode = "off", roll?: number): StrategyAction | undefined {
  const complete = genuineCompleteReferenceFrequencies(strategy);
  if (complete === undefined) return undefined;
  if (rngMode === "off") {
    let selected: (StrategyAction & { readonly frequency: number }) | undefined;
    for (const item of complete) {
      if (selected === undefined || item.frequency > selected.frequency) selected = item;
    }
    return selected;
  }
  if (!Number.isSafeInteger(roll) || roll === undefined || roll < 1 || roll > 100) {
    throw new RangeError("RNG roll must be an integer from 1 through 100");
  }
  return partitionStrategyFrequencies(strategy, rngMode).find(({ start, end }) => roll >= start && roll <= end)?.item;
}

export interface ReferenceSelection {
  readonly rngMode?: RngMode;
  readonly roll?: number;
  /** When supplied, EV grading is permitted only if every issued legal action has an EV. */
  readonly legalActions?: readonly PokerAction[];
}

export function gradeAction(
  chosen: PokerAction,
  strategy: StrategyResult,
  potBeforeDecisionBB: BB,
  policy: GradingPolicy = defaultGradingPolicy,
  referenceSelection: ReferenceSelection = {},
): Grade {
  if (potBeforeDecisionBB <= 0) throw new RangeError("EV-loss grading requires a positive pot before the decision.");
  if (!Number.isFinite(policy.lowFrequencyBoundary) || policy.lowFrequencyBoundary < 0 || policy.lowFrequencyBoundary > 1) {
    throw new RangeError("Low-frequency boundary must be in [0, 1].");
  }
  const orderedLossThresholds = [policy.goodMaxLossPctPot, policy.inaccuracyMaxLossPctPot, policy.mistakeMaxLossPctPot];
  if (orderedLossThresholds.some((value) => !Number.isFinite(value) || value < 0)
    || policy.goodMaxLossPctPot > policy.inaccuracyMaxLossPctPot
    || policy.inaccuracyMaxLossPctPot > policy.mistakeMaxLossPctPot) {
    throw new RangeError("EV-loss grading thresholds must be finite, nonnegative, and ordered.");
  }
  const selected = strategy.actions.find(({ action }) => actionKey(action) === actionKey(chosen));
  if (strategy.provenance === "HEURISTIC") {
    if (selected === undefined) return { mode: "HEURISTIC", grade: "HEURISTIC QUESTIONABLE" };
    return { mode: "HEURISTIC", grade: strategy.actions[0] === selected ? "HEURISTIC BEST" : "HEURISTIC ACCEPTABLE" };
  }

  const expectedActionKeys = (referenceSelection.legalActions ?? strategy.actions.map(({ action }) => action)).map(actionKey);
  const strategyByAction = new Map(strategy.actions.map((item) => [actionKey(item.action), item]));
  const hasCompleteLegalFrequencySet = expectedActionKeys.length > 0
    && expectedActionKeys.every((key) => strategyByAction.get(key)?.frequency !== undefined)
    && Math.abs(expectedActionKeys.reduce((sum, key) => sum + (strategyByAction.get(key)?.frequency ?? 0), 0) - 1) <= 0.001;
  const reference = hasCompleteLegalFrequencySet
    ? selectReferenceAction(strategy, referenceSelection.rngMode ?? "off", referenceSelection.roll)
    : undefined;
  const isReference = reference !== undefined && actionKey(reference.action) === actionKey(chosen);
  const evActions = strategy.actions.filter((item): item is typeof item & { evBB: BB } => item.evBB !== undefined);
  const evByAction = new Map(evActions.map((item) => [actionKey(item.action), item]));
  const hasComparableEvs = selected?.evBB !== undefined
    && expectedActionKeys.length > 0
    && expectedActionKeys.every((key) => evByAction.has(key));
  if (hasComparableEvs && reference !== undefined) {
    const bestEv = Math.max(...expectedActionKeys.map((key) => evByAction.get(key)!.evBB));
    const loss = Math.max(0, bestEv - selected.evBB) as BB;
    const lossPct = (bbToNumber(loss) / bbToNumber(potBeforeDecisionBB)) * 100;
    let grade: Extract<Grade, { mode: "EV" }>["grade"];
    if (isReference) grade = "BEST MOVE";
    else if ((selected.frequency ?? 0) >= policy.lowFrequencyBoundary && lossPct < policy.goodMaxLossPctPot) grade = "GOOD MOVE";
    else if (lossPct <= policy.inaccuracyMaxLossPctPot) grade = "INACCURACY";
    else if (lossPct <= policy.mistakeMaxLossPctPot) grade = "MISTAKE";
    else grade = "BLUNDER";
    return { mode: "EV", grade, evLossBB: loss, evLossPctPot: lossPct, policy };
  }

  if (reference === undefined) return { mode: "REFERENCE_ONLY", grade: "REFERENCE UNAVAILABLE" };
  if (isReference) return { mode: "REFERENCE_ONLY", grade: "REFERENCE ACTION" };
  if (selected === undefined || (selected.frequency ?? 0) === 0) return { mode: "REFERENCE_ONLY", grade: "OUTSIDE REFERENCE" };
  return { mode: "REFERENCE_ONLY", grade: "SUPPORTED MIX" };
}
