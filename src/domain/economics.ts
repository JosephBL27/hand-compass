import type { PokerAction } from "./actions";
import { bbAdd, bbMin, bbSub, bbToNumber, ZERO_BB, type BB } from "./money";
import { amountToCall, contributionAccounting, type PokerState } from "./rules";
import type { SeatId } from "./seats";

export interface ActionEconomics {
  readonly currentPotBB: BB;
  readonly amountToCallBB: BB;
  readonly amountAddedBB: BB;
  readonly totalToBB: BB;
  /** Aggressive increment above the amount required to call. */
  readonly raiseIncrementBB?: BB;
  /** Bet/pure-raise increment divided by the pot after calling, when defined. */
  readonly raiseFractionOfPotAfterCall?: number;
  /** Backward-compatible alias of raiseFractionOfPotAfterCall. */
  readonly potFraction?: number;
  readonly previousBetMultiple?: number;
  /** Gross immutable contribution ledger after Hero acts and one named opponent calls. */
  readonly potIfCalledByOneBB: BB;
  readonly ledgerPotIfCalledByOneBB: BB;
  /** Gross pot less a unique unmatched top contribution. */
  readonly contestablePotIfCalledByOneBB: BB;
  readonly uncalledReturnBB: BB;
  readonly heroBehindBB: BB;
  readonly opponentId?: SeatId;
  readonly opponentSelection: "EXPLICIT" | "ONLY_LIVE_OPPONENT" | "MULTIWAY_UNSPECIFIED" | "NO_LIVE_OPPONENT";
  readonly opponentBehindBB?: BB;
  readonly effectiveStackBehindBB?: BB;
  readonly projectedSPR?: number;
}

export function effectiveStackAgainst(state: PokerState, heroId: SeatId, opponentId: SeatId): BB {
  const hero = state.players.find((player) => player.id === heroId);
  const opponent = state.players.find((player) => player.id === opponentId);
  if (hero === undefined || opponent === undefined) throw new RangeError("Unknown effective-stack seat");
  return bbMin(hero.stackBB, opponent.stackBB);
}

export function actionEconomics(state: PokerState, action: PokerAction, opponentId?: SeatId): ActionEconomics {
  if (state.actor === null) throw new Error("No current actor");
  const hero = state.players.find((player) => player.id === state.actor);
  if (hero === undefined) throw new Error("Actor invariant failed");
  const toCall = amountToCall(state);
  const target = "to" in action ? action.to : action.kind === "call" ? bbAdd(hero.streetContributionBB, action.amount) : hero.streetContributionBB;
  const amountAdded = action.kind === "fold" || action.kind === "check" ? ZERO_BB : bbSub(target, hero.streetContributionBB);
  const heroBehind = bbSub(hero.stackBB, amountAdded);
  const liveOpponents = state.players.filter((player) => player.id !== hero.id && player.status !== "folded");
  const explicitOpponent = opponentId === undefined
    ? undefined
    : liveOpponents.find((player) => player.id === opponentId);
  const opponent = explicitOpponent ?? (opponentId === undefined && liveOpponents.length === 1 ? liveOpponents[0] : undefined);
  const opponentSelection: ActionEconomics["opponentSelection"] = opponentId !== undefined && explicitOpponent !== undefined
    ? "EXPLICIT"
    : opponent !== undefined
      ? "ONLY_LIVE_OPPONENT"
      : liveOpponents.length === 0
        ? "NO_LIVE_OPPONENT"
        : "MULTIWAY_UNSPECIFIED";
  const opponentCallNeeded = opponent !== undefined && "to" in action && target > opponent.streetContributionBB
    ? bbSub(target, opponent.streetContributionBB)
    : ZERO_BB;
  const opponentCall = opponent === undefined ? ZERO_BB : bbMin(opponentCallNeeded, opponent.stackBB);
  const opponentBehind = opponent === undefined ? undefined : bbSub(opponent.stackBB, opponentCall);
  const effective = opponentBehind === undefined ? undefined : bbMin(heroBehind, opponentBehind);
  const projectedPlayers = state.players.map((player) => {
    if (player.id === hero.id) {
      return { ...player, stackBB: heroBehind, totalContributionBB: bbAdd(player.totalContributionBB, amountAdded) };
    }
    if (opponent !== undefined && player.id === opponent.id) {
      return { ...player, stackBB: opponentBehind ?? player.stackBB, totalContributionBB: bbAdd(player.totalContributionBB, opponentCall) };
    }
    return player;
  });
  const projectedAccounting = contributionAccounting(projectedPlayers);
  const projectedSPR = effective === undefined || projectedAccounting.contestablePotBB === ZERO_BB
    ? undefined
    : effective / projectedAccounting.contestablePotBB;
  const raiseIncrement = "to" in action
    ? state.currentBetBB === ZERO_BB
      ? amountAdded
      : bbSub(amountAdded, toCall)
    : undefined;
  const raiseFraction = raiseIncrement === undefined
    ? undefined
    : bbToNumber(raiseIncrement) / bbToNumber(state.currentBetBB === ZERO_BB ? state.potBB : bbAdd(state.potBB, toCall));
  return {
    currentPotBB: state.potBB,
    amountToCallBB: toCall,
    amountAddedBB: amountAdded,
    totalToBB: target,
    ...(raiseIncrement === undefined ? {} : { raiseIncrementBB: raiseIncrement }),
    ...(raiseFraction === undefined || !Number.isFinite(raiseFraction)
      ? {}
      : { raiseFractionOfPotAfterCall: raiseFraction, potFraction: raiseFraction }),
    ...(state.currentBetBB > ZERO_BB && "to" in action ? { previousBetMultiple: target / state.currentBetBB } : {}),
    potIfCalledByOneBB: projectedAccounting.ledgerPotBB,
    ledgerPotIfCalledByOneBB: projectedAccounting.ledgerPotBB,
    contestablePotIfCalledByOneBB: projectedAccounting.contestablePotBB,
    uncalledReturnBB: projectedAccounting.uncalledExcessBB,
    heroBehindBB: heroBehind,
    opponentSelection,
    ...(opponent === undefined ? {} : { opponentId: opponent.id }),
    ...(opponentBehind === undefined ? {} : { opponentBehindBB: opponentBehind }),
    ...(effective === undefined ? {} : { effectiveStackBehindBB: effective }),
    ...(projectedSPR === undefined ? {} : { projectedSPR }),
  };
}
