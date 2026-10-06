import { actionKey, type PokerAction } from "../domain/actions";
import { COMBO_POLICY_ROUNDING_TOLERANCE, validateComboPolicy, conditionRangeByAction, sampleActionForCombo, strategyActionsForHeldCombo } from "../domain/comboPolicy";
import { sevenCardEvaluator } from "../domain/evaluator";
import { defaultGradingPolicy, gradeAction, gradeFrequencyPrediction, sampleStrategyActionByUnitRoll, type FrequencyPredictionGrade, type Grade, type RngMode } from "../domain/grading";
import { PokerRulesEngine, type PokerState } from "../domain/rules";
import type { StrategyQuery, StrategyRequestContext, StrategyResult } from "../domain/strategy";
import { buildStrategyQuery, decisionMathForState } from "./query";
import { ReplayRng } from "./rng";
import { checkComboPolicyCoverage } from "./sampling";
import { prepareFullHand, reconstructNode, type ScenarioPreparation } from "./scenario";
import type {
  DecisionMath,
  DrillSnapshot,
  FullHandInput,
  HeroReveal,
  HeroSubmissionResult,
  MutableSeatRangeMap,
  NodeScenarioDefinition,
  PreparedStateInput,
  SessionBlock,
  SessionCommonInput,
  SessionPhase,
} from "./types";

function resultValidationIssue(result: StrategyResult, legalActions: readonly PokerAction[]): string | null {
  const legal = new Set(legalActions.map(actionKey));
  const seen = new Set<string>();
  for (const item of result.actions) {
    const key = actionKey(item.action);
    if (seen.has(key)) return `Strategy repeats action ${key}.`;
    if (!legal.has(key)) return `Strategy contains action ${key}, which is not legal at this node.`;
    seen.add(key);
    if (item.frequency !== undefined && (!Number.isFinite(item.frequency) || item.frequency < 0 || item.frequency > 1)) {
      return `Strategy action ${key} has an invalid frequency.`;
    }
    if (item.evBB !== undefined && !Number.isSafeInteger(item.evBB)) return `Strategy action ${key} has a non-fixed-point EV.`;
    if (result.provenance === "HEURISTIC" && (item.frequency !== undefined || item.evBB !== undefined)) {
      return "A HEURISTIC result cannot carry solver frequency or EV fields.";
    }
  }
  if (result.comboPolicy !== undefined) {
    try {
      validateComboPolicy(result.comboPolicy, legalActions);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

function hasGenuineCompleteFrequencies(result: StrategyResult): boolean {
  const frequencies = result.actions.map(({ frequency }) => frequency);
  const total = frequencies.reduce<number>((sum, frequency) => sum + (frequency ?? 0), 0);
  return (result.provenance === "SOLVED" || result.provenance === "INTERPOLATED")
    && result.actions.length > 0
    && result.actions.every(({ frequency }) => frequency !== undefined && Number.isFinite(frequency) && frequency >= 0)
    && Math.abs(total - 1) <= COMBO_POLICY_ROUNDING_TOLERANCE;
}

function heldComboStrategy(result: StrategyResult, state: PokerState, heroSeatId: SessionCommonInput["heroSeatId"], legalActions: readonly PokerAction[]): StrategyResult {
  // Educational combo rows exist only to keep deterministic action/range
  // mechanics coherent. They are not solver evidence and must never surface as
  // exact frequencies or EVs.
  if (result.provenance === "HEURISTIC") return result;
  const cards = state.players.find(({ id }) => id === heroSeatId)?.holeCards;
  const actions = cards === undefined ? undefined : strategyActionsForHeldCombo(result.comboPolicy, cards, legalActions);
  if (cards !== undefined && actions !== undefined) {
    return {
      ...result,
      actions,
      notes: [...(result.notes ?? []), `Reference actions and EVs are the exact held-combo row for ${cards.join(" ")}.`],
    };
  }
  return {
    ...result,
    // Preserve the real source provenance while withholding node-aggregate
    // precision that is not valid for Hero's concrete cards.
    actions: result.actions.map(({ action }) => ({ action })),
    notes: [...(result.notes ?? []), "Exact held-combo policy is unavailable; aggregate node frequencies and EVs were withheld from hand-level grading."],
  };
}

function redactState(state: PokerState, heroSeatId: string): PokerState {
  const revealLiveHands = state.terminal?.type === "showdown";
  return {
    ...state,
    players: state.players.map((player) => {
      if (player.id === heroSeatId || (revealLiveHands && player.status !== "folded")) return player;
      const { holeCards: _privateCards, ...publicPlayer } = player;
      return publicPlayer;
    }),
    futureBoard: [],
    deck: [],
  };
}

interface SessionConstruction {
  readonly common: SessionCommonInput;
  readonly rng: ReplayRng;
  readonly preparation: ScenarioPreparation;
}

interface SessionCheckpoint {
  readonly phase: SessionPhase;
  readonly state: PokerState | null;
  readonly ranges: MutableSeatRangeMap;
  readonly blocked: SessionBlock | undefined;
  readonly decisionQuery: StrategyQuery | undefined;
  readonly decisionMath: DecisionMath | undefined;
  readonly privateStrategy: StrategyResult | undefined;
  readonly heroRngRoll: number | undefined;
  readonly reveal: HeroReveal | undefined;
  readonly settlement: DrillSnapshot["settlement"];
  readonly rng: ReturnType<ReplayRng["snapshot"]>;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(typeof signal.reason === "string" ? signal.reason : "The strategy request was aborted", "AbortError");
}

function throwIfAborted(context?: StrategyRequestContext): void {
  if (context?.signal?.aborted === true) throw abortError(context.signal);
}

function isAbort(error: unknown, context?: StrategyRequestContext): boolean {
  if (context?.signal?.aborted === true) return true;
  return error instanceof Error && error.name === "AbortError";
}

export class DrillSession {
  readonly #engine = new PokerRulesEngine();
  readonly #heroSeatId: SessionCommonInput["heroSeatId"];
  readonly #actionTree: SessionCommonInput["actionTree"];
  readonly #provider: SessionCommonInput["strategyProvider"];
  readonly #deadCards: NonNullable<SessionCommonInput["deadCards"]>;
  readonly #gradingPolicy: NonNullable<SessionCommonInput["gradingPolicy"]>;
  readonly #evaluator: NonNullable<SessionCommonInput["evaluator"]>;
  readonly #rngMode: RngMode;
  readonly #revealRollBeforeAction: boolean;
  #rng: ReplayRng;
  #phase: SessionPhase;
  #state: PokerState | null;
  #ranges: MutableSeatRangeMap;
  #blocked: SessionBlock | undefined;
  #decisionQuery: StrategyQuery | undefined;
  #decisionMath: DecisionMath | undefined;
  #privateStrategy: StrategyResult | undefined;
  #heroRngRoll: number | undefined;
  #reveal: HeroReveal | undefined;
  #settlement: DrillSnapshot["settlement"];

  private constructor(construction: SessionConstruction) {
    const { common, preparation } = construction;
    this.#heroSeatId = common.heroSeatId;
    this.#actionTree = common.actionTree;
    this.#provider = common.strategyProvider;
    this.#deadCards = [...(common.deadCards ?? [])];
    this.#gradingPolicy = common.gradingPolicy ?? defaultGradingPolicy;
    this.#evaluator = common.evaluator ?? sevenCardEvaluator;
    this.#rngMode = common.rng?.mode ?? "off";
    this.#revealRollBeforeAction = common.rng?.revealRollBeforeAction ?? false;
    this.#rng = construction.rng;
    if (preparation.available) {
      this.#phase = "INITIALIZING";
      this.#state = preparation.state;
      this.#ranges = preparation.ranges;
    } else {
      this.#phase = "BLOCKED";
      this.#state = null;
      this.#ranges = { ...common.ranges };
      this.#blocked = preparation.block;
    }
  }

  static createFullHand(input: FullHandInput): DrillSession {
    const rng = new ReplayRng(input.seed);
    return new DrillSession({ common: input, rng, preparation: prepareFullHand(input, rng) });
  }

  static loadNode(definition: NodeScenarioDefinition): DrillSession {
    const rng = new ReplayRng(definition.seed);
    return new DrillSession({ common: definition, rng, preparation: reconstructNode(definition, rng) });
  }

  static loadPreparedState(input: PreparedStateInput): DrillSession {
    const rng = new ReplayRng(input.seed);
    return new DrillSession({
      common: input,
      rng,
      preparation: { available: true, state: input.state, ranges: { ...input.ranges } },
    });
  }

  #block(block: SessionBlock): void {
    this.#phase = "BLOCKED";
    this.#blocked = block;
  }

  #checkpoint(): SessionCheckpoint {
    return {
      phase: this.#phase,
      state: this.#state,
      ranges: { ...this.#ranges },
      blocked: this.#blocked,
      decisionQuery: this.#decisionQuery,
      decisionMath: this.#decisionMath,
      privateStrategy: this.#privateStrategy,
      heroRngRoll: this.#heroRngRoll,
      reveal: this.#reveal,
      settlement: this.#settlement,
      rng: this.#rng.snapshot(),
    };
  }

  #restore(checkpoint: SessionCheckpoint): void {
    this.#phase = checkpoint.phase;
    this.#state = checkpoint.state;
    this.#ranges = { ...checkpoint.ranges };
    this.#blocked = checkpoint.blocked;
    this.#decisionQuery = checkpoint.decisionQuery;
    this.#decisionMath = checkpoint.decisionMath;
    this.#privateStrategy = checkpoint.privateStrategy;
    this.#heroRngRoll = checkpoint.heroRngRoll;
    this.#reveal = checkpoint.reveal;
    this.#settlement = checkpoint.settlement;
    this.#rng = new ReplayRng(checkpoint.rng.seed);
    for (let cursor = 0; cursor < checkpoint.rng.cursor; cursor += 1) this.#rng.nextUnit();
  }

  #queryForCurrentState(): StrategyQuery {
    if (this.#state === null) throw new Error("Session has no rules state");
    return buildStrategyQuery({
      state: this.#state,
      heroSeatId: this.#heroSeatId,
      ranges: this.#ranges,
      actionTree: this.#actionTree,
      deadCards: this.#deadCards,
    });
  }

  async #loadStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult | null> {
    throwIfAborted(context);
    let result: StrategyResult;
    try {
      result = await this.#provider.getStrategy(query, context);
    } catch (error) {
      if (isAbort(error, context)) throw error;
      this.#block({ code: "PROVIDER_ERROR", reason: `Strategy provider ${this.#provider.id} failed: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
    throwIfAborted(context);
    const issue = resultValidationIssue(result, query.legalActions);
    if (issue !== null) {
      this.#block({ code: "INVALID_STRATEGY", reason: issue });
      return null;
    }
    return result;
  }

  #settleTerminal(): boolean {
    if (this.#state?.terminal === undefined) return false;
    try {
      this.#settlement = this.#engine.settle(this.#state, this.#state.terminal.type === "showdown" ? this.#evaluator : undefined);
      return true;
    } catch (error) {
      this.#block({ code: "SETTLEMENT_ERROR", reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async #automateOpponent(query: StrategyQuery, context?: StrategyRequestContext): Promise<boolean> {
    const state = this.#state;
    if (state === null || state.actor === null) {
      this.#block({ code: "STATE_INVARIANT", reason: "Opponent automation requires a current actor." });
      return false;
    }
    const actor = state.actor;
    const result = await this.#loadStrategy(query, context);
    if (result === null) return false;
    if (result.comboPolicy === undefined) {
      this.#block({ code: "MISSING_COMBO_POLICY", reason: `Opponent ${actor} cannot be automated without combo-level policy.` });
      return false;
    }
    const range = this.#ranges[actor];
    if (range === undefined) {
      this.#block({ code: "MISSING_ACTOR_RANGE", reason: `Opponent ${actor} has no public range for policy coverage and posterior conditioning.` });
      return false;
    }
    const publicBlockedCards = [...state.board, ...this.#deadCards];
    const coverage = checkComboPolicyCoverage(range, result.comboPolicy, publicBlockedCards);
    if (!coverage.complete) {
      this.#block({ code: "INCOMPLETE_COMBO_POLICY", reason: coverage.reason ?? "Opponent combo policy coverage is incomplete." });
      return false;
    }
    const heldCards = state.players.find((player) => player.id === actor)?.holeCards;
    if (heldCards === undefined) {
      this.#block({ code: "STATE_INVARIANT", reason: `Opponent ${actor} has no private dealt cards in the internal ledger.` });
      return false;
    }
    const sample = sampleActionForCombo(result.comboPolicy, heldCards, this.#rng.peekUnit(), query.legalActions);
    if (!sample.available) {
      this.#block({ code: "MISSING_HELD_COMBO_ROW", reason: sample.reason });
      return false;
    }
    const conditioned = conditionRangeByAction(range, result.comboPolicy, sample.action, publicBlockedCards);
    if (!conditioned.available) {
      this.#block({ code: "INCOMPLETE_COMBO_POLICY", reason: conditioned.reason });
      return false;
    }
    let nextState: PokerState;
    try {
      nextState = this.#engine.dispatch(state, sample.action);
    } catch (error) {
      this.#block({ code: "INVALID_STRATEGY", reason: `Held-combo action could not be dispatched: ${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
    throwIfAborted(context);
    this.#rng.nextUnit();
    this.#ranges[actor] = conditioned.posterior;
    this.#state = nextState;
    return true;
  }

  async runUntilHeroOrTerminal(context?: StrategyRequestContext): Promise<DrillSnapshot> {
    throwIfAborted(context);
    if (["BLOCKED", "TERMINAL", "AWAITING_HERO", "REVEALED"].includes(this.#phase)) return this.snapshot();
    const checkpoint = this.#checkpoint();
    try {
      this.#phase = "AUTOMATING";
      while (this.#state !== null) {
        throwIfAborted(context);
        if (this.#state.terminal !== undefined) {
          if (this.#settleTerminal()) this.#phase = "TERMINAL";
          return this.snapshot();
        }
        if (this.#state.actor === null) {
          this.#block({ code: "STATE_INVARIANT", reason: "A nonterminal rules state has no actor." });
          return this.snapshot();
        }
        const query = this.#queryForCurrentState();
        if (this.#state.actor === this.#heroSeatId) {
          const result = await this.#loadStrategy(query, context);
          if (result === null) return this.snapshot();
          throwIfAborted(context);
          const handStrategy = heldComboStrategy(result, this.#state, this.#heroSeatId, query.legalActions);
          this.#decisionQuery = query;
          this.#decisionMath = decisionMathForState(this.#state);
          this.#privateStrategy = handStrategy;
          if (this.#rngMode !== "off" && hasGenuineCompleteFrequencies(handStrategy)) {
            this.#heroRngRoll = this.#rng.nextInteger(1, 100);
          } else {
            this.#heroRngRoll = undefined;
          }
          this.#phase = "AWAITING_HERO";
          return this.snapshot();
        }
        if (!await this.#automateOpponent(query, context)) return this.snapshot();
      }
      this.#block({ code: "STATE_INVARIANT", reason: "Session lost its rules state." });
      return this.snapshot();
    } catch (error) {
      if (isAbort(error, context)) {
        this.#restore(checkpoint);
        throw error;
      }
      throw error;
    }
  }

  submitHeroAction(action: PokerAction): HeroSubmissionResult {
    if (this.#phase !== "AWAITING_HERO" || this.#state === null || this.#decisionQuery === undefined || this.#decisionMath === undefined || this.#privateStrategy === undefined) {
      return { accepted: false, snapshot: this.snapshot(), reason: "The session is not awaiting a Hero decision." };
    }
    if (!this.#decisionQuery.legalActions.some((candidate) => actionKey(candidate) === actionKey(action))) {
      return { accepted: false, snapshot: this.snapshot(), reason: `Action ${actionKey(action)} was not issued for this decision.` };
    }
    const grade = gradeAction(
      action,
      this.#privateStrategy,
      this.#decisionMath.potAtDecisionBB,
      this.#gradingPolicy,
      {
        legalActions: this.#decisionQuery.legalActions,
        ...(this.#heroRngRoll === undefined ? {} : { rngMode: this.#rngMode, roll: this.#heroRngRoll }),
      },
    );
    return this.#commitHeroAction(action, grade);
  }

  submitHeroFrequencyPrediction(prediction: Readonly<Record<string, number>>): HeroSubmissionResult {
    if (this.#phase !== "AWAITING_HERO" || this.#state === null || this.#decisionQuery === undefined || this.#decisionMath === undefined || this.#privateStrategy === undefined) {
      return { accepted: false, snapshot: this.snapshot(), reason: "The session is not awaiting a Hero decision." };
    }
    let frequencyGrade: FrequencyPredictionGrade;
    try {
      frequencyGrade = gradeFrequencyPrediction(prediction, this.#privateStrategy, this.#decisionQuery.legalActions);
    } catch (error) {
      return { accepted: false, snapshot: this.snapshot(), reason: error instanceof Error ? error.message : String(error) };
    }
    const rolloutRoll = this.#rng.peekUnit();
    let rolloutAction: PokerAction;
    try {
      rolloutAction = sampleStrategyActionByUnitRoll(this.#privateStrategy, rolloutRoll).action;
    } catch (error) {
      return { accepted: false, snapshot: this.snapshot(), reason: error instanceof Error ? error.message : String(error) };
    }
    const rolloutGrade = gradeAction(
      rolloutAction,
      this.#privateStrategy,
      this.#decisionMath.potAtDecisionBB,
      this.#gradingPolicy,
      { legalActions: this.#decisionQuery.legalActions },
    );
    return this.#commitHeroAction(rolloutAction, rolloutGrade, { ...frequencyGrade, rolloutAction, rolloutRoll }, true);
  }

  #commitHeroAction(
    action: PokerAction,
    grade: Grade,
    frequencyPrediction?: NonNullable<HeroReveal["frequencyPrediction"]>,
    consumeFrequencyRoll = false,
  ): HeroSubmissionResult {
    if (this.#state === null || this.#decisionMath === undefined || this.#privateStrategy === undefined) {
      return { accepted: false, snapshot: this.snapshot(), reason: "The Hero decision state is incomplete." };
    }
    const publicRangesAtDecision: MutableSeatRangeMap = { ...this.#ranges };
    const heroRange = this.#ranges[this.#heroSeatId];
    const conditioning = heroRange === undefined
      ? undefined
      : conditionRangeByAction(heroRange, this.#privateStrategy.comboPolicy, action, [...this.#state.board, ...this.#deadCards]);
    let nextState: PokerState;
    try {
      nextState = this.#engine.dispatch(this.#state, action);
    } catch (error) {
      return { accepted: false, snapshot: this.snapshot(), reason: error instanceof Error ? error.message : String(error) };
    }
    if (consumeFrequencyRoll) this.#rng.nextUnit();
    if (conditioning?.available) {
      this.#ranges[this.#heroSeatId] = conditioning.posterior;
    } else if (conditioning !== undefined) {
      // A legal off-policy action can have zero likelihood in a supplied
      // combo policy. In that case no Bayesian posterior exists. Preserve the
      // public prior so the hand remains playable, and expose the unavailable
      // conditioning result in the reveal instead of silently inventing a
      // range or deleting the actor's only usable range.
      this.#ranges[this.#heroSeatId] = conditioning.unchangedRange;
    }
    this.#state = nextState;
    const publicRangesAfterHeroAction: MutableSeatRangeMap = { ...this.#ranges };
    this.#reveal = {
      chosenAction: action,
      grade,
      strategy: this.#privateStrategy,
      decisionMath: this.#decisionMath,
      ...(conditioning === undefined ? {} : { rangeConditioning: conditioning }),
      publicRangesAtDecision,
      publicRangesAfterHeroAction,
      // Kept until UI consumers migrate to the timing-explicit field above.
      publicRanges: publicRangesAfterHeroAction,
      publicDeadCards: [...this.#deadCards],
      ...(this.#heroRngRoll === undefined || frequencyPrediction !== undefined ? {} : { rngRoll: this.#heroRngRoll }),
      ...(frequencyPrediction === undefined ? {} : { frequencyPrediction }),
    };
    if (this.#state.terminal !== undefined && !this.#settleTerminal()) {
      return { accepted: true, snapshot: this.snapshot() };
    }
    this.#phase = "REVEALED";
    return { accepted: true, snapshot: this.snapshot() };
  }

  async continue(context?: StrategyRequestContext): Promise<DrillSnapshot> {
    throwIfAborted(context);
    if (this.#phase !== "REVEALED") return this.snapshot();
    const checkpoint = this.#checkpoint();
    try {
      this.#decisionQuery = undefined;
      this.#decisionMath = undefined;
      this.#privateStrategy = undefined;
      this.#heroRngRoll = undefined;
      this.#reveal = undefined;
      if (this.#state?.terminal !== undefined) {
        this.#phase = "TERMINAL";
        return this.snapshot();
      }
      this.#phase = "AUTOMATING";
      return await this.runUntilHeroOrTerminal(context);
    } catch (error) {
      if (isAbort(error, context)) {
        this.#restore(checkpoint);
        throw error;
      }
      throw error;
    }
  }

  snapshot(): DrillSnapshot {
    const roll = this.#heroRngRoll;
    const showRoll = roll !== undefined && (this.#revealRollBeforeAction || this.#phase === "REVEALED" || this.#phase === "TERMINAL");
    return {
      phase: this.#phase,
      heroSeatId: this.#heroSeatId,
      state: this.#state === null ? null : redactState(this.#state, this.#heroSeatId),
      legalActions: this.#phase === "AWAITING_HERO" || this.#phase === "REVEALED" ? this.#decisionQuery?.legalActions ?? [] : [],
      mixPredictionAvailable: this.#phase === "AWAITING_HERO" && this.#privateStrategy !== undefined && hasGenuineCompleteFrequencies(this.#privateStrategy),
      ...(this.#phase === "AWAITING_HERO" && this.#decisionMath !== undefined ? { decisionMath: this.#decisionMath } : {}),
      rng: {
        mode: this.#rngMode,
        available: this.#heroRngRoll !== undefined,
        cursor: this.#rng.cursor,
        ...(showRoll ? { roll } : {}),
        hiddenRoll: roll !== undefined && !showRoll,
      },
      ...(this.#blocked === undefined ? {} : { blocked: this.#blocked }),
      ...(this.#reveal === undefined ? {} : { reveal: this.#reveal }),
      ...(this.#settlement === undefined ? {} : { settlement: this.#settlement }),
    };
  }
}
