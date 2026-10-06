import type { PokerAction } from "../domain/actions";
import type { ActionTreeConfig } from "../domain/actionTree";
import type { Card } from "../domain/cards";
import type { GameConfig } from "../domain/config";
import type { FrequencyPredictionGrade, Grade, GradingPolicy, RngMode } from "../domain/grading";
import type { ExactValue, PotOddsValue } from "../domain/math";
import type { BB } from "../domain/money";
import type { ConditionedRangeResult } from "../domain/comboPolicy";
import type { HandEvaluator } from "../domain/evaluator";
import type { WeightedRange } from "../domain/ranges";
import type { HandSettlementLedger, PokerState, Street } from "../domain/rules";
import type { PlayerCount, SeatId } from "../domain/seats";
import type { StrategyProvider, StrategyResult } from "../domain/strategy";

export type SessionPhase = "INITIALIZING" | "AUTOMATING" | "AWAITING_HERO" | "REVEALED" | "BLOCKED" | "TERMINAL";

export type SessionBlockCode =
  | "IMPOSSIBLE_HOLE_ASSIGNMENT"
  | "MISSING_ACTOR_RANGE"
  | "INCOMPLETE_COMBO_POLICY"
  | "MISSING_HELD_COMBO_ROW"
  | "MISSING_COMBO_POLICY"
  | "INVALID_STRATEGY"
  | "PROVIDER_ERROR"
  | "SETTLEMENT_ERROR"
  | "STATE_INVARIANT";

export interface SessionBlock {
  readonly code: SessionBlockCode;
  readonly reason: string;
}

export type SeatRangeMap = Readonly<Partial<Record<SeatId, WeightedRange>>>;
export type MutableSeatRangeMap = Partial<Record<SeatId, WeightedRange>>;
export type FixedHoleMap = Readonly<Partial<Record<SeatId, readonly [Card, Card]>>>;

export interface SessionRngConfig {
  readonly mode?: RngMode;
  readonly revealRollBeforeAction?: boolean;
}

export interface SessionCommonInput {
  readonly config: GameConfig;
  readonly heroSeatId: SeatId;
  readonly buttonIndex: number;
  readonly actionTree: ActionTreeConfig;
  readonly strategyProvider: StrategyProvider;
  readonly seed: number;
  /** Public range priors. These are sent to the provider and must not encode private fixed cards implicitly. */
  readonly ranges: SeatRangeMap;
  /** Optional private assignments. Every remaining seat must have a positive-mass public range for sampling. */
  readonly fixedHoleCards?: FixedHoleMap;
  readonly deadCards?: readonly Card[];
  readonly futureBoard?: readonly Card[];
  readonly maxAssignmentAttempts?: number;
  readonly gradingPolicy?: GradingPolicy;
  readonly rng?: SessionRngConfig;
  readonly evaluator?: HandEvaluator;
}

export interface FullHandInput extends SessionCommonInput {}

/** A state already reconstructed and validated by PokerRulesEngine. */
export interface PreparedStateInput extends SessionCommonInput {
  readonly state: PokerState;
}

export interface NodeExpectation {
  readonly actor: SeatId | null;
  readonly street: Street;
  readonly board: readonly Card[];
  readonly potBB: BB;
  readonly currentBetBB: BB;
}

export type PreflopLine = "RFI" | "vs-limp" | "vs-open" | "squeeze" | "vs-3-bet" | "vs-4-bet" | "vs-shove" | "blind-vs-blind" | "multiway";
export type PotType = "limped" | "SRP" | "3-bet" | "4-bet" | "5-bet" | "multiway";

export interface ScenarioSourceTags {
  readonly preflopLine: PreflopLine;
  readonly potType: PotType;
  /** Strategic classes are source-authored; the catalog never infers them. */
  readonly strategicClasses?: readonly string[];
}

export interface NodeScenarioDefinition extends SessionCommonInput {
  readonly id: string;
  /** Human-readable drill metadata, never solver evidence or a strategic verdict. */
  readonly presentation?: {
    readonly title: string;
    readonly family: string;
    readonly rangeAssumption: string;
    readonly rangeProfile?: "focused" | "broad";
  };
  readonly replay: readonly PokerAction[];
  readonly expected: NodeExpectation;
  readonly sourceTags: ScenarioSourceTags;
}

export interface DecisionMath {
  /** Gross immutable contribution ledger; retained for EV-loss-as-%-of-pot grading. */
  readonly potAtDecisionBB: BB;
  /** Raw pre-rake pot this actor can win after making the capped call. */
  readonly contestablePotAtDecisionBB: BB;
  readonly excludedFromActorContestBB: BB;
  readonly amountToCallBB: BB;
  /** A labeled summary only; use perOpponent for multiway decisions. */
  readonly effectiveStackBB: BB;
  readonly effectiveStackBasis: "HEADS_UP" | "SHORTEST_WAGER_CAPABLE_OPPONENT" | "ALL_OPPONENTS_ALL_IN" | "NO_LIVE_OPPONENT";
  readonly selectedOpponentSeatId?: SeatId;
  readonly perOpponent: readonly {
    readonly seatId: SeatId;
    readonly effectiveStackBB: BB;
    readonly wagerCapable: boolean;
    readonly currentSPR?: ExactValue;
  }[];
  readonly potOdds?: PotOddsValue;
  readonly potOddsBasis?: "RAW_PRE_RAKE_CONTESTABLE_POT";
  readonly rakeAdjustedPotOdds?: PotOddsValue;
  readonly projectedRakeIfNoFurtherBettingBB?: BB;
  readonly rakeAdjustedPotOddsBasis?: "HEADS_UP_CLOSING_CALL_NO_FURTHER_BETTING";
  readonly potOddsCaveats: readonly string[];
  readonly currentSPR?: ExactValue;
}

export interface RngPublicState {
  readonly mode: RngMode;
  readonly available: boolean;
  readonly cursor: number;
  readonly roll?: number;
  readonly hiddenRoll: boolean;
}

export interface HeroReveal {
  readonly chosenAction: PokerAction;
  readonly grade: Grade;
  readonly strategy: StrategyResult;
  readonly decisionMath: DecisionMath;
  readonly rangeConditioning?: ConditionedRangeResult;
  /** Public priors at the decision, captured before Hero's submitted action is observed. */
  readonly publicRangesAtDecision: SeatRangeMap;
  /** Public ranges after conditioning on Hero's submitted action. */
  readonly publicRangesAfterHeroAction: SeatRangeMap;
  /** @deprecated Compatibility alias for publicRangesAfterHeroAction. */
  readonly publicRanges?: SeatRangeMap;
  /** Publicly declared dead cards; private deck and future-board cards remain concealed. */
  readonly publicDeadCards: readonly Card[];
  readonly rngRoll?: number;
  readonly frequencyPrediction?: FrequencyPredictionGrade & {
    /** Source-supported action sampled only to advance the same hand. */
    readonly rolloutAction: PokerAction;
    readonly rolloutRoll: number;
  };
}

export interface DrillSnapshot {
  readonly phase: SessionPhase;
  readonly heroSeatId: SeatId;
  /** Deck and future board are always redacted; opponent cards follow terminal reveal rules. */
  readonly state: PokerState | null;
  readonly legalActions: readonly PokerAction[];
  /** True only when the exact held-combo row has a complete solved/interpolated mix. */
  readonly mixPredictionAvailable: boolean;
  readonly decisionMath?: DecisionMath;
  readonly rng: RngPublicState;
  readonly blocked?: SessionBlock;
  readonly reveal?: HeroReveal;
  readonly settlement?: HandSettlementLedger;
}

export interface HeroSubmissionResult {
  readonly accepted: boolean;
  readonly snapshot: DrillSnapshot;
  readonly reason?: string;
}

export type StackFilter =
  | { readonly mode: "fixed"; readonly stackBB: BB }
  | { readonly mode: "per-player"; readonly stacksBB: Readonly<Record<SeatId, BB>> };

export interface ScenarioFilter {
  readonly scenarioId?: string;
  readonly tableSize?: PlayerCount;
  readonly heroPosition?: string;
  readonly opponentPosition?: string;
  readonly stack?: StackFilter;
  readonly street?: Street;
  readonly playersCurrentlyInPot?: number;
  readonly preflopLine?: PreflopLine;
  readonly potType?: PotType;
  readonly exactBoard?: readonly Card[];
  readonly requiredBoardCards?: readonly Card[];
  readonly boardTexture?: string;
  readonly heroHandClass?: string;
  readonly drawClass?: string;
  readonly strategicClass?: string;
}

export interface ScenarioFacts {
  readonly id: string;
  readonly tableSize: PlayerCount;
  readonly heroPosition: string;
  readonly opponentPositions: readonly string[];
  readonly stack: StackFilter;
  readonly street: Street;
  readonly playersCurrentlyInPot: number;
  readonly preflopLine: PreflopLine;
  readonly potType: PotType;
  readonly board: readonly Card[];
  readonly boardTextures: readonly string[];
  readonly heroHandClass?: string;
  readonly drawClasses: readonly string[];
  readonly strategicClasses: readonly string[];
}

export interface ScenarioCatalogMatch {
  readonly definition: NodeScenarioDefinition;
  readonly facts: ScenarioFacts;
}
