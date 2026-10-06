import { assertUniqueCards, createDeck, type Card } from "./cards";
import type { PokerAction } from "./actions";
import { validateGameConfig, type GameConfig } from "./config";
import { bbAdd, bbMin, bbSub, ZERO_BB, type BB } from "./money";
import {
  clockwiseIndex,
  orderedSeatIds,
  postflopFirstActorIndex,
  preflopFirstActorIndex,
  seatId,
  type SeatId,
} from "./seats";
import type { HandEvaluator } from "./evaluator";

export type Street = "preflop" | "flop" | "turn" | "river";
export type PlayerStatus = "active" | "folded" | "all-in";

export interface PlayerState {
  readonly id: SeatId;
  readonly stackBB: BB;
  readonly streetContributionBB: BB;
  readonly totalContributionBB: BB;
  readonly status: PlayerStatus;
  readonly holeCards?: readonly [Card, Card];
}

export interface ActionRecord {
  readonly seatId: SeatId;
  readonly street: Street;
  readonly action: PokerAction;
  readonly potAfterBB: BB;
}

export interface FoldTerminal {
  readonly type: "fold";
  readonly winner: SeatId;
}

export interface ShowdownTerminal {
  readonly type: "showdown";
}

export interface PokerState {
  readonly config: GameConfig;
  readonly buttonIndex: number;
  readonly street: Street;
  readonly players: readonly PlayerState[];
  readonly actor: SeatId | null;
  readonly pending: readonly SeatId[];
  readonly currentBetBB: BB;
  readonly lastFullRaiseBB: BB;
  readonly fullRaiseVersion: number;
  readonly actedAtVersion: Readonly<Partial<Record<SeatId, number>>>;
  readonly potBB: BB;
  readonly board: readonly Card[];
  readonly futureBoard: readonly Card[];
  readonly deck: readonly Card[];
  readonly actionHistory: readonly ActionRecord[];
  readonly flopStartPotBB?: BB;
  /** Stack-behind ledger captured immediately after preflop closes. */
  readonly flopStartStacksBB?: Readonly<Record<SeatId, BB>>;
  readonly terminal?: FoldTerminal | ShowdownTerminal;
}

export interface HandSetup {
  readonly buttonIndex?: number;
  readonly holeCards?: Readonly<Partial<Record<SeatId, readonly [Card, Card]>>>;
  readonly futureBoard?: readonly Card[];
  readonly deck?: readonly Card[];
  readonly dealUnknownHoleCards?: boolean;
}

export interface SidePot {
  readonly amountBB: BB;
  readonly eligible: readonly SeatId[];
}

export interface ContributionAccounting {
  /** Every committed unit still present in the immutable hand ledger. */
  readonly ledgerPotBB: BB;
  /** Pot layers funded by at least two seats and therefore actually contestable. */
  readonly contestablePotBB: BB;
  /** A unique high contributor's unmatched top layer, returned without rake. */
  readonly uncalledExcessBB: BB;
  readonly uncalledReturnSeatId?: SeatId;
}

export interface ActorContestablePot {
  /** Gross committed pot before this actor calls. */
  readonly ledgerPotBB: BB;
  /** Portion of the current pot the actor can win after making the capped call. */
  readonly contestablePotAtDecisionBB: BB;
  /** Existing upper pot layers this actor cannot win. */
  readonly excludedFromActorContestBB: BB;
  readonly callCapTotalContributionBB: BB;
}

export type PayoutLedger = Readonly<Partial<Record<SeatId, BB>>>;

export interface HandSettlementLedger {
  readonly terminalType: FoldTerminal["type"] | ShowdownTerminal["type"];
  readonly potBB: BB;
  readonly rakeBaseBB: BB;
  readonly uncalledReturnBB: BB;
  readonly uncalledReturnSeatId?: SeatId;
  readonly rakeBB: BB;
  readonly payoutsBB: Readonly<Record<SeatId, BB>>;
  readonly finalStacksBB: Readonly<Record<SeatId, BB>>;
  readonly totalBeforeBB: BB;
  readonly totalPlayerStacksAfterBB: BB;
  /** Player stacks plus house rake; this must exactly equal totalBeforeBB. */
  readonly totalAfterIncludingRakeBB: BB;
  readonly conserved: true;
  readonly nextButtonIndex: number;
}

export function nextButtonIndex(state: Pick<PokerState, "buttonIndex" | "config">): number {
  return clockwiseIndex(state.buttonIndex, 1, state.config.playerCount);
}

export function calculateRakeBB(config: GameConfig, potBB: BB, flopSeen: boolean): BB {
  if (!config.rake.enabled || (config.rake.noFlopNoDrop && !flopSeen)) return ZERO_BB;
  return bbMin(Math.floor(potBB * config.rake.percentage) as BB, config.rake.capBB);
}

/**
 * Separates the gross contribution ledger from the wagered pot. A sole highest
 * contribution above the second-highest contribution is an uncalled return,
 * not a one-player side pot and never part of the rake base.
 */
export function contributionAccounting(players: readonly PlayerState[]): ContributionAccounting {
  const ledgerPotBB = potOf(players);
  const ordered = [...players]
    .filter((player) => player.totalContributionBB > ZERO_BB)
    .sort((left, right) => right.totalContributionBB - left.totalContributionBB);
  const highest = ordered[0];
  const second = ordered[1];
  if (highest === undefined || highest.totalContributionBB === second?.totalContributionBB) {
    return { ledgerPotBB, contestablePotBB: ledgerPotBB, uncalledExcessBB: ZERO_BB };
  }
  const secondHighestBB = second?.totalContributionBB ?? ZERO_BB;
  const uncalledExcessBB = bbSub(highest.totalContributionBB, secondHighestBB);
  return {
    ledgerPotBB,
    contestablePotBB: bbSub(ledgerPotBB, uncalledExcessBB),
    uncalledExcessBB,
    uncalledReturnSeatId: highest.id,
  };
}

function copyPlayer(player: PlayerState, patch: Partial<PlayerState>): PlayerState {
  return { ...player, ...patch };
}

function playerAt(players: readonly PlayerState[], id: SeatId): PlayerState {
  const player = players.find((candidate) => candidate.id === id);
  if (player === undefined) throw new Error(`Unknown player: ${id}`);
  return player;
}

function contribute(players: readonly PlayerState[], id: SeatId, requested: BB, street = true): readonly PlayerState[] {
  return players.map((player) => {
    if (player.id !== id) return player;
    const paid = bbMin(requested, player.stackBB);
    const stack = bbSub(player.stackBB, paid);
    return copyPlayer(player, {
      stackBB: stack,
      streetContributionBB: street ? bbAdd(player.streetContributionBB, paid) : player.streetContributionBB,
      totalContributionBB: bbAdd(player.totalContributionBB, paid),
      status: stack === ZERO_BB ? "all-in" : player.status,
    });
  });
}

function potOf(players: readonly PlayerState[]): BB {
  return players.reduce<BB>((sum, player) => bbAdd(sum, player.totalContributionBB), ZERO_BB);
}

function nextPendingActor(state: Pick<PokerState, "config" | "players" | "pending">, afterIndex: number): SeatId | null {
  for (let offset = 1; offset <= state.config.playerCount; offset += 1) {
    const candidate = seatId(clockwiseIndex(afterIndex, offset, state.config.playerCount));
    if (state.pending.includes(candidate) && playerAt(state.players, candidate).status === "active") return candidate;
  }
  return null;
}

function initialDeck(setup: HandSetup, playerCount: number): { readonly deck: readonly Card[]; readonly holes: Readonly<Partial<Record<SeatId, readonly [Card, Card]>>> } {
  const holes: Partial<Record<SeatId, readonly [Card, Card]>> = { ...setup.holeCards };
  const fixedCards = [
    ...Object.values(holes).filter((value): value is readonly [Card, Card] => value !== undefined).flat(),
    ...(setup.futureBoard ?? []),
  ];
  assertUniqueCards(fixedCards);
  let deck = [...(setup.deck ?? createDeck())].filter((value) => !fixedCards.includes(value));
  assertUniqueCards(deck);
  if (setup.dealUnknownHoleCards === true) {
    for (let index = 0; index < playerCount; index += 1) {
      const id = seatId(index);
      if (holes[id] !== undefined) continue;
      const first = deck.shift();
      const second = deck.shift();
      if (first === undefined || second === undefined) throw new Error("Deck exhausted");
      holes[id] = [first, second];
    }
  }
  return { deck, holes };
}

export function createHand(configValue: GameConfig, setup: HandSetup = {}): PokerState {
  const config = validateGameConfig(configValue);
  const buttonIndex = setup.buttonIndex ?? 0;
  if (!Number.isSafeInteger(buttonIndex) || buttonIndex < 0 || buttonIndex >= config.playerCount) throw new RangeError("Invalid button index");
  const prepared = initialDeck(setup, config.playerCount);
  let players: readonly PlayerState[] = Array.from({ length: config.playerCount }, (_, index): PlayerState => {
    const id = seatId(index);
    const stack = config.startingStacksBB[id];
    if (stack === undefined) throw new RangeError(`Missing stack for ${id}`);
    const holeCards = prepared.holes[id];
    return {
      id,
      stackBB: stack,
      streetContributionBB: ZERO_BB,
      totalContributionBB: ZERO_BB,
      status: "active",
      ...(holeCards === undefined ? {} : { holeCards }),
    };
  });
  const smallBlindIndex = clockwiseIndex(buttonIndex, 1, config.playerCount);
  const bigBlindIndex = clockwiseIndex(buttonIndex, 2, config.playerCount);
  for (let index = 0; index < config.playerCount; index += 1) {
    players = contribute(players, seatId(index), config.anteBB, false);
  }
  players = contribute(players, seatId(smallBlindIndex), config.smallBlindBB);
  // 2024 TDA RP-11: in BBA format the live blind has priority over the ante.
  players = contribute(players, seatId(bigBlindIndex), config.bigBlindBB);
  players = contribute(players, seatId(bigBlindIndex), config.bigBlindAnteBB, false);
  // A dead or short all-in blind does not reduce the nominal preflop bring-in.
  let currentBet = config.bigBlindBB;
  let lastFullRaise = config.bigBlindBB;
  const liveStraddle = config.straddleBB !== undefined;
  if (config.straddleBB !== undefined) {
    const straddleIndex = clockwiseIndex(buttonIndex, 3, config.playerCount);
    players = contribute(players, seatId(straddleIndex), config.straddleBB);
    currentBet = config.straddleBB;
    lastFullRaise = config.straddleBB;
  }
  const firstIndex = preflopFirstActorIndex(config.playerCount, buttonIndex, liveStraddle);
  const pending = orderedSeatIds(config.playerCount, firstIndex).filter((id) => playerAt(players, id).status === "active");
  return {
    config,
    buttonIndex,
    street: "preflop",
    players,
    actor: pending[0] ?? null,
    pending,
    currentBetBB: currentBet,
    lastFullRaiseBB: lastFullRaise,
    fullRaiseVersion: 0,
    actedAtVersion: {},
    potBB: potOf(players),
    board: [],
    futureBoard: setup.futureBoard ?? [],
    deck: prepared.deck,
    actionHistory: [],
  };
}

export function amountToCall(state: PokerState, id = state.actor): BB {
  if (id === null) return ZERO_BB;
  const player = playerAt(state.players, id);
  return bbMin(bbSub(state.currentBetBB, player.streetContributionBB), player.stackBB);
}

/**
 * Returns the raw, pre-rake pot visible to one actor at a call decision. Upper
 * side-pot layers are capped at the actor's post-call total contribution,
 * because those chips cannot be won by this hand. This is a price benchmark;
 * it does not model future-street realization or multiway strategic effects.
 */
export function actorContestablePot(state: PokerState, id = state.actor): ActorContestablePot {
  if (id === null) throw new Error("Contestable pot requires an actor");
  const actor = playerAt(state.players, id);
  const call = amountToCall(state, id);
  const callCapTotalContributionBB = bbAdd(actor.totalContributionBB, call);
  const contestablePotAtDecisionBB = state.players.reduce<BB>(
    (sum, player) => bbAdd(sum, bbMin(player.totalContributionBB, callCapTotalContributionBB)),
    ZERO_BB,
  );
  return {
    ledgerPotBB: state.potBB,
    contestablePotAtDecisionBB,
    excludedFromActorContestBB: bbSub(state.potBB, contestablePotAtDecisionBB),
    callCapTotalContributionBB,
  };
}

export function canRaise(state: PokerState, id = state.actor): boolean {
  if (id === null) return false;
  const player = playerAt(state.players, id);
  if (player.status !== "active") return false;
  const alreadyActedAtVersion = state.actedAtVersion[id] === state.fullRaiseVersion;
  return !alreadyActedAtVersion && player.stackBB > amountToCall(state, id);
}

export function minimumRaiseTo(state: PokerState): BB {
  return bbAdd(state.currentBetBB, state.lastFullRaiseBB);
}

export function getLegalActions(state: PokerState, aggressiveTargets: readonly BB[] = []): readonly PokerAction[] {
  if (state.actor === null || state.terminal !== undefined) return [];
  const player = playerAt(state.players, state.actor);
  const toCall = amountToCall(state);
  const maxTo = bbAdd(player.streetContributionBB, player.stackBB);
  const actions: PokerAction[] = [];
  if (toCall > ZERO_BB) {
    actions.push({ kind: "fold" }, { kind: "call", amount: toCall });
  } else {
    actions.push({ kind: "check" });
  }
  if (!canRaise(state)) return actions;
  const isBet = state.currentBetBB === ZERO_BB;
  const minimum = isBet ? state.config.bigBlindBB : minimumRaiseTo(state);
  const targets = aggressiveTargets.length === 0 ? [minimum] : [...new Set(aggressiveTargets)].sort((a, b) => a - b);
  for (const target of targets) {
    if (target < minimum || target >= maxTo) continue;
    actions.push({ kind: isBet ? "bet" : "raise", to: target });
  }
  if (maxTo > state.currentBetBB) actions.push({ kind: "jam", to: maxTo });
  return actions;
}

function actionIsLegal(state: PokerState, action: PokerAction): boolean {
  return getLegalActions(state, "to" in action ? [action.to] : []).some((candidate) => {
    if (candidate.kind !== action.kind) return false;
    if (candidate.kind === "call" && action.kind === "call") return candidate.amount === action.amount;
    if ("to" in candidate && "to" in action) return candidate.to === action.to;
    return true;
  });
}

function dealBoard(state: PokerState, count: number): Pick<PokerState, "board" | "futureBoard" | "deck"> {
  const fromFuture = state.futureBoard.slice(0, count);
  const needed = count - fromFuture.length;
  const fromDeck = state.deck.slice(0, needed);
  if (fromFuture.length + fromDeck.length !== count) throw new Error("Not enough cards to advance street");
  return {
    board: [...state.board, ...fromFuture, ...fromDeck],
    futureBoard: state.futureBoard.slice(fromFuture.length),
    deck: state.deck.slice(needed),
  };
}

function advanceStreet(state: PokerState): PokerState {
  const streetOrder: readonly Street[] = ["preflop", "flop", "turn", "river"];
  const currentIndex = streetOrder.indexOf(state.street);
  if (currentIndex === streetOrder.length - 1) return { ...state, actor: null, pending: [], terminal: { type: "showdown" } };
  const nextStreet = streetOrder[currentIndex + 1];
  if (nextStreet === undefined) throw new Error("Street invariant failed");
  const cards = dealBoard(state, nextStreet === "flop" ? 3 : 1);
  const flopStartStacksBB = nextStreet === "flop"
    ? Object.fromEntries(state.players.map((player) => [player.id, player.stackBB])) as Record<SeatId, BB>
    : undefined;
  const players = state.players.map((player) => copyPlayer(player, { streetContributionBB: ZERO_BB }));
  const firstIndex = postflopFirstActorIndex(state.config.playerCount, state.buttonIndex);
  const pending = orderedSeatIds(state.config.playerCount, firstIndex).filter((id) => playerAt(players, id).status === "active");
  // With at most one player still able to wager, no further betting can occur.
  if (pending.length <= 1) {
    const advanced: PokerState = {
      ...state,
      ...cards,
      street: nextStreet,
      players,
      actor: null,
      pending: [],
      currentBetBB: ZERO_BB,
      lastFullRaiseBB: state.config.bigBlindBB,
      fullRaiseVersion: 0,
      actedAtVersion: {},
      ...(flopStartStacksBB === undefined ? {} : { flopStartPotBB: state.potBB, flopStartStacksBB }),
    };
    return advanceStreet(advanced);
  }
  return {
    ...state,
    ...cards,
    street: nextStreet,
    players,
    actor: pending[0] ?? null,
    pending,
    currentBetBB: ZERO_BB,
    lastFullRaiseBB: state.config.bigBlindBB,
    fullRaiseVersion: 0,
    actedAtVersion: {},
    ...(flopStartStacksBB === undefined ? {} : { flopStartPotBB: state.potBB, flopStartStacksBB }),
  };
}

export function applyAction(state: PokerState, action: PokerAction): PokerState {
  if (state.actor === null) throw new Error("No player is facing a decision");
  if (!actionIsLegal(state, action)) throw new RangeError(`Illegal action: ${action.kind}`);
  const actingId = state.actor;
  const actingIndex = Number(actingId.slice(5));
  let players = state.players;
  let currentBet = state.currentBetBB;
  let lastFullRaise = state.lastFullRaiseBB;
  let fullRaiseVersion = state.fullRaiseVersion;
  let pending = state.pending.filter((id) => id !== actingId);
  let actedAtVersion: Partial<Record<SeatId, number>> = { ...state.actedAtVersion, [actingId]: state.fullRaiseVersion };
  if (action.kind === "fold") {
    players = players.map((player) => player.id === actingId ? copyPlayer(player, { status: "folded" }) : player);
  } else if (action.kind === "call") {
    players = contribute(players, actingId, action.amount);
  } else if (action.kind === "bet" || action.kind === "raise" || action.kind === "jam") {
    const before = playerAt(players, actingId).streetContributionBB;
    const previousBet = currentBet;
    players = contribute(players, actingId, bbSub(action.to, before));
    currentBet = playerAt(players, actingId).streetContributionBB;
    const increment = bbSub(currentBet, previousBet);
    const isFullRaise = previousBet === ZERO_BB ? currentBet >= state.config.bigBlindBB : increment >= lastFullRaise;
    if (isFullRaise) {
      lastFullRaise = previousBet === ZERO_BB ? currentBet : increment;
      fullRaiseVersion += 1;
      actedAtVersion = { [actingId]: fullRaiseVersion };
      pending = players.filter((player) => player.id !== actingId && player.status === "active").map((player) => player.id);
    } else {
      pending = players
        .filter((player) => player.id !== actingId && player.status === "active" && player.streetContributionBB < currentBet)
        .map((player) => player.id);
    }
  }
  pending = pending.filter((id) => playerAt(players, id).status === "active");
  const pot = potOf(players);
  const history: readonly ActionRecord[] = [...state.actionHistory, { seatId: actingId, street: state.street, action, potAfterBB: pot }];
  const remaining = players.filter((player) => player.status !== "folded");
  if (remaining.length === 1) {
    const winner = remaining[0];
    if (winner === undefined) throw new Error("Winner invariant failed");
    return { ...state, players, actor: null, pending: [], currentBetBB: currentBet, lastFullRaiseBB: lastFullRaise, fullRaiseVersion, actedAtVersion, potBB: pot, actionHistory: history, terminal: { type: "fold", winner: winner.id } };
  }
  const interim: PokerState = {
    ...state,
    players,
    actor: null,
    pending,
    currentBetBB: currentBet,
    lastFullRaiseBB: lastFullRaise,
    fullRaiseVersion,
    actedAtVersion,
    potBB: pot,
    actionHistory: history,
  };
  if (pending.length === 0) return advanceStreet(interim);
  return { ...interim, actor: nextPendingActor(interim, actingIndex) };
}

export function deriveSidePots(players: readonly PlayerState[]): readonly SidePot[] {
  const levels = [...new Set(players.map((player) => player.totalContributionBB).filter((amount) => amount > ZERO_BB))].sort((a, b) => a - b);
  let previous = ZERO_BB;
  const pots: SidePot[] = [];
  for (const level of levels) {
    const contributors = players.filter((player) => player.totalContributionBB >= level);
    const amount = (bbSub(level, previous) * contributors.length) as BB;
    const eligible = contributors.filter((player) => player.status !== "folded").map((player) => player.id);
    if (amount > ZERO_BB) pots.push({ amountBB: amount, eligible });
    previous = level;
  }
  return pots;
}

function clockwiseWinnerOrder(state: PokerState, winners: readonly SeatId[]): readonly SeatId[] {
  const winnerSet = new Set(winners);
  const firstLeftOfButton = clockwiseIndex(state.buttonIndex, 1, state.config.playerCount);
  return orderedSeatIds(state.config.playerCount, firstLeftOfButton).filter((id) => winnerSet.has(id));
}

export function settleShowdown(state: PokerState, evaluator: HandEvaluator): PayoutLedger {
  if (state.terminal?.type !== "showdown" || state.board.length !== 5) throw new Error("State is not ready for showdown");
  const payouts: Partial<Record<SeatId, BB>> = {};
  const accounting = contributionAccounting(state.players);
  let rakeRemaining = calculateRakeBB(state.config, accounting.contestablePotBB, state.board.length >= 3);
  for (const pot of deriveSidePots(state.players)) {
    const rakeFromPot = bbMin(rakeRemaining, pot.amountBB);
    const distributable = bbSub(pot.amountBB, rakeFromPot);
    rakeRemaining = bbSub(rakeRemaining, rakeFromPot);
    const ranked = pot.eligible.map((id) => {
      const cards = playerAt(state.players, id).holeCards;
      if (cards === undefined) throw new Error(`Missing hole cards for ${id}`);
      return { id, score: evaluator.evaluate([...cards, ...state.board]).score };
    });
    const best = Math.max(...ranked.map(({ score }) => score));
    const winners = ranked.filter(({ score }) => score === best).map(({ id }) => id);
    const share = Math.floor(distributable / winners.length) as BB;
    let remainder = distributable - share * winners.length;
    // TDA Rule 20: each side pot starts its own odd-chip order left of button.
    for (const id of clockwiseWinnerOrder(state, winners)) {
      const extra = remainder > 0 ? 1 : 0;
      payouts[id] = bbAdd(payouts[id] ?? ZERO_BB, (share + extra) as BB);
      remainder -= extra;
    }
  }
  return payouts;
}

export function settleFold(state: PokerState): PayoutLedger {
  if (state.terminal?.type !== "fold") throw new Error("State did not end by folds");
  const accounting = contributionAccounting(state.players);
  const rake = calculateRakeBB(state.config, accounting.contestablePotBB, state.board.length >= 3);
  return { [state.terminal.winner]: bbSub(state.potBB, rake) };
}

/**
 * Produces an immutable end-of-hand ledger. It advances only the button index;
 * tournament elimination, reseating, and next-hand construction remain external.
 */
export function settleHand(state: PokerState, evaluator?: HandEvaluator): HandSettlementLedger {
  if (state.terminal === undefined) throw new Error("Hand is not terminal");
  const contributionTotal = potOf(state.players);
  if (contributionTotal !== state.potBB) throw new Error("Pot and contribution ledger do not match");
  const accounting = contributionAccounting(state.players);
  let payouts: PayoutLedger;
  if (state.terminal.type === "fold") {
    payouts = settleFold(state);
  } else {
    if (evaluator === undefined) throw new Error("A hand evaluator is required for showdown settlement");
    payouts = settleShowdown(state, evaluator);
  }
  const rakeBB = calculateRakeBB(state.config, accounting.contestablePotBB, state.board.length >= 3);
  const payoutTotal = Object.values(payouts).reduce<BB>((sum, amount) => bbAdd(sum, amount ?? ZERO_BB), ZERO_BB);
  if (bbAdd(payoutTotal, rakeBB) !== state.potBB) throw new Error("Payouts plus rake do not equal the pot");
  const payoutsBB = Object.fromEntries(state.players.map((player) => [player.id, payouts[player.id] ?? ZERO_BB])) as Record<SeatId, BB>;
  const finalStacksBB = Object.fromEntries(state.players.map((player) => [player.id, bbAdd(player.stackBB, payoutsBB[player.id] ?? ZERO_BB)])) as Record<SeatId, BB>;
  const stackTotalBefore = state.players.reduce<BB>((sum, player) => bbAdd(sum, player.stackBB), ZERO_BB);
  const totalBeforeBB = bbAdd(stackTotalBefore, state.potBB);
  const totalPlayerStacksAfterBB = Object.values(finalStacksBB).reduce<BB>((sum, stack) => bbAdd(sum, stack), ZERO_BB);
  const totalAfterIncludingRakeBB = bbAdd(totalPlayerStacksAfterBB, rakeBB);
  if (totalBeforeBB !== totalAfterIncludingRakeBB) throw new Error("Settlement does not conserve chips including rake");
  return {
    terminalType: state.terminal.type,
    potBB: state.potBB,
    rakeBaseBB: accounting.contestablePotBB,
    uncalledReturnBB: accounting.uncalledExcessBB,
    ...(accounting.uncalledReturnSeatId === undefined ? {} : { uncalledReturnSeatId: accounting.uncalledReturnSeatId }),
    rakeBB,
    payoutsBB,
    finalStacksBB,
    totalBeforeBB,
    totalPlayerStacksAfterBB,
    totalAfterIncludingRakeBB,
    conserved: true,
    nextButtonIndex: nextButtonIndex(state),
  };
}

/** Stateful-looking facade over immutable rule functions; it contains no strategy logic. */
export class PokerRulesEngine {
  create(config: GameConfig, setup: HandSetup = {}): PokerState {
    return createHand(config, setup);
  }

  legalActions(state: PokerState, aggressiveTargets: readonly BB[] = []): readonly PokerAction[] {
    return getLegalActions(state, aggressiveTargets);
  }

  dispatch(state: PokerState, action: PokerAction): PokerState {
    return applyAction(state, action);
  }

  sidePots(state: PokerState): readonly SidePot[] {
    return deriveSidePots(state.players);
  }

  settleShowdown(state: PokerState, evaluator: HandEvaluator): PayoutLedger {
    return settleShowdown(state, evaluator);
  }

  settleFold(state: PokerState): PayoutLedger {
    return settleFold(state);
  }

  settle(state: PokerState, evaluator?: HandEvaluator): HandSettlementLedger {
    return settleHand(state, evaluator);
  }
}
