import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PokerRulesEngine,
  amountToCall,
  applyAction,
  bb,
  bbAdd,
  bbFromUnits,
  calculateRakeBB,
  canRaise,
  createCashConfig,
  createHand,
  getLegalActions,
  minimumRaiseTo,
  positionLabel,
  preflopFirstActorIndex,
  seatId,
  settleHand,
  settleShowdown,
  sevenCardEvaluator,
  type BB,
  type GameConfig,
  type HandEvaluator,
  type PlayerCount,
  type PlayerState,
  type PokerState,
} from "../src/domain";
import { card } from "../src/domain/cards";

function configWithStacks(values: readonly number[], patch: Partial<GameConfig> = {}): GameConfig {
  const count = values.length as PlayerCount;
  const base = createCashConfig(count);
  const startingStacksBB = Object.fromEntries(values.map((value, index) => [seatId(index), bb(value)])) as Record<ReturnType<typeof seatId>, BB>;
  return { ...base, ...patch, playerCount: count, startingStacksBB };
}

function foldToTerminal(config: GameConfig): PokerState {
  let state = createHand(config);
  while (state.terminal === undefined) state = applyAction(state, { kind: "fold" });
  return state;
}

function manualShowdown(input: {
  readonly playerCount: PlayerCount;
  readonly buttonIndex?: number;
  readonly contributionUnits: readonly number[];
  readonly stackUnits: readonly number[];
  readonly statuses?: readonly PlayerState["status"][];
  readonly holes: readonly (readonly [ReturnType<typeof card>, ReturnType<typeof card>])[];
  readonly board: readonly ReturnType<typeof card>[];
}): PokerState {
  const config = createCashConfig(input.playerCount, bb(100));
  const holeCards = Object.fromEntries(input.holes.map((cards, index) => [seatId(index), cards]));
  const created = createHand(config, {
    buttonIndex: input.buttonIndex ?? 0,
    holeCards,
    futureBoard: input.board,
  });
  const players = created.players.map((player, index): PlayerState => ({
    ...player,
    stackBB: bbFromUnits(input.stackUnits[index] ?? 0),
    streetContributionBB: bbFromUnits(0),
    totalContributionBB: bbFromUnits(input.contributionUnits[index] ?? 0),
    status: input.statuses?.[index] ?? "active",
  }));
  const potBB = players.reduce<BB>((sum, player) => bbAdd(sum, player.totalContributionBB), bbFromUnits(0));
  return {
    ...created,
    street: "river",
    players,
    actor: null,
    pending: [],
    currentBetBB: bbFromUnits(0),
    potBB,
    board: input.board,
    futureBoard: [],
    terminal: { type: "showdown" },
  };
}

const scoreByFirstCard = (scores: Readonly<Record<string, number>>): HandEvaluator => ({
  evaluate(cards) {
    return { score: scores[cards[0] ?? ""] ?? 0, category: "high-card" };
  },
});

describe("2024 TDA blind and action lifecycle", () => {
  it("keeps a nominal 1 BB bring-in and 2 BB minimum raise when the BB posts only 0.5 BB", () => {
    let state = createHand(configWithStacks([100, 100, 0.5, 100]));
    expect(state.currentBetBB).toBe(bb(1));
    expect(state.potBB).toBe(bb(1));
    expect(amountToCall(state)).toBe(bb(1));
    expect(minimumRaiseTo(state)).toBe(bb(2));
    expect(getLegalActions(state).some((action) => action.kind === "raise" && action.to === bb(2))).toBe(true);
    state = applyAction(state, { kind: "call", amount: bb(1) });
    expect(state.actor).toBe(seatId(0));
    expect(amountToCall(state)).toBe(bb(1));
  });

  it("posts the live big blind before BBA when the BB can cover only one", () => {
    const state = createHand(configWithStacks([100, 100, 1, 100], { bigBlindAnteBB: bb(1) }));
    const bigBlind = state.players[2]!;
    expect(bigBlind.stackBB).toBe(bb(0));
    expect(bigBlind.streetContributionBB).toBe(bb(1));
    expect(bigBlind.totalContributionBB).toBe(bb(1));
    expect(state.currentBetBB).toBe(bb(1));
    expect(state.potBB).toBe(bb(1.5));
  });

  it("preserves non-reopening for every returning actor after one short all-in", () => {
    let state = createHand(configWithStacks([100, 4, 30, 100]));
    state = applyAction(state, { kind: "raise", to: bb(3) }); // CO
    state = applyAction(state, { kind: "call", amount: bb(3) }); // BTN
    state = applyAction(state, { kind: "jam", to: bb(4) }); // SB short raise
    state = applyAction(state, { kind: "call", amount: bb(3) }); // BB
    expect(state.actor).toBe(seatId(3));
    expect(canRaise(state)).toBe(false);
    expect(getLegalActions(state).map(({ kind }) => kind)).toEqual(["fold", "call"]);
    state = applyAction(state, { kind: "call", amount: bb(1) });
    expect(state.actor).toBe(seatId(0));
    expect(canRaise(state)).toBe(false);
    expect(getLegalActions(state).map(({ kind }) => kind)).toEqual(["fold", "call"]);
    state = applyAction(state, { kind: "call", amount: bb(1) });
    expect(state.street).toBe("flop");
    expect(state.potBB).toBe(bb(16));
  });

  it("automatically runs an all-in hand through the river once no betting remains", () => {
    let state = createHand(configWithStacks([1, 1, 1, 1]), {
      futureBoard: [card("2c"), card("3d"), card("4h"), card("5s"), card("9c")],
    });
    while (state.terminal === undefined) {
      expect(state.actor).not.toBeNull();
      state = applyAction(state, { kind: "call", amount: amountToCall(state) });
    }
    expect(state.terminal).toEqual({ type: "showdown" });
    expect(state.street).toBe("river");
    expect(state.board).toEqual([card("2c"), card("3d"), card("4h"), card("5s"), card("9c")]);
    expect(state.potBB).toBe(bb(4));
  });

  it("keeps 4–8 handed labels and preflop order correct with and without a straddle", () => {
    const labels: Readonly<Record<PlayerCount, readonly string[]>> = {
      4: ["BTN", "SB", "BB", "CO"],
      5: ["BTN", "SB", "BB", "HJ", "CO"],
      6: ["BTN", "SB", "BB", "LJ", "HJ", "CO"],
      7: ["BTN", "SB", "BB", "UTG", "LJ", "HJ", "CO"],
      8: ["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"],
    };
    for (const count of [4, 5, 6, 7, 8] as const) {
      expect(Array.from({ length: count }, (_, index) => positionLabel(index, 0, count))).toEqual(labels[count]);
      expect(createHand(createCashConfig(count)).actor).toBe(seatId(preflopFirstActorIndex(count, 0)));
      const straddled = createHand({ ...createCashConfig(count), straddleBB: bb(2) });
      expect(straddled.actor).toBe(seatId(preflopFirstActorIndex(count, 0, true)));
      expect(straddled.currentBetBB).toBe(bb(2));
      expect(minimumRaiseTo(straddled)).toBe(bb(4));
    }
  });

  it("posts a six-handed ante, BBA, blinds, and straddle to the exact ledgers", () => {
    const state = createHand({
      ...createCashConfig(6),
      anteBB: bb(0.1),
      bigBlindAnteBB: bb(1),
      straddleBB: bb(2),
    });
    expect(state.potBB).toBe(bb(5.1));
    expect(state.players.map(({ streetContributionBB }) => streetContributionBB)).toEqual([bb(0), bb(0.5), bb(1), bb(2), bb(0), bb(0)]);
    expect(state.players.map(({ totalContributionBB }) => totalContributionBB)).toEqual([bb(0.1), bb(0.6), bb(2.1), bb(2.1), bb(0.1), bb(0.1)]);
    expect(state.actor).toBe(seatId(4));
    expect(state.currentBetBB).toBe(bb(2));
    expect(minimumRaiseTo(state)).toBe(bb(4));
  });
});

describe("side pots, odd units, rake, and settlement", () => {
  it("settles a 40/30/20 main-plus-two-side-pot ladder and excludes the folded strongest hand", () => {
    const state = manualShowdown({
      playerCount: 4,
      contributionUnits: [bb(10), bb(20), bb(30), bb(30)],
      stackUnits: [bb(90), bb(80), bb(70), bb(70)],
      statuses: ["active", "active", "active", "folded"],
      holes: [
        [card("As"), card("Ad")],
        [card("Ks"), card("Kd")],
        [card("Qs"), card("Qd")],
        [card("Js"), card("Jd")],
      ],
      board: [card("2c"), card("3c"), card("4c"), card("5c"), card("7d")],
    });
    const evaluator = scoreByFirstCard({ As: 30, Ks: 20, Qs: 10, Js: 100 });
    const payouts = settleShowdown(state, evaluator);
    expect(payouts).toEqual({ [seatId(0)]: bb(40), [seatId(1)]: bb(30), [seatId(2)]: bb(20) });
    const ledger = settleHand(state, evaluator);
    expect(ledger.payoutsBB).toEqual({ [seatId(0)]: bb(40), [seatId(1)]: bb(30), [seatId(2)]: bb(20), [seatId(3)]: bb(0) });
    expect(ledger.finalStacksBB).toEqual({ [seatId(0)]: bb(130), [seatId(1)]: bb(110), [seatId(2)]: bb(90), [seatId(3)]: bb(70) });
    expect(ledger.totalBeforeBB).toBe(bb(400));
    expect(ledger.totalAfterIncludingRakeBB).toBe(bb(400));
    expect(ledger.conserved).toBe(true);
    expect(ledger.nextButtonIndex).toBe(1);
  });

  it("splits an even tied board pot exactly", () => {
    const state = manualShowdown({
      playerCount: 4,
      contributionUnits: [2, 2, 2, 2],
      stackUnits: [8, 8, 8, 8],
      holes: [
        [card("As"), card("Ad")], [card("Ks"), card("Kd")], [card("Qs"), card("Qd")], [card("Js"), card("Jd")],
      ],
      board: [card("2c"), card("3c"), card("4c"), card("5c"), card("7d")],
    });
    const payouts = settleShowdown(state, scoreByFirstCard({ Ks: 10, Js: 10 }));
    expect(payouts).toEqual({ [seatId(1)]: bbFromUnits(4), [seatId(3)]: bbFromUnits(4) });
  });

  it("restarts odd-unit priority left of the button for every side pot", () => {
    const state = manualShowdown({
      playerCount: 5,
      contributionUnits: [1, 2, 3, 4, 4],
      stackUnits: [9, 8, 7, 6, 6],
      holes: [
        [card("As"), card("Ad")], [card("Ks"), card("Kd")], [card("Qs"), card("Qd")], [card("Js"), card("Jd")], [card("Ts"), card("Td")],
      ],
      board: [card("2c"), card("3c"), card("4c"), card("5c"), card("7d")],
    });
    const payouts = settleShowdown(state, scoreByFirstCard({ Js: 10, Ts: 10 }));
    expect(payouts).toEqual({ [seatId(3)]: bbFromUnits(8), [seatId(4)]: bbFromUnits(6) });
  });

  it("applies no-flop-no-drop on fold terminals and accounts for rake when disabled", () => {
    const rake = { enabled: true, percentage: 0.1, capBB: bb(1), noFlopNoDrop: true } as const;
    const noDropState = foldToTerminal(configWithStacks([100, 100, 100, 100], { rake }));
    const noDrop = settleHand(noDropState);
    expect(noDrop.rakeBB).toBe(bb(0));
    expect(noDrop.payoutsBB[seatId(2)]).toBe(bb(1.5));

    const dropState = foldToTerminal(configWithStacks([100, 100, 100, 100], { rake: { ...rake, noFlopNoDrop: false } }));
    const drop = new PokerRulesEngine().settle(dropState);
    // The BB's unmatched 0.5 BB is returned without rake; only the 1 BB
    // funded by both blind seats is a contestable rake base.
    expect(drop.rakeBaseBB).toBe(bb(1));
    expect(drop.uncalledReturnBB).toBe(bb(0.5));
    expect(drop.rakeBB).toBe(bb(0.1));
    expect(drop.payoutsBB[seatId(2)]).toBe(bb(1.4));
    expect(drop.totalAfterIncludingRakeBB).toBe(drop.totalBeforeBB);
  });

  it("returns a unique unmatched showdown excess without increasing rake", () => {
    const state = manualShowdown({
      playerCount: 4,
      contributionUnits: [bb(10), bb(10), bb(30), bb(0)],
      stackUnits: [bb(90), bb(90), bb(70), bb(100)],
      statuses: ["active", "active", "active", "folded"],
      holes: [
        [card("As"), card("Ad")],
        [card("Ks"), card("Kd")],
        [card("Qs"), card("Qd")],
        [card("Js"), card("Jd")],
      ],
      board: [card("2c"), card("3c"), card("4c"), card("5c"), card("7d")],
    });
    const rakedState: PokerState = {
      ...state,
      config: {
        ...state.config,
        rake: { enabled: true, percentage: 0.1, capBB: bb(100), noFlopNoDrop: true },
      },
    };
    const ledger = settleHand(rakedState, scoreByFirstCard({ As: 30, Ks: 20, Qs: 10 }));
    expect(ledger.potBB).toBe(bb(50));
    expect(ledger.rakeBaseBB).toBe(bb(30));
    expect(ledger.uncalledReturnBB).toBe(bb(20));
    expect(ledger.uncalledReturnSeatId).toBe(seatId(2));
    expect(ledger.rakeBB).toBe(bb(3));
    expect(ledger.payoutsBB).toEqual({
      [seatId(0)]: bb(27),
      [seatId(1)]: bb(0),
      [seatId(2)]: bb(20),
      [seatId(3)]: bb(0),
    });
    expect(ledger.totalAfterIncludingRakeBB).toBe(ledger.totalBeforeBB);
    expect(ledger.conserved).toBe(true);
  });

  it("calculates disabled, no-flop-no-drop, uncapped, and capped rake in fixed units", () => {
    const base = createCashConfig(4);
    expect(calculateRakeBB(base, bb(10), true)).toBe(bb(0));
    const enabled = { ...base, rake: { enabled: true, percentage: 0.1, capBB: bb(100), noFlopNoDrop: true } };
    expect(calculateRakeBB(enabled, bb(10), false)).toBe(bb(0));
    expect(calculateRakeBB(enabled, bb(10), true)).toBe(bb(1));
    expect(calculateRakeBB({ ...enabled, rake: { ...enabled.rake, capBB: bb(0.5) } }, bb(10), true)).toBe(bb(0.5));
  });

  it("conserves unequal stacks through arbitrary legal play and terminal settlement", () => {
    fc.assert(fc.property(
      fc.tuple(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
      ),
      fc.array(fc.nat(), { maxLength: 60 }),
      (stacks, choices) => {
        let state = createHand(configWithStacks(stacks), { dealUnknownHoleCards: true });
        const initial = stacks.reduce<BB>((sum, stack) => bbAdd(sum, bb(stack)), bb(0));
        for (const choice of choices) {
          if (state.terminal !== undefined) break;
          const legal = getLegalActions(state);
          const action = legal[choice % legal.length];
          if (action === undefined) return false;
          state = applyAction(state, action);
        }
        let safety = 0;
        while (state.terminal === undefined && safety < 200) {
          const legal = getLegalActions(state);
          const action = legal.find(({ kind }) => kind === "jam")
            ?? legal.find(({ kind }) => kind === "call")
            ?? legal.find(({ kind }) => kind === "check")
            ?? legal[0];
          if (action === undefined) return false;
          state = applyAction(state, action);
          safety += 1;
        }
        if (state.terminal === undefined) return false;
        const ledger = settleHand(state, state.terminal.type === "showdown" ? sevenCardEvaluator : undefined);
        return ledger.conserved
          && ledger.totalBeforeBB === initial
          && ledger.totalAfterIncludingRakeBB === initial;
      },
    ), { numRuns: 100 });
  });
});
