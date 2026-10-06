import { describe, expect, it } from "vitest";
import {
  ImportedSolutionProvider,
  STRATEGY_PACK_SCHEMA_VERSION,
  bb,
  card,
  checkStrategyPackCompatibility,
  createRange,
  createStrategyQueryHashes,
  parseStrategyPack,
  parseStrategyPackCsv,
  parseStrategyPackJson,
  STRATEGY_PACK_CSV_COLUMNS,
  type PokerAction,
  type StrategyPackScenarioManifest,
  type StrategyQuery,
  type ValidatedStrategyPack,
} from "../src/domain";
import { acceptanceActionTree, acceptanceReplay, createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { COMBO_POLICY_WEIGHT_TOLERANCE, checkComboPolicyCoverage } from "../src/session/sampling";

function makeQuery(): StrategyQuery {
  const spot = createAcceptanceSpot();
  const config = {
    ...spot.config,
    actionTreeId: acceptanceActionTree.id,
    strategyProviderId: "fixture-solver",
  };
  return {
    nodeHash: "acceptance-qsts-flop",
    actorSeatId: "seat-2",
    actorPosition: "BB",
    heroSeatId: "seat-2",
    gameConfig: config,
    street: spot.flopDecision.street,
    board: spot.flopDecision.board,
    actionHistory: spot.flopDecision.actionHistory.map(({ action }) => action),
    potBB: spot.flopDecision.potBB,
    stacksBB: Object.fromEntries(spot.flopDecision.players.map((player) => [player.id, player.stackBB])) as StrategyQuery["stacksBB"],
    heroPosition: "BB",
    opponentPositions: ["CO"],
    ranges: {},
    legalActions: spot.legalActions,
    actionTree: acceptanceActionTree,
    rake: config.rake,
    deadCards: [],
  };
}

function makeScenario(query: StrategyQuery, identity: StrategyPackScenarioManifest["nodeIdentity"]): StrategyPackScenarioManifest {
  return {
    id: "acceptance-bb-co-qsts",
    nodeIdentity: identity,
    config: query.gameConfig,
    buttonIndex: 0,
    heroSeatId: "seat-2",
    actionTree: query.actionTree,
    seed: 20_260_826,
    ranges: {},
    fixedHoleCards: {
      "seat-0": [card("Ac"), card("Ad")],
      "seat-1": [card("Kc"), card("Kh")],
      "seat-2": [card("Qs"), card("Ts")],
      "seat-3": [card("3c"), card("3d")],
      "seat-4": [card("5c"), card("5d")],
      "seat-5": [card("6c"), card("6d")],
      "seat-6": [card("7c"), card("7d")],
      "seat-7": [card("As"), card("Js")],
    },
    deadCards: [],
    futureBoard: [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")],
    replay: acceptanceReplay,
    expected: {
      actor: "seat-2",
      street: "flop",
      board: query.board,
      potBB: query.potBB,
      currentBetBB: bb(1.8),
      stacksBB: query.stacksBB,
    },
    sourceTags: { preflopLine: "vs-open", potType: "SRP", strategicClasses: ["bluff-catcher"] },
  };
}

function makePack(query = makeQuery()): ValidatedStrategyPack {
  const hashes = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  const fold = query.legalActions.find((action) => action.kind === "fold") as PokerAction;
  const call = query.legalActions.find((action) => action.kind === "call") as PokerAction;
  const node = {
    provenance: "SOLVED" as const,
    ...hashes,
    stackBB: query.stacksBB,
    potBB: query.potBB,
    rake: query.rake,
    board: query.board,
    legalActions: query.legalActions,
    convergence: {
      exploitabilityBB: 0.02,
      exploitabilityPctPot: 0.4,
      targetExploitabilityBB: 0.025,
      targetExploitabilityPctPot: 0.5,
      iterations: 290,
      solver: "Fixture CFR",
      compression: "16-bit integer",
    },
    notes: ["Fixture continuation tree."],
    comboPolicy: [
      {
        cards: [card("As"), card("Ah")] as const,
        weight: 0.75,
        actions: [{ action: fold, frequency: 0.2, evBB: bb(1) }, { action: call, frequency: 0.8, evBB: bb(2) }],
      },
      {
        cards: [card("Kc"), card("Kd")] as const,
        weight: 0.25,
        actions: [{ action: fold, frequency: 0.6, evBB: bb(3) }, { action: call, frequency: 0.4 }],
      },
    ],
  };
  return {
    schemaVersion: STRATEGY_PACK_SCHEMA_VERSION,
    packId: "unit-solved-pack",
    source: {
      name: "Fixture Solver",
      version: "2026.08",
      timestamp: "2026-08-26T12:00:00Z",
      solver: "Fixture CFR",
      commit: "abcdef1",
      sourceUrl: "https://example.test/solver",
      license: "AGPL-3.0-or-later",
    },
    nodes: [node],
    scenarios: [makeScenario(query, hashes)],
  };
}

function csvField(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function packCsv(
  pack: ValidatedStrategyPack,
  scenarioForRow: (scenario: StrategyPackScenarioManifest, rowIndex: number) => StrategyPackScenarioManifest = (scenario) => scenario,
): string {
  let rowIndex = 0;
  const rows = pack.nodes.flatMap((node) => node.comboPolicy.flatMap((combo) => combo.actions.map((item) => {
    const scenario = pack.scenarios.find((candidate) => candidate.nodeIdentity.nodeHash === node.nodeHash);
    if (scenario === undefined) throw new Error("Test pack scenario invariant failed");
    const fields = [
      pack.schemaVersion, pack.packId, pack.source.name, pack.source.version, pack.source.timestamp, node.provenance,
      node.gameConfigHash, node.rangeHash, node.treeHash, node.nodeHash, node.boardCanonicalHash,
      scenarioForRow(scenario, rowIndex),
      node.stackBB, node.potBB, node.rake, node.board, node.legalActions,
      combo.cards, combo.weight, item.action, item.frequency, item.evBB ?? "",
    ];
    rowIndex += 1;
    return fields.map(csvField).join(",");
  })));
  return [STRATEGY_PACK_CSV_COLUMNS.join(","), ...rows].join("\n");
}

describe("validated combo strategy packs", () => {
  it("requires each unblocked positive combo-policy row to preserve the queried range weight", () => {
    const range = createRange([
      { cards: [card("Qs"), card("Ts")], weight: 0.5 },
      { cards: [card("Qc"), card("Tc")], weight: 0.25 },
    ]);
    const call = createAcceptanceSpot().legalActions.find((action) => action.kind === "call")!;
    const policy = [...range.values()].map((combo) => ({
      cards: combo.cards,
      weight: combo.cards.includes(card("Qs")) ? combo.weight + COMBO_POLICY_WEIGHT_TOLERANCE * 2 : combo.weight,
      actions: [{ action: call, frequency: 1 }],
    }));

    expect(checkComboPolicyCoverage(range, policy, [])).toMatchObject({
      complete: false,
      coveredPositiveCombos: 1,
      requiredPositiveCombos: 2,
      mismatchedPositiveCombos: 1,
    });
    expect(checkComboPolicyCoverage(range, policy, []).reason).toMatch(/weight mismatch.*tolerance/iu);
    expect(checkComboPolicyCoverage(range, policy, [card("Qs")])).toMatchObject({
      complete: true,
      coveredPositiveCombos: 1,
      requiredPositiveCombos: 1,
      mismatchedPositiveCombos: 0,
    });
  });

  it("runtime-parses strict JSON and exposes SOLVED only after exact compatibility", async () => {
    const query = makeQuery();
    const pack = makePack(query);
    const parsed = parseStrategyPackJson(JSON.stringify(pack));
    expect(parsed).toEqual(pack);
    expect(checkStrategyPackCompatibility(parsed.nodes[0]!, query)).toMatchObject({ compatible: true, issues: [] });
    const result = await ImportedSolutionProvider.fromJson("imported", JSON.stringify(pack)).getStrategy(query);
    expect(result).toMatchObject({
      provenance: "SOLVED",
      sourceNodeId: query.nodeHash,
      convergence: { exploitabilityBB: 0.02, exploitabilityPctPot: 0.4, iterations: 290 },
      source: { solver: "Fixture CFR", commit: "abcdef1", license: "AGPL-3.0-or-later" },
      notes: expect.arrayContaining(["Fixture continuation tree."]),
    });
    const aggregateFold = result.actions.find(({ action }) => action.kind === "fold");
    expect(aggregateFold).toMatchObject({ evBB: bb(2) });
    expect(aggregateFold?.frequency).toBeCloseTo(0.3, 12);
    expect(result.actions.find(({ action }) => action.kind === "call")).not.toHaveProperty("evBB");
    expect(result.comboPolicy).toHaveLength(2);
  });

  it("rejects malformed JSON, unknown fields, missing metadata, and non-SOLVED provenance", () => {
    const pack = makePack();
    expect(() => parseStrategyPackJson("{")) .toThrow(/Malformed strategy-pack JSON/u);
    expect(() => parseStrategyPack({ ...pack, invented: true })).toThrow();
    const { source: _source, ...withoutSource } = pack;
    expect(() => parseStrategyPack(withoutSource)).toThrow();
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...pack.nodes[0], provenance: "HEURISTIC" }] })).toThrow();
    expect(() => parseStrategyPack({ ...pack, schemaVersion: "1.0.0" })).toThrow(/not drillable/u);
  });

  it("requires an exact one-to-one node/scenario manifest mapping", () => {
    const pack = makePack();
    const scenario = pack.scenarios[0]!;
    expect(() => parseStrategyPack({ ...pack, scenarios: [] })).toThrow();
    expect(() => parseStrategyPack({ ...pack, scenarios: [scenario, { ...scenario, id: "duplicate-recipe" }] })).toThrow(/Duplicate strategy-pack scenario/u);
    expect(() => parseStrategyPack({
      ...pack,
      scenarios: [{ ...scenario, nodeIdentity: { ...scenario.nodeIdentity, nodeHash: "orphan-node" } }],
    })).toThrow(/no replayable scenario manifest/u);
  });

  it("rejects invalid cards, duplicate or colliding cards, illegal/duplicate actions, and bad policy totals", () => {
    const pack = makePack();
    const node = pack.nodes[0]!;
    const firstRow = node.comboPolicy[0]!;
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, board: ["1x"] }] })).toThrow(/Invalid poker card/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, board: [card("Qh"), card("Qh")] }] })).toThrow(/Duplicate cards/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...firstRow, cards: [card("As"), card("As")] }] }] })).toThrow(/Duplicate cards/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...firstRow, cards: [card("Qh"), card("Ah")] }] }] })).toThrow(/collides with the board/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [firstRow, firstRow] }] })).toThrow(/Duplicate combo-policy row/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, legalActions: [node.legalActions[0], node.legalActions[0]] }] })).toThrow(/duplicate legal actions/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...firstRow, actions: [{ action: { kind: "check" }, frequency: 1 }] }] }] })).toThrow(/Illegal action/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...firstRow, actions: [firstRow.actions[0], firstRow.actions[0]] }] }] })).toThrow(/Duplicate action/u);
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...firstRow, actions: firstRow.actions.map((item) => ({ ...item, frequency: 0.2 })) }] }] })).toThrow(/rounding tolerance/u);
  });

  it("rejects weights/frequencies outside [0,1] and nonfinite EV before use", () => {
    const pack = makePack();
    const node = pack.nodes[0]!;
    const row = node.comboPolicy[0]!;
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...row, weight: 1.01 }] }] })).toThrow();
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...row, actions: [{ ...row.actions[0], frequency: -0.1 }, row.actions[1]] }] }] })).toThrow();
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...node, comboPolicy: [{ ...row, actions: [{ ...row.actions[0], evBB: Number.POSITIVE_INFINITY }, row.actions[1]] }] }] })).toThrow();
  });

  it("rejects hash/config incompatibility instead of silently downgrading or interpolating", async () => {
    const query = makeQuery();
    const pack = makePack(query);
    const incompatible = parseStrategyPack({
      ...pack,
      nodes: [{ ...pack.nodes[0]!, rangeHash: "wrong-range" }],
      scenarios: [{ ...pack.scenarios[0]!, nodeIdentity: { ...pack.scenarios[0]!.nodeIdentity, rangeHash: "wrong-range" } }],
    });
    expect(checkStrategyPackCompatibility(incompatible.nodes[0]!, query)).toMatchObject({ compatible: false, issues: ["rangeHash mismatch"] });
    const provider = new ImportedSolutionProvider("incompatible", incompatible);
    await expect(provider.getStrategy(query)).rejects.toThrow(/incompatible: rangeHash mismatch/u);
  });

  it("checks the live stack, pot, rake, board, legal action, and game configuration alongside hashes", () => {
    const query = makeQuery();
    const node = parseStrategyPack(makePack(query)).nodes[0]!;
    const changedStack = { ...query.stacksBB, [Object.keys(query.stacksBB)[0] ?? "seat-0"]: bb(7) };
    expect(checkStrategyPackCompatibility(node, { ...query, stacksBB: changedStack }).issues).toContain("stackBB mismatch");
    expect(checkStrategyPackCompatibility(node, { ...query, potBB: bb(99) }).issues).toContain("potBB mismatch");
    expect(checkStrategyPackCompatibility(node, { ...query, rake: { ...query.rake, percentage: 0.01 } }).issues).toContain("rake mismatch");
    expect(checkStrategyPackCompatibility(node, { ...query, board: [card("Ac"), card("8s"), card("4s")] }).issues).toContain("board mismatch");
    expect(checkStrategyPackCompatibility(node, { ...query, legalActions: query.legalActions.slice(0, 2) }).issues).toContain("legal actions mismatch");
    expect(checkStrategyPackCompatibility(node, { ...query, gameConfig: { ...query.gameConfig, actionTreeId: "different" } }).issues).toContain("gameConfigHash mismatch");
  });

  it("requires combo rows, imports schema-defined CSV, and refuses aggregate CSV", async () => {
    const pack = makePack();
    expect(() => parseStrategyPack({ ...pack, nodes: [{ ...pack.nodes[0]!, comboPolicy: [] }] })).toThrow();
    const parsed = parseStrategyPackCsv(packCsv(pack));
    expect(parsed).toMatchObject({
      schemaVersion: pack.schemaVersion,
      packId: pack.packId,
      source: { name: pack.source.name, version: pack.source.version, timestamp: pack.source.timestamp },
      scenarios: pack.scenarios,
    });
    expect(parsed.nodes[0]).toMatchObject({
      provenance: "SOLVED",
      nodeHash: pack.nodes[0]!.nodeHash,
      comboPolicy: pack.nodes[0]!.comboPolicy,
    });
    expect(parsed.source).not.toHaveProperty("solver");
    expect(parsed.nodes[0]).not.toHaveProperty("convergence");
    const query = makeQuery();
    await expect(ImportedSolutionProvider.fromCsv("csv", "1", packCsv(pack)).getStrategy(query)).resolves.toMatchObject({ provenance: "SOLVED" });
    expect(() => ImportedSolutionProvider.fromCsv("legacy", "1", "nodeHash,action,amountUnits,frequency,evUnits")).toThrow(/missing columns/u);
    expect(() => parseStrategyPackCsv(packCsv(pack, (scenario, rowIndex) => rowIndex === 1 ? { ...scenario, id: "changed-mid-node" } : scenario))).toThrow(/changes scenario manifest/u);
    expect(() => parseStrategyPackCsv(`${STRATEGY_PACK_CSV_COLUMNS.join(",")},invented\n`)).toThrow(/unexpected columns/u);
  });

  it("allows a reused nodeHash only when the remaining cache identity differs", () => {
    const pack = makePack();
    const node = pack.nodes[0]!;
    expect(() => parseStrategyPack({ ...pack, nodes: [node, node] })).toThrow(/Duplicate strategy-pack state/u);
    const compatibleSibling = { ...node, rangeHash: "another-exact-range" };
    const siblingScenario = {
      ...pack.scenarios[0]!,
      id: "acceptance-sibling-range",
      nodeIdentity: { ...pack.scenarios[0]!.nodeIdentity, rangeHash: "another-exact-range" },
    };
    expect(parseStrategyPack({ ...pack, nodes: [node, compatibleSibling], scenarios: [...pack.scenarios, siblingScenario] }).nodes).toHaveLength(2);
  });
});
