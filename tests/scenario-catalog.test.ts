import { describe, expect, it } from "vitest";
import {
  bb,
  card,
  createCashConfig,
  createRange,
  seatId,
  type ActionTreeConfig,
  type StrategyProvider,
  type StrategyQuery,
} from "../src/domain";
import { createScenarioCatalog, selectScenarioForReview, type NodeScenarioDefinition } from "../src/session";

const tree: ActionTreeConfig = {
  id: "catalog-tree",
  preflop: { unopened: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(2.5) }] }, facingRaise: { mode: "fixed", candidates: [{ type: "all-in" }] } },
  flop: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(5.5) }, { type: "raise-to", toBB: bb(7.2) }, { type: "raise-to", toBB: bb(9) }, { type: "all-in" }] },
  turn: { mode: "fixed", candidates: [{ type: "all-in" }] },
  river: { mode: "fixed", candidates: [{ type: "all-in" }] },
};

const provider: StrategyProvider = { id: "catalog-provider", async getStrategy(_query: StrategyQuery) { return { provenance: "HEURISTIC", actions: [] }; } };

function definition(): NodeScenarioDefinition {
  const config = { ...createCashConfig(8, bb(100)), actionTreeId: tree.id, strategyProviderId: provider.id };
  return {
    id: "catalog-acceptance",
    config,
    heroSeatId: seatId(2),
    buttonIndex: 0,
    actionTree: tree,
    strategyProvider: provider,
    seed: 4,
    fixedHoleCards: {
      [seatId(0)]: [card("Ac"), card("Ad")], [seatId(1)]: [card("Kc"), card("Kh")],
      [seatId(2)]: [card("Qs"), card("Ts")], [seatId(3)]: [card("3c"), card("3d")],
      [seatId(4)]: [card("5c"), card("5d")], [seatId(5)]: [card("6c"), card("6d")],
      [seatId(6)]: [card("7c"), card("7d")], [seatId(7)]: [card("As"), card("Js")],
    },
    ranges: { [seatId(2)]: createRange([{ cards: [card("Qs"), card("Ts")], weight: 1 }]) },
    futureBoard: [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")],
    replay: [
      { kind: "fold" }, { kind: "fold" }, { kind: "fold" }, { kind: "fold" },
      { kind: "raise", to: bb(2.5) }, { kind: "fold" }, { kind: "fold" }, { kind: "call", amount: bb(1.5) },
      { kind: "check" }, { kind: "bet", to: bb(1.8) },
    ],
    expected: { actor: seatId(2), street: "flop", board: [card("Qh"), card("8s"), card("4s")], potBB: bb(7.3), currentBetBB: bb(1.8) },
    sourceTags: { preflopLine: "vs-open", potType: "SRP", strategicClasses: ["bluff-catcher"] },
  };
}

describe("validated scenario catalog", () => {
  it("matches exact state/source filters and deterministic board, hand, and draw classifiers", () => {
    const item = definition();
    const catalog = createScenarioCatalog([item]);
    const matches = catalog.filter({
      tableSize: 8,
      heroPosition: "BB",
      opponentPosition: "CO",
      stack: { mode: "fixed", stackBB: bb(100) },
      street: "flop",
      playersCurrentlyInPot: 2,
      preflopLine: "vs-open",
      potType: "SRP",
      exactBoard: [card("Qh"), card("8s"), card("4s")],
      requiredBoardCards: [card("8s")],
      boardTexture: "queen-high",
      heroHandClass: "top-pair",
      drawClass: "flush-draw",
      strategicClass: "bluff-catcher",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.facts).toMatchObject({
      heroPosition: "BB",
      opponentPositions: ["CO"],
      boardTextures: expect.arrayContaining(["queen-high", "two-tone", "disconnected"]),
      heroHandClass: "top-pair",
      drawClasses: expect.arrayContaining(["flush-draw"]),
    });
  });

  it("returns zero for unsupported combinations and never infers strategic source tags", () => {
    const catalog = createScenarioCatalog([definition()]);
    expect(catalog.filter({ street: "river" })).toEqual([]);
    expect(catalog.filter({ tableSize: 4 })).toEqual([]);
    expect(catalog.filter({ exactBoard: [card("Ah"), card("8s"), card("4s")] })).toEqual([]);
    expect(catalog.filter({ requiredBoardCards: [card("2c")] })).toEqual([]);
    expect(catalog.filter({ strategicClass: "top-pair" })).toEqual([]);
    expect(catalog.filter({ stack: { mode: "per-player", stacksBB: definition().config.startingStacksBB } })).toEqual([]);
  });

  it("classifies turn-card texture and preserves the Hero draw class mechanically", () => {
    const flop = definition();
    const turn: NodeScenarioDefinition = {
      ...flop,
      id: "catalog-turn-blank",
      replay: [...flop.replay, { kind: "call", amount: bb(1.8) }],
      expected: { actor: seatId(2), street: "turn", board: [card("Qh"), card("8s"), card("4s"), card("2c")], potBB: bb(9.1), currentBetBB: bb(0) },
    };
    const facts = createScenarioCatalog([turn]).all()[0]!.facts;
    expect(facts.boardTextures).toEqual(expect.arrayContaining(["undercard", "blank", "two-tone", "disconnected", "dynamic"]));
    expect(facts.heroHandClass).toBe("top-pair");
    expect(facts.drawClasses).toContain("flush-draw");
  });

  it("matches an exact unequal per-player stack ledger without collapsing it to effective depth", () => {
    const stacks = {
      [seatId(0)]: bb(100),
      [seatId(1)]: bb(50),
      [seatId(2)]: bb(20),
      [seatId(3)]: bb(75),
    };
    const base = createCashConfig(4);
    const unequal: NodeScenarioDefinition = {
      id: "unequal-preflop",
      config: { ...base, startingStacksBB: stacks, actionTreeId: tree.id, strategyProviderId: provider.id },
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: tree,
      strategyProvider: provider,
      seed: 8,
      ranges: {},
      fixedHoleCards: {
        [seatId(0)]: [card("Ac"), card("Ad")], [seatId(1)]: [card("Kc"), card("Kh")],
        [seatId(2)]: [card("Qc"), card("Qd")], [seatId(3)]: [card("Jc"), card("Jd")],
      },
      replay: [],
      expected: { actor: seatId(3), street: "preflop", board: [], potBB: bb(1.5), currentBetBB: bb(1) },
      sourceTags: { preflopLine: "RFI", potType: "SRP" },
    };
    const catalog = createScenarioCatalog([unequal]);
    expect(catalog.filter({ stack: { mode: "per-player", stacksBB: stacks } })).toHaveLength(1);
    expect(catalog.filter({ stack: { mode: "fixed", stackBB: bb(75) } })).toEqual([]);
  });

  it("returns no review selection when validated filtering has no supported nodes", () => {
    const matches = createScenarioCatalog([definition()]).filter({ street: "river" });
    expect(selectScenarioForReview(matches, { seed: 9, currentDecision: 0 })).toBeUndefined();
  });

  it("selects uniformly without review weights and is deterministic across match order", () => {
    const base = definition();
    const catalog = createScenarioCatalog([
      { ...base, id: "catalog-a" },
      { ...base, id: "catalog-b" },
    ]);
    const matches = catalog.all();
    const selected = selectScenarioForReview(matches, { seed: 41, currentDecision: 0 });
    expect(selected).toBe(selectScenarioForReview([...matches].reverse(), { seed: 41, currentDecision: 0, conceptReviews: [] }));
    expect(matches).toContain(selected);
    const selectedIds = new Set(Array.from({ length: 128 }, (_, seed) => selectScenarioForReview(matches, { seed, currentDecision: 0 })?.definition.id));
    expect(selectedIds).toEqual(new Set(["catalog-a", "catalog-b"]));
  });

  it("biases repeated seeded selections toward a due source-tagged concept", () => {
    const base = definition();
    const dueId = "catalog-due-small-bet";
    const matches = createScenarioCatalog([
      { ...base, id: "catalog-baseline", sourceTags: { ...base.sourceTags, strategicClasses: ["GENERAL_DECISION_QUALITY"] } },
      { ...base, id: dueId, sourceTags: { ...base.sourceTags, strategicClasses: ["FACING_SMALL_BET"] } },
    ]).all();
    let dueSelections = 0;
    for (let seed = 0; seed < 1_000; seed += 1) {
      const selected = selectScenarioForReview(matches, {
        seed,
        currentDecision: 12,
        conceptReviews: [{ tag: "FACING_SMALL_BET", samplingWeight: 8, nextDueDecision: 12 }],
      });
      expect(matches).toContain(selected);
      if (selected?.definition.id === dueId) dueSelections += 1;
    }
    expect(dueSelections).toBeGreaterThan(800);
  });
});
