import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyAction,
  bb,
  bbToNumber,
  canRaise,
  createCashConfig,
  createHand,
  deriveSidePots,
  getLegalActions,
  positionLabel,
  preflopFirstActorIndex,
  seatId,
  sevenCardEvaluator,
  settleShowdown,
  type BB,
  type PlayerState,
  type PokerState,
} from "../src/domain";
import { card } from "../src/domain/cards";

function totalChips(state: PokerState): number {
  return state.players.reduce((sum, player) => sum + player.stackBB + player.totalContributionBB, 0);
}

describe("rules ledger", () => {
  it("assigns button-relative labels for 4–8 handed tables", () => {
    expect([0, 1, 2, 3].map((index) => positionLabel(index, 0, 4))).toEqual(["BTN", "SB", "BB", "CO"]);
    expect(Array.from({ length: 8 }, (_, index) => positionLabel(index, 0, 8))).toEqual(["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"]);
    expect(preflopFirstActorIndex(8, 0)).toBe(3);
    expect(preflopFirstActorIndex(8, 0, true)).toBe(4);
  });

  it("posts blinds and starts with the seat left of the big blind", () => {
    const state = createHand(createCashConfig(6));
    expect(bbToNumber(state.potBB)).toBe(1.5);
    expect(state.actor).toBe(seatId(3));
    expect(bbToNumber(state.players[1]?.streetContributionBB ?? bb(0))).toBe(0.5);
    expect(bbToNumber(state.players[2]?.streetContributionBB ?? bb(0))).toBe(1);
  });

  it("does not reopen raising after a short all-in", () => {
    const base = createCashConfig(4);
    const config = {
      ...base,
      startingStacksBB: { ...base.startingStacksBB, [seatId(1)]: bb(4) },
    };
    let state = createHand(config);
    state = applyAction(state, { kind: "raise", to: bb(3) }); // CO
    state = applyAction(state, { kind: "call", amount: bb(3) }); // BTN
    state = applyAction(state, { kind: "jam", to: bb(4) }); // SB, a 1 BB under-raise
    state = applyAction(state, { kind: "call", amount: bb(3) }); // BB
    expect(state.actor).toBe(seatId(3));
    expect(canRaise(state)).toBe(false);
    expect(getLegalActions(state).map(({ kind }) => kind)).toEqual(["fold", "call"]);
  });

  it("constructs side pots while excluding folded players from eligibility", () => {
    const players: readonly PlayerState[] = [
      { id: seatId(0), stackBB: bb(0), streetContributionBB: bb(10), totalContributionBB: bb(10), status: "all-in" },
      { id: seatId(1), stackBB: bb(0), streetContributionBB: bb(20), totalContributionBB: bb(20), status: "all-in" },
      { id: seatId(2), stackBB: bb(70), streetContributionBB: bb(30), totalContributionBB: bb(30), status: "active" },
      { id: seatId(3), stackBB: bb(70), streetContributionBB: bb(30), totalContributionBB: bb(30), status: "folded" },
    ];
    const pots = deriveSidePots(players);
    expect(pots.map(({ amountBB }) => bbToNumber(amountBB))).toEqual([40, 30, 20]);
    expect(pots[2]?.eligible).toEqual([seatId(2)]);
  });

  it("evaluates hands and splits tied showdown pots exactly", () => {
    const config = createCashConfig(4);
    const created = createHand(config, {
      holeCards: {
        [seatId(0)]: [card("2c"), card("3d")],
        [seatId(1)]: [card("4c"), card("5d")],
        [seatId(2)]: [card("6c"), card("7d")],
        [seatId(3)]: [card("8c"), card("9d")],
      },
    });
    const players = created.players.map((player) => ({ ...player, stackBB: bb(90), totalContributionBB: bb(10), streetContributionBB: bb(0), status: "active" as const }));
    const showdown: PokerState = { ...created, players, potBB: bb(40), board: [card("As"), card("Ks"), card("Qs"), card("Js"), card("Ts")], actor: null, pending: [], terminal: { type: "showdown" } };
    const payouts = settleShowdown(showdown, sevenCardEvaluator);
    expect(Object.values(payouts).filter((value): value is BB => value !== undefined).map(bbToNumber)).toEqual([10, 10, 10, 10]);
    expect(sevenCardEvaluator.evaluate([card("As"), card("Ad"), card("Ac"), card("Ah"), card("2s"), card("3s"), card("4s")]).category).toBe("quads");
  });

  it("conserves chips through arbitrary legal action choices", () => {
    fc.assert(fc.property(fc.array(fc.nat(), { maxLength: 80 }), (choices) => {
      let state = createHand(createCashConfig(4));
      const starting = totalChips(state);
      for (const choice of choices) {
        const legal = getLegalActions(state);
        if (legal.length === 0) break;
        const action = legal[choice % legal.length];
        if (action === undefined) break;
        state = applyAction(state, action);
        if (totalChips(state) !== starting) return false;
      }
      return true;
    }), { numRuns: 100 });
  });
});
