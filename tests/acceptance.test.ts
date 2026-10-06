import { describe, expect, it } from "vitest";
import { bbToNumber, type PokerAction } from "../src/domain";
import { acceptanceSpotSummary, createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";

describe("master acceptance node", () => {
  it("derives every requested amount from the rules ledger and action tree", () => {
    const spot = createAcceptanceSpot();
    expect(bbToNumber(spot.math.flopStartPotBB)).toBe(5.5);
    expect(bbToNumber(spot.math.decisionPotBB)).toBe(7.3);
    expect(spot.math.callOddsPct).toBeCloseTo(19.7802, 4);
    expect(acceptanceSpotSummary()["raiseTargetsBB"]).toEqual([5.5, 7.2, 9, 97.5]);
    expect(spot.flopDecision.board).toEqual(["Qh", "8s", "4s"]);
  });

  it("continues the exact same hand to its configured turn after a call", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find((action): action is Extract<PokerAction, { kind: "call" }> => action.kind === "call");
    expect(call).toBeDefined();
    const turn = spot.continueWith(call as Extract<PokerAction, { kind: "call" }>);
    expect(turn.street).toBe("turn");
    expect(turn.board).toEqual(["Qh", "8s", "4s", "2c"]);
    expect(bbToNumber(turn.potBB)).toBe(9.1);
  });
});
