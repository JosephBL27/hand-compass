import { describe, expect, it } from "vitest";
import { prepareCustomSpot, validateCustomSpot } from "../src/builder";
import { actionKey, resolveActionTree } from "../src/domain";

const acceptanceSpec = {
  playerCount: 8 as const,
  buttonIndex: 0,
  heroSeatIndex: 2,
  startingStacksBB: new Array(8).fill(100),
  fixedHoleCards: { "2": ["Qs", "Ts"] as const },
  futureBoard: ["Qh", "8s", "4s", "2c", "Kd"],
  actionTree: { flop: [{ type: "raise-to" as const, toBB: 5.5 }, { type: "raise-to" as const, toBB: 7.2 }, { type: "raise-to" as const, toBB: 9 }, { type: "all-in" as const }] },
  actions: [
    { kind: "fold" as const }, { kind: "fold" as const }, { kind: "fold" as const }, { kind: "fold" as const },
    { kind: "raise" as const, toBB: 2.5 }, { kind: "fold" as const }, { kind: "fold" as const },
    { kind: "call" as const, amountBB: 1.5 }, { kind: "check" as const }, { kind: "bet" as const, toBB: 1.8 },
  ],
  expected: { actorSeatIndex: 2, street: "flop" as const, board: ["Qh", "8s", "4s"], potBB: 7.3, currentBetBB: 1.8, remainingStacksBB: [100, 99.5, 97.5, 100, 100, 100, 100, 95.7] },
};

describe("custom spot reachability", () => {
  it("reconstructs the acceptance node through legal rules actions", () => {
    const result = validateCustomSpot(acceptanceSpec);
    expect(result).toMatchObject({ valid: true, summary: { street: "flop", actor: "BB", potBB: 7.3, currentBetBB: 1.8, actionCount: 10 } });
  });

  it("prepares a playable fixed sizing tree and complete public priors", () => {
    const prepared = prepareCustomSpot(acceptanceSpec);
    expect(resolveActionTree(prepared.state, prepared.actionTree).actions.map(actionKey)).toEqual([
      "fold", "call:18000", "raise:55000", "raise:72000", "raise:90000", "jam:975000",
    ]);
    expect(prepared.ranges["seat-2"]?.size).toBe(1326);
    expect(prepared.ranges["seat-7"]?.size).toBe(1326);
  });

  it("requires a fixed private combo to remain possible in its supplied public range", () => {
    const result = validateCustomSpot({
      ...acceptanceSpec,
      ranges: { "2": [{ cards: ["Ac", "Ad"] as const, weight: 1 }] },
    });
    expect(result.issues[0]).toContain("Fixed hole cards for seat 2 are absent");
  });

  it("reports the exact ledger mismatch without mutating the supplied state", () => {
    const result = validateCustomSpot({ ...acceptanceSpec, expected: { ...acceptanceSpec.expected, remainingStacksBB: [100, 100, 37, 100, 100, 100, 99.5, 95.7] } });
    expect(result.valid).toBe(false);
    const issue = result.issues.find((item) => item.includes("remainingStacksBB[2]"));
    expect(issue).toContain("remainingStacksBB[2] expected 37 BB");
    expect(issue).toContain("97.5 BB");
  });

  it("rejects illegal action order and duplicate known cards", () => {
    expect(validateCustomSpot({ ...acceptanceSpec, actions: [{ kind: "check" }] }).issues[0]).toContain("illegal for UTG");
    expect(validateCustomSpot({ ...acceptanceSpec, fixedHoleCards: { "2": ["Qs", "Qs"] } }).issues[0]).toContain("Duplicate cards");
  });
});
