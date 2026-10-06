import { actionKey, type PokerAction } from "../domain/actions";
import { actionEconomics } from "../domain/economics";
import { actorContestablePot, amountToCall, type PokerState } from "../domain/rules";
import { bb, bbAdd, bbSub, bbToNumber, formatBB as formatDomainBB } from "../domain/money";
import { potOdds, spr } from "../domain/math";
import { positionLabel, seatId, seatIndex } from "../domain/seats";

export type Suit = "♠" | "♥" | "♦" | "♣";
export type Card = { rank: string; suit: Suit };

export type LegalAction = {
  id: string;
  family: "fold" | "check" | "call" | "bet" | "raise" | "all-in";
  label: string;
  amountAddedBB: number;
  totalSizeBB: number;
  annotation: string;
  detail: string;
  potIfCalledBB?: number;
  uncalledReturnBB?: number;
  heroBehindBB: number;
  villainBehindBB: number;
  projectedSpr?: number;
  aggressiveFractionOfPotAfterCall?: number;
  previousBetMultiple?: number;
  domainAction: PokerAction;
};

export type SeatState = {
  position: string;
  stackBB: number;
  status: string;
  holeCards?: Card[];
  isHero?: boolean;
  isButton?: boolean;
  isActive?: boolean;
  isInHand?: boolean;
};

export type TrainerState = {
  street: "Preflop" | "Flop" | "Turn" | "River";
  board: Card[];
  potBB: number;
  flopStartPotBB: number | null;
  currentBetBB: number;
  amountToCallBB: number;
  heroStackBB: number;
  villainStackBB: number;
  playerCount: number;
  activePlayerCount: number;
  heroPosition: string;
  opponentPosition: string;
  actorLabel: string;
  callOdds: {
    callBB: number;
    potAtDecisionBB: number;
    finalPotBB: number;
    requiredEquityPct: number;
    rewardToRisk: number;
    formula: string;
  } | null;
  exactCallOddsPct: number;
  exactCurrentSpr: number;
  exactFlopStartSpr: number | null;
  actionHistory: string[];
  seats: SeatState[];
  legalActions: LegalAction[];
  domainState: PokerState;
};

const suitMap: Record<string, Suit> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const defaultHeroId = seatId(2);

const compact = (value: number) => Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
export const formatBB = (value: number) => formatDomainBB(bb(value));

function cardForUi(value: string): Card {
  return { rank: value[0] ?? "?", suit: suitMap[value[1] ?? "s"] ?? "♠" };
}

function actionText(action: PokerAction): string {
  switch (action.kind) {
    case "fold": return "folds";
    case "check": return "checks";
    case "call": return `calls ${formatDomainBB(action.amount)}`;
    case "bet": return `bets ${formatDomainBB(action.to)}`;
    case "raise": return `raises to ${formatDomainBB(action.to)}`;
    case "jam": return `jams to ${formatDomainBB(action.to)}`;
  }
}

function recordText(state: PokerState, record: PokerState["actionHistory"][number]): string {
  const label = positionLabel(seatIndex(record.seatId), state.buttonIndex, state.config.playerCount);
  return `${label} ${actionText(record.action)}`;
}

function lastStatus(state: PokerState, playerId: PokerState["players"][number]["id"]): string {
  if (state.actor === playerId) return "To act";
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (player?.status === "folded") return "Folded";
  if (player?.status === "all-in") return "All-in";
  const last = [...state.actionHistory].reverse().find((record) => record.seatId === playerId && record.street === state.street);
  return last ? actionText(last.action).replace(/^./, (letter) => letter.toUpperCase()) : "Waiting";
}

function actionForUi(state: PokerState, action: PokerAction, comparisonOpponentId: PokerState["players"][number]["id"], projectionOpponentId?: PokerState["players"][number]["id"]): LegalAction {
  const economics = actionEconomics(state, action, projectionOpponentId);
  const total = bbToNumber(economics.totalToBB);
  const added = bbToNumber(economics.amountAddedBB);
  const potIfCalled = bbToNumber(economics.contestablePotIfCalledByOneBB);
  // With multiple possible callers, unmatched chips are not a known return.
  // A one-opponent projection must be selected before presenting that result.
  const uncalledReturn = economics.opponentSelection === "MULTIWAY_UNSPECIFIED"
    ? 0 : bbToNumber(economics.uncalledReturnBB);
  const heroBehind = bbToNumber(economics.heroBehindBB);
  const villainBehind = economics.opponentBehindBB === undefined
    ? bbToNumber(state.players.find((player) => player.id === comparisonOpponentId)?.stackBB ?? bb(0))
    : bbToNumber(economics.opponentBehindBB);
  let family: LegalAction["family"];
  let label: string;
  let annotation: string;

  switch (action.kind) {
    case "fold":
      family = "fold";
      label = "Fold";
      annotation = "Surrender the pot";
      break;
    case "check":
      family = "check";
      label = "Check";
      annotation = state.pending.some((seatId) => seatId !== state.actor) ? "Pass action" : "Close the betting round";
      break;
    case "call":
      family = "call";
      label = `Call ${formatDomainBB(action.amount)}`;
      annotation = `+${formatDomainBB(action.amount)} · ${state.pending.some((seatId) => seatId !== state.actor) ? "action continues" : "closes the betting round"}`;
      break;
    case "bet":
      family = "bet";
      label = `Bet ${formatDomainBB(action.to)}`;
      annotation = `+${formatDomainBB(economics.amountAddedBB)} · ${Math.round((economics.potFraction ?? 0) * 100)}% pot`;
      break;
    case "raise":
      family = "raise";
      label = `Raise to ${formatDomainBB(action.to)}`;
      annotation = `+${formatDomainBB(economics.amountAddedBB)} · ${Math.round((economics.raiseFractionOfPotAfterCall ?? 0) * 100)}% pot · ${compact(economics.previousBetMultiple ?? 0)}× bet`;
      break;
    case "jam":
      family = "all-in";
      label = `Jam ${formatDomainBB(action.to)}`;
      annotation = `+${formatDomainBB(economics.amountAddedBB)}${economics.raiseFractionOfPotAfterCall === undefined ? "" : ` · ${Math.round(economics.raiseFractionOfPotAfterCall * 100)}% pot`} · all-in`;
      break;
  }

  const detail = [
    label,
    `Current pot ${formatDomainBB(state.potBB)}`,
    `Amount to call ${formatDomainBB(economics.amountToCallBB)}`,
    ...(action.kind === "fold" || action.kind === "check" ? [] : [`Amount added ${formatDomainBB(economics.amountAddedBB)}`, `Total size ${formatDomainBB(economics.totalToBB)}`]),
    ...(action.kind === "fold" || action.kind === "check" || economics.opponentSelection === "MULTIWAY_UNSPECIFIED" ? [] : [`Contestable pot if called by one player ${formatDomainBB(economics.contestablePotIfCalledByOneBB)}`]),
    ...(uncalledReturn > 0 ? [`Uncalled excess returned ${formatDomainBB(economics.uncalledReturnBB)}`] : []),
    `Hero behind ${formatDomainBB(economics.heroBehindBB)}`,
    ...(economics.opponentBehindBB === undefined ? [] : [`Opponent behind ${formatDomainBB(economics.opponentBehindBB)}`]),
    ...(action.kind === "fold" || economics.projectedSPR === undefined ? [] : [`Projected SPR ${economics.projectedSPR.toFixed(2)}`]),
  ].join(". ");

  return {
    id: actionKey(action),
    family,
    label,
    amountAddedBB: added,
    totalSizeBB: total,
    annotation,
    detail,
    ...(action.kind === "fold" || action.kind === "check" || (economics.opponentSelection === "MULTIWAY_UNSPECIFIED" && action.kind !== "call")
      ? {}
      : { potIfCalledBB: potIfCalled }),
    ...(uncalledReturn > 0 ? { uncalledReturnBB: uncalledReturn } : {}),
    heroBehindBB: heroBehind,
    villainBehindBB: villainBehind,
    ...(economics.projectedSPR === undefined ? {} : { projectedSpr: Number(economics.projectedSPR.toFixed(2)) }),
    ...(economics.raiseFractionOfPotAfterCall === undefined ? {} : { aggressiveFractionOfPotAfterCall: economics.raiseFractionOfPotAfterCall }),
    ...(economics.previousBetMultiple === undefined ? {} : { previousBetMultiple: economics.previousBetMultiple }),
    domainAction: action,
  };
}

export function toTrainerState(state: PokerState, legalActions: readonly PokerAction[], heroSeatId = defaultHeroId): TrainerState {
  const heroId = heroSeatId;
  const hero = state.players.find((player) => player.id === heroId);
  const liveOpponents = state.players.filter((player) => player.id !== heroId && player.status !== "folded");
  const latestLiveOpponent = [...state.actionHistory].reverse()
    .map(({ seatId: id }) => liveOpponents.find((player) => player.id === id))
    .find((player) => player !== undefined);
  const villain = state.actor === null || state.actor === heroId
    ? latestLiveOpponent ?? liveOpponents[0] ?? state.players.find((player) => player.id !== heroId)
    : state.players.find((player) => player.id === state.actor);
  if (hero === undefined || villain === undefined) throw new Error("Hero or comparison opponent is missing");
  const effective = Math.min(hero.stackBB, villain.stackBB) as typeof hero.stackBB;
  const displayOrder = ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
  const seats = state.players.map((player): SeatState => {
    const position = positionLabel(seatIndex(player.id), state.buttonIndex, state.config.playerCount);
    return {
      position,
      stackBB: bbToNumber(player.stackBB),
      status: lastStatus(state, player.id),
      ...(player.holeCards === undefined ? {} : { holeCards: player.holeCards.map(cardForUi) }),
      ...(player.id === heroId ? { isHero: true } : {}),
      ...(seatIndex(player.id) === state.buttonIndex ? { isButton: true } : {}),
      ...(player.id === state.actor ? { isActive: true } : {}),
      ...(player.id !== heroId && player.status !== "folded" ? { isInHand: true } : {}),
    };
  }).sort((left, right) => displayOrder.indexOf(left.position) - displayOrder.indexOf(right.position));
  const call = legalActions.find((action): action is Extract<PokerAction, { kind: "call" }> => action.kind === "call");
  const contestablePot = call === undefined ? null : actorContestablePot(state, heroId).contestablePotAtDecisionBB;
  const odds = call === undefined || contestablePot === null ? null : potOdds(call.amount, contestablePot);
  const current = spr(effective, state.potBB).value;
  const flopStartPot = state.flopStartPotBB;
  const heroAtFlopStart = state.flopStartStacksBB?.[hero.id];
  const villainAtFlopStart = state.flopStartStacksBB?.[villain.id];
  const effectiveAtFlopStart = heroAtFlopStart === undefined || villainAtFlopStart === undefined
    ? undefined
    : Math.min(heroAtFlopStart, villainAtFlopStart) as typeof hero.stackBB;
  const flopStart = flopStartPot === undefined || effectiveAtFlopStart === undefined || flopStartPot <= 0
    ? null
    : spr(effectiveAtFlopStart, flopStartPot).value;
  const heroPosition = positionLabel(seatIndex(hero.id), state.buttonIndex, state.config.playerCount);
  const opponentPosition = positionLabel(seatIndex(villain.id), state.buttonIndex, state.config.playerCount);
  const actorLabel = state.actor === null
    ? "Hand complete"
    : positionLabel(seatIndex(state.actor), state.buttonIndex, state.config.playerCount);

  return {
    street: `${state.street[0]?.toUpperCase() ?? ""}${state.street.slice(1)}` as TrainerState["street"],
    board: state.board.map(cardForUi),
    potBB: bbToNumber(state.potBB),
    flopStartPotBB: flopStartPot === undefined ? null : bbToNumber(flopStartPot),
    currentBetBB: bbToNumber(state.currentBetBB),
    amountToCallBB: bbToNumber(amountToCall(state)),
    heroStackBB: bbToNumber(hero.stackBB),
    villainStackBB: bbToNumber(villain.stackBB),
    playerCount: state.config.playerCount,
    activePlayerCount: state.players.filter((player) => player.status !== "folded").length,
    heroPosition,
    opponentPosition,
    actorLabel,
    callOdds: odds === null || call === undefined ? null : {
      callBB: bbToNumber(call.amount),
      potAtDecisionBB: bbToNumber(contestablePot ?? state.potBB),
      finalPotBB: bbToNumber(contestablePot ?? state.potBB) + bbToNumber(call.amount),
      requiredEquityPct: odds.value * 100,
      rewardToRisk: bbToNumber(contestablePot ?? state.potBB) / bbToNumber(call.amount),
      formula: odds.formula,
    },
    exactCallOddsPct: Number(((odds?.value ?? 0) * 100).toFixed(1)),
    exactCurrentSpr: Number(current.toFixed(2)),
    exactFlopStartSpr: flopStart === null ? null : Number(flopStart.toFixed(2)),
    actionHistory: state.actionHistory.map((record) => recordText(state, record)),
    seats,
    legalActions: legalActions.map((action) => actionForUi(state, action, villain.id, liveOpponents.length === 1 ? villain.id : undefined)),
    domainState: state,
  };
}

export const currentSpr = (state: TrainerState) => state.exactCurrentSpr;
export const flopStartSpr = (state: TrainerState) => state.exactFlopStartSpr ?? "N/A";
export const potOddsPct = (state: TrainerState) => state.exactCallOddsPct;
