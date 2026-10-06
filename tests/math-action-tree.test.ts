import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  actionEconomics,
  actorContestablePot,
  bb,
  bbToNumber,
  bluffToValueRatio,
  breakEvenBluffFrequency,
  geometricSizing,
  headsUpMdf,
  holdemRunoutCount,
  potOdds,
  potOddsAfterRake,
  resolveActionTree,
  riverPolarizedBluffFraction,
  standardActionTree,
  spr,
} from "../src/domain";
import { seatId } from "../src/domain/seats";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { decisionMathForState } from "../src/session/query";
import type { PokerState } from "../src/domain/rules";

function shortStackFacingOverbet(): PokerState {
  const base = createAcceptanceSpot().flopDecision;
  const players = base.players.map((player) => {
    if (player.id === seatId(2)) return { ...player, stackBB: bb(5) };
    if (player.id === seatId(7)) {
      return { ...player, stackBB: bb(77.5), streetContributionBB: bb(20), totalContributionBB: bb(22.5) };
    }
    return player;
  });
  return { ...base, players, currentBetBB: bb(20), potBB: bb(25.5) };
}

describe("exact poker math", () => {
  it("calculates call odds using the pot at the decision", () => {
    const odds = potOdds(bb(1.8), bb(7.3));
    expect(odds.value * 100).toBeCloseTo(19.78021978, 8);
    expect(odds.requiredEquity).toBe(odds.value);
    expect(odds.potToCallRatio).toBeCloseTo(7.3 / 1.8, 12);
    expect(odds.ratio).toEqual({ pot: 7.3, call: 1.8 });
  });

  it("property-checks pot odds over positive fixed-precision call and pot inputs", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: 1, max: 50_000 }),
      (callTenths, potTenths) => {
        const call = callTenths / 10;
        const pot = potTenths / 10;
        const result = potOdds(bb(call), bb(pot));
        return Math.abs(result.requiredEquity - call / (pot + call)) < 1e-12
          && result.potToCallRatio !== null
          && Math.abs(result.potToCallRatio - pot / call) < 1e-12;
      },
    ), { numRuns: 500 });
  });

  it("calculates a separately labeled rake-adjusted closing-call benchmark", () => {
    const direct = potOddsAfterRake(bb(1.8), bb(7.3), bb(0.455));
    expect(direct.requiredEquity).toBeCloseTo(1.8 / (7.3 + 1.8 - 0.455), 12);
    expect(direct.formula).toContain("projectedRake");

    const base = createAcceptanceSpot().flopDecision;
    const raked: PokerState = {
      ...base,
      config: { ...base.config, rake: { enabled: true, percentage: 0.05, capBB: bb(2), noFlopNoDrop: true } },
    };
    const derived = decisionMathForState(raked);
    expect(derived.projectedRakeIfNoFurtherBettingBB).toBe(bb(0.455));
    expect(derived.rakeAdjustedPotOdds?.requiredEquity).toBeCloseTo(direct.requiredEquity, 12);
    expect(derived.rakeAdjustedPotOddsBasis).toBe("HEADS_UP_CLOSING_CALL_NO_FURTHER_BETTING");

    const actionBehind = decisionMathForState({ ...raked, pending: [seatId(2), seatId(7)] });
    expect(actionBehind.rakeAdjustedPotOdds).toBeUndefined();
  });

  it("calculates alpha, MDF, SPR and river ratios independently", () => {
    expect(breakEvenBluffFrequency(bb(5), bb(10)).value).toBeCloseTo(1 / 3, 12);
    expect(headsUpMdf(bb(5), bb(10)).value).toBeCloseTo(2 / 3, 12);
    expect(spr(bb(20), bb(5)).value).toBe(4);
    expect(riverPolarizedBluffFraction(1).value).toBeCloseTo(1 / 3, 12);
    expect(bluffToValueRatio(1).value).toBeCloseTo(1 / 2, 12);
    expect(() => breakEvenBluffFrequency(bb(2), bb(-1))).toThrow(/Invalid bluff/u);
    expect(() => headsUpMdf(bb(2), bb(-1))).toThrow(/Invalid MDF/u);
  });

  it("property-checks that heads-up alpha and MDF are complements", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 20_000 }),
      fc.integer({ min: 1, max: 50_000 }),
      (betTenths, potTenths) => {
        const alpha = breakEvenBluffFrequency(bb(betTenths / 10), bb(potTenths / 10)).value;
        const mdf = headsUpMdf(bb(betTenths / 10), bb(potTenths / 10)).value;
        return Math.abs(alpha + mdf - 1) < 1e-12;
      },
    ), { numRuns: 500 });
  });

  it("counts exact fixed-hand Hold'em runouts on river, turn, and flop", () => {
    expect(holdemRunoutCount(5)).toBe(1);
    expect(holdemRunoutCount(4)).toBe(44);
    expect(holdemRunoutCount(3)).toBe(990);
    expect(holdemRunoutCount(4, 1)).toBe(43);
  });

  it("uses the specified geometric sizing derivation without calling it optimal", () => {
    const result = geometricSizing(bb(10), bb(30), 2);
    expect(result.value).toBeCloseTo((Math.sqrt(7) - 1) / 2, 12);
    expect(bbToNumber(result.betBB)).toBeCloseTo(8.229, 3);
    expect(result.provenance).toBe("EXACT_MATH");
    expect(result.formula).toContain("2S/P");
  });

  it("derives economics for every acceptance raise size from the rules ledger", () => {
    const spot = createAcceptanceSpot();
    const aggressive = spot.legalActions.filter((action) => action.kind === "raise" || action.kind === "jam");
    const economics = aggressive.map((action) => actionEconomics(spot.flopDecision, action, seatId(7)));
    expect(economics.map(({ totalToBB }) => bbToNumber(totalToBB))).toEqual([5.5, 7.2, 9, 97.5]);
    expect(economics.map(({ amountAddedBB }) => bbToNumber(amountAddedBB))).toEqual([5.5, 7.2, 9, 97.5]);
    expect(economics.map(({ potIfCalledByOneBB }) => bbToNumber(potIfCalledByOneBB))).toEqual([16.5, 19.9, 23.5, 200.5]);
    expect(economics.map(({ contestablePotIfCalledByOneBB }) => bbToNumber(contestablePotIfCalledByOneBB))).toEqual([16.5, 19.9, 23.5, 200.5]);
    expect(economics.map(({ raiseIncrementBB }) => bbToNumber(raiseIncrementBB ?? bb(0)))).toEqual([3.7, 5.4, 7.2, 95.7]);
    expect(economics.map(({ heroBehindBB }) => bbToNumber(heroBehindBB))).toEqual([92, 90.3, 88.5, 0]);
    expect(economics.map(({ opponentBehindBB }) => bbToNumber(opponentBehindBB ?? bb(0)))).toEqual([92, 90.3, 88.5, 0]);
    expect(economics[0]?.projectedSPR).toBeCloseTo(92 / 16.5, 12);
    expect(economics[3]?.projectedSPR).toBe(0);
  });

  it("prices a short all-in call against only the pot layers Hero can contest", () => {
    const state = shortStackFacingOverbet();
    const contest = actorContestablePot(state);
    const math = decisionMathForState(state);
    expect(bbToNumber(contest.ledgerPotBB)).toBe(25.5);
    expect(bbToNumber(contest.contestablePotAtDecisionBB)).toBe(10.5);
    expect(bbToNumber(contest.excludedFromActorContestBB)).toBe(15);
    expect(math.potOdds?.requiredEquity).toBeCloseTo(5 / 15.5, 12);
    expect(math.potOddsBasis).toBe("RAW_PRE_RAKE_CONTESTABLE_POT");

    const call = actionEconomics(state, { kind: "call", amount: bb(5) }, seatId(7));
    expect(bbToNumber(call.ledgerPotIfCalledByOneBB)).toBe(30.5);
    expect(bbToNumber(call.contestablePotIfCalledByOneBB)).toBe(15.5);
    expect(bbToNumber(call.uncalledReturnBB)).toBe(15);
  });

  it("uses the heads-up effective stack for a geometric first bet and refuses a raise derivation", () => {
    const spot = createAcceptanceSpot();
    const firstBetState: PokerState = {
      ...spot.preflopComplete,
      players: spot.preflopComplete.players.map((player) => player.id === seatId(7) ? { ...player, stackBB: bb(30) } : player),
    };
    const tree = {
      id: "geometric-test",
      preflop: { unopened: { mode: "fixed", candidates: [] }, facingRaise: { mode: "fixed", candidates: [] } },
      flop: { mode: "geometric", streetsRemaining: 3 },
      turn: { mode: "geometric", streetsRemaining: 2 },
      river: { mode: "geometric", streetsRemaining: 1 },
    } as const;
    const firstBet = resolveActionTree(firstBetState, tree);
    expect(firstBet.geometric?.inputs["S"]).toBe(30);
    expect(firstBet.geometricUnavailable).toBeUndefined();

    const facingBet = resolveActionTree(spot.flopDecision, tree);
    expect(facingBet.geometric).toBeUndefined();
    expect(facingBet.geometricUnavailable?.code).toBe("FACING_WAGER");

    const invalidHorizon = resolveActionTree(firstBetState, { ...tree, flop: { mode: "geometric", streetsRemaining: 2 } });
    expect(invalidHorizon.geometric).toBeUndefined();
    expect(invalidHorizon.geometricUnavailable?.code).toBe("INVALID_STREET_COUNT");
  });

  it("keeps first-bet and raise candidates in separate solver-tree branches", () => {
    const spot = createAcceptanceSpot();
    const firstBet = resolveActionTree(spot.preflopComplete, standardActionTree).actions;
    expect(firstBet.some((action) => action.kind === "bet")).toBe(true);
    expect(firstBet.filter((action) => action.kind === "bet")).toHaveLength(1);

    const facingBet = resolveActionTree(spot.flopDecision, standardActionTree).actions;
    expect(facingBet.some((action) => action.kind === "raise")).toBe(true);
    expect(facingBet.filter((action) => action.kind === "raise")).toHaveLength(1);
    expect(facingBet.some((action) => action.kind === "bet")).toBe(false);
  });

  it("labels the multiway shortest-stack summary and exposes every opponent SPR", () => {
    const base = createAcceptanceSpot().flopDecision;
    const state: PokerState = {
      ...base,
      players: base.players.map((player) => player.id === seatId(0)
        ? { ...player, status: "active", stackBB: bb(20), totalContributionBB: bb(0.5) }
        : player),
      pending: [seatId(2), seatId(0)],
      potBB: bb(7.8),
    };
    const math = decisionMathForState(state);
    expect(math.effectiveStackBasis).toBe("SHORTEST_WAGER_CAPABLE_OPPONENT");
    expect(math.selectedOpponentSeatId).toBe(seatId(0));
    expect(math.perOpponent.map(({ seatId: id }) => id)).toEqual([seatId(0), seatId(7)]);
    expect(math.perOpponent.every(({ currentSPR }) => currentSPR !== undefined)).toBe(true);
    expect(math.potOddsCaveats.join(" ")).toMatch(/Multiway.*continue frequency/);
    expect(math.potOddsCaveats.join(" ")).toMatch(/not a closing-action guarantee/);
  });

  it("does not collapse current SPR to zero because another opponent is already all-in", () => {
    const base = createAcceptanceSpot().flopDecision;
    const state: PokerState = {
      ...base,
      players: base.players.map((player) => player.id === seatId(0)
        ? { ...player, status: "all-in", stackBB: bb(0), totalContributionBB: bb(20) }
        : player),
      potBB: bb(27.3),
    };
    const math = decisionMathForState(state);
    expect(math.selectedOpponentSeatId).toBe(seatId(7));
    expect(math.effectiveStackBasis).toBe("SHORTEST_WAGER_CAPABLE_OPPONENT");
    expect(math.currentSPR?.value).toBeGreaterThan(0);
    expect(math.perOpponent.find(({ seatId: id }) => id === seatId(0))).toMatchObject({ wagerCapable: false, effectiveStackBB: bb(0) });
  });
});
