import type { PokerAction } from "../domain/actions";
import type { Card } from "../domain/cards";
import type { ExactValue, PotOddsValue } from "../domain/math";
import type { BB } from "../domain/money";
import type { RngMode } from "../domain/grading";
import type { ComboId, WeightedRange } from "../domain/ranges";
import type { PokerState } from "../domain/rules";
import type { SeatId } from "../domain/seats";
import type { StrategyAction, StrategyProvenance, StrategyResult } from "../domain/strategy";
import type { DecisionMath } from "../session/types";

export type ExplanationProvenance = StrategyProvenance | "UNAVAILABLE";

export interface ExplanationStatement {
  readonly provenance: ExplanationProvenance;
  readonly text: string;
}

export type EvidenceCoverage = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface ExplanationInput {
  readonly state: PokerState;
  readonly heroSeatId: SeatId;
  readonly legalActions: readonly PokerAction[];
  readonly chosenAction: PokerAction;
  readonly strategy: StrategyResult;
  readonly decisionMath: DecisionMath;
  /** The post-answer reference policy. High/low modes require the revealed 1–100 roll. */
  readonly referenceSelection?: {
    readonly rngMode: RngMode;
    readonly roll?: number;
  };
  /** Public priors/posteriors only. Private sampled opponent cards do not belong here. */
  readonly publicRanges?: Readonly<Partial<Record<SeatId, WeightedRange>>>;
  /** Publicly known dead cards. `state.deck` and `state.futureBoard` are deliberately ignored. */
  readonly deadCards?: readonly Card[];
}

export interface VerdictEvidence {
  readonly provenance: ExplanationProvenance;
  readonly chosenAction: PokerAction;
  readonly chosenSourceAction?: StrategyAction;
  readonly frequencyCoverage: EvidenceCoverage;
  readonly evCoverage: EvidenceCoverage;
  readonly referenceAction?: StrategyAction;
  /** Exists only when every issued legal action and the chosen action have source EV. */
  readonly evLossBB?: BB;
  readonly statements: readonly ExplanationStatement[];
}

export interface ActionRationale {
  readonly action: PokerAction;
  readonly statements: readonly ExplanationStatement[];
}

export interface SizingRationale {
  readonly applies: boolean;
  readonly statements: readonly ExplanationStatement[];
}

export interface BlockedComboDetail {
  readonly seatId: SeatId;
  readonly comboId: ComboId;
  readonly cards: readonly [Card, Card];
  readonly weight: number;
  readonly blockedBy: readonly Card[];
}

export interface HeroCardRemovalDetail {
  readonly card: Card;
  readonly sameRankBoardCards: readonly Card[];
  readonly sameSuitBoardCards: readonly Card[];
  readonly blockedCombos: readonly BlockedComboDetail[];
  readonly blockedComboCount?: number;
  readonly blockedWeightedMass?: number;
  readonly statements: readonly ExplanationStatement[];
}

export interface OpponentRangeRemovalSummary {
  readonly seatId: SeatId;
  readonly suppliedComboCount: number;
  readonly suppliedWeightedMass: number;
  readonly removedByHeroComboCount: number;
  readonly removedByHeroWeightedMass: number;
  readonly removedByBoardComboCount: number;
  readonly removedByBoardWeightedMass: number;
  readonly removedByAnyKnownCardComboCount: number;
  readonly removedByAnyKnownCardWeightedMass: number;
}

export interface BlockerExplanation {
  readonly provenance: "EXACT_MATH" | "UNAVAILABLE";
  readonly knownCards: readonly Card[];
  readonly heroCards: readonly HeroCardRemovalDetail[];
  readonly opponentRangeCoverage: EvidenceCoverage;
  readonly blockedCombos: readonly BlockedComboDetail[];
  readonly rangeRemoval: readonly OpponentRangeRemovalSummary[];
  readonly strategicNetEffect: readonly ExplanationStatement[];
}

export interface AlternativeExplanation {
  readonly action: PokerAction;
  readonly sourceAction?: StrategyAction;
  readonly statements: readonly ExplanationStatement[];
}

export interface MultiwayExplanation {
  readonly applies: boolean;
  readonly liveOpponentCount: number;
  readonly statements: readonly ExplanationStatement[];
}

export type MathPanelId =
  | "POT_ODDS"
  | "RAKE_ADJUSTED_POT_ODDS"
  | "CURRENT_SPR"
  | "BLUFF_BREAK_EVEN"
  | "HEADS_UP_MDF"
  | "RIVER_POLARIZED_BLUFF_FRACTION"
  | "RIVER_BLUFF_TO_VALUE";

export interface ExactMathPanel {
  readonly id: MathPanelId;
  readonly provenance: "EXACT_MATH";
  readonly label: string;
  readonly value: ExactValue | PotOddsValue;
  readonly appliesTo: "HERO_DECISION" | "FACING_FIRST_BET" | "CHOSEN_FIRST_BET";
  readonly assumptions: readonly string[];
}

export type FutureCardTag =
  | "IMPROVES_HAND_SCORE"
  | "IMPROVES_HAND_CATEGORY"
  | "PAIRS_BOARD"
  | "COMPLETES_HERO_FLUSH"
  | "ADDS_HERO_FLUSH_DRAW"
  | "CHANGES_BOARD_FLUSH_STRUCTURE"
  | "COMPLETES_HERO_STRAIGHT"
  | "ADDS_GUTSHOT"
  | "ADDS_OPEN_ENDED_STRAIGHT_DRAW"
  | "CHANGES_BOARD_STRAIGHT_STRUCTURE"
  | "NO_LISTED_CHANGE";

export interface FutureCardDetail {
  readonly card: Card;
  readonly tags: readonly FutureCardTag[];
  readonly handCategoryBefore?: string;
  readonly handCategoryAfter?: string;
}

export interface FutureStreetPlan {
  readonly provenance: "EXACT_MATH" | "UNAVAILABLE";
  readonly cardsToCome: number;
  readonly unseenCardCount: number;
  readonly cards: readonly FutureCardDetail[];
  readonly byTag: Readonly<Record<FutureCardTag, readonly Card[]>>;
  readonly statements: readonly ExplanationStatement[];
}

export interface RuleOfThumb {
  readonly provenance: "HEURISTIC";
  readonly rule: string;
  readonly exception: string;
}

export interface ExplanationModel {
  readonly verdict: VerdictEvidence;
  readonly actionRationale: ActionRationale;
  readonly sizingRationale: SizingRationale;
  readonly blockers: BlockerExplanation;
  readonly alternatives: readonly AlternativeExplanation[];
  readonly multiway: MultiwayExplanation;
  readonly exactMath: readonly ExactMathPanel[];
  readonly futureStreet: FutureStreetPlan;
  readonly ruleOfThumb: RuleOfThumb;
}
