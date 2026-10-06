import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import {
  type Card,
  currentSpr,
  formatBB,
  type LegalAction,
  flopStartSpr,
  toTrainerState,
  type TrainerState,
} from "./trainerModel";
import { actionKey } from "../domain/actions";
import { card as domainCard, type Card as DomainCard } from "../domain/cards";
import { bb, bbToNumber } from "../domain/money";
import { comboId, type WeightedRange } from "../domain/ranges";
import { defaultGradingPolicy, partitionStrategyFrequencies, type Grade, type RngBucket } from "../domain/grading";
import type { RegisteredStrategyProvider } from "../domain/providerRegistry";
import type { StrategyResult } from "../domain/strategy";
import type { DecisionMath, DrillSnapshot, ScenarioFilter } from "../session/types";
import {
  countCompatibleScenarios,
  BUNDLED_SOLVED_PROVIDER_ID,
  configureAndProbeLocalSolver,
  createAcceptanceProviderRegistry,
  createCustomSpotSession,
  createTrainerSession,
  DEFAULT_FULL_HAND_OPTIONS,
  DEFAULT_LOCAL_SOLVER_ENDPOINT,
  EDUCATIONAL_PROVIDER_ID,
  LOCAL_SOLVER_PROVIDER_ID,
  importStrategyPackText,
  registerImportedProvider,
  type AcceptanceSessionController,
  type ImportedPackResult,
  type LocalSolverProbeResult,
  type UiDrillMode,
  type UiRngMode,
} from "./sessionAdapter";
import type { FullHandDealOptions } from "../fixtures/fullHand";
import { buildExplanation, type ExplanationProvenance, type ExplanationStatement, type FutureCardTag } from "../explanation";
import {
  ANALYTICS_STORAGE_KEY,
  largestLeak,
  parseSessionAnalytics,
  recordDecision,
  recordFrequencyPrediction,
  startAnalyticsHand,
  summarizeAnalytics,
  type SessionAnalyticsState,
} from "../analytics";
import { parseAndValidateCustomSpot, type CustomSpotValidation } from "../builder";
import type { EquityCombo, EquityWorkerRequest, EquityWorkerResponse } from "../workers/equity.worker";
import { createPracticeCatalog } from "./sessionAdapter";
import { createPracticeQueue, type PracticeQueue } from "../session/practiceQueue";
import { PracticeToolbar, StudyHud, type PracticeStreet } from "./PracticeHud";
import { getLocalSolverStatus, type LocalSolverStatus } from "../domain/localSolverStatus";
import { buildCoachingLesson } from "../explanation/coachingLesson";

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const GRADE_STOPS = ["Best Move", "Good Move", "Inaccuracy", "Mistake", "Blunder"];
const MIX_GRADE_STOPS = ["Excellent", "Close", "Developing", "Off target"];
const WORKSPACE_TABS = ["Drill", "Range", "Odds / Math", "Strategy", "Session", "Builder"] as const;

type Theme = "light" | "dark";
type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
type RngMode = UiRngMode;
type PracticeDifficulty = "Simple" | "Grouped" | "Standard" | "Frequency";

interface AppliedDrillSetup {
  readonly drillMode: UiDrillMode;
  readonly difficulty: PracticeDifficulty;
  readonly fullHand: FullHandDealOptions;
  readonly nodeFilter: ScenarioFilter;
}

const DEFAULT_DRILL_SETUP: AppliedDrillSetup = {
  drillMode: "Node drill",
  difficulty: "Standard",
  fullHand: DEFAULT_FULL_HAND_OPTIONS,
  nodeFilter: {},
};

const workspaceTabSlug = (tab: WorkspaceTab) => tab.toLowerCase().replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "");

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "light" ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" />
    </svg>
  );
}

function PlayingCard({ card, concealed = false }: { card?: Card; concealed?: boolean }) {
  if (concealed || card === undefined) {
    return <span className="playing-card card-back" aria-label="Concealed card"><span aria-hidden="true">HC</span></span>;
  }
  const isRed = card.suit === "♥" || card.suit === "♦";
  return (
    <span className={`playing-card ${isRed ? "red-suit" : "black-suit"}`} aria-label={`${card.rank} ${card.suit}`}>
      <strong>{card.rank}</strong><span>{card.suit}</span>
    </span>
  );
}

function TableSeat({ seat, index, selected, onInspect }: { seat: TrainerState["seats"][number]; index: number; selected: boolean; onInspect: () => void }) {
  return (
    <div
      className={`table-seat seat-${index} ${seat.isHero ? "hero-seat" : ""} ${seat.isActive ? "active-seat" : ""}`}
      aria-label={`${seat.position}, ${formatBB(seat.stackBB)}, ${seat.status}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onInspect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInspect(); } }}
    >
      <div className="seat-topline">
        <strong>{seat.position}</strong>
        {seat.isButton ? <span className="dealer-button" aria-label="Dealer button">D</span> : null}
      </div>
      <span className="seat-stack">{formatBB(seat.stackBB)}</span>
      <span className="seat-status">{seat.status}</span>
      {seat.holeCards !== undefined ? (
        <span className="seat-cards" aria-label={seat.isHero ? "Hero cards" : "Showdown cards"}>
          {seat.holeCards.map((card) => <PlayingCard key={`${card.rank}${card.suit}`} card={card} />)}
        </span>
      ) : seat.isInHand ? (
        <span className="seat-cards opponent-cards" aria-label="Opponent cards concealed">
          <PlayingCard concealed /><PlayingCard concealed />
        </span>
      ) : null}
    </div>
  );
}

function PokerTable({ state, drillMode, selectedSeat, onInspect }: { state: TrainerState; drillMode: UiDrillMode; selectedSeat: number | null; onInspect: (index: number) => void }) {
  const effective = Math.min(state.heroStackBB, state.villainStackBB);
  const modeLabel = drillMode === "Full hand" ? "full-hand deal" : drillMode === "Custom spot" ? "validated custom spot" : "validated node drill";
  return (
    <section className="table-region" aria-labelledby="decision-heading" data-primary-trainer="table">
      <div className="table-context">
        <div>
          <h1 id="decision-heading" tabIndex={-1}>{state.activePlayerCount > 2 ? `${state.heroPosition} · ${state.activePlayerCount}-way decision` : `${state.heroPosition} decision versus ${state.opponentPosition}`}</h1>
          <p>{state.street} · {state.playerCount}-handed {state.domainState.config.gameType} · {formatBB(effective)} effective vs {state.opponentPosition} · {modeLabel}</p>
        </div>
        <div className="state-facts" aria-label="Current hand facts">
          <span><b>{state.street}</b></span>
          <span><b>{state.activePlayerCount}</b> of {state.playerCount} remain</span>
          <span><b>{formatBB(state.potBB)}</b> pot</span>
          <span><b>{formatBB(state.amountToCallBB)}</b> to call</span>
        </div>
      </div>

      <div className="poker-table-wrap">
        <div className={`poker-table table-count-${state.playerCount}`} aria-label={`${state.playerCount}-handed poker table`}>
          <div className="felt-line" aria-hidden="true" />
          {state.seats.map((seat, index) => <TableSeat key={seat.position} seat={seat} index={index} selected={selectedSeat === index} onInspect={() => onInspect(index)} />)}
          <div className="table-center">
            <div className="pot-display"><span>Pot</span><strong>{formatBB(state.potBB)}</strong></div>
            <div className="board" aria-label={`${state.street} board`}>
              {state.board.map((card) => <PlayingCard key={`${card.rank}${card.suit}`} card={card} />)}
              {Array.from({ length: 5 - state.board.length }).map((_, index) => <span className="board-slot" key={index} aria-hidden="true" />)}
            </div>
            <div className="turn-indicator" aria-live="polite">{state.actorLabel === "Hand complete" ? state.actorLabel : `${state.actorLabel} to act`}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ActionButton({
  action,
  disabled,
  onChoose,
}: {
  action: LegalAction;
  disabled: boolean;
  onChoose: (button: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      className={`action-button action-${action.family}`}
      aria-disabled={disabled}
      aria-label={action.detail}
      title={action.detail}
      onClick={(event) => {
        if (!disabled) onChoose(event.currentTarget);
      }}
    >
      <span>{action.label}</span><small>{action.annotation}</small>
    </button>
  );
}

interface PracticeActionGroup {
  readonly id: string;
  readonly label: string;
  readonly annotation: string;
  readonly actions: readonly LegalAction[];
}

function groupedBand(action: LegalAction): "Small" | "Medium" | "Large" | "Overbet" | "Jam" {
  if (action.family === "all-in") return "Jam";
  const fraction = action.aggressiveFractionOfPotAfterCall ?? 0;
  if (fraction <= 0.5) return "Small";
  if (fraction <= 0.75) return "Medium";
  if (fraction <= 1) return "Large";
  return "Overbet";
}

function practiceActionGroups(actions: readonly LegalAction[], difficulty: "Simple" | "Grouped"): readonly PracticeActionGroup[] {
  const definitions = difficulty === "Simple"
    ? [
      { id: "fold", label: "Fold", accepts: (action: LegalAction) => action.family === "fold" },
      { id: "passive", label: "Check / Call", accepts: (action: LegalAction) => action.family === "check" || action.family === "call" },
      { id: "aggressive", label: "Bet / Raise", accepts: (action: LegalAction) => ["bet", "raise", "all-in"].includes(action.family) },
    ]
    : [
      { id: "fold", label: "Fold", accepts: (action: LegalAction) => action.family === "fold" },
      { id: "check", label: "Check", accepts: (action: LegalAction) => action.family === "check" },
      { id: "call", label: "Call", accepts: (action: LegalAction) => action.family === "call" },
      ...(["Small", "Medium", "Large", "Overbet", "Jam"] as const).map((label) => ({
        id: label.toLowerCase(),
        label,
        accepts: (action: LegalAction) => ["bet", "raise", "all-in"].includes(action.family) && groupedBand(action) === label,
      })),
    ];
  return definitions.flatMap((definition) => {
    const matches = actions.filter(definition.accepts);
    if (matches.length === 0) return [];
    return [{
      id: definition.id,
      label: definition.label,
      annotation: matches.length === 1 ? matches[0]!.label : `${matches.length} exact legal sizes`,
      actions: matches,
    }];
  });
}

function FrequencyPredictionDock({
  actions,
  available,
  disabled,
  onSubmit,
  onChangeProvider,
}: {
  actions: readonly LegalAction[];
  available: boolean;
  disabled: boolean;
  onSubmit: (prediction: Readonly<Record<string, number>>, button: HTMLButtonElement) => void;
  onChangeProvider: () => void;
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(actions.map(({ id }) => [id, "0"])));
  useEffect(() => setValues(Object.fromEntries(actions.map(({ id }) => [id, "0"]))), [actions]);
  const total = actions.reduce((sum, { id }) => sum + (Number(values[id] ?? 0) || 0), 0);
  const valid = actions.every(({ id }) => {
    const value = Number(values[id] ?? 0);
    return Number.isFinite(value) && value >= 0 && value <= 100;
  }) && Math.abs(total - 100) <= 0.01;
  if (!available) {
    return (
      <div className="mix-unavailable" role="status">
        <span><strong>Exact held-combo mix unavailable.</strong> Connect a SOLVED source with a complete row for Hero’s exact suits. Aggregate node frequencies and heuristic policy rows are not accepted.</span>
        <button type="button" className="secondary-button" onClick={onChangeProvider}>Change provider</button>
      </div>
    );
  }
  return (
    <div className="frequency-predictor">
      <div className="frequency-predictor-grid">
        {actions.map((action) => (
          <label key={action.id}>
            <span>{action.label}</span>
            <span className="frequency-input"><input type="number" inputMode="decimal" min="0" max="100" step="1" value={values[action.id] ?? "0"} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, [action.id]: event.target.value }))} aria-label={`${action.label} predicted frequency percent`} /><b>%</b></span>
          </label>
        ))}
      </div>
      <div className={`frequency-total ${valid ? "frequency-total-valid" : ""}`}><span>Total</span><strong>{Number(total.toFixed(1))}%</strong><small>{valid ? "Ready · reference still hidden" : "Must equal 100%"}</small></div>
      <button type="button" className="primary-button frequency-submit" disabled={disabled || !valid} onClick={(event) => onSubmit(Object.fromEntries(actions.map(({ id }) => [id, Number(values[id] ?? 0) / 100])), event.currentTarget)}>Grade my mix</button>
    </div>
  );
}

function ActionDock({
  state,
  selected,
  busy,
  phase,
  settlement,
  heroSeatId,
  status,
  onReset,
  onChangeProvider,
  onChoose,
  onPredict,
  onReview,
  difficulty,
  mixPredictionAvailable,
}: {
  state: TrainerState;
  selected: LegalAction | null;
  busy: boolean;
  phase: DrillSnapshot["phase"];
  settlement?: DrillSnapshot["settlement"];
  heroSeatId: DrillSnapshot["heroSeatId"];
  status?: string;
  onReset: () => void;
  onChangeProvider: () => void;
  onChoose: (action: LegalAction, button: HTMLButtonElement) => void;
  onPredict: (prediction: Readonly<Record<string, number>>, button: HTMLButtonElement) => void;
  onReview: () => void;
  difficulty: PracticeDifficulty;
  mixPredictionAvailable: boolean;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  useEffect(() => setOpenGroup(null), [difficulty, state.legalActions]);
  const hasActions = state.legalActions.length > 0;
  const heading = hasActions ? (difficulty === "Frequency" ? "Predict the exact hand mix" : "Choose your action") : phase === "TERMINAL" ? "Hand settlement" : "Continuation blocked";
  const heroPayout = settlement?.payoutsBB[heroSeatId];
  const heroFinal = settlement?.finalStacksBB[heroSeatId];
  const groups = difficulty === "Simple" || difficulty === "Grouped" ? practiceActionGroups(state.legalActions, difficulty) : [];
  const activeGroup = groups.find(({ id }) => id === openGroup);
  return (
    <section className="action-dock" aria-labelledby="choose-action-heading" data-primary-trainer="actions">
      <div className="action-dock-heading">
        <div>
          <h2 id="choose-action-heading">{heading}</h2>
          <p>{hasActions ? (status ?? (selected === null ? "Reference concealed until you commit." : `${selected.label} locked.`)) : phase === "TERMINAL" ? "Exact ledger from the rules engine." : "No opponent action was manufactured."}</p>
        </div>
        {!hasActions ? (
          <span className={`source-badge ${phase === "TERMINAL" ? "badge-math" : "badge-heuristic"}`}>{phase === "TERMINAL" ? "Settled" : "Provider block"}</span>
        ) : selected === null ? (
          <span className="source-badge badge-concealed">Answer hidden</span>
        ) : (
          <button type="button" className="review-button" onClick={onReview}>Review result</button>
        )}
      </div>
      <div className="action-scroll" tabIndex={0} aria-label={difficulty === "Frequency" ? "Frequency prediction" : "Legal actions"}>
        {difficulty === "Frequency" ? (
          <FrequencyPredictionDock actions={state.legalActions} available={mixPredictionAvailable} disabled={selected !== null || busy} onSubmit={onPredict} onChangeProvider={onChangeProvider} />
        ) : (
          <>
        {activeGroup === undefined ? null : (
          <div className="action-group-drilldown">
            <button type="button" className="group-back" onClick={() => setOpenGroup(null)}>← {activeGroup.label}</button>
            <span>Choose the exact engine-issued size</span>
          </div>
        )}
        <div className={`action-grid ${state.street === "Turn" ? "turn-actions" : ""} ${difficulty === "Standard" ? "" : "practice-group-grid"}`}>
          {(difficulty === "Standard" || activeGroup !== undefined ? (activeGroup?.actions ?? state.legalActions) : []).map((action) => (
            <ActionButton
              key={action.id}
              action={action}
              disabled={selected !== null || busy}
              onChoose={(button) => onChoose(action, button)}
            />
          ))}
          {difficulty === "Standard" || activeGroup !== undefined ? null : groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="action-button action-practice-group"
              aria-disabled={selected !== null || busy}
              onClick={(event) => {
                if (selected !== null || busy) return;
                if (group.actions.length === 1) onChoose(group.actions[0]!, event.currentTarget);
                else setOpenGroup(group.id);
              }}
            >
              <span>{group.label}</span><small>{group.annotation}</small>
            </button>
          ))}
        </div>
          </>
        )}
      </div>
      {state.legalActions.length === 0 && status !== undefined ? (
        <div className="dock-status" role="status">
          <span>
            {status}
            {settlement === undefined ? null : (
              <span className="settlement-ledger">
                <b>Pot {formatBB(bbToNumber(settlement.potBB))}</b>
                <b>Rake {formatBB(bbToNumber(settlement.rakeBB))}</b>
                <b>Hero payout {formatBB(bbToNumber(heroPayout ?? bb(0)))}</b>
                <b>Hero final {formatBB(bbToNumber(heroFinal ?? bb(0)))}</b>
              </span>
            )}
          </span>
          <span className="dock-recovery">
            <button type="button" className="secondary-button" onClick={onReset}>New / reset hand</button>
            <button type="button" className="secondary-button" onClick={onChangeProvider}>Change provider</button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function GradeScale({ grade }: { grade: Grade }) {
  const activeIndex = grade.mode === "EV"
    ? ["BEST MOVE", "GOOD MOVE", "INACCURACY", "MISTAKE", "BLUNDER"].indexOf(grade.grade)
    : -1;
  const policy = grade.mode === "EV" ? (grade.policy ?? defaultGradingPolicy) : defaultGradingPolicy;
  return (
    <section className={`grade-scale ${activeIndex >= 0 ? "grade-scale-active" : ""}`} aria-label={activeIndex >= 0 ? `EV grade: ${grade.grade}` : "EV grading scale locked"}>
      <div className="grade-scale-heading">
        <h3>EV-loss grading scale</h3>
        <span className="scale-lock">{activeIndex >= 0 ? "Comparable action EVs supplied" : "Locked · no comparable action EV set"}</span>
      </div>
      <div className="grade-track" aria-hidden="true">
        <span />
        {activeIndex >= 0 ? <i className={`grade-marker grade-marker-${activeIndex}`} /> : null}
      </div>
      <ol>{GRADE_STOPS.map((stop, index) => <li className={index === activeIndex ? "active-grade" : ""} key={stop}>{stop}</li>)}</ol>
      <p><strong>Configurable application policy:</strong> Best = reference-selected action · Good = frequency ≥ {(policy.lowFrequencyBoundary * 100).toFixed(1)}% and loss &lt; {policy.goodMaxLossPctPot}% pot · Inaccuracy ≤ {policy.inaccuracyMaxLossPctPot}% · Mistake ≤ {policy.mistakeMaxLossPctPot}% · Blunder &gt; {policy.mistakeMaxLossPctPot}%. {activeIndex >= 0 ? "This node supplied a complete comparable EV set." : "The scale stays inactive until every legal action has a comparable EV."}</p>
    </section>
  );
}

function FrequencyGradeScale({ prediction }: { prediction: NonNullable<NonNullable<DrillSnapshot["reveal"]>["frequencyPrediction"]> }) {
  const activeIndex = ["EXCELLENT MIX", "CLOSE MIX", "DEVELOPING MIX", "OFF TARGET"].indexOf(prediction.grade);
  return (
    <section className="grade-scale grade-scale-active mix-grade-scale" aria-label={`Frequency prediction grade: ${prediction.grade}`}>
      <div className="grade-scale-heading"><h3>Mix-distance grading</h3><span className="scale-lock">Exact held-combo reference supplied</span></div>
      <div className="grade-track" aria-hidden="true"><span /><i className={`grade-marker mix-grade-marker-${activeIndex}`} /></div>
      <ol>{MIX_GRADE_STOPS.map((stop, index) => <li className={index === activeIndex ? "active-grade" : ""} key={stop}>{stop}</li>)}</ol>
      <p>Total-variation distance: <strong>{(prediction.totalVariationDistance * 100).toFixed(1)}%</strong> · mean action error {(prediction.meanAbsoluteError * 100).toFixed(1)} percentage points · maximum {(prediction.maximumAbsoluteError * 100).toFixed(1)}.</p>
    </section>
  );
}

function OddsSummary({ state, decisionMath, compact = false }: { state: TrainerState; decisionMath?: DecisionMath; compact?: boolean }) {
  const pot = decisionMath === undefined ? state.potBB : bbToNumber(decisionMath.potAtDecisionBB);
  const contestablePot = decisionMath === undefined ? pot : bbToNumber(decisionMath.contestablePotAtDecisionBB);
  const call = decisionMath === undefined ? state.amountToCallBB : bbToNumber(decisionMath.amountToCallBB);
  const exactOdds = decisionMath?.potOdds;
  const oddsPct = exactOdds === undefined ? state.callOdds?.requiredEquityPct : exactOdds.requiredEquity * 100;
  const rewardToRisk = exactOdds === undefined ? state.callOdds?.rewardToRisk : exactOdds.potToCallRatio;
  const finalPot = contestablePot + call;
  const current = decisionMath?.currentSPR?.value ?? currentSpr(state);
  return (
    <section className={`odds-summary ${compact ? "odds-compact" : ""}`} {...(!compact ? { "aria-labelledby": "odds-heading" } : {})}>
      <div className="section-heading">
        {!compact ? <h3 id="odds-heading">Decision math</h3> : <strong>Exact decision math</strong>}
        <span className="source-badge badge-math">Exact math</span>
      </div>
      <dl>
        <div><dt>Pot</dt><dd>{formatBB(pot)}</dd></div>
        {contestablePot === pot ? null : <div><dt>Contestable to Hero</dt><dd>{formatBB(contestablePot)}</dd></div>}
        <div><dt>To call</dt><dd>{formatBB(call)}</dd></div>
        <div><dt>Current SPR</dt><dd>{Number(current.toFixed(2))}</dd></div>
        <div><dt>Flop-start SPR</dt><dd>{flopStartSpr(state)}</dd></div>
      </dl>
      {oddsPct === undefined || call === 0 ? (
        <p className="formula-line">No call is currently due.</p>
      ) : (
        <p className="formula-line">
          Raw pre-rake required equity = {formatBB(call)} ÷ ({formatBB(contestablePot)} + {formatBB(call)}) = <strong>{oddsPct.toFixed(1)}%</strong>
          <span> · {rewardToRisk?.toFixed(2)}:1 reward-to-risk · final pot {formatBB(finalPot)}</span>
        </p>
      )}
      {decisionMath?.rakeAdjustedPotOdds === undefined ? null : (
        <p className="formula-line rake-odds-line">
          Rake-adjusted closing-call benchmark = <strong>{(decisionMath.rakeAdjustedPotOdds.requiredEquity * 100).toFixed(1)}%</strong>
          <span> · assumes no further wagering · projected rake {formatBB(bbToNumber(decisionMath.projectedRakeIfNoFurtherBettingBB ?? bb(0)))}</span>
        </p>
      )}
    </section>
  );
}

function strategyActionLabel(state: TrainerState, strategyAction: StrategyResult["actions"][number]): string {
  return state.legalActions.find((candidate) => actionKey(candidate.domainAction) === actionKey(strategyAction.action))?.label
    ?? actionKey(strategyAction.action);
}

function formatStrategyFrequency(frequency: number | undefined): string {
  if (frequency === undefined) return "Frequency unavailable";
  const percentage = frequency * 100;
  if (percentage > 0 && percentage < 0.1) return `${percentage.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}%`;
  return `${percentage.toFixed(1)}%`;
}

const provenanceLabel = (provenance: ExplanationProvenance) => provenance.replace("_", " ");
const provenanceClass = (provenance: ExplanationProvenance) => provenance === "UNAVAILABLE" ? "unavailable" : provenance.toLowerCase();
const domainCardLabel = (card: string) => `${card[0] ?? "?"}${({ s: "♠", h: "♥", d: "♦", c: "♣" } as const)[card[1] as "s" | "h" | "d" | "c"] ?? "?"}`;

function ProvenanceBadge({ provenance }: { provenance: ExplanationProvenance }) {
  return <span className={`source-badge badge-${provenanceClass(provenance)}`}>{provenanceLabel(provenance)}</span>;
}

function StatementList({ statements }: { statements: readonly ExplanationStatement[] }) {
  return (
    <ul className="provenance-statements">
      {statements.map((item, index) => (
        <li key={`${item.provenance}-${index}`}><ProvenanceBadge provenance={item.provenance} /><span>{item.text}</span></li>
      ))}
    </ul>
  );
}

type EquityUiState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "ready"; readonly hand: EquityWorkerResponse; readonly range?: EquityWorkerResponse }
  | { readonly status: "error"; readonly reason: string };

function rangeCombos(range: WeightedRange | undefined): readonly EquityCombo[] {
  return range === undefined ? [] : [...range.values()].filter(({ weight }) => weight > 0).map(({ cards, weight }) => ({ cards, weight }));
}

function EquityPanel({ state, heroSeatId, publicRanges, deadCards }: { state: TrainerState; heroSeatId: DrillSnapshot["heroSeatId"]; publicRanges?: NonNullable<DrillSnapshot["reveal"]>["publicRanges"]; deadCards: NonNullable<DrillSnapshot["reveal"]>["publicDeadCards"] }) {
  const [equity, setEquity] = useState<EquityUiState>({ status: "loading" });
  useEffect(() => {
    const hero = state.domainState.players.find(({ id }) => id === heroSeatId);
    const opponents = state.domainState.players.filter(({ id, status }) => id !== heroSeatId && status !== "folded");
    if (hero?.holeCards === undefined) {
      setEquity({ status: "unavailable", reason: "Hero's exact cards are unavailable." });
      return;
    }
    if (opponents.length !== 1) {
      setEquity({ status: "unavailable", reason: "The current equity worker is heads-up only; no multiway equity is inferred." });
      return;
    }
    const opponent = opponents[0]!;
    const opponentRange = rangeCombos(publicRanges?.[opponent.id]);
    if (opponentRange.length === 0) {
      setEquity({ status: "unavailable", reason: "No positive-weight public opponent range is available." });
      return;
    }
    const heroRange = rangeCombos(publicRanges?.[heroSeatId]);
    const worker = new Worker(new URL("../workers/equity.worker.ts", import.meta.url), { type: "module" });
    const results = new Map<string, EquityWorkerResponse>();
    const handRequest: EquityWorkerRequest = {
      id: "hand-equity",
      hero: hero.holeCards,
      opponentRange,
      board: state.domainState.board,
      deadCards,
      mode: "auto",
      iterations: 20_000,
      seed: 20_260_827,
      maximumExactScenarios: 2_000_000,
    };
    const includeRange = heroRange.length > 0 && heroRange.length * opponentRange.length <= 50_000;
    const rangeRequest: EquityWorkerRequest | undefined = includeRange ? {
      id: "range-equity",
      heroRange,
      opponentRange,
      board: state.domainState.board,
      deadCards,
      mode: "auto",
      iterations: 20_000,
      seed: 20_260_828,
      maximumExactScenarios: 2_000_000,
    } : undefined;
    setEquity({ status: "loading" });
    let active = true;
    worker.onmessage = (event: MessageEvent<EquityWorkerResponse>) => {
      if (!active) return;
      results.set(event.data.id, event.data);
      const hand = results.get("hand-equity");
      const range = results.get("range-equity");
      if (hand !== undefined && (rangeRequest === undefined || range !== undefined)) setEquity({ status: "ready", hand, ...(range === undefined ? {} : { range }) });
    };
    worker.onerror = (event) => {
      if (active) setEquity({ status: "error", reason: event.message || "Equity worker failed." });
    };
    worker.onmessageerror = () => {
      if (active) setEquity({ status: "error", reason: "The equity worker returned an unreadable response." });
    };
    worker.postMessage(handRequest);
    if (rangeRequest !== undefined) worker.postMessage(rangeRequest);
    return () => {
      active = false;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
  }, [deadCards, heroSeatId, publicRanges, state.domainState]);

  if (equity.status === "loading") return <section className="equity-panel" aria-live="polite"><h3>Equity</h3><p>Calculating outside the rendering thread…</p></section>;
  if (equity.status === "unavailable" || equity.status === "error") return <section className="equity-panel"><h3>Equity <ProvenanceBadge provenance="UNAVAILABLE" /></h3><p>{equity.reason}</p></section>;
  const rangeStrength = equity.range?.rangeStrengthComparison;
  const resultCard = (label: string, result: EquityWorkerResponse, value = result.equity) => (
    <article key={label}>
      <div><strong>{label}</strong><span className={`source-badge badge-${result.provenance === "EXACT_MATH" ? "exact_math" : "estimate"}`}>{result.provenance === "EXACT_MATH" ? "EXACT MATH" : "MONTE CARLO ESTIMATE"}</span></div>
      <b>{(value * 100).toFixed(2)}%</b>
      <small>{result.method === "exact-enumeration" ? `${result.scenarioCount.toLocaleString()} concrete pair/runout scenarios · combo weights applied` : `${result.sampleCount?.toLocaleString()} seeded samples${result.confidence95 === undefined ? "" : ` · 95% CI ${(result.confidence95[0] * 100).toFixed(2)}–${(result.confidence95[1] * 100).toFixed(2)}%`}`}</small>
    </article>
  );
  return (
    <section className="equity-panel" aria-live="polite">
      <h3>Equity and range comparison</h3>
      <div className="equity-result-grid">
        {resultCard("Hero hand equity", equity.hand)}
        {equity.range === undefined ? null : resultCard("Hero range equity", equity.range)}
        {equity.range === undefined ? null : resultCard("Villain range equity", equity.range, 1 - equity.range.equity)}
      </div>
      {equity.range === undefined ? null : (
        <p className="range-advantage-line">
          <span className={`source-badge badge-${equity.range.provenance === "EXACT_MATH" ? "exact_math" : "estimate"}`}>{equity.range.provenance === "EXACT_MATH" ? "EXACT MATH" : "MONTE CARLO ESTIMATE"}</span>
          {equity.range.equity === 0.5
            ? " The supplied ranges have equal heads-up showdown equity."
            : ` ${equity.range.equity > 0.5 ? "Hero" : "Villain"} has ${(Math.abs(equity.range.equity - 0.5) * 100).toFixed(2)} percentage points of range-equity advantage against the other supplied range.`}
        </p>
      )}
      {rangeStrength === undefined ? (
        <p>Equity is a showdown share against the supplied public range, not proof of the best action. Current nut-density comparison is unavailable before the flop or when no compatible public Hero range is supplied.</p>
      ) : (
        <section className="range-strength-panel">
          <header><h4>Current range strength</h4><span className="source-badge badge-exact_math">Exact math</span></header>
          <p>Visible board only · {rangeStrength.legalComboCount.toLocaleString()} legal two-card combos · strongest {(rangeStrength.topFiveCutoffPercentage * 100).toFixed(2)}% included because ties at the nominal 5% cutoff are retained.</p>
          <div className="range-density-grid">
            {(["hero", "opponent"] as const).map((side) => {
              const profile = rangeStrength[side];
              return (
                <article key={side}>
                  <strong>{side === "hero" ? "Hero range" : "Villain range"}</strong>
                  <b>{(profile.nutDensity * 100).toFixed(2)}%</b><span>current-nut density · {profile.weightedNutCombos.toFixed(2)} weighted combos</span>
                  <b>{(profile.topFiveDensity * 100).toFixed(2)}%</b><span>above top-5% legal-combo cutoff · {profile.weightedTopFiveCombos.toFixed(2)} weighted combos</span>
                </article>
              );
            })}
          </div>
          <table className="range-category-table">
            <thead><tr><th>Made-hand class</th><th>Hero</th><th>Villain</th></tr></thead>
            <tbody>{Object.keys(rangeStrength.hero.categoryWeightedCombos).filter((category) => {
              const key = category as keyof typeof rangeStrength.hero.categoryWeightedCombos;
              return rangeStrength.hero.categoryWeightedCombos[key] > 0 || rangeStrength.opponent.categoryWeightedCombos[key] > 0;
            }).map((category) => {
              const key = category as keyof typeof rangeStrength.hero.categoryWeightedCombos;
              const heroShare = rangeStrength.hero.weightedComboCount === 0 ? 0 : rangeStrength.hero.categoryWeightedCombos[key] / rangeStrength.hero.weightedComboCount;
              const opponentShare = rangeStrength.opponent.weightedComboCount === 0 ? 0 : rangeStrength.opponent.categoryWeightedCombos[key] / rangeStrength.opponent.weightedComboCount;
              return <tr key={category}><th>{category}</th><td>{(heroShare * 100).toFixed(1)}%</td><td>{(opponentShare * 100).toFixed(1)}%</td></tr>;
            })}</tbody>
          </table>
          <p className="range-advantage-line">
            <span className="source-badge badge-exact_math">Exact math</span>
            {rangeStrength.hero.nutDensity === rangeStrength.opponent.nutDensity
              ? " Neither supplied range has a current-nut density advantage."
              : ` ${rangeStrength.hero.nutDensity > rangeStrength.opponent.nutDensity ? "Hero" : "Villain"} has ${(Math.abs(rangeStrength.hero.nutDensity - rangeStrength.opponent.nutDensity) * 100).toFixed(2)} percentage points more current-nut density.`}
            {rangeStrength.hero.topFiveDensity === rangeStrength.opponent.topFiveDensity
              ? " Their density above the top-5% cutoff is equal."
              : ` ${rangeStrength.hero.topFiveDensity > rangeStrength.opponent.topFiveDensity ? "Hero" : "Villain"} also has ${(Math.abs(rangeStrength.hero.topFiveDensity - rangeStrength.opponent.topFiveDensity) * 100).toFixed(2)} percentage points more density above that cutoff.`}
          </p>
          <p>These are weighted public-range composition facts, not a solver sizing recommendation. Equity remains a showdown share rather than proof of the best action.</p>
        </section>
      )}
    </section>
  );
}

const futureTagLabels: Readonly<Record<FutureCardTag, string>> = {
  IMPROVES_HAND_SCORE: "Improves Hero's evaluated hand",
  IMPROVES_HAND_CATEGORY: "Improves hand category",
  PAIRS_BOARD: "Pairs the board",
  COMPLETES_HERO_FLUSH: "Completes Hero's flush",
  ADDS_HERO_FLUSH_DRAW: "Adds a flush draw",
  CHANGES_BOARD_FLUSH_STRUCTURE: "Changes board flush structure",
  COMPLETES_HERO_STRAIGHT: "Completes Hero's straight",
  ADDS_GUTSHOT: "Adds a gutshot",
  ADDS_OPEN_ENDED_STRAIGHT_DRAW: "Adds an open-ended draw",
  CHANGES_BOARD_STRAIGHT_STRUCTURE: "Changes board straight structure",
  NO_LISTED_CHANGE: "No listed mechanical change",
};

function FullExplanation({ state, action, reveal, heroSeatId, rng }: { state: TrainerState; action: LegalAction; reveal: NonNullable<DrillSnapshot["reveal"]>; heroSeatId: DrillSnapshot["heroSeatId"]; rng: DrillSnapshot["rng"] }) {
  const hasFrequencies = reveal.strategy.actions.some(({ frequency }) => frequency !== undefined);
  const hasEvs = reveal.strategy.actions.some(({ evBB }) => evBB !== undefined);
  const explanation = useMemo(() => buildExplanation({
    state: state.domainState,
    heroSeatId,
    legalActions: state.legalActions.map(({ domainAction }) => domainAction),
    chosenAction: action.domainAction,
    strategy: reveal.strategy,
    decisionMath: reveal.decisionMath,
    referenceSelection: {
      rngMode: rng.mode,
      ...((reveal.rngRoll ?? rng.roll) === undefined ? {} : { roll: reveal.rngRoll ?? rng.roll }),
    },
    ...(reveal.publicRanges === undefined ? {} : { publicRanges: reveal.publicRanges }),
    deadCards: reveal.publicDeadCards,
  }), [action.domainAction, heroSeatId, reveal.decisionMath, reveal.publicDeadCards, reveal.publicRanges, reveal.rngRoll, reveal.strategy, rng.mode, rng.roll, state.domainState, state.legalActions]);
  const futureGroups = Object.entries(explanation.futureStreet.byTag)
    .filter(([, cards]) => cards.length > 0) as [FutureCardTag, readonly string[]][];
  const source = reveal.strategy.source;
  const configuration = reveal.strategy.configuration;
  const rangeSummary = configuration === undefined ? "Unavailable" : Object.entries(configuration.ranges).map(([seat, range]) => `${seat}: ${range.comboCount} combos / ${range.weightedComboCount.toFixed(3)} weight`).join(" · ") || "No public ranges supplied";
  const convergence = reveal.strategy.convergence;
  return (
    <div className="full-explanation" id="full-explanation">
      <nav className="explanation-jump" aria-label="Explanation sections">
        {[["explanation-why", "Why"], ["explanation-blockers", "Blockers"], ["explanation-math", "Math"], ["explanation-alternatives", "Alternatives"], ...(explanation.futureStreet.cardsToCome > 0 ? [["explanation-future", "Next cards"]] : []), ["explanation-source", "Source"]].map(([id, label]) => <button type="button" key={id} onClick={() => { const target = document.getElementById(id!); if (target instanceof HTMLDetailsElement) target.open = true; target?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }}>{label}</button>)}
      </nav>
      {reveal.frequencyPrediction === undefined ? null : (
        <section className="mix-breakdown">
          <h3>Predicted mix versus reference</h3>
          <p>The reference is the source row for Hero’s exact two-card combination. The sampled rollout action is not graded as your choice.</p>
          <div className="reference-actions" aria-label="Predicted and reference action frequencies">
            {reveal.frequencyPrediction.actions.map((item) => (
              <div key={actionKey(item.action)}>
                <strong>{strategyActionLabel(state, item)}</strong>
                <span>You {(item.predictedFrequency * 100).toFixed(1)}%</span>
                <span>Reference {(item.referenceFrequency * 100).toFixed(1)}% · Δ {(item.absoluteError * 100).toFixed(1)} pp</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <details className="evidence-block" id="explanation-source">
        <summary>Source, ranges, and convergence</summary>
        <dl className="availability-list">
          <div><dt>Reference strategy</dt><dd>{hasFrequencies ? "Supplied by the active strategy source" : `Unavailable · ${reveal.strategy.provenance.toLowerCase()} source supplied no frequencies`}</dd></div>
          <div><dt>Action EVs / regret</dt><dd>{hasEvs ? "Supplied for at least one action; see the action table" : "Unavailable"}</dd></div>
          <div><dt>Source</dt><dd>{source === undefined ? "Unavailable" : [source.name ?? source.id, source.solver, source.version, source.commit, source.timestamp].filter(Boolean).join(" · ")}</dd></div>
          <div><dt>License / source URL</dt><dd>{source === undefined ? "Unavailable" : [source.license, source.sourceUrl].filter(Boolean).join(" · ") || "Unavailable"}</dd></div>
          <div><dt>Source node</dt><dd>{reveal.strategy.sourceNodeId ?? "Unavailable"}</dd></div>
          <div><dt>Tree / pot / board</dt><dd>{configuration === undefined ? "Unavailable" : `${configuration.actionTreeId} · ${formatBB(bbToNumber(configuration.potBB))} · ${configuration.board.length === 0 ? "preflop" : configuration.board.map(domainCardLabel).join(" ")}`}</dd></div>
          <div><dt>Rake</dt><dd>{configuration === undefined ? "Unavailable" : configuration.rake.enabled ? `${(configuration.rake.percentage * 100).toFixed(2)}% · cap ${formatBB(bbToNumber(configuration.rake.capBB))}${configuration.rake.noFlopNoDrop ? " · no flop, no drop" : ""}` : "Disabled"}</dd></div>
          <div><dt>Public ranges</dt><dd>{rangeSummary}</dd></div>
          <div><dt>Convergence</dt><dd>{convergence === undefined ? "Unavailable" : [
            convergence.solver,
            convergence.iterations === undefined ? undefined : `${convergence.iterations} iterations`,
            convergence.exploitabilityBB === undefined ? (convergence.exploitability === undefined ? undefined : `exploitability ${convergence.exploitability}`) : `exploitability ${convergence.exploitabilityBB.toFixed(5)} BB`,
            convergence.exploitabilityPctPot === undefined ? undefined : `${convergence.exploitabilityPctPot.toFixed(3)}% of starting pot`,
            convergence.targetExploitabilityPctPot === undefined ? undefined : `target ${convergence.targetExploitabilityPctPot.toFixed(3)}%`,
            convergence.compression,
          ].filter(Boolean).join(" · ")}</dd></div>
          <div><dt>Hero posterior range</dt><dd>{reveal.rangeConditioning === undefined ? "Unavailable · no public Hero prior" : reveal.rangeConditioning.available ? `${reveal.rangeConditioning.posteriorComboCount} conditioned combos` : `Unavailable · ${reveal.rangeConditioning.reason}`}</dd></div>
          <div><dt>Hand and range equity</dt><dd>Calculated below when compatible public heads-up ranges are available</dd></div>
          <div><dt>Nut / top-range density</dt><dd>Calculated below when compatible public postflop ranges are available</dd></div>
        </dl>
        <div className="reference-actions" aria-label="Reference actions supplied by the active source">
          {reveal.strategy.actions.length === 0 ? <p>No action recommendation matched this exact node.</p> : reveal.strategy.actions.map((item) => (
            <div key={actionKey(item.action)}>
              <strong>{strategyActionLabel(state, item)}</strong>
                <span>{formatStrategyFrequency(item.frequency)}</span>
              <span>{item.evBB === undefined ? "EV unavailable" : `${bbToNumber(item.evBB).toFixed(2)} BB EV`}</span>
            </div>
          ))}
        </div>
        {reveal.strategy.notes?.map((note) => <p className="source-note" key={note}>{note}</p>)}
        {configuration === undefined ? null : (
          <details className="configuration-hashes">
            <summary>Deterministic configuration hashes</summary>
            <code>{`game ${configuration.gameConfigHash}\nrange ${configuration.rangeHash}\ntree ${configuration.treeHash}\nnode ${configuration.nodeHash}\nboard ${configuration.boardCanonicalHash}`}</code>
          </details>
        )}
      </details>

      <EquityPanel state={state} heroSeatId={heroSeatId} deadCards={reveal.publicDeadCards} {...(reveal.publicRanges === undefined ? {} : { publicRanges: reveal.publicRanges })} />

      <div className="explanation-columns">
        <section id="explanation-why">
          <h3>What this action does</h3>
          <StatementList statements={explanation.actionRationale.statements} />
          <h4>Why this size</h4>
          <StatementList statements={explanation.sizingRationale.statements} />
        </section>
        <section id="explanation-blockers">
          <h3>{explanation.blockers.heroCards.map(({ card }) => domainCardLabel(card)).join(" ")} blocker effects</h3>
          {explanation.blockers.heroCards.map((detail) => (
            <div className="blocker-card" key={detail.card}>
              <strong>{domainCardLabel(detail.card)}</strong>
              <StatementList statements={detail.statements} />
            </div>
          ))}
          <StatementList statements={explanation.blockers.strategicNetEffect} />
        </section>
      </div>

      <section className="exact-math-grid" id="explanation-math">
        <h3>Exact mathematical panel</h3>
        {explanation.exactMath.length === 0 ? <p>No additional wager benchmark applies to this node.</p> : (
          <div className="math-panel-grid">
            {explanation.exactMath.map((panel) => (
              <article key={panel.id}>
                <div><strong>{panel.label}</strong><ProvenanceBadge provenance={panel.provenance} /></div>
                <b>{panel.id === "CURRENT_SPR" ? panel.value.value.toFixed(2) : `${(panel.value.value * 100).toFixed(1)}%`}</b>
                <code>{panel.value.formula}</code>
                <details><summary>Assumptions</summary><ul>{panel.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>
              </article>
            ))}
          </div>
        )}
      </section>

      {explanation.multiway.applies ? (
        <section className="multiway-explanation">
          <h3>Multiway adjustment <ProvenanceBadge provenance="HEURISTIC" /></h3>
          <StatementList statements={explanation.multiway.statements} />
        </section>
      ) : null}

      <section className="alternatives" id="explanation-alternatives">
        <h3>Why not the other legal actions?</h3>
        {explanation.alternatives.map((alternative) => {
          const candidate = state.legalActions.find(({ domainAction }) => actionKey(domainAction) === actionKey(alternative.action));
          return candidate === undefined ? null : (
          <details key={candidate.id}>
            <summary>{candidate.label}</summary>
            <StatementList statements={alternative.statements} />
            <dl>
              <div><dt>Added</dt><dd>{formatBB(candidate.amountAddedBB)}</dd></div>
              <div><dt>Contestable if called</dt><dd>{candidate.potIfCalledBB === undefined ? "N/A" : formatBB(candidate.potIfCalledBB)}</dd></div>
              {candidate.uncalledReturnBB === undefined ? null : <div><dt>Uncalled return</dt><dd>{formatBB(candidate.uncalledReturnBB)}</dd></div>}
              <div><dt>Behind</dt><dd>{formatBB(candidate.heroBehindBB)}</dd></div>
            </dl>
          </details>
          );
        })}
      </section>

      {explanation.futureStreet.cardsToCome > 0 ? (
        <section className="future-plan" id="explanation-future">
          <h3>Next-card map <ProvenanceBadge provenance={explanation.futureStreet.provenance} /></h3>
          <StatementList statements={explanation.futureStreet.statements} />
          <div className="future-card-groups">
            {futureGroups.map(([tag, cards]) => (
              <details key={tag}>
                <summary>{futureTagLabels[tag]} <span>{cards.length}</span></summary>
                <p>{cards.map(domainCardLabel).join(" · ")}</p>
              </details>
            ))}
          </div>
        </section>
      ) : null}

    </div>
  );
}

function RngBucketVisualization({
  state,
  mode,
  roll,
  buckets,
}: {
  state: TrainerState;
  mode: Exclude<DrillSnapshot["rng"]["mode"], "off">;
  roll: number;
  buckets: readonly RngBucket[];
}) {
  const selected = buckets.find(({ start, end }) => roll >= start && roll <= end);
  if (selected === undefined) return null;
  const direction = mode === "high" ? "Passive at 1 \u2192 aggressive at 100" : "Aggressive at 1 \u2192 passive at 100";
  return (
    <section className="rng-bucket-visualization" aria-label={`${mode === "high" ? "High" : "Low"} RNG source-frequency buckets`}>
      <header>
        <strong>1\u2013100 equilibrium buckets</strong>
        <span>{direction}</span>
      </header>
      <div className="rng-bucket-axis" aria-hidden="true"><span>1</span><span>100</span></div>
      <ol>
        {buckets.map((bucket) => {
          const active = bucket === selected;
          const label = strategyActionLabel(state, bucket.item);
          const range = bucket.start === bucket.end ? `${bucket.start}` : `${bucket.start}\u2013${bucket.end}`;
          return (
            <li
              key={actionKey(bucket.item.action)}
              className={active ? "selected-rng-bucket" : undefined}
              style={{ flexBasis: `${bucket.end - bucket.start + 1}%` }}
              aria-current={active ? "true" : undefined}
              aria-label={`Rolls ${range}: ${label}, source frequency ${formatStrategyFrequency(bucket.item.frequency)}`}
              title={`${range} \u00b7 ${label} \u00b7 ${formatStrategyFrequency(bucket.item.frequency)}`}
            >
              <strong>{range}</strong>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>
      <p><strong>Roll {roll}</strong> selects <b>{strategyActionLabel(state, selected.item)}</b> from bucket {selected.start}\u2013{selected.end} \u00b7 source frequency {formatStrategyFrequency(selected.item.frequency)}</p>
    </section>
  );
}

function ResultDialog({
  dialogRef,
  headingRef,
  state,
  heroSeatId,
  action,
  reveal,
  rng,
  continuing,
  expanded,
  onExpandedChange,
  onContinue,
  onReset,
  onNext,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  state: TrainerState;
  heroSeatId: DrillSnapshot["heroSeatId"];
  action: LegalAction | null;
  reveal: DrillSnapshot["reveal"];
  rng: DrillSnapshot["rng"];
  continuing: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onContinue: () => void;
  onReset: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  if (action === null || reveal === undefined) return null;
  const frequencyPrediction = reveal.frequencyPrediction;
  const lesson = buildCoachingLesson({ state: state.domainState, heroSeatId, legalActions: state.legalActions.map(({ domainAction }) => domainAction), chosenAction: action.domainAction, strategy: reveal.strategy, decisionMath: reveal.decisionMath });
  const isEvGrade = reveal.grade.mode === "EV";
  const provenanceClass = reveal.strategy.provenance.toLowerCase();
  const continueLabel = action.family === "fold" ? "View hand settlement" : "Continue same hand";
  const visibleReference = reveal.strategy.actions.filter(({ frequency, evBB }) => frequency !== undefined || evBB !== undefined);
  const legalDomainActions = state.legalActions.map(({ domainAction }) => domainAction);
  const completeBuckets = partitionStrategyFrequencies(reveal.strategy, "high", legalDomainActions);
  const completeFrequencySet = completeBuckets.length > 0;
  const rngRoll = reveal.rngRoll ?? rng.roll;
  const rngBuckets = frequencyPrediction === undefined && rng.mode !== "off"
    ? partitionStrategyFrequencies(reveal.strategy, rng.mode, legalDomainActions)
    : [];
  const toggleExplanation = () => {
    const nextExpanded = !expanded;
    onExpandedChange(nextExpanded);
    if (nextExpanded) {
      requestAnimationFrame(() => document.getElementById("full-explanation")?.scrollIntoView({ block: "start" }));
    }
  };
  return (
    <dialog ref={dialogRef} className="result-dialog" aria-labelledby="result-heading" onClose={onClose}>
      <div className="sheet-shell">
        <header className="sheet-header">
          <div>
            <span className={`source-badge badge-${provenanceClass}`}>{reveal.strategy.provenance.replace("_", " ")}</span>
            <h2 id="result-heading" ref={headingRef} tabIndex={-1}>{frequencyPrediction?.grade ?? reveal.grade.grade}</h2>
            {frequencyPrediction === undefined
              ? <p>You chose <strong>{action.label}</strong>. {!isEvGrade ? "This is educational feedback, not an exact EV-loss grade." : ""}</p>
              : <p>You predicted the exact held-combo mix. <strong>{action.label}</strong> was source-sampled only to continue the same hand.</p>}
          </div>
          <div className="sheet-header-actions">
            <button
              type="button"
              className="quiet-button header-explanation-button"
              aria-expanded={expanded}
              aria-controls="full-explanation"
              onClick={toggleExplanation}
            >
              {expanded ? "Hide" : "Go deeper"}
            </button>
            <button type="button" className="quiet-button" onClick={() => dialogRef.current?.close()}>Close</button>
          </div>
        </header>

        <div className="sheet-summary">
          <section className="coaching-lesson" aria-label="The poker lesson">
            <h3>{lesson.title}</h3>
            <p className="lesson-principle">{lesson.principle}</p>
            <h4>In this hand</h4>
            <p>{lesson.inThisHand}</p>
            <details><summary>When this changes</summary><p>{lesson.watchOut}</p></details>
            <small>Educational principle · the solver numbers are separate below.</small>
          </section>
          {frequencyPrediction === undefined ? reveal.grade.mode === "EV" ? <div className="lesson-grade"><GradeScale grade={reveal.grade} /></div> : null : <FrequencyGradeScale prediction={frequencyPrediction} />}
          <details className="optional-math">
            <summary>Show the math and grading details</summary>
          {frequencyPrediction === undefined ? (
            <>
              <div className="result-status-line">
                <span>RNG: {rng.mode === "off" ? "Off" : rng.mode === "high" ? "High RNG" : "Low RNG"}</span>
                <span>{rng.mode === "off"
                  ? completeFrequencySet ? "Complete source mix · highest-frequency reference" : "RNG off · complete source mix unavailable"
                  : rng.available ? `Roll ${rng.roll ?? "hidden"} · genuine frequency buckets` : "No complete solved frequency set · no roll used"}</span>
              </div>
              <div className="result-core-grid">
                <div className="result-grade-column">
                  <GradeScale grade={reveal.grade} />
                  {reveal.grade.mode === "EV" ? (
                    <dl className="ev-loss-summary">
                      <div><dt>Chosen EV loss</dt><dd>{bbToNumber(reveal.grade.evLossBB).toFixed(2)} BB</dd></div>
                      <div><dt>Loss relative to pot</dt><dd>{reveal.grade.evLossPctPot.toFixed(2)}%</dd></div>
                    </dl>
                  ) : null}
                </div>
                <OddsSummary state={state} decisionMath={reveal.decisionMath} compact />
              </div>
              {rng.mode === "off" || rngRoll === undefined || rngBuckets.length === 0
                ? null
                : <RngBucketVisualization state={state} mode={rng.mode} roll={rngRoll} buckets={rngBuckets} />}
            </>
          ) : (
            <>
              <div className="result-status-line"><span>Frequency drill</span><span>Reference revealed after submission · rollout {(frequencyPrediction.rolloutRoll * 100).toFixed(1)}%</span></div>
              <FrequencyGradeScale prediction={frequencyPrediction} />
              <OddsSummary state={state} decisionMath={reveal.decisionMath} compact />
            </>
          )}
          </details>
          <div className="result-actions">
            <button type="button" className="primary-button" disabled={continuing} onClick={onContinue}>{continuing ? "Continuing…" : continueLabel}</button>
            <button
              type="button"
              className="explanation-toggle"
              aria-expanded={expanded}
              aria-controls="full-explanation"
              onClick={toggleExplanation}
            >
              {expanded ? "Hide details" : "Explore this hand"}
            </button>
            <button type="button" className="secondary-button next-spot-result" disabled={continuing} onClick={onNext}>Next spot →</button>
            <button type="button" className="secondary-button" disabled={continuing} onClick={onReset}>Replay this spot</button>
          </div>
          {visibleReference.length === 0 ? null : (
            <details className="result-reference-strip optional-math" aria-label="Reference strategy for Hero's exact hand">
              <summary>See each action’s frequency and expected value</summary>
              <div>{visibleReference.map((item) => (
                <article key={actionKey(item.action)}>
                  <strong>{strategyActionLabel(state, item)}</strong>
                  <span>{formatStrategyFrequency(item.frequency)}</span>
                  <span>{item.evBB === undefined ? "EV unavailable" : `${bbToNumber(item.evBB).toFixed(2)} BB EV`}</span>
                </article>
              ))}</div>
            </details>
          )}
        </div>
        {expanded ? <FullExplanation state={state} action={action} reveal={reveal} heroSeatId={heroSeatId} rng={rng} /> : null}
      </div>
    </dialog>
  );
}

type ExactCombo = {
  label: string;
  status: string;
  domainCards: readonly [DomainCard, DomainCard];
  weight?: number;
  actions?: readonly { label: string; frequency: number; ev?: string }[];
};

const UI_TO_DOMAIN_SUIT = { "♠": "s", "♥": "h", "♦": "d", "♣": "c" } as const;

function domainCombo(first: string, second: string): readonly [DomainCard, DomainCard] {
  return [
    domainCard(`${first[0]}${UI_TO_DOMAIN_SUIT[first[1] as keyof typeof UI_TO_DOMAIN_SUIT]}`),
    domainCard(`${second[0]}${UI_TO_DOMAIN_SUIT[second[1] as keyof typeof UI_TO_DOMAIN_SUIT]}`),
  ];
}

function handClassForCards(cards: readonly [DomainCard, DomainCard]): string {
  const [first, second] = cards;
  const firstRank = first[0] ?? "A";
  const secondRank = second[0] ?? "A";
  if (firstRank === secondRank) return `${firstRank}${secondRank}`;
  const ordered = RANKS.indexOf(firstRank) < RANKS.indexOf(secondRank) ? [firstRank, secondRank] : [secondRank, firstRank];
  return `${ordered[0]}${ordered[1]}${first[1] === second[1] ? "s" : "o"}`;
}

function combosFor(hand: string, state: TrainerState, strategy?: StrategyResult): ExactCombo[] {
  const rankA = hand[0] ?? "A";
  const rankB = hand[1] ?? "A";
  const kind = hand.length === 2 ? "pair" : hand[2];
  const combos: Array<[string, string]> = [];
  if (kind === "pair") {
    SUITS.forEach((first, index) => SUITS.slice(index + 1).forEach((second) => combos.push([`${rankA}${first}`, `${rankB}${second}`])));
  } else if (kind === "s") {
    SUITS.forEach((suit) => combos.push([`${rankA}${suit}`, `${rankB}${suit}`]));
  } else {
    SUITS.forEach((first) => SUITS.forEach((second) => { if (first !== second) combos.push([`${rankA}${first}`, `${rankB}${second}`]); }));
  }
  const boardCards = new Set(state.board.map((card) => `${card.rank}${card.suit}`));
  const heroCards = new Set(state.seats.find((seat) => seat.isHero)?.holeCards?.map((card) => `${card.rank}${card.suit}`) ?? []);
  return combos.map(([first, second]) => {
    const domainCards = domainCombo(first, second);
    const policy = strategy?.comboPolicy?.find((row) => comboId(...row.cards) === comboId(...domainCards));
    return {
    label: `${first}${second}`,
    domainCards,
    status: heroCards.has(first) && heroCards.has(second)
      ? "Hero hand"
      : boardCards.has(first) || boardCards.has(second)
        ? "Board-blocked"
        : heroCards.has(first) || heroCards.has(second)
          ? "Card-removed"
          : "Available",
    ...(policy === undefined ? {} : {
      weight: policy.weight,
      actions: policy.actions.map((item) => ({
        label: strategyActionLabel(state, item),
        frequency: item.frequency,
        ...(item.evBB === undefined ? {} : { ev: `${bbToNumber(item.evBB).toFixed(2)} BB EV` }),
      })),
    }),
  };});
}

function RangeExplorer({ state, strategy }: { state: TrainerState; strategy?: StrategyResult }) {
  const [selected, setSelected] = useState("QTs");
  const combos = useMemo(() => combosFor(selected, state, strategy), [selected, state, strategy]);
  const handPolicies = useMemo(() => {
    const summaries = new Map<string, { total: number; byAction: Map<string, number> }>();
    for (const row of strategy?.comboPolicy ?? []) {
      const hand = handClassForCards(row.cards);
      const summary = summaries.get(hand) ?? { total: 0, byAction: new Map<string, number>() };
      summary.total += row.weight;
      for (const item of row.actions) {
        const key = actionKey(item.action);
        summary.byAction.set(key, (summary.byAction.get(key) ?? 0) + row.weight * item.frequency);
      }
      summaries.set(hand, summary);
    }
    return summaries;
  }, [strategy]);
  return (
    <div className="range-layout">
      <div className="matrix-scroll" role="region" aria-label="13 by 13 range matrix" tabIndex={0}>
        <div className="range-matrix">
          {RANKS.flatMap((row, rowIndex) => RANKS.map((column, columnIndex) => {
            const hand = rowIndex === columnIndex ? `${row}${column}` : rowIndex < columnIndex ? `${row}${column}s` : `${column}${row}o`;
            const policy = handPolicies.get(hand);
            const dominant = policy === undefined ? undefined : [...policy.byAction].sort((left, right) => right[1] - left[1])[0];
            const dominantPct = dominant === undefined || policy === undefined || policy.total <= 0 ? 0 : dominant[1] / policy.total;
            return (
              <button
                key={`${row}-${column}`}
                type="button"
                className={`${selected === hand ? "selected-cell" : ""} ${dominant === undefined ? "" : "policy-cell"}`}
                style={dominant === undefined ? undefined : ({ "--policy-mix": `${Math.round(dominantPct * 100)}%` } as CSSProperties)}
                aria-pressed={selected === hand}
                onClick={() => setSelected(hand)}
              >
                <span>{hand}</span><small>{dominant === undefined ? "—" : `${dominant[0].split(":")[0]} ${Math.round(dominantPct * 100)}%`}</small>
              </button>
            );
          }))}
        </div>
      </div>
      <aside className="combo-inspector" aria-live="polite">
        <h3>{selected} exact combinations</h3>
        <p>{strategy?.comboPolicy === undefined ? "Strategy weights unavailable. Known-card removal is exact." : `${strategy.provenance} combo policy · suit-specific frequencies are source supplied.`}</p>
        <ul>{combos.map((combo) => <li key={combo.label} className={combo.actions === undefined ? "" : "combo-with-policy"}><span>{combo.label}</span><small>{combo.status}{combo.weight === undefined ? "" : ` · weight ${combo.weight.toFixed(3)}`}</small>{combo.actions?.map((item) => <em key={item.label}>{item.label} {formatStrategyFrequency(item.frequency)}{item.ev === undefined ? "" : ` · ${item.ev}`}</em>)}</li>)}</ul>
      </aside>
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  );
}

function DrillPanel({
  rngMode,
  onRngModeChange,
  catalog,
  importedCatalogs,
  appliedSetup,
  activeProviderId,
  providers,
  onApply,
}: {
  rngMode: RngMode;
  onRngModeChange: (mode: RngMode) => void;
  catalog: AcceptanceSessionController["catalog"] | null;
  importedCatalogs: ReadonlyMap<string, AcceptanceSessionController["catalog"]>;
  appliedSetup: AppliedDrillSetup;
  activeProviderId: string;
  providers: readonly RegisteredStrategyProvider[];
  onApply: (setup: AppliedDrillSetup, providerId: string) => void;
}) {
  const [drillMode, setDrillMode] = useState<UiDrillMode>(appliedSetup.drillMode);
  const [difficulty, setDifficulty] = useState<PracticeDifficulty>(appliedSetup.difficulty);
  const [seats, setSeats] = useState(appliedSetup.drillMode === "Full hand" ? String(appliedSetup.fullHand.playerCount) : String(appliedSetup.nodeFilter.tableSize ?? "Any"));
  const [stacks, setStacks] = useState(appliedSetup.fullHand.startingStacksBB.join(", "));
  const [buttonSeat, setButtonSeat] = useState(String(appliedSetup.fullHand.buttonIndex + 1));
  const [seed, setSeed] = useState(String(appliedSetup.fullHand.seed));
  const [providerId, setProviderId] = useState(activeProviderId);
  const [scenarioId, setScenarioId] = useState(appliedSetup.nodeFilter.scenarioId ?? "Any");
  const [setupIssue, setSetupIssue] = useState<string | null>(null);
  const [hero, setHero] = useState(appliedSetup.nodeFilter.heroPosition ?? "Any");
  const [opponent, setOpponent] = useState(appliedSetup.nodeFilter.opponentPosition ?? "Any");
  const [stack, setStack] = useState(appliedSetup.nodeFilter.stack?.mode === "fixed" ? String(bbToNumber(appliedSetup.nodeFilter.stack.stackBB)) : "Any");
  const [street, setStreet] = useState(appliedSetup.nodeFilter.street ?? "all");
  const [preflopLine, setPreflopLine] = useState(appliedSetup.nodeFilter.preflopLine ?? "Any");
  const [potType, setPotType] = useState(appliedSetup.nodeFilter.potType ?? "Any");
  const [playersInPot, setPlayersInPot] = useState(appliedSetup.nodeFilter.playersCurrentlyInPot === undefined ? "Any" : String(appliedSetup.nodeFilter.playersCurrentlyInPot));
  const [texture, setTexture] = useState(appliedSetup.nodeFilter.boardTexture ?? "Any");
  const [handClass, setHandClass] = useState(appliedSetup.nodeFilter.heroHandClass ?? "Any");
  const [drawClass, setDrawClass] = useState(appliedSetup.nodeFilter.drawClass ?? "Any");
  const [strategicClass, setStrategicClass] = useState(appliedSetup.nodeFilter.strategicClass ?? "Any");
  useEffect(() => {
    setProviderId(activeProviderId);
    setScenarioId(appliedSetup.nodeFilter.scenarioId ?? "Any");
  }, [activeProviderId, appliedSetup.nodeFilter.scenarioId]);
  useEffect(() => {
    setDrillMode(appliedSetup.drillMode);
    setSeats(appliedSetup.drillMode === "Full hand" ? String(appliedSetup.fullHand.playerCount) : String(appliedSetup.nodeFilter.tableSize ?? "Any"));
    setStacks(appliedSetup.fullHand.startingStacksBB.join(", "));
    setButtonSeat(String(appliedSetup.fullHand.buttonIndex + 1));
    setSeed(String(appliedSetup.fullHand.seed));
  }, [appliedSetup.drillMode, appliedSetup.fullHand, appliedSetup.nodeFilter.tableSize]);
  const filter = useMemo<ScenarioFilter>(() => scenarioId !== "Any" ? { scenarioId } : ({
    ...(seats === "Any" ? {} : { tableSize: Number(seats) as 4 | 5 | 6 | 7 | 8 }),
    ...(hero === "Any" ? {} : { heroPosition: hero }),
    ...(opponent === "Any" ? {} : { opponentPosition: opponent }),
    ...(stack === "Any" ? {} : { stack: { mode: "fixed" as const, stackBB: bb(Number(stack)) } }),
    ...(street === "all" ? {} : { street: street as "preflop" | "flop" | "turn" | "river" }),
    ...(preflopLine === "Any" ? {} : { preflopLine: preflopLine as NonNullable<ScenarioFilter["preflopLine"]> }),
    ...(potType === "Any" ? {} : { potType: potType as NonNullable<ScenarioFilter["potType"]> }),
    ...(playersInPot === "Any" ? {} : { playersCurrentlyInPot: Number(playersInPot) }),
    ...(texture === "Any" ? {} : { boardTexture: texture }),
    ...(handClass === "Any" ? {} : { heroHandClass: handClass }),
    ...(drawClass === "Any" ? {} : { drawClass }),
    ...(strategicClass === "Any" ? {} : { strategicClass }),
  }), [drawClass, handClass, hero, opponent, playersInPot, potType, preflopLine, scenarioId, seats, stack, strategicClass, street, texture]);
  const selectedCatalog = importedCatalogs.get(providerId) ?? catalog;
  const scenarioOptions = selectedCatalog?.all() ?? [];
  const compatible = selectedCatalog === null || selectedCatalog === undefined ? 0 : countCompatibleScenarios(selectedCatalog, filter);
  const apply = () => {
    const playerCount = Number(seats) as FullHandDealOptions["playerCount"];
    const stackValues = stacks.split(",").map((value) => Number(value.trim()));
    const parsedButton = Number(buttonSeat) - 1;
    const parsedSeed = Number(seed);
    if (drillMode === "Full hand" && ![4, 5, 6, 7, 8].includes(playerCount)) return setSetupIssue("Full-hand mode supports 4 through 8 seats.");
    if (drillMode === "Full hand") {
      if (stackValues.length !== playerCount || stackValues.some((value) => !Number.isFinite(value) || value <= 0)) {
        return setSetupIssue(`Enter ${playerCount} positive comma-separated stacks, one per seat.`);
      }
      if (!Number.isSafeInteger(parsedButton) || parsedButton < 0 || parsedButton >= playerCount) {
        return setSetupIssue(`Button seat must be between 1 and ${playerCount}.`);
      }
      if (!Number.isSafeInteger(parsedSeed)) return setSetupIssue("Deal seed must be a whole safe integer.");
    }
    if (drillMode === "Node drill" && compatible === 0) return setSetupIssue("No validated catalog node matches these filters. Broaden the filters; no synthetic node will be created.");
    setSetupIssue(null);
    onApply({
      drillMode,
      difficulty,
      nodeFilter: filter,
      fullHand: drillMode === "Full hand" ? { playerCount, startingStacksBB: stackValues, buttonIndex: parsedButton, seed: parsedSeed } : appliedSetup.fullHand,
    }, providerId);
  };
  const updateSeatCount = (value: string) => {
    setSeats(value);
    if (value === "Any") return;
    const count = Number(value);
    if (![4, 5, 6, 7, 8].includes(count)) return;
    const current = stacks.split(",").map((item) => Number(item.trim())).map((item) => Number.isFinite(item) && item > 0 ? item : 100);
    const next = Array.from({ length: count }, (_, index) => current[index] ?? 100);
    setStacks(next.join(", "));
    if (!Number.isSafeInteger(Number(buttonSeat)) || Number(buttonSeat) < 1 || Number(buttonSeat) > count) setButtonSeat("1");
  };
  const updateDrillMode = (value: string) => {
    setDrillMode(value as UiDrillMode);
    if (value === "Full hand") {
      updateSeatCount(seats === "Any" ? String(appliedSetup.fullHand.playerCount) : seats);
    }
  };
  return (
    <div className="workspace-panel drill-panel" role="tabpanel" id="panel-drill" aria-labelledby="tab-drill">
      <div className="workspace-copy">
        <h3>Drill setup</h3>
        <p>Build your practice deck by street, position, depth, and texture. Every matching spot has a validated legal history; generated ranges are declared study inputs.</p>
      </div>
      <div className="rng-control">
        <label htmlFor="rng-mode">RNG mode</label>
        <select id="rng-mode" value={rngMode} onChange={(event) => onRngModeChange(event.target.value as RngMode)}>
          <option>Off</option><option>High RNG</option><option>Low RNG</option>
        </select>
        <p>{rngMode === "Off" ? "No roll is used." : "Mode selected; bucket grading is locked because no action frequencies are available."}</p>
      </div>
      {drillMode === "Node drill" ? (
        <p className={`catalog-count ${compatible === 0 ? "catalog-empty" : ""}`} aria-live="polite">
          <strong>{compatible}</strong> compatible validated scenario{compatible === 1 ? "" : "s"}
          {compatible === 0 ? " · no fabricated node will be synthesized" : " · exact catalog node available"}
        </p>
      ) : (
        <p className="catalog-count">A new collision-free deal is sampled from public 1,326-combo priors. Opponent actions require combo-policy coverage from the selected provider.</p>
      )}
      <div className="settings-grid">
        <FilterSelect label="Drill mode" value={drillMode} options={["Node drill", "Full hand"]} onChange={updateDrillMode} />
        <FilterSelect label="Seats" value={seats} options={drillMode === "Full hand" ? ["4", "5", "6", "7", "8"] : ["Any", "4", "5", "6", "7", "8"]} onChange={updateSeatCount} />
        <label><span>Strategy provider</span><select value={providerId} onChange={(event) => {
          const nextProvider = event.target.value;
          setProviderId(nextProvider);
          setScenarioId("Any");
        }}>{providers.map((entry) => <option key={entry.provider.id} value={entry.provider.id} disabled={entry.availability.state !== "AVAILABLE"}>{entry.metadata.label} · {entry.availability.state}</option>)}</select></label>
        {drillMode === "Full hand" ? (
          <>
            <label className="stack-list-field"><span>Starting stacks by seat (BB)</span><input value={stacks} onChange={(event) => setStacks(event.target.value)} inputMode="decimal" aria-describedby="full-hand-stack-help" /></label>
            <label><span>Button seat</span><input value={buttonSeat} onChange={(event) => setButtonSeat(event.target.value)} inputMode="numeric" /></label>
            <label><span>Deterministic deal seed</span><input value={seed} onChange={(event) => setSeed(event.target.value)} inputMode="numeric" /></label>
          </>
        ) : (
          <>
            <label className="scenario-select"><span>Validated scenario</span><select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}><option value="Any">Any filtered node</option>{scenarioOptions.map(({ facts }) => <option key={facts.id} value={facts.id}>{facts.id} · {facts.heroPosition} vs {facts.opponentPositions.join("/")} · {facts.street}</option>)}</select></label>
            <FilterSelect label="Hero position" value={hero} options={["Any", "UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"]} onChange={setHero} />
            <FilterSelect label="Opponent position" value={opponent} options={["Any", "UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"]} onChange={setOpponent} />
            <FilterSelect label="Stack depth (BB)" value={stack} options={["Any", "10", "15", "20", "25", "30", "40", "50", "75", "100", "150", "200"]} onChange={setStack} />
            <FilterSelect label="Street" value={street} options={["all", "preflop", "flop", "turn", "river"]} onChange={setStreet} />
            <FilterSelect label="Preflop line" value={preflopLine} options={["Any", "RFI", "vs-limp", "vs-open", "squeeze", "vs-3-bet", "vs-4-bet", "vs-shove", "blind-vs-blind", "multiway"]} onChange={setPreflopLine} />
            <FilterSelect label="Pot type" value={potType} options={["Any", "limped", "SRP", "3-bet", "4-bet", "5-bet", "multiway"]} onChange={setPotType} />
            <FilterSelect label="Players in pot" value={playersInPot} options={["Any", "2", "3", "4", "5", "6", "7", "8"]} onChange={setPlayersInPot} />
            <FilterSelect label="Board texture" value={texture} options={["Any", "high-card-board", "low-board", "paired", "double-paired", "monotone", "two-tone", "rainbow", "connected", "disconnected", "dynamic", "static", "Broadway-heavy", "ace-high", "king-high", "queen-high", "paired-turn", "flush-completing-turn", "straight-completing-turn", "blank", "overcard", "undercard"]} onChange={setTexture} />
            <FilterSelect label="Hero hand class" value={handClass} options={["Any", "air", "ace-high", "pair", "underpair", "middle-pair", "top-pair", "overpair", "two-pair", "set", "trips", "straight", "flush", "full-house", "quads", "straight-flush"]} onChange={setHandClass} />
            <FilterSelect label="Draw class" value={drawClass} options={["Any", "no-draw", "gutshot", "OESD", "flush-draw", "nut-flush-draw", "combo-draw", "backdoor-flush", "backdoor-straight"]} onChange={setDrawClass} />
            <FilterSelect label="Strategic class" value={strategicClass} options={["Any", "pure-action", "mixed-action", "close-EV", "bluff-catcher", "value-bet", "thin-value", "bluff", "semi-bluff", "range-bet", "polarized-bet", "overbet", "check-raise", "probe", "delayed-c-bet", "donk", "river-bluff-catch"]} onChange={setStrategicClass} />
          </>
        )}
        <FilterSelect label="Difficulty" value={difficulty} options={["Simple", "Grouped", "Standard", "Frequency"]} onChange={(value) => setDifficulty(value as PracticeDifficulty)} />
      </div>
      {drillMode === "Full hand" ? <p className="adapter-note" id="full-hand-stack-help">Seat order is the internal clockwise seat order. Unequal stacks are preserved exactly; Hero is seat 3.</p> : null}
      {setupIssue === null ? null : <output className="import-result import-error">{setupIssue}</output>}
      <div className="drill-apply-row"><button type="button" className="primary-button" onClick={apply}>{drillMode === "Full hand" ? "Deal configured hand" : "Load catalog node"}</button><span>{providerId === EDUCATIONAL_PROVIDER_ID ? "HEURISTIC combo policy · no solver precision" : providerId === LOCAL_SOLVER_PROVIDER_ID ? "SOLVED where supported · visibly HEURISTIC otherwise" : "Exact provider match required; missing nodes block honestly"}</span></div>
    </div>
  );
}

function StrategyPanel({
  activeProviderId,
  providers,
  onProviderLoaded,
  onUseEducational,
  onProbeLocal,
  solverStatus,
}: {
  activeProviderId: string;
  providers: readonly RegisteredStrategyProvider[];
  onProviderLoaded: (result: Extract<ImportedPackResult, { status: "loaded" }>) => Promise<void>;
  onUseEducational: () => void;
  onProbeLocal: (endpoint: string) => Promise<LocalSolverProbeResult>;
  solverStatus: LocalSolverStatus | null;
}) {
  const [importResult, setImportResult] = useState<ImportedPackResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [endpoint, setEndpoint] = useState(DEFAULT_LOCAL_SOLVER_ENDPOINT);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<LocalSolverProbeResult | null>(null);
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    if (file.size > 5_000_000) {
      setImportResult({ status: "error", fileName: file.name, message: "Strategy packs are limited to 5 MB in this browser build." });
      event.target.value = "";
      return;
    }
    setImporting(true);
    const result = await importStrategyPackText(file.name, await file.text());
    setImportResult(result);
    if (result.status === "loaded") await onProviderLoaded(result);
    setImporting(false);
    event.target.value = "";
  };
  const probeLocal = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      setProbeResult(await onProbeLocal(endpoint.trim()));
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setProbeResult({
          status: "error",
          providerId: "local-solver",
          endpoint,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setProbing(false);
    }
  };
  return (
    <div className="workspace-panel" role="tabpanel" id="panel-strategy" aria-labelledby="tab-strategy">
      <div className="workspace-copy"><h3>Strategy provenance</h3><p>Schema 2 packs become active only after every solved node is replayed through the rules engine and its state, five hashes, legal actions, and exact-combo rows match. Aggregate charts are rejected because they cannot support exact-suit grading.</p></div>
      {solverStatus === null ? null : <section className="solver-status-panel" aria-label="Live solver status"><h4>Local solver · {solverStatus.activity.phase}</h4><dl><div><dt>Reusable solved nodes</dt><dd>{solverStatus.cache.entries}</dd></div><div><dt>Cache hits</dt><dd>{solverStatus.cache.hits}</dd></div><div><dt>Completed solves</dt><dd>{solverStatus.activity.completedSolves}</dd></div><div><dt>Current iterations</dt><dd>{solverStatus.activity.iterations}</dd></div><div><dt>Convergence target</dt><dd>{solverStatus.limits.targetExploitabilityPctPot}% pot</dd></div><div><dt>Memory budget</dt><dd>{solverStatus.limits.maxMemoryMB} MB</dd></div></dl><p>Heads-up flop, turn, and river · weighted ranges · unequal stacks · rake. {solverStatus.cache.persistent ? "Exact results persist across server restarts." : "Cache is memory-only."}</p><p>{solverStatus.capabilities.unsupported.join(" · ")}</p></section>}
      <div className="strategy-import">
        <label className="file-button">
          <span>{importing ? "Validating…" : "Import strategy pack"}</span>
          <input type="file" accept=".json,.csv,application/json,text/csv" disabled={importing} onChange={(event) => void importFile(event)} />
        </label>
        <p>Active provider: <strong>{providers.find(({ provider }) => provider.id === activeProviderId)?.metadata.label ?? activeProviderId}</strong></p>
        {activeProviderId !== EDUCATIONAL_PROVIDER_ID ? <button type="button" className="secondary-button provider-reset" onClick={onUseEducational}>Use educational fallback</button> : null}
        {importResult === null ? null : importResult.status === "loaded" ? (
          <output className="import-result import-success">
            Loaded {importResult.sourceName} {importResult.sourceVersion} · {importResult.nodeCount} legally replayed solved drill{importResult.nodeCount === 1 ? "" : "s"} · {importResult.comboRowCount} exact combo rows · {importResult.completeEvComboRowCount} with complete action EVs · {importResult.timestamp}
          </output>
        ) : (
          <output className="import-result import-error">{importResult.fileName}: {importResult.message}</output>
        )}
      </div>
      <form className="local-solver-form" onSubmit={(event) => { event.preventDefault(); void probeLocal(); }}>
        <label htmlFor="local-solver-endpoint"><span>Local sidecar endpoint</span><input id="local-solver-endpoint" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} spellCheck={false} /></label>
        <button type="submit" className="primary-button" disabled={probing}>{probing ? "Verifying exact node…" : "Verify and use"}</button>
        <p>Configuration is not availability. The trainer sends the exact acceptance query and activates this provider only after a normalized SOLVED response passes identity, state, and legal-action checks.</p>
        {probeResult === null ? null : (
          <output className={`import-result ${probeResult.status === "available" ? "import-success" : "import-error"}`}>
            {probeResult.status === "available" ? "Available · " : "Unavailable · "}{probeResult.message}
          </output>
        )}
      </form>
      <div className="provider-table">
        {providers.map((entry) => (
          <div key={entry.provider.id}>
            <strong>{entry.metadata.label}</strong>
            <span>{entry.metadata.description ?? entry.metadata.source ?? "No source description"}</span>
            <span>
              {entry.provider.id === activeProviderId ? "Active · " : ""}{entry.availability.state}
              {entry.availability.reason === undefined ? "" : ` · ${entry.availability.reason}`}
            </span>
          </div>
        ))}
        {!providers.some(({ metadata }) => metadata.kind === "SOLVED_PACK") ? <div><strong>Imported solution</strong><span>No validated pack registered</span><span>UNAVAILABLE</span></div> : null}
        {!providers.some(({ metadata }) => metadata.kind === "LOCAL_SOLVER") ? <div><strong>Local solver sidecar</strong><span>{DEFAULT_LOCAL_SOLVER_ENDPOINT}</span><span>UNAVAILABLE · not verified</span></div> : null}
        <div><strong>Interpolation</strong><span>No compatible solved anchors registered</span><span>UNAVAILABLE</span></div>
      </div>
    </div>
  );
}

function SessionPanel({ analytics }: { analytics: SessionAnalyticsState }) {
  const summary = summarizeAnalytics(analytics);
  const leak = largestLeak(analytics);
  const evDisplay = summary.totalEvLossBB === undefined ? "Unavailable" : `${summary.totalEvLossBB.toFixed(2)} BB`;
  const gradeEntries = Object.entries(summary.gradeCounts).sort((left, right) => right[1] - left[1]);
  const evBreakdowns = [
    ["Position", summary.byPosition],
    ["Street", summary.byStreet],
    ["Pot type", summary.byPotType],
    ["Stack", summary.byStackDepth],
    ["Hand class", summary.byHandClass],
    ["Sizing", summary.bySizing],
  ] as const;
  const mixBreakdowns = [
    ["Street", summary.mixByStreet],
    ["Position", summary.mixByPosition],
  ] as const;
  return (
    <div className="workspace-panel" role="tabpanel" id="panel-session" aria-labelledby="tab-session">
      <div className="workspace-copy"><h3>Session analytics</h3><p>EV and frequency metrics include only decisions where the active source supplied the required fields.</p></div>
      <div className="analytics-grid">
        <div><strong>{summary.handsStarted}</strong><span>Hands started</span></div>
        <div><strong>{summary.totalDecisions}</strong><span>Decisions</span></div>
        <div><strong>{evDisplay}</strong><span>Total EV loss · {summary.evKnownDecisions} EV-backed</span></div>
        <div><strong>{summary.averageEvLossPerDecisionBB === undefined ? "Unavailable" : `${summary.averageEvLossPerDecisionBB.toFixed(3)} BB`}</strong><span>Average EV loss / backed decision</span></div>
        <div><strong>{summary.averageEvLossPctPot === undefined ? "Unavailable" : `${summary.averageEvLossPctPot.toFixed(2)}%`}</strong><span>Average loss relative to pot</span></div>
        <div><strong>{summary.averageFrequencyDeviation === undefined ? "Unavailable" : `${(summary.averageFrequencyDeviation * 100).toFixed(1)}%`}</strong><span>Mean reference-frequency deviation · {summary.frequencyKnownDecisions} backed</span></div>
        <div><strong>{summary.averageMixDistance === undefined ? "Unavailable" : `${(summary.averageMixDistance * 100).toFixed(1)}%`}</strong><span>Mean predicted-mix distance · {summary.frequencyPredictionCount} exercises</span></div>
      </div>
      <section className="analytics-section">
        <h4>Verdict distribution</h4>
        {gradeEntries.length === 0 ? <p>No decisions recorded yet.</p> : <div className="grade-distribution">{gradeEntries.map(([grade, count]) => <div key={grade}><span>{grade}</span><strong>{count}</strong><small>{((count / summary.totalDecisions) * 100).toFixed(1)}%</small></div>)}</div>}
      </section>
      <section className="analytics-section">
        <h4>EV-backed performance slices</h4>
        {summary.evKnownDecisions === 0 ? <p>No EV-backed decisions are available yet.</p> : (
          <div className="analytics-breakdown-grid">
            {evBreakdowns.map(([label, groups]) => (
              <article key={label}>
                <strong>{label}</strong>
                {Object.entries(groups).sort((left, right) => right[1].evLossBB - left[1].evLossBB).map(([group, value]) => (
                  <div key={group}><span>{group}</span><b>{value.evKnown === 0 ? "EV unavailable" : `${value.evLossBB.toFixed(2)} BB · ${value.evKnown}`}</b></div>
                ))}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="analytics-section">
        <h4>Frequency-prediction performance</h4>
        {summary.frequencyPredictionCount === 0 ? <p>No exact-mix exercises recorded yet. Sampled rollout actions are never counted as user choices.</p> : (
          <div className="analytics-breakdown-grid">
            {mixBreakdowns.map(([label, groups]) => (
              <article key={label}>
                <strong>{label}</strong>
                {Object.entries(groups).sort((left, right) => right[1].meanDistance - left[1].meanDistance).map(([group, value]) => (
                  <div key={group}><span>{group}</span><b>{(value.meanDistance * 100).toFixed(1)}% TVD · {value.attempts}</b></div>
                ))}
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="analytics-section">
        <h4>Concept review queue</h4>
        {summary.dueConcepts.length === 0 ? <p>No concept is due at this decision index. Failed concepts return sooner and receive higher sampling weights.</p> : (
          <div className="concept-queue">{summary.dueConcepts.map((concept) => <div key={concept.tag}><strong>{concept.tag}</strong><span>{concept.failures} misses · streak {concept.streak}</span><b>{concept.samplingWeight.toFixed(2)}×</b></div>)}</div>
        )}
      </section>
      <output className={`builder-output ${leak.available ? "" : "analytics-unavailable"}`}>
        {leak.available
          ? `Largest EV-backed group: ${leak.dimension} ${leak.group} · ${leak.evLossBB?.toFixed(2)} BB across ${leak.decisions} decisions (${leak.averageEvLossBB?.toFixed(3)} BB/decision).`
          : `Leak report unavailable · ${leak.reason}`}
      </output>
    </div>
  );
}

const CUSTOM_SPOT_EXAMPLE = JSON.stringify({
  playerCount: 8,
  buttonIndex: 0,
  heroSeatIndex: 2,
  startingStacksBB: [100, 100, 100, 100, 100, 100, 100, 100],
  fixedHoleCards: { "2": ["Qs", "Ts"] },
  futureBoard: ["Qh", "8s", "4s", "2c", "Kd"],
  actionTree: {
    flop: [
      { type: "raise-to", toBB: 5.5 },
      { type: "raise-to", toBB: 7.2 },
      { type: "raise-to", toBB: 9 },
      { type: "all-in" },
    ],
  },
  actions: [
    { kind: "fold" }, { kind: "fold" }, { kind: "fold" }, { kind: "fold" },
    { kind: "raise", toBB: 2.5 }, { kind: "fold" }, { kind: "fold" },
    { kind: "call", amountBB: 1.5 }, { kind: "check" }, { kind: "bet", toBB: 1.8 },
  ],
  expected: { actorSeatIndex: 2, street: "flop", board: ["Qh", "8s", "4s"], potBB: 7.3, currentBetBB: 1.8 },
}, null, 2);

function BuilderPanel({ onLoad }: { onLoad: (source: string) => Promise<void> }) {
  const [source, setSource] = useState(CUSTOM_SPOT_EXAMPLE);
  const [result, setResult] = useState<CustomSpotValidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setLoadIssue(null);
    try {
      await onLoad(source);
    } catch (error) {
      setLoadIssue(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="workspace-panel" role="tabpanel" id="panel-builder" aria-labelledby="tab-builder">
      <div className="workspace-copy"><h3>Custom spot builder</h3><p>Replay a complete configuration through PokerRulesEngine. Unknown hole cards are dealt deterministically; expected pot, board, actor, stacks, and contributions are checked after the replay.</p></div>
      <div className="custom-builder-layout">
        <label><span>Spot JSON</span><textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} /></label>
        <aside>
          <h4>Accepted controls</h4>
          <p>4–8 seats · Button · Hero seat · unequal stacks · blinds · antes · BB ante · straddle · rake · fixed or unknown cards · public combo ranges · dead cards · future board · full action history · fixed sizing tree · expected ledger.</p>
          <button type="button" className="primary-button" onClick={() => setResult(parseAndValidateCustomSpot(source))}>Validate legal reachability</button>
          <button type="button" className="secondary-button" onClick={() => { setSource(CUSTOM_SPOT_EXAMPLE); setResult(null); }}>Restore example</button>
          <button type="button" className="secondary-button" disabled={!result?.valid || loading} onClick={() => void load()}>{loading ? "Loading legal state…" : "Load as playable drill"}</button>
        </aside>
      </div>
      {result === null ? <output className="builder-output">Not checked</output> : (
        <output className={`builder-output ${result.valid ? "import-success" : "import-error"}`}>
          <strong>{result.valid ? "Legally reachable" : "Invalid custom spot"}</strong>
          {result.issues.map((issue) => <span key={issue}>{issue}</span>)}
          {result.summary === undefined ? null : <span>{result.summary.street} · actor {result.summary.actor} · pot {formatBB(result.summary.potBB)} · current bet {formatBB(result.summary.currentBetBB)} · {result.summary.actionCount} actions</span>}
        </output>
      )}
      {loadIssue === null ? null : <output className="builder-output import-error">{loadIssue}</output>}
    </div>
  );
}

function WorkspaceDialog({
  dialogRef,
  launcherRef,
  state,
  rngMode,
  onRngModeChange,
  catalog,
  importedCatalogs,
  decisionMath,
  strategy,
  activeProviderId,
  providers,
  onProviderLoaded,
  onUseEducational,
  onProbeLocal,
  analytics,
  appliedSetup,
  onApplySetup,
  onLoadCustomSpot,
  tab,
  onTabChange,
  solverStatus,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  launcherRef: RefObject<HTMLButtonElement | null>;
  state: TrainerState;
  rngMode: RngMode;
  onRngModeChange: (mode: RngMode) => void;
  catalog: AcceptanceSessionController["catalog"] | null;
  importedCatalogs: ReadonlyMap<string, AcceptanceSessionController["catalog"]>;
  decisionMath?: DecisionMath;
  strategy?: StrategyResult;
  activeProviderId: string;
  providers: readonly RegisteredStrategyProvider[];
  onProviderLoaded: (result: Extract<ImportedPackResult, { status: "loaded" }>) => Promise<void>;
  onUseEducational: () => void;
  onProbeLocal: (endpoint: string) => Promise<LocalSolverProbeResult>;
  analytics: SessionAnalyticsState;
  appliedSetup: AppliedDrillSetup;
  onApplySetup: (setup: AppliedDrillSetup, providerId: string) => void;
  onLoadCustomSpot: (source: string) => Promise<void>;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  solverStatus: LocalSolverStatus | null;
}) {
  const activateTab = (next: WorkspaceTab) => {
    onTabChange(next);
    requestAnimationFrame(() => document.getElementById(`tab-${workspaceTabSlug(next)}`)?.focus());
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % WORKSPACE_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = WORKSPACE_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(WORKSPACE_TABS[nextIndex] ?? "Drill");
  };
  return (
    <dialog ref={dialogRef} className="workspace-dialog" aria-labelledby="workspace-heading" onClose={() => launcherRef.current?.focus()}>
      <div className="workspace-shell">
        <header className="workspace-header">
          <div><h2 id="workspace-heading" tabIndex={-1}>Study workspace</h2><p>Configure, inspect, and verify without crowding the table.</p></div>
          <button type="button" className="quiet-button" onClick={() => dialogRef.current?.close()}>Close</button>
        </header>
        <div className="workspace-tabs" role="tablist" aria-label="Study workspace sections">
          {WORKSPACE_TABS.map((item, index) => (
            <button
              key={item}
              id={`tab-${workspaceTabSlug(item)}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`panel-${workspaceTabSlug(item)}`}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => activateTab(item)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >{item}</button>
          ))}
        </div>
        <div className="workspace-content">
          {tab === "Drill" ? <DrillPanel rngMode={rngMode} onRngModeChange={onRngModeChange} catalog={catalog} importedCatalogs={importedCatalogs} appliedSetup={appliedSetup} activeProviderId={activeProviderId} providers={providers} onApply={onApplySetup} /> : null}
          {tab === "Range" ? <div className="workspace-panel" role="tabpanel" id="panel-range" aria-labelledby="tab-range"><div className="workspace-copy"><h3>Range explorer</h3><p>Known-card removal is exact. Source combo weights, frequencies, and EV appear only after a strategy result supplies them.</p></div><RangeExplorer state={state} {...(strategy === undefined ? {} : { strategy })} /></div> : null}
          {tab === "Odds / Math" ? <div className="workspace-panel" role="tabpanel" id="panel-odds-math" aria-labelledby="tab-odds-math"><div className="workspace-copy"><h3>Odds and exact math</h3><p>All displayed quantities use the current state inputs.</p></div><OddsSummary state={state} {...(decisionMath === undefined ? {} : { decisionMath })} /></div> : null}
          {tab === "Strategy" ? <StrategyPanel activeProviderId={activeProviderId} providers={providers} onProviderLoaded={onProviderLoaded} onUseEducational={onUseEducational} onProbeLocal={onProbeLocal} solverStatus={solverStatus} /> : null}
          {tab === "Session" ? <SessionPanel analytics={analytics} /> : null}
          {tab === "Builder" ? <BuilderPanel onLoad={onLoadCustomSpot} /> : null}
        </div>
      </div>
    </dialog>
  );
}

function HistoryDialog({
  dialogRef,
  launcherRef,
  history,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  launcherRef: RefObject<HTMLButtonElement | null>;
  history: string[];
}) {
  return (
    <dialog ref={dialogRef} className="history-dialog" aria-labelledby="history-heading" onClose={() => launcherRef.current?.focus()}>
      <header><div><h2 id="history-heading">Action history</h2><p>{history.length} recorded actions</p></div><button type="button" className="quiet-button" onClick={() => dialogRef.current?.close()}>Close</button></header>
      <ol>{history.map((item, index) => <li key={`${item}-${index}`}><span>{index + 1}</span>{item}</li>)}</ol>
    </dialog>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("hand-compass-theme") as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [state, setState] = useState<TrainerState | null>(null);
  const [controller, setController] = useState<AcceptanceSessionController | null>(null);
  const [snapshot, setSnapshot] = useState<DrillSnapshot | null>(null);
  const [providerRegistry] = useState(createAcceptanceProviderRegistry);
  const [, setRegistryRevision] = useState(0);
  const [practiceCatalog] = useState(() => createPracticeCatalog(providerRegistry.requireAvailable(BUNDLED_SOLVED_PROVIDER_ID)));
  const queueRef = useRef<PracticeQueue | null>(null);
  const queuesByCatalogRef = useRef(new Map<AcceptanceSessionController["catalog"], PracticeQueue>());
  if (queueRef.current === null) {
    queueRef.current = createPracticeQueue(practiceCatalog, { seed: Date.now() });
    queuesByCatalogRef.current.set(practiceCatalog, queueRef.current);
  }
  const replayScenarioRef = useRef<string | null>(null);
  const currentScenarioIdRef = useRef<string | null>(null);
  const currentModeRef = useRef<UiDrillMode>(DEFAULT_DRILL_SETUP.drillMode);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [previewAction, setPreviewAction] = useState<LegalAction | null>(null);
  const [solverStatus, setSolverStatus] = useState<LocalSolverStatus | null>(null);
  const [solverConnecting, setSolverConnecting] = useState(false);
  const [savedSpots, setSavedSpots] = useState<readonly string[]>(() => {
    try { const parsed: unknown = JSON.parse(window.localStorage.getItem("hand-compass-saved-spots-v1") ?? "[]"); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
  });
  const [savedOnly, setSavedOnly] = useState(false);
  const savedSpotsRef = useRef(savedSpots);
  savedSpotsRef.current = savedSpots;
  const savedCursorRef = useRef(0);
  const userAnsweredRef = useRef(false);
  const [importedCatalogs, setImportedCatalogs] = useState<ReadonlyMap<string, AcceptanceSessionController["catalog"]>>(() => new Map());
  const [activeProviderId, setActiveProviderId] = useState(BUNDLED_SOLVED_PROVIDER_ID);
  const activeProviderIdRef = useRef(activeProviderId);
  activeProviderIdRef.current = activeProviderId;
  const [selected, setSelected] = useState<LegalAction | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [analytics, setAnalytics] = useState<SessionAnalyticsState>(() => parseSessionAnalytics(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)));
  const analyticsRef = useRef(analytics);
  analyticsRef.current = analytics;
  const [rngMode, setRngMode] = useState<RngMode>("Off");
  const [drillSetup, setDrillSetup] = useState<AppliedDrillSetup>(DEFAULT_DRILL_SETUP);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("Drill");
  const [loading, setLoading] = useState(true);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultDialogRef = useRef<HTMLDialogElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const workspaceDialogRef = useRef<HTMLDialogElement>(null);
  const historyDialogRef = useRef<HTMLDialogElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const lastActionButtonRef = useRef<HTMLButtonElement | null>(null);
  const suppressResultRestoreRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const probeGenerationRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const continueAbortRef = useRef<AbortController | null>(null);
  const probeAbortRef = useRef<AbortController | null>(null);
  const customSourceRef = useRef<string | null>(null);
  const handIdRef = useRef("hand-initializing");
  const activeProviderEntry = providerRegistry.get(activeProviderId);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    window.localStorage.setItem("hand-compass-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(analytics));
  }, [analytics]);

  useEffect(() => { window.localStorage.setItem("hand-compass-saved-spots-v1", JSON.stringify(savedSpots)); }, [savedSpots]);

  const startSession = useCallback(async (mode: RngMode, providerId: string, setup: AppliedDrillSetup) => {
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    sessionAbortRef.current?.abort(new DOMException("A newer session request replaced this one", "AbortError"));
    continueAbortRef.current?.abort(new DOMException("The hand continuation was replaced by a new session", "AbortError"));
    const abortController = new AbortController();
    sessionAbortRef.current = abortController;
    setLoading(true);
    setError(null);
    setSelected(null);
    setExpanded(false);
    setSelectedSeat(null);
    setPreviewAction(null);
    setContinuing(false);
    try {
      const importedCatalog = importedCatalogs.get(providerId);
      const scenarioCatalog = importedCatalog ?? practiceCatalog;
      let nodeFilter = setup.nodeFilter;
      currentModeRef.current = setup.drillMode;
      currentScenarioIdRef.current = null;
      if (setup.drillMode === "Node drill") {
        let practiceQueue = queuesByCatalogRef.current.get(scenarioCatalog);
        if (practiceQueue === undefined) {
          practiceQueue = createPracticeQueue(scenarioCatalog, { seed: Date.now() });
          queuesByCatalogRef.current.set(scenarioCatalog, practiceQueue);
        }
        queueRef.current = practiceQueue;
        const replayId = replayScenarioRef.current;
        replayScenarioRef.current = null;
        const savedCandidates = savedOnly ? scenarioCatalog.filter(setup.nodeFilter).filter(({ definition }) => savedSpotsRef.current.includes(definition.id)) : [];
        const match = replayId !== null
          ? scenarioCatalog.filter({ scenarioId: replayId })[0]
          : savedOnly ? savedCandidates[savedCursorRef.current++ % Math.max(1, savedCandidates.length)]
            : practiceQueue.next(setup.nodeFilter, { currentDecision: analyticsRef.current.records.length, conceptReviews: Object.values(analyticsRef.current.concepts).filter((value) => value !== undefined) });
        if (match === undefined) throw new Error(savedOnly ? "No saved spots match these filters. Turn off saved-only practice or broaden the filters." : "No practice spots match these filters. Open Filters and broaden your selection.");
        nodeFilter = { scenarioId: match.definition.id };
        currentScenarioIdRef.current = match.definition.id;
      }
      const nextController = await createTrainerSession(mode, {
        registry: providerRegistry,
        activeProviderId: providerId,
        drillMode: setup.drillMode,
        fullHand: setup.fullHand,
        nodeFilter,
        scenarioCatalog,
        context: { signal: abortController.signal },
      });
      if (sessionGenerationRef.current !== generation || abortController.signal.aborted) return;
      const nextSnapshot = nextController.snapshot;
      setController(nextController);
      setSnapshot(nextSnapshot);
      if (nextSnapshot.state === null) {
        setState(null);
        setError(nextSnapshot.blocked?.reason ?? "The scenario could not be reconstructed.");
        return;
      }
      handIdRef.current = `hand-${generation}-${Date.now()}`;
      setAnalytics((current) => startAnalyticsHand(current));
      setState(toTrainerState(nextSnapshot.state, nextSnapshot.legalActions, nextSnapshot.heroSeatId));
      if (nextSnapshot.phase === "BLOCKED") setError(nextSnapshot.blocked?.reason ?? "The session is blocked.");
    } catch (cause) {
      if (abortController.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;
      if (sessionGenerationRef.current === generation) {
        setState(null);
        setController(null);
        setSnapshot(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (sessionGenerationRef.current === generation) setLoading(false);
    }
  }, [importedCatalogs, practiceCatalog, providerRegistry, savedOnly]);

  useEffect(() => {
    // StrictMode replays mount effects before this microtask. Cancelled mount
    // attempts must not consume an extra practice card or start a native solve.
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void startSession(rngMode, activeProviderId, drillSetup); });
    return () => { cancelled = true; };
  }, [activeProviderId, drillSetup, rngMode, startSession]);

  useEffect(() => () => {
    sessionGenerationRef.current += 1;
    probeGenerationRef.current += 1;
    sessionAbortRef.current?.abort(new DOMException("Trainer unmounted", "AbortError"));
    continueAbortRef.current?.abort(new DOMException("Trainer unmounted", "AbortError"));
    probeAbortRef.current?.abort(new DOMException("Trainer unmounted", "AbortError"));
  }, []);

  useEffect(() => {
    if (selected === null || resultDialogRef.current === null || resultDialogRef.current.open) return;
    resultDialogRef.current.showModal();
    requestAnimationFrame(() => resultHeadingRef.current?.focus());
  }, [selected]);

  const choose = (action: LegalAction, button: HTMLButtonElement) => {
    if (controller === null || state === null || snapshot?.phase !== "AWAITING_HERO" || loading || continuing) return;
    lastActionButtonRef.current = button;
    setExpanded(false);
    const submission = controller.session.submitHeroAction(action.domainAction);
    if (!submission.accepted) {
      setError(submission.reason ?? "The rules engine rejected that action.");
      return;
    }
    setError(null);
    userAnsweredRef.current = true;
    setSnapshot(submission.snapshot);
    setSelected(action);
    if (submission.snapshot.reveal !== undefined) {
      const reveal = submission.snapshot.reveal;
      setAnalytics((current) => recordDecision(current, {
        handId: handIdRef.current,
        state: state.domainState,
        heroSeatId: snapshot.heroSeatId,
        chosenAction: action.domainAction,
        grade: reveal.grade,
        strategy: reveal.strategy,
        decisionMath: reveal.decisionMath,
      }));
    }
  };

  const predictFrequencyMix = (prediction: Readonly<Record<string, number>>, button: HTMLButtonElement) => {
    if (controller === null || state === null || snapshot?.phase !== "AWAITING_HERO" || loading || continuing) return;
    lastActionButtonRef.current = button;
    setExpanded(false);
    const submission = controller.session.submitHeroFrequencyPrediction(prediction);
    if (!submission.accepted || submission.snapshot.reveal?.frequencyPrediction === undefined) {
      setError(submission.reason ?? "The exact held-combo mix could not be graded.");
      return;
    }
    const rolloutKey = actionKey(submission.snapshot.reveal.frequencyPrediction.rolloutAction);
    const rolloutAction = state.legalActions.find(({ domainAction }) => actionKey(domainAction) === rolloutKey);
    if (rolloutAction === undefined) {
      setError("The source rollout action was not among the engine-issued legal actions.");
      return;
    }
    setError(null);
    userAnsweredRef.current = true;
    setSnapshot(submission.snapshot);
    setSelected(rolloutAction);
    const reveal = submission.snapshot.reveal;
    const provenance = reveal.strategy.provenance;
    if (provenance === "SOLVED" || provenance === "INTERPOLATED") {
      setAnalytics((current) => recordFrequencyPrediction(current, {
        handId: handIdRef.current,
        state: state.domainState,
        heroSeatId: snapshot.heroSeatId,
        grade: reveal.frequencyPrediction!,
        provenance,
        decisionMath: reveal.decisionMath,
      }));
    }
    // The rollout action is source-sampled only to preserve hand continuity; it
    // is never recorded as the user's action-quality decision.
  };

  const openResult = () => {
    if (selected === null || resultDialogRef.current === null || resultDialogRef.current.open) return;
    resultDialogRef.current.showModal();
    requestAnimationFrame(() => resultHeadingRef.current?.focus());
  };

  const loadCustomSpot = async (source: string) => {
    currentModeRef.current = "Custom spot";
    currentScenarioIdRef.current = null;
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    sessionAbortRef.current?.abort(new DOMException("A custom spot replaced the current session", "AbortError"));
    continueAbortRef.current?.abort(new DOMException("A custom spot replaced the current continuation", "AbortError"));
    const abortController = new AbortController();
    sessionAbortRef.current = abortController;
    setLoading(true);
    setError(null);
    try {
      const provider = providerRegistry.requireAvailable(activeProviderId);
      const nextController = await createCustomSpotSession(source, provider, rngMode, { signal: abortController.signal });
      if (sessionGenerationRef.current !== generation || abortController.signal.aborted) return;
      const nextSnapshot = nextController.snapshot;
      if (nextSnapshot.state === null) throw new Error(nextSnapshot.blocked?.reason ?? "The custom state could not be loaded.");
      customSourceRef.current = source;
      setController(nextController);
      setSnapshot(nextSnapshot);
      setSelected(null);
      setExpanded(false);
      setState(toTrainerState(nextSnapshot.state, nextSnapshot.legalActions, nextSnapshot.heroSeatId));
      handIdRef.current = `custom-${generation}-${Date.now()}`;
      setAnalytics((current) => startAnalyticsHand(current));
      setError(nextSnapshot.phase === "BLOCKED" ? nextSnapshot.blocked?.reason ?? "The custom session is blocked." : null);
      suppressResultRestoreRef.current = true;
      resultDialogRef.current?.close();
      workspaceDialogRef.current?.close();
      requestAnimationFrame(() => document.getElementById("choose-action-heading")?.focus());
    } catch (cause) {
      if (abortController.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;
      throw cause;
    } finally {
      if (sessionGenerationRef.current === generation) setLoading(false);
    }
  };

  const continueHand = async () => {
    if (controller === null || snapshot?.phase !== "REVEALED") return;
    continueAbortRef.current?.abort(new DOMException("A newer continuation replaced this one", "AbortError"));
    const abortController = new AbortController();
    continueAbortRef.current = abortController;
    setContinuing(true);
    suppressResultRestoreRef.current = true;
    resultDialogRef.current?.close();
    try {
      const nextSnapshot = await controller.session.continue({ signal: abortController.signal });
      if (abortController.signal.aborted || continueAbortRef.current !== abortController) return;
      setSnapshot(nextSnapshot);
      setSelected(null);
      setExpanded(false);
      if (nextSnapshot.state !== null) setState(toTrainerState(nextSnapshot.state, nextSnapshot.legalActions, nextSnapshot.heroSeatId));
      setError(nextSnapshot.phase === "BLOCKED" ? nextSnapshot.blocked?.reason ?? "The session is blocked." : null);
      requestAnimationFrame(() => document.getElementById(nextSnapshot.phase === "AWAITING_HERO" ? "decision-heading" : "choose-action-heading")?.focus());
    } catch (cause) {
      if (abortController.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (continueAbortRef.current === abortController) setContinuing(false);
    }
  };

  const reset = () => {
    suppressResultRestoreRef.current = true;
    resultDialogRef.current?.close();
    if (controller?.mode === "Custom spot" && customSourceRef.current !== null) {
      void loadCustomSpot(customSourceRef.current);
      return;
    }
    if (drillSetup.drillMode === "Full hand") {
      setDrillSetup((current) => ({
        ...current,
        fullHand: {
          ...current.fullHand,
          seed: current.fullHand.seed + 1,
          buttonIndex: (current.fullHand.buttonIndex + 1) % current.fullHand.playerCount,
        },
      }));
      return;
    }
    void startSession(rngMode, activeProviderId, drillSetup).then(() => requestAnimationFrame(() => document.getElementById("choose-action-heading")?.focus()));
  };

  const replayCurrent = () => {
    suppressResultRestoreRef.current = true;
    resultDialogRef.current?.close();
    if (controller?.mode === "Custom spot" && customSourceRef.current !== null) {
      void loadCustomSpot(customSourceRef.current);
      return;
    }
    replayScenarioRef.current = controller?.scenarioId ?? null;
    void startSession(rngMode, activeProviderId, drillSetup);
  };

  const changePracticeMode = (mode: UiDrillMode) => {
    setSavedOnly(false);
    suppressResultRestoreRef.current = true;
    resultDialogRef.current?.close();
    setDrillSetup((current) => ({ ...current, drillMode: mode, nodeFilter: {}, fullHand: { ...current.fullHand, seed: Date.now() } }));
  };

  const changePracticeStreet = (street: PracticeStreet) => {
    setSavedOnly(false);
    setDrillSetup((current) => ({ ...current, nodeFilter: street === "all" ? {} : { street } }));
  };

  const toggleBookmark = () => {
    const id = controller?.scenarioId;
    if (id === undefined) return;
    setSavedSpots((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const applyDrillSetup = (setup: AppliedDrillSetup, providerId: string) => {
    setSavedOnly(false);
    setDrillSetup(setup);
    setActiveProviderId(providerId);
    suppressResultRestoreRef.current = true;
    resultDialogRef.current?.close();
    workspaceDialogRef.current?.close();
  };

  const activateImportedProvider = async (result: Extract<ImportedPackResult, { status: "loaded" }>) => {
    registerImportedProvider(providerRegistry, result);
    setImportedCatalogs((current) => new Map(current).set(result.providerId, result.catalog));
    setRegistryRevision((revision) => revision + 1);
    setSavedOnly(false);
    replayScenarioRef.current = null;
    setDrillSetup((current) => ({ ...current, drillMode: "Node drill", nodeFilter: {} }));
    setActiveProviderId(result.providerId);
  };

  const useEducationalProvider = () => {
    setActiveProviderId(EDUCATIONAL_PROVIDER_ID);
  };

  const probeLocalProvider = async (endpoint: string): Promise<LocalSolverProbeResult> => {
    const generation = probeGenerationRef.current + 1;
    probeGenerationRef.current = generation;
    probeAbortRef.current?.abort(new DOMException("A newer local solver verification replaced this one", "AbortError"));
    const abortController = new AbortController();
    probeAbortRef.current = abortController;
    const pending = configureAndProbeLocalSolver(providerRegistry, endpoint, { context: { signal: abortController.signal } });
    setRegistryRevision((revision) => revision + 1);
    const result = await pending;
    if (probeGenerationRef.current !== generation || abortController.signal.aborted) throw new DOMException("Local solver verification was superseded", "AbortError");
    setRegistryRevision((revision) => revision + 1);
    if (result.status === "available") setActiveProviderId(result.providerId);
    return result;
  };

  useEffect(() => {
    const abort = new AbortController();
    void getLocalSolverStatus(DEFAULT_LOCAL_SOLVER_ENDPOINT, { signal: abort.signal }).then(async (status) => {
      if (abort.signal.aborted) return;
      setSolverStatus(status);
      setSolverConnecting(true);
      const result = await configureAndProbeLocalSolver(providerRegistry, DEFAULT_LOCAL_SOLVER_ENDPOINT, { context: { signal: abort.signal } });
      if (abort.signal.aborted) return;
      setRegistryRevision((revision) => revision + 1);
      if (result.status === "available" && !userAnsweredRef.current && currentModeRef.current !== "Custom spot" && activeProviderIdRef.current === BUNDLED_SOLVED_PROVIDER_ID) {
        const currentId = currentScenarioIdRef.current;
        if (currentId !== null && practiceCatalog.filter({ scenarioId: currentId }).length > 0) replayScenarioRef.current = currentId;
        setActiveProviderId(result.providerId);
      }
    }).catch(() => { /* An absent sidecar leaves the available study deck playable. */ }).finally(() => { if (!abort.signal.aborted) setSolverConnecting(false); });
    return () => abort.abort();
  }, [practiceCatalog, providerRegistry]);

  useEffect(() => {
    if (solverStatus === null) return;
    const abort = new AbortController();
    const refresh = () => { void getLocalSolverStatus(DEFAULT_LOCAL_SOLVER_ENDPOINT, { signal: abort.signal }).then(setSolverStatus).catch(() => {}); };
    const timer = window.setInterval(refresh, loading || continuing ? 2000 : 15000);
    return () => { window.clearInterval(timer); abort.abort(); };
  }, [solverStatus !== null, loading, continuing]);

  const handleResultClose = () => {
    if (suppressResultRestoreRef.current) {
      suppressResultRestoreRef.current = false;
      return;
    }
    lastActionButtonRef.current?.focus();
  };

  const openWorkspace = () => {
    setWorkspaceTab("Drill");
    workspaceDialogRef.current?.showModal();
    requestAnimationFrame(() => document.getElementById("workspace-heading")?.focus());
  };

  const openHistory = () => historyDialogRef.current?.showModal();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, select, textarea") || target.isContentEditable)) return;
      const dialog = document.querySelector("dialog[open]");
      let control: HTMLButtonElement | null = null;
      if (event.key.toLowerCase() === "n") control = document.querySelector(dialog ? ".result-dialog[open] .next-spot-result" : ".practice-next");
      if (event.key.toLowerCase() === "e") control = document.querySelector(".result-dialog[open] .header-explanation-button");
      if (dialog === null && /^[1-9]$/.test(event.key)) control = [...document.querySelectorAll<HTMLButtonElement>(".action-button")].filter((button) => button.getClientRects().length > 0)[Number(event.key) - 1] ?? null;
      if (control !== null && !control.disabled && control.getAttribute("aria-disabled") !== "true") { event.preventDefault(); control.click(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const activeScenario = controller?.scenarioId === undefined ? undefined : controller.catalog.filter({ scenarioId: controller.scenarioId })[0]?.definition;
  const practiceCount = (controller?.mode === "Node drill" ? controller.catalog : practiceCatalog)?.filter(drillSetup.nodeFilter).length ?? 0;
  const solverLabel = solverConnecting ? "Verifying local solver" : activeProviderId === LOCAL_SOLVER_PROVIDER_ID ? `Local solver · ${solverStatus?.cache.entries ?? 0} cached` : activeProviderId === BUNDLED_SOLVED_PROVIDER_ID ? "Bundled solve + education" : activeProviderEntry?.metadata.label ?? "Educational reference";

  const phaseStatus = snapshot?.phase === "BLOCKED"
    ? `${snapshot.blocked?.code ?? "BLOCKED"}: ${snapshot.blocked?.reason ?? "The active provider cannot continue this hand."}`
    : snapshot?.phase === "TERMINAL"
      ? `Hand complete · ${snapshot.settlement?.terminalType === "fold" ? "uncontested pot settled" : "showdown settled"}`
      : error ?? undefined;
  const headerProvenance = snapshot?.reveal?.strategy.provenance;
  const headerBadgeClass = headerProvenance?.toLowerCase()
    ?? (snapshot?.phase === "BLOCKED" ? "heuristic" : undefined)
    ?? (activeProviderEntry?.metadata.kind === "HEURISTIC"
      ? "heuristic"
      : activeProviderEntry?.metadata.kind === "SOLVED_PACK"
        ? "imported"
        : activeProviderEntry?.availability.state === "AVAILABLE" ? "solved" : "heuristic");
  const headerSourceLabel = headerProvenance?.replace("_", " ")
    ?? (snapshot?.phase === "BLOCKED" ? `${activeProviderEntry?.metadata.label ?? activeProviderId} · NODE UNAVAILABLE` : undefined)
    ?? `${activeProviderEntry?.metadata.label ?? activeProviderId} · ${activeProviderEntry?.availability.state ?? "UNAVAILABLE"}`;

  if (state === null) {
    return (
      <div className="trainer-app app-loading">
        <main className="startup-state" aria-live="polite">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <h1>{loading ? (drillSetup.drillMode === "Full hand" ? "Dealing a collision-free hand…" : "Reconstructing the verified node…") : "Trainer unavailable"}</h1>
          <p>{error ?? "The rules engine is validating cards, ledger, action order, and strategy boundaries."}</p>
          {!loading ? (
            <div className="startup-actions">
              <button type="button" className="primary-button" onClick={reset}>Retry current drill</button>
              <button type="button" className="secondary-button" onClick={() => changePracticeMode("Node drill")}>Browse all spots</button>
              {activeProviderId === EDUCATIONAL_PROVIDER_ID ? null : <button type="button" className="secondary-button" onClick={useEducationalProvider}>Use educational fallback</button>}
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="trainer-app">
      <a className="skip-link" href="#choose-action-heading">Skip to actions</a>
      <header className="app-header">
        <a className="brand" href="#decision-heading" aria-label="Hand Compass table">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>Hand Compass</strong><small>Hold'em study table</small></span>
        </a>
        <div className="header-state">
          <span className={`source-badge badge-${headerBadgeClass}`}>{headerSourceLabel}</span>
          <span>{state.heroPosition} vs {state.opponentPosition} · {state.street}</span>
        </div>
        <nav className="header-actions" aria-label="Table tools">
          <button ref={historyButtonRef} type="button" className="header-button" onClick={openHistory}>History</button>
          <button ref={workspaceButtonRef} type="button" className="header-button" onClick={openWorkspace}>Study workspace</button>
          <button type="button" className="icon-button" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}>
            <ThemeIcon theme={theme} />
          </button>
        </nav>
      </header>

      <main className="app-main" id="trainer-main">
        <PracticeToolbar mode={controller?.mode ?? drillSetup.drillMode} street={drillSetup.nodeFilter.street ?? "all"} onStreet={changePracticeStreet} onMode={changePracticeMode} onNext={reset} onReplay={replayCurrent} onFilters={openWorkspace} busy={loading || continuing} count={practiceCount} visited={queueRef.current?.stats().uniqueServed ?? 0} title={savedOnly ? "Saved spots" : activeScenario?.presentation?.title ?? (controller?.mode === "Full hand" ? "Play from the blinds to showdown" : "Acceptance example · BB vs CO")} bookmarked={controller?.scenarioId !== undefined && savedSpots.includes(controller.scenarioId)} onBookmark={toggleBookmark} />
        <div className="table-workspace">
          <PokerTable state={state} drillMode={controller?.mode ?? drillSetup.drillMode} selectedSeat={selectedSeat} onInspect={setSelectedSeat} />
          <StudyHud state={state} snapshot={snapshot} analytics={analytics} selectedSeat={selectedSeat} onSeat={setSelectedSeat} preview={previewAction} onPreview={setPreviewAction} busy={loading || continuing} solverLabel={solverLabel} onSolver={() => { setWorkspaceTab("Strategy"); workspaceDialogRef.current?.showModal(); }} onReview={openResult} onSaved={() => { setDrillSetup((current) => ({ ...current, drillMode: "Node drill", nodeFilter: {} })); setSavedOnly((current) => !current); }} savedCount={savedSpots.length} {...(activeScenario?.presentation?.rangeAssumption === undefined ? {} : { rangeAssumption: activeScenario.presentation.rangeAssumption })} />
        </div>
        <ActionDock state={state} selected={selected} busy={loading || continuing} phase={snapshot?.phase ?? "INITIALIZING"} {...(snapshot?.settlement === undefined ? {} : { settlement: snapshot.settlement })} heroSeatId={snapshot?.heroSeatId ?? "seat-2"} {...(phaseStatus === undefined ? {} : { status: phaseStatus })} onReset={reset} onChangeProvider={openWorkspace} onChoose={choose} onPredict={predictFrequencyMix} onReview={openResult} difficulty={drillSetup.difficulty} mixPredictionAvailable={snapshot?.mixPredictionAvailable ?? false} />
      </main>

      <ResultDialog
        dialogRef={resultDialogRef}
        headingRef={resultHeadingRef}
        state={state}
        heroSeatId={snapshot?.heroSeatId ?? "seat-2"}
        action={selected}
        reveal={snapshot?.reveal}
        rng={snapshot?.rng ?? { mode: "off", available: false, cursor: 0, hiddenRoll: false }}
        continuing={continuing}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onContinue={() => void continueHand()}
        onReset={replayCurrent}
        onNext={reset}
        onClose={handleResultClose}
      />
      <WorkspaceDialog
        dialogRef={workspaceDialogRef}
        launcherRef={workspaceButtonRef}
        state={state}
        rngMode={rngMode}
        onRngModeChange={setRngMode}
        catalog={controller?.catalog ?? null}
        importedCatalogs={importedCatalogs}
        {...(snapshot?.decisionMath === undefined ? {} : { decisionMath: snapshot.decisionMath })}
        {...(snapshot?.reveal?.strategy === undefined ? {} : { strategy: snapshot.reveal.strategy })}
        activeProviderId={activeProviderId}
        providers={providerRegistry.list()}
        onProviderLoaded={activateImportedProvider}
        onUseEducational={useEducationalProvider}
        onProbeLocal={probeLocalProvider}
        analytics={analytics}
        appliedSetup={drillSetup}
        onApplySetup={applyDrillSetup}
        onLoadCustomSpot={loadCustomSpot}
        tab={workspaceTab}
        onTabChange={setWorkspaceTab}
        solverStatus={solverStatus}
      />
      <HistoryDialog dialogRef={historyDialogRef} launcherRef={historyButtonRef} history={state.actionHistory} />
    </div>
  );
}
