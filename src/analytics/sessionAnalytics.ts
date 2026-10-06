import { actionKey, type PokerAction } from "../domain/actions";
import { actionEconomics } from "../domain/economics";
import { customSevenCardEvaluator } from "../domain/evaluator";
import type { FrequencyPredictionGrade, Grade } from "../domain/grading";
import { bbToNumber } from "../domain/money";
import type { PokerState, Street } from "../domain/rules";
import { positionLabel, seatIndex, type SeatId } from "../domain/seats";
import type { StrategyResult } from "../domain/strategy";
import { selectScenarioForReview } from "../session/reviewSelection";
import type { ScenarioCatalogMatch } from "../session/types";
import type { DecisionMath } from "../session/types";

export const ANALYTICS_SCHEMA_VERSION = 2;
export const ANALYTICS_STORAGE_KEY = "hand-compass-session-analytics-v1";

export type ConceptTag =
  | "PREFLOP_UNOPENED_OR_LIMPED_POT"
  | "PREFLOP_FACING_AGGRESSION"
  | "BLIND_VS_LATE_POSITION_DEFENSE"
  | "MULTIWAY_DISCIPLINE"
  | "FACING_SMALL_BET"
  | "FACING_LARGE_BET"
  | "FACING_RAISE"
  | "AGGRESSIVE_SIZING"
  | "OVERBET_CONSTRUCTION"
  | "LOW_SPR_COMMITMENT"
  | "RIVER_POLARIZATION"
  | "GENERAL_DECISION_QUALITY";

export type AnalyticsPotType = "limped" | "SRP" | "3-bet" | "4-bet" | "5-bet" | "multiway";

export interface DecisionRecord {
  readonly id: string;
  readonly handId: string;
  readonly decidedAt: string;
  readonly street: Street;
  readonly heroPosition: string;
  readonly opponentPositions: readonly string[];
  readonly playerCount: number;
  readonly playersInPot: number;
  readonly potType: AnalyticsPotType;
  readonly effectiveStackBB: number;
  readonly stackBucket: string;
  readonly handClass: string;
  readonly sizingBucket: string;
  readonly potBB: number;
  readonly chosenActionKey: string;
  readonly chosenActionFamily: PokerAction["kind"];
  readonly provenance: StrategyResult["provenance"];
  readonly gradeMode: Grade["mode"];
  readonly grade: Grade["grade"];
  readonly success: boolean;
  readonly evLossBB?: number;
  readonly evLossPctPot?: number;
  readonly chosenFrequency?: number;
  readonly frequencyDeviation?: number;
  readonly conceptTags: readonly ConceptTag[];
}

export interface FrequencyPredictionRecord {
  readonly id: string;
  readonly handId: string;
  readonly decidedAt: string;
  readonly street: Street;
  readonly heroPosition: string;
  readonly playerCount: number;
  readonly playersInPot: number;
  readonly potType: AnalyticsPotType;
  readonly stackBucket: string;
  readonly handClass: string;
  readonly provenance: "SOLVED" | "INTERPOLATED";
  readonly grade: FrequencyPredictionGrade["grade"];
  readonly success: boolean;
  readonly totalVariationDistance: number;
  readonly meanAbsoluteError: number;
  readonly maximumAbsoluteError: number;
}

export interface ConceptReviewState {
  readonly tag: ConceptTag;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly streak: number;
  readonly nextDueDecision: number;
  readonly samplingWeight: number;
  readonly lastGrade: Grade["grade"];
}

export interface AnalyticsScenarioReviewSelectionInput {
  readonly matches: readonly ScenarioCatalogMatch[];
  readonly analytics: SessionAnalyticsState;
  readonly seed: number;
  /** Source-authored concept tags for each validated match. */
  readonly conceptTagsForMatch?: (match: ScenarioCatalogMatch) => readonly ConceptTag[];
}

export interface SessionAnalyticsState {
  readonly schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  readonly handsStarted: number;
  readonly records: readonly DecisionRecord[];
  readonly frequencyPredictions: readonly FrequencyPredictionRecord[];
  readonly concepts: Readonly<Partial<Record<ConceptTag, ConceptReviewState>>>;
}

export interface RecordFrequencyPredictionInput {
  readonly handId: string;
  readonly state: PokerState;
  readonly heroSeatId: SeatId;
  readonly grade: FrequencyPredictionGrade;
  readonly provenance: "SOLVED" | "INTERPOLATED";
  readonly decisionMath: DecisionMath;
  readonly decidedAt?: Date;
}

export interface RecordDecisionInput {
  readonly handId: string;
  readonly state: PokerState;
  readonly heroSeatId: SeatId;
  readonly chosenAction: PokerAction;
  readonly grade: Grade;
  readonly strategy: StrategyResult;
  readonly decisionMath: DecisionMath;
  readonly decidedAt?: Date;
}

export interface AnalyticsSummary {
  readonly handsStarted: number;
  readonly totalDecisions: number;
  readonly gradeCounts: Readonly<Record<string, number>>;
  readonly evKnownDecisions: number;
  readonly totalEvLossBB?: number;
  readonly averageEvLossPerDecisionBB?: number;
  readonly averageEvLossPerHandBB?: number;
  readonly averageEvLossPctPot?: number;
  readonly frequencyKnownDecisions: number;
  readonly averageFrequencyDeviation?: number;
  readonly byStreet: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly byPosition: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly byPotType: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly byActionFamily: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly byStackDepth: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly byHandClass: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly bySizing: Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>>;
  readonly frequencyPredictionCount: number;
  readonly averageMixDistance?: number;
  readonly mixByStreet: Readonly<Record<string, { readonly attempts: number; readonly meanDistance: number }>>;
  readonly mixByPosition: Readonly<Record<string, { readonly attempts: number; readonly meanDistance: number }>>;
  readonly dueConcepts: readonly ConceptReviewState[];
}

export interface LeakReport {
  readonly available: boolean;
  readonly reason?: string;
  readonly dimension?: "position" | "street" | "potType" | "actionFamily" | "stackDepth" | "handClass" | "sizing";
  readonly group?: string;
  readonly decisions?: number;
  readonly evLossBB?: number;
  readonly averageEvLossBB?: number;
}

export function emptySessionAnalytics(): SessionAnalyticsState {
  return { schemaVersion: ANALYTICS_SCHEMA_VERSION, handsStarted: 0, records: [], frequencyPredictions: [], concepts: {} };
}

export function startAnalyticsHand(state: SessionAnalyticsState): SessionAnalyticsState {
  return { ...state, handsStarted: state.handsStarted + 1 };
}

/** Bridges persisted concept review state to the deterministic catalog selector. */
export function selectScenarioForAnalyticsReview(input: AnalyticsScenarioReviewSelectionInput): ScenarioCatalogMatch | undefined {
  const conceptReviews = Object.values(input.analytics.concepts).filter((review): review is ConceptReviewState => review !== undefined);
  return selectScenarioForReview(input.matches, {
    seed: input.seed,
    currentDecision: input.analytics.records.length,
    conceptReviews,
    ...(input.conceptTagsForMatch === undefined ? {} : { conceptTagsForMatch: input.conceptTagsForMatch }),
  });
}

function preflopAggressionCount(state: PokerState): number {
  return state.actionHistory.filter(({ street, action }) => street === "preflop" && (action.kind === "raise" || action.kind === "jam")).length;
}

export function inferPotType(state: PokerState): AnalyticsPotType {
  const playersInPot = state.players.filter(({ status }) => status !== "folded").length;
  if (playersInPot > 2) return "multiway";
  const aggression = preflopAggressionCount(state);
  if (aggression === 0) return "limped";
  if (aggression === 1) return "SRP";
  if (aggression === 2) return "3-bet";
  if (aggression === 3) return "4-bet";
  return "5-bet";
}

function stackBucket(stackBB: number): string {
  if (stackBB <= 15) return "≤15 BB";
  if (stackBB <= 30) return "16–30 BB";
  if (stackBB <= 50) return "31–50 BB";
  if (stackBB <= 100) return "51–100 BB";
  return ">100 BB";
}

const HAND_CLASS_LABELS: Readonly<Record<ReturnType<typeof customSevenCardEvaluator.evaluate>["category"], string>> = {
  "high-card": "High card",
  pair: "Pair",
  "two-pair": "Two pair",
  trips: "Trips",
  straight: "Straight",
  flush: "Flush",
  "full-house": "Full house",
  quads: "Quads",
  "straight-flush": "Straight flush",
};

function handClass(state: PokerState, heroSeatId: SeatId): string {
  if (state.board.length < 3) return "Preflop";
  const cards = state.players.find(({ id }) => id === heroSeatId)?.holeCards;
  if (cards === undefined) return "Unknown";
  return HAND_CLASS_LABELS[customSevenCardEvaluator.evaluate([...cards, ...state.board]).category];
}

function sizingBucket(state: PokerState, action: PokerAction): string {
  if (action.kind === "fold" || action.kind === "check" || action.kind === "call") return action.kind[0]!.toUpperCase() + action.kind.slice(1);
  if (action.kind === "jam") return "Jam";
  const fraction = actionEconomics(state, action).raiseFractionOfPotAfterCall;
  if (fraction === undefined) return "Aggressive · unknown fraction";
  if (fraction <= 0.33) return "Aggressive · ≤33% pot";
  if (fraction <= 0.66) return "Aggressive · 34–66% pot";
  if (fraction <= 1) return "Aggressive · 67–100% pot";
  return "Aggressive · overbet";
}

function gradeSucceeded(grade: Grade): boolean {
  if (grade.mode === "EV") return grade.grade === "BEST MOVE" || grade.grade === "GOOD MOVE";
  if (grade.mode === "HEURISTIC") return grade.grade !== "HEURISTIC QUESTIONABLE";
  return grade.grade === "REFERENCE ACTION" || grade.grade === "SUPPORTED MIX";
}

function sourceFrequency(strategy: StrategyResult, chosenAction: PokerAction): number | undefined {
  const legalRows = strategy.actions;
  if (legalRows.length === 0 || legalRows.some(({ frequency }) => frequency === undefined)) return undefined;
  return legalRows.find(({ action }) => actionKey(action) === actionKey(chosenAction))?.frequency;
}

export function conceptTagsForDecision(input: Omit<RecordDecisionInput, "handId" | "decidedAt">): readonly ConceptTag[] {
  const { state, heroSeatId, chosenAction, decisionMath } = input;
  const tags = new Set<ConceptTag>();
  const heroPosition = positionLabel(seatIndex(heroSeatId), state.buttonIndex, state.config.playerCount);
  const aggression = preflopAggressionCount(state);
  if (state.street === "preflop") tags.add(aggression === 0 ? "PREFLOP_UNOPENED_OR_LIMPED_POT" : "PREFLOP_FACING_AGGRESSION");
  if ((heroPosition === "BB" || heroPosition === "SB") && state.players.some((player) => {
    if (player.id === heroSeatId || player.status === "folded") return false;
    const position = positionLabel(seatIndex(player.id), state.buttonIndex, state.config.playerCount);
    return position === "BTN" || position === "CO";
  })) tags.add("BLIND_VS_LATE_POSITION_DEFENSE");
  if (state.players.filter(({ status }) => status !== "folded").length > 2) tags.add("MULTIWAY_DISCIPLINE");
  const latestBet = [...state.actionHistory].reverse().find(({ street, action }) => street === state.street && (action.kind === "bet" || action.kind === "raise" || action.kind === "jam"));
  if (latestBet !== undefined && decisionMath.amountToCallBB > 0) {
    if (latestBet.action.kind === "bet") {
      const before = latestBet.potAfterBB - latestBet.action.to;
      if (before > 0 && latestBet.action.to / before <= 0.5) tags.add("FACING_SMALL_BET");
      else tags.add("FACING_LARGE_BET");
    } else {
      tags.add("FACING_RAISE");
    }
  }
  if (chosenAction.kind === "bet" || chosenAction.kind === "raise" || chosenAction.kind === "jam") {
    tags.add("AGGRESSIVE_SIZING");
    if ((actionEconomics(state, chosenAction).raiseFractionOfPotAfterCall ?? 0) > 1) tags.add("OVERBET_CONSTRUCTION");
  }
  if ((decisionMath.currentSPR?.value ?? Number.POSITIVE_INFINITY) <= 2) tags.add("LOW_SPR_COMMITMENT");
  if (state.street === "river") tags.add("RIVER_POLARIZATION");
  if (tags.size === 0) tags.add("GENERAL_DECISION_QUALITY");
  return [...tags];
}

function updateConcept(previous: ConceptReviewState | undefined, tag: ConceptTag, success: boolean, grade: Grade["grade"], decisionNumber: number): ConceptReviewState {
  const attempts = (previous?.attempts ?? 0) + 1;
  const successes = (previous?.successes ?? 0) + (success ? 1 : 0);
  const failures = (previous?.failures ?? 0) + (success ? 0 : 1);
  const streak = success ? (previous?.streak ?? 0) + 1 : 0;
  const interval = success ? [1, 3, 7, 15, 30][Math.min(streak - 1, 4)] ?? 30 : 1;
  const samplingWeight = Math.min(8, Number((1 + failures * 1.5 + (success ? 0 : 2) - streak * 0.2).toFixed(2)));
  return { tag, attempts, successes, failures, streak, nextDueDecision: decisionNumber + interval, samplingWeight: Math.max(0.5, samplingWeight), lastGrade: grade };
}

export function recordDecision(state: SessionAnalyticsState, input: RecordDecisionInput): SessionAnalyticsState {
  const heroPosition = positionLabel(seatIndex(input.heroSeatId), input.state.buttonIndex, input.state.config.playerCount);
  const opponents = input.state.players
    .filter(({ id, status }) => id !== input.heroSeatId && status !== "folded")
    .map(({ id }) => positionLabel(seatIndex(id), input.state.buttonIndex, input.state.config.playerCount));
  const chosenFrequency = sourceFrequency(input.strategy, input.chosenAction);
  const success = gradeSucceeded(input.grade);
  const conceptTags = conceptTagsForDecision(input);
  const record: DecisionRecord = {
    id: `${input.handId}:${state.records.length + 1}`,
    handId: input.handId,
    decidedAt: (input.decidedAt ?? new Date()).toISOString(),
    street: input.state.street,
    heroPosition,
    opponentPositions: opponents,
    playerCount: input.state.config.playerCount,
    playersInPot: opponents.length + 1,
    potType: inferPotType(input.state),
    effectiveStackBB: bbToNumber(input.decisionMath.effectiveStackBB),
    stackBucket: stackBucket(bbToNumber(input.decisionMath.effectiveStackBB)),
    handClass: handClass(input.state, input.heroSeatId),
    sizingBucket: sizingBucket(input.state, input.chosenAction),
    potBB: bbToNumber(input.decisionMath.potAtDecisionBB),
    chosenActionKey: actionKey(input.chosenAction),
    chosenActionFamily: input.chosenAction.kind,
    provenance: input.strategy.provenance,
    gradeMode: input.grade.mode,
    grade: input.grade.grade,
    success,
    ...(input.grade.mode === "EV" ? { evLossBB: bbToNumber(input.grade.evLossBB), evLossPctPot: input.grade.evLossPctPot } : {}),
    ...(chosenFrequency === undefined ? {} : { chosenFrequency, frequencyDeviation: 1 - chosenFrequency }),
    conceptTags,
  };
  const decisionNumber = state.records.length + 1;
  const concepts = { ...state.concepts };
  for (const tag of conceptTags) concepts[tag] = updateConcept(concepts[tag], tag, success, input.grade.grade, decisionNumber);
  return { ...state, records: [...state.records, record], concepts };
}

/** Records the user's distribution estimate itself; the sampled rollout action is intentionally absent. */
export function recordFrequencyPrediction(state: SessionAnalyticsState, input: RecordFrequencyPredictionInput): SessionAnalyticsState {
  const previousPredictions = state.frequencyPredictions ?? [];
  const heroPosition = positionLabel(seatIndex(input.heroSeatId), input.state.buttonIndex, input.state.config.playerCount);
  const playersInPot = input.state.players.filter(({ status }) => status !== "folded").length;
  const record: FrequencyPredictionRecord = {
    id: `${input.handId}:mix:${previousPredictions.length + 1}`,
    handId: input.handId,
    decidedAt: (input.decidedAt ?? new Date()).toISOString(),
    street: input.state.street,
    heroPosition,
    playerCount: input.state.config.playerCount,
    playersInPot,
    potType: inferPotType(input.state),
    stackBucket: stackBucket(bbToNumber(input.decisionMath.effectiveStackBB)),
    handClass: handClass(input.state, input.heroSeatId),
    provenance: input.provenance,
    grade: input.grade.grade,
    success: input.grade.grade === "EXCELLENT MIX" || input.grade.grade === "CLOSE MIX",
    totalVariationDistance: input.grade.totalVariationDistance,
    meanAbsoluteError: input.grade.meanAbsoluteError,
    maximumAbsoluteError: input.grade.maximumAbsoluteError,
  };
  return { ...state, frequencyPredictions: [...previousPredictions, record] };
}

function grouped(records: readonly DecisionRecord[], keyOf: (record: DecisionRecord) => string): Readonly<Record<string, { readonly decisions: number; readonly evKnown: number; readonly evLossBB: number }>> {
  const output: Record<string, { decisions: number; evKnown: number; evLossBB: number }> = {};
  for (const record of records) {
    const key = keyOf(record);
    const current = output[key] ?? { decisions: 0, evKnown: 0, evLossBB: 0 };
    output[key] = {
      decisions: current.decisions + 1,
      evKnown: current.evKnown + (record.evLossBB === undefined ? 0 : 1),
      evLossBB: current.evLossBB + (record.evLossBB ?? 0),
    };
  }
  return output;
}

function groupedMix(records: readonly FrequencyPredictionRecord[], keyOf: (record: FrequencyPredictionRecord) => string): Readonly<Record<string, { readonly attempts: number; readonly meanDistance: number }>> {
  const totals: Record<string, { attempts: number; distance: number }> = {};
  for (const record of records) {
    const key = keyOf(record);
    const current = totals[key] ?? { attempts: 0, distance: 0 };
    totals[key] = { attempts: current.attempts + 1, distance: current.distance + record.totalVariationDistance };
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, { attempts: value.attempts, meanDistance: value.distance / value.attempts }]));
}

export function summarizeAnalytics(state: SessionAnalyticsState): AnalyticsSummary {
  const frequencyPredictions = state.frequencyPredictions ?? [];
  const evRecords = state.records.filter((record): record is DecisionRecord & { evLossBB: number; evLossPctPot: number } => record.evLossBB !== undefined && record.evLossPctPot !== undefined);
  const frequencyRecords = state.records.filter((record): record is DecisionRecord & { frequencyDeviation: number } => record.frequencyDeviation !== undefined);
  const totalEvLossBB = evRecords.reduce((sum, record) => sum + record.evLossBB, 0);
  const gradeCounts: Record<string, number> = {};
  for (const record of state.records) gradeCounts[record.grade] = (gradeCounts[record.grade] ?? 0) + 1;
  return {
    handsStarted: state.handsStarted,
    totalDecisions: state.records.length,
    gradeCounts,
    evKnownDecisions: evRecords.length,
    ...(evRecords.length === 0 ? {} : {
      totalEvLossBB,
      averageEvLossPerDecisionBB: totalEvLossBB / evRecords.length,
      averageEvLossPerHandBB: totalEvLossBB / Math.max(1, new Set(evRecords.map(({ handId }) => handId)).size),
      averageEvLossPctPot: evRecords.reduce((sum, record) => sum + record.evLossPctPot, 0) / evRecords.length,
    }),
    frequencyKnownDecisions: frequencyRecords.length,
    ...(frequencyRecords.length === 0 ? {} : { averageFrequencyDeviation: frequencyRecords.reduce((sum, record) => sum + record.frequencyDeviation, 0) / frequencyRecords.length }),
    byStreet: grouped(state.records, ({ street }) => street),
    byPosition: grouped(state.records, ({ heroPosition }) => heroPosition),
    byPotType: grouped(state.records, ({ potType }) => potType),
    byActionFamily: grouped(state.records, ({ chosenActionFamily }) => chosenActionFamily),
    byStackDepth: grouped(state.records, ({ stackBucket }) => stackBucket),
    byHandClass: grouped(state.records, ({ handClass: value }) => value),
    bySizing: grouped(state.records, ({ sizingBucket: value }) => value),
    frequencyPredictionCount: frequencyPredictions.length,
    ...(frequencyPredictions.length === 0 ? {} : { averageMixDistance: frequencyPredictions.reduce((sum, record) => sum + record.totalVariationDistance, 0) / frequencyPredictions.length }),
    mixByStreet: groupedMix(frequencyPredictions, ({ street }) => street),
    mixByPosition: groupedMix(frequencyPredictions, ({ heroPosition }) => heroPosition),
    dueConcepts: Object.values(state.concepts).filter((item): item is ConceptReviewState => item !== undefined && item.nextDueDecision <= state.records.length).sort((left, right) => right.samplingWeight - left.samplingWeight),
  };
}

export function largestLeak(state: SessionAnalyticsState, minimumEvSample = 5): LeakReport {
  const summary = summarizeAnalytics(state);
  const candidates = ([
    ["position", summary.byPosition],
    ["street", summary.byStreet],
    ["potType", summary.byPotType],
    ["actionFamily", summary.byActionFamily],
    ["stackDepth", summary.byStackDepth],
    ["handClass", summary.byHandClass],
    ["sizing", summary.bySizing],
  ] as const).flatMap(([dimension, groups]) => Object.entries(groups).filter(([, value]) => value.evKnown >= minimumEvSample).map(([group, value]) => ({ dimension, group, ...value })));
  if (candidates.length === 0) return { available: false, reason: `At least ${minimumEvSample} EV-backed decisions in one group are required before naming a leak.` };
  const worst = candidates.reduce((left, right) => right.evLossBB > left.evLossBB ? right : left);
  return { available: true, dimension: worst.dimension, group: worst.group, decisions: worst.evKnown, evLossBB: worst.evLossBB, averageEvLossBB: worst.evLossBB / worst.evKnown };
}

export function parseSessionAnalytics(serialized: string | null): SessionAnalyticsState {
  if (serialized === null) return emptySessionAnalytics();
  try {
    const raw = JSON.parse(serialized) as { readonly schemaVersion?: unknown; readonly handsStarted?: unknown; readonly records?: unknown; readonly concepts?: unknown };
    if ((raw.schemaVersion !== 1 && raw.schemaVersion !== ANALYTICS_SCHEMA_VERSION) || !Number.isSafeInteger(raw.handsStarted) || !Array.isArray(raw.records) || raw.concepts === null || typeof raw.concepts !== "object") {
      return emptySessionAnalytics();
    }
    const value = raw as unknown as Partial<SessionAnalyticsState>;
    return {
      ...(value as unknown as SessionAnalyticsState),
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      frequencyPredictions: Array.isArray((value as Partial<SessionAnalyticsState>).frequencyPredictions) ? (value as Partial<SessionAnalyticsState>).frequencyPredictions! : [],
    };
  } catch {
    return emptySessionAnalytics();
  }
}
