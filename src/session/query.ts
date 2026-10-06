import { resolveActionTree, type ActionTreeConfig } from "../domain/actionTree";
import { assertUniqueCards, type Card } from "../domain/cards";
import { deterministicHash } from "../domain/hash";
import { potOdds, potOddsAfterRake, spr } from "../domain/math";
import { bbAdd, ZERO_BB, type BB } from "../domain/money";
import { actorContestablePot, amountToCall, calculateRakeBB, type PokerState } from "../domain/rules";
import { positionLabel, type SeatId } from "../domain/seats";
import type { StrategyQuery } from "../domain/strategy";
import type { DecisionMath, SeatRangeMap } from "./types";

/** Every field is public game state; private cards, deck, and future board are excluded. */
export function createNodeDescriptor(state: PokerState): Readonly<Record<string, unknown>> {
  return {
    actor: state.actor,
    street: state.street,
    board: state.board,
    buttonIndex: state.buttonIndex,
    potBB: state.potBB,
    currentBetBB: state.currentBetBB,
    lastFullRaiseBB: state.lastFullRaiseBB,
    players: state.players.map((player) => ({
      id: player.id,
      stackBB: player.stackBB,
      streetContributionBB: player.streetContributionBB,
      totalContributionBB: player.totalContributionBB,
      status: player.status,
    })),
    history: state.actionHistory.map((record) => ({
      seatId: record.seatId,
      street: record.street,
      action: record.action,
      potAfterBB: record.potAfterBB,
    })),
  };
}

export function nodeHashForState(state: PokerState): string {
  return deterministicHash(createNodeDescriptor(state));
}

export function buildStrategyQuery(input: {
  readonly state: PokerState;
  readonly heroSeatId: SeatId;
  readonly ranges: SeatRangeMap;
  readonly actionTree: ActionTreeConfig;
  readonly deadCards?: readonly Card[];
}): StrategyQuery {
  const { state } = input;
  if (state.actor === null) throw new Error("A strategy query requires an actor");
  const deadCards = [...(input.deadCards ?? [])];
  assertUniqueCards([...state.board, ...deadCards]);
  const legalActions = resolveActionTree(state, input.actionTree).actions;
  const stacksBB = Object.fromEntries(state.players.map((player) => [player.id, player.stackBB])) as Record<SeatId, BB>;
  const activeOpponents = state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded");
  const actorPosition = positionLabel(Number(state.actor.slice(5)), state.buttonIndex, state.config.playerCount);
  const heroPosition = positionLabel(Number(input.heroSeatId.slice(5)), state.buttonIndex, state.config.playerCount);
  return {
    nodeHash: nodeHashForState(state),
    actorSeatId: state.actor,
    actorPosition,
    heroSeatId: input.heroSeatId,
    gameConfig: state.config,
    street: state.street,
    board: state.board,
    actionHistory: state.actionHistory.map(({ action }) => action),
    publicState: {
      buttonIndex: state.buttonIndex,
      currentBetBB: state.currentBetBB,
      lastFullRaiseBB: state.lastFullRaiseBB,
      players: state.players.map(({ id, stackBB, streetContributionBB, totalContributionBB, status }) => ({
        id,
        stackBB,
        streetContributionBB,
        totalContributionBB,
        status,
      })),
      actionHistory: state.actionHistory.map(({ seatId, street, action, potAfterBB }) => ({
        seatId,
        street,
        action,
        potAfterBB,
      })),
    },
    potBB: state.potBB,
    stacksBB,
    heroPosition,
    opponentPositions: activeOpponents.map((player) => positionLabel(Number(player.id.slice(5)), state.buttonIndex, state.config.playerCount)),
    ranges: input.ranges,
    legalActions,
    actionTree: input.actionTree,
    rake: state.config.rake,
    deadCards,
  };
}

export function decisionMathForState(state: PokerState): DecisionMath {
  if (state.actor === null) throw new Error("Decision math requires an actor");
  const actor = state.players.find((player) => player.id === state.actor);
  if (actor === undefined) throw new Error("Decision actor is absent from the player ledger");
  const opponents = state.players.filter((player) => player.id !== actor.id && player.status !== "folded");
  const perOpponent = opponents.map((opponent) => {
    const effectiveStackBB = Math.min(actor.stackBB, opponent.stackBB) as BB;
    return {
      seatId: opponent.id,
      effectiveStackBB,
      wagerCapable: opponent.status === "active" && opponent.stackBB > ZERO_BB,
      ...(state.potBB > ZERO_BB ? { currentSPR: spr(effectiveStackBB, state.potBB) } : {}),
    };
  });
  const selected = perOpponent
    .filter(({ wagerCapable }) => wagerCapable)
    .sort((left, right) => left.effectiveStackBB - right.effectiveStackBB)[0];
  const effectiveStackBB = selected?.effectiveStackBB ?? ZERO_BB;
  const effectiveStackBasis: DecisionMath["effectiveStackBasis"] = opponents.length === 0
    ? "NO_LIVE_OPPONENT"
    : selected === undefined
      ? "ALL_OPPONENTS_ALL_IN"
      : opponents.length === 1
      ? "HEADS_UP"
      : "SHORTEST_WAGER_CAPABLE_OPPONENT";
  const call = amountToCall(state);
  const contest = actorContestablePot(state);
  const closesCurrentBetting = state.pending.every((seat) => seat === actor.id);
  const compatibleRakeBenchmark = call > ZERO_BB
    && state.config.rake.enabled
    && opponents.length === 1
    && closesCurrentBetting
    && contest.excludedFromActorContestBB === ZERO_BB;
  const projectedRakeIfNoFurtherBettingBB = compatibleRakeBenchmark
    ? calculateRakeBB(
      state.config,
      bbAdd(contest.contestablePotAtDecisionBB, call),
      state.board.length >= 3 || state.street === "preflop",
    )
    : undefined;
  const potOddsCaveats = [
    "Raw pre-rake price: configured rake is not deducted from this benchmark.",
    "Required equity is a showdown break-even benchmark; future-street equity realization is not modeled.",
    ...(opponents.length > 1
      ? ["Multiway benchmark only: it is not a heads-up MDF or a recommended continue frequency."]
      : []),
    ...(state.pending.some((seat) => seat !== actor.id)
      ? ["Action may continue behind the caller, so the displayed price is not a closing-action guarantee."]
      : []),
  ];
  return {
    potAtDecisionBB: state.potBB,
    contestablePotAtDecisionBB: contest.contestablePotAtDecisionBB,
    excludedFromActorContestBB: contest.excludedFromActorContestBB,
    amountToCallBB: call,
    effectiveStackBB,
    effectiveStackBasis,
    ...(selected === undefined ? {} : { selectedOpponentSeatId: selected.seatId }),
    perOpponent,
    potOddsCaveats,
    ...(call > ZERO_BB
      ? {
        potOdds: potOdds(call, contest.contestablePotAtDecisionBB),
        potOddsBasis: "RAW_PRE_RAKE_CONTESTABLE_POT" as const,
      }
      : {}),
    ...(projectedRakeIfNoFurtherBettingBB === undefined ? {} : {
      projectedRakeIfNoFurtherBettingBB,
      rakeAdjustedPotOdds: potOddsAfterRake(call, contest.contestablePotAtDecisionBB, projectedRakeIfNoFurtherBettingBB),
      rakeAdjustedPotOddsBasis: "HEADS_UP_CLOSING_CALL_NO_FURTHER_BETTING" as const,
    }),
    ...(selected !== undefined && state.potBB > ZERO_BB ? { currentSPR: spr(effectiveStackBB, state.potBB) } : {}),
  };
}
