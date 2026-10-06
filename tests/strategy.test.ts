import { describe, expect, it } from "vitest";
import {
  HeuristicStrategyProvider,
  InterpolatedStrategyProvider,
  SolvedStrategyProvider,
  bb,
  cacheHashesKey,
  createStrategyQueryHashes,
  gradeAction,
  type PokerAction,
  type StrategyQuery,
  type StrategyResult,
} from "../src/domain";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";

function query(): StrategyQuery {
  const spot = createAcceptanceSpot();
  const stacks = Object.fromEntries(spot.flopDecision.players.map((player) => [player.id, player.stackBB])) as StrategyQuery["stacksBB"];
  return {
    nodeHash: "known",
    actorSeatId: "seat-2",
    actorPosition: "BB",
    heroSeatId: "seat-2",
    gameConfig: spot.config,
    street: spot.flopDecision.street,
    board: spot.flopDecision.board,
    actionHistory: spot.flopDecision.actionHistory.map(({ action }) => action),
    potBB: spot.flopDecision.potBB,
    stacksBB: stacks,
    heroPosition: "BB",
    opponentPositions: ["CO"],
    ranges: {},
    legalActions: spot.legalActions,
    actionTree: { id: "empty", preflop: { unopened: { mode: "fixed", candidates: [] }, facingRaise: { mode: "fixed", candidates: [] } }, flop: { mode: "fixed", candidates: [] }, turn: { mode: "fixed", candidates: [] }, river: { mode: "fixed", candidates: [] } },
    rake: spot.config.rake,
    deadCards: [],
  };
}

describe("strategy provenance boundaries", () => {
  it("leaves absent solved nodes explicitly unsolved", async () => {
    const provider = new SolvedStrategyProvider("solved", new Map());
    await expect(provider.getStrategy(query())).rejects.toMatchObject({
      name: "StrategyUnavailableError",
      providerId: "solved",
    });
  });

  it("keys solved nodes by the complete five-hash identity", async () => {
    const q = query();
    const action = q.legalActions[0] as PokerAction;
    const result: StrategyResult = { provenance: "SOLVED", actions: [{ action, frequency: 1, evBB: bb(1) }] };
    const identity = createStrategyQueryHashes({ gameConfig: q.gameConfig, ranges: q.ranges, tree: q.actionTree, nodeHash: q.nodeHash, board: q.board });
    const provider = new SolvedStrategyProvider("solved", new Map([[cacheHashesKey(identity), result]]));
    await expect(provider.getStrategy(q)).resolves.toBe(result);
    await expect(provider.getStrategy({ ...q, actionTree: { ...q.actionTree, id: "different" } })).rejects.toMatchObject({ name: "StrategyUnavailableError" });
  });

  it("never adds EV or frequency to heuristic advice", async () => {
    const q = query();
    const provider = new HeuristicStrategyProvider("education", ({ legalActions }) => ({ actions: legalActions.slice(0, 2), notes: ["Uses pot odds and range-shape principles."] }));
    const result = await provider.getStrategy(q);
    expect(result.provenance).toBe("HEURISTIC");
    expect(result.actions.every((item) => item.evBB === undefined && item.frequency === undefined)).toBe(true);
    expect(gradeAction(q.legalActions[0] as PokerAction, result, q.potBB).mode).toBe("HEURISTIC");
  });

  it("interpolates a field only when both solved endpoints contain it", async () => {
    const q = query();
    const action = q.legalActions[0] as PokerAction;
    const lower: StrategyResult = { provenance: "SOLVED", actions: [{ action, frequency: 0.2, evBB: bb(1) }] };
    const upper: StrategyResult = { provenance: "SOLVED", actions: [{ action, frequency: 0.6 }] };
    const provider = new InterpolatedStrategyProvider("interpolated", async () => ({ lower, upper, weight: 0.5, variables: { stack: [50, 75, 100] }, compatible: true }));
    const result = await provider.getStrategy(q);
    expect(result.provenance).toBe("INTERPOLATED");
    expect(result.actions[0]?.frequency).toBeCloseTo(0.4, 12);
    expect(result.actions[0]?.evBB).toBeUndefined();
  });

  it("uses exact five-level grading only with comparable EVs", () => {
    const q = query();
    const first = q.legalActions[0] as PokerAction;
    const second = q.legalActions[1] as PokerAction;
    const solved: StrategyResult = { provenance: "SOLVED", actions: [{ action: first, frequency: 0.5, evBB: bb(2) }, { action: second, frequency: 0.5, evBB: bb(1.9) }] };
    expect(gradeAction(first, solved, bb(10))).toMatchObject({ mode: "EV", grade: "BEST MOVE", evLossBB: bb(0) });
    const frequencyOnly: StrategyResult = { provenance: "SOLVED", actions: [{ action: first, frequency: 0.7 }, { action: second, frequency: 0.3 }] };
    expect(gradeAction(second, frequencyOnly, bb(10))).toEqual({ mode: "REFERENCE_ONLY", grade: "SUPPORTED MIX" });
  });
});
