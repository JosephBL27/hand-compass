import { type PokerAction } from "../domain/actions";
import { type ActionTreeConfig, resolveActionTree } from "../domain/actionTree";
import { card } from "../domain/cards";
import { createCashConfig } from "../domain/config";
import { potOdds, spr } from "../domain/math";
import { bb, bbToNumber, type BB } from "../domain/money";
import { createRange } from "../domain/ranges";
import { applyAction, createHand, type PokerState } from "../domain/rules";
import { seatId } from "../domain/seats";
import type { RngMode } from "../domain/grading";
import type { StrategyProvider } from "../domain/strategy";
import type { NodeScenarioDefinition } from "../session/types";

export const acceptanceActionTree: ActionTreeConfig = {
  id: "acceptance-fixed",
  preflop: {
    unopened: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(2.5) }] },
    facingRaise: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(8.5) }, { type: "all-in" }] },
  },
  flop: {
    mode: "fixed",
    candidates: [
      { type: "raise-to", toBB: bb(5.5) },
      { type: "raise-to", toBB: bb(7.2) },
      { type: "raise-to", toBB: bb(9) },
      { type: "all-in" },
    ],
  },
  turn: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 0.66 }, { type: "all-in" }] },
  river: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 1 }, { type: "all-in" }] },
};

function act(state: PokerState, action: PokerAction): PokerState {
  return applyAction(state, action);
}

export interface AcceptanceSpot {
  readonly config: ReturnType<typeof createCashConfig>;
  readonly preflopComplete: PokerState;
  readonly flopDecision: PokerState;
  readonly legalActions: readonly PokerAction[];
  readonly math: {
    readonly flopStartPotBB: BB;
    readonly decisionPotBB: BB;
    readonly callOdds: ReturnType<typeof potOdds>;
    readonly callOddsPct: number;
    readonly currentSPR: ReturnType<typeof spr>;
  };
  continueWith(action: PokerAction): PokerState;
}

export function createAcceptanceSpot(): AcceptanceSpot {
  const config = createCashConfig(8, bb(100));
  let state = createHand(config, {
    buttonIndex: 0,
    holeCards: { [seatId(2)]: [card("Qs"), card("Ts")] },
    futureBoard: [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")],
  });
  // UTG, UTG+1, LJ, HJ fold; CO opens; BTN and SB fold; BB calls.
  for (const id of [seatId(3), seatId(4), seatId(5), seatId(6)]) {
    if (state.actor !== id) throw new Error(`Acceptance action order failed at ${id}`);
    state = act(state, { kind: "fold" });
  }
  state = act(state, { kind: "raise", to: bb(2.5) });
  state = act(state, { kind: "fold" });
  state = act(state, { kind: "fold" });
  state = act(state, { kind: "call", amount: bb(1.5) });
  const preflopComplete = state;
  if (state.street !== "flop" || state.actor !== seatId(2)) throw new Error("Acceptance fixture did not reach BB flop action");
  state = act(state, { kind: "check" });
  state = act(state, { kind: "bet", to: bb(1.8) });
  const flopDecision = state;
  const legalActions = resolveActionTree(flopDecision, acceptanceActionTree).actions;
  const call = legalActions.find((action): action is Extract<PokerAction, { kind: "call" }> => action.kind === "call");
  const hero = flopDecision.players.find((player) => player.id === seatId(2));
  const villain = flopDecision.players.find((player) => player.id === seatId(7));
  if (call === undefined || hero === undefined || villain === undefined) throw new Error("Acceptance fixture invariant failed");
  const effective = Math.min(hero.stackBB, villain.stackBB) as BB;
  const callOdds = potOdds(call.amount, flopDecision.potBB);
  return {
    config,
    preflopComplete,
    flopDecision,
    legalActions,
    math: {
      flopStartPotBB: preflopComplete.flopStartPotBB ?? preflopComplete.potBB,
      decisionPotBB: flopDecision.potBB,
      callOdds,
      callOddsPct: callOdds.value * 100,
      currentSPR: spr(effective, flopDecision.potBB),
    },
    continueWith(action) {
      if (!legalActions.some((legal) => JSON.stringify(legal) === JSON.stringify(action))) throw new RangeError("Action was not issued for this fixture");
      return act(flopDecision, action);
    },
  };
}

export const acceptanceReplay: readonly PokerAction[] = [
  { kind: "fold" },
  { kind: "fold" },
  { kind: "fold" },
  { kind: "fold" },
  { kind: "raise", to: bb(2.5) },
  { kind: "fold" },
  { kind: "fold" },
  { kind: "call", amount: bb(1.5) },
  { kind: "check" },
  { kind: "bet", to: bb(1.8) },
];

/**
 * Session-ready version of the golden node. Fixed cards and the two small
 * public fixture ranges exist for deterministic replay only; they are not
 * equilibrium range claims.
 */
export function createAcceptanceNodeDefinition(
  strategyProvider: StrategyProvider,
  rngMode: RngMode = "off",
  seed = 20_260_826,
): NodeScenarioDefinition {
  const base = createCashConfig(8, bb(100));
  return {
    id: "acceptance-bb-co-qsts",
    config: {
      ...base,
      actionTreeId: acceptanceActionTree.id,
      strategyProviderId: strategyProvider.id,
    },
    heroSeatId: seatId(2),
    buttonIndex: 0,
    actionTree: acceptanceActionTree,
    strategyProvider,
    seed,
    rng: { mode: rngMode, revealRollBeforeAction: true },
    fixedHoleCards: {
      [seatId(0)]: [card("Ac"), card("Ad")],
      [seatId(1)]: [card("Kc"), card("Kh")],
      [seatId(2)]: [card("Qs"), card("Ts")],
      [seatId(3)]: [card("3c"), card("3d")],
      [seatId(4)]: [card("5c"), card("5d")],
      [seatId(5)]: [card("6c"), card("6d")],
      [seatId(6)]: [card("7c"), card("7d")],
      [seatId(7)]: [card("As"), card("Js")],
    },
    ranges: {
      [seatId(2)]: createRange([
        { cards: [card("Qs"), card("Ts")], weight: 1 },
        { cards: [card("Qc"), card("Tc")], weight: 0.5 },
      ]),
      [seatId(7)]: createRange([
        { cards: [card("As"), card("Js")], weight: 1 },
        { cards: [card("Ah"), card("Jh")], weight: 0.5 },
      ]),
    },
    futureBoard: [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")],
    replay: acceptanceReplay,
    expected: {
      actor: seatId(2),
      street: "flop",
      board: [card("Qh"), card("8s"), card("4s")],
      potBB: bb(7.3),
      currentBetBB: bb(1.8),
    },
    sourceTags: {
      preflopLine: "vs-open",
      potType: "SRP",
      strategicClasses: ["bluff-catcher"],
    },
  };
}

/** Convenient serializable facts for stories, smoke tests, and non-domain consumers. */
export function acceptanceSpotSummary(): Readonly<Record<string, number | readonly number[]>> {
  const spot = createAcceptanceSpot();
  return {
    flopStartPotBB: bbToNumber(spot.math.flopStartPotBB),
    decisionPotBB: bbToNumber(spot.math.decisionPotBB),
    callOddsPct: spot.math.callOddsPct,
    raiseTargetsBB: spot.legalActions.filter((action): action is Extract<PokerAction, { kind: "raise" | "jam" }> => action.kind === "raise" || action.kind === "jam").map((action) => bbToNumber(action.to)),
  };
}
