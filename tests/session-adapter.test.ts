import { describe, expect, it } from "vitest";
import { actionKey, type PokerAction } from "../src/domain/actions";
import { bb, bbToNumber } from "../src/domain/money";
import { MemoryStrategyCache } from "../src/domain/strategyCache";
import { card } from "../src/domain/cards";
import { createRange } from "../src/domain/ranges";
import { createStrategyQueryHashes } from "../src/domain/hash";
import { STRATEGY_PACK_SCHEMA_VERSION, type ValidatedStrategyPack } from "../src/domain/strategyPack";
import type { StrategyProvider } from "../src/domain/strategy";
import { createAcceptanceNodeDefinition } from "../src/fixtures/acceptanceSpot";
import { buildStrategyQuery } from "../src/session/query";
import { ReplayRng } from "../src/session/rng";
import { reconstructNode } from "../src/session/scenario";
import {
  configureAndProbeLocalSolver,
  countCompatibleScenarios,
  createAcceptanceProviderRegistry,
  createAcceptanceSession,
  createCustomSpotSession,
  createEducationalProvider,
  createTrainerSession,
  EDUCATIONAL_PROVIDER_ID,
  importStrategyPackText,
  LOCAL_SOLVER_PROVIDER_ID,
  registerImportedProvider,
} from "../src/app/sessionAdapter";

function solvedPackScenario(secondHeroWeight: number, id: string) {
  const sourceProvider: StrategyProvider = {
    id: "fixture-pack-source",
    async getStrategy() { return { provenance: "HEURISTIC", actions: [] }; },
  };
  const base = createAcceptanceNodeDefinition(sourceProvider, "off", 20_260_826);
  const definition = {
    ...base,
    id,
    ranges: {
      ...base.ranges,
      "seat-2": createRange([
        { cards: [card("Qs"), card("Ts")], weight: 1 },
        { cards: [card("Qc"), card("Tc")], weight: secondHeroWeight },
      ]),
    },
  };
  const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
  if (!prepared.available) throw new Error(prepared.block.reason);
  const query = buildStrategyQuery({
    state: prepared.state,
    heroSeatId: definition.heroSeatId,
    ranges: prepared.ranges,
    actionTree: definition.actionTree,
    ...(definition.deadCards === undefined ? {} : { deadCards: definition.deadCards }),
  });
  const hashes = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  const actionFrequencies = [0.05, 0.7, 0.1, 0.07, 0.05, 0.03] as const;
  const actionEvs = [0, 10, 9.5, 9.3, 9, 8.5] as const;
  const comboPolicy = [
    { cards: [card("Qs"), card("Ts")] as const, weight: 1 },
    { cards: [card("Qc"), card("Tc")] as const, weight: secondHeroWeight },
  ].map((combo) => ({
    ...combo,
    actions: query.legalActions.map((action, index) => ({
      action,
      frequency: actionFrequencies[index] ?? 0,
      evBB: bb(actionEvs[index] ?? 0),
    })),
  }));
  const node = {
    provenance: "SOLVED" as const,
    ...hashes,
    stackBB: query.stacksBB,
    potBB: query.potBB,
    rake: query.rake,
    board: query.board,
    legalActions: query.legalActions,
    comboPolicy,
  };
  const ranges = Object.fromEntries(Object.entries(definition.ranges).map(([seat, range]) => [
    seat,
    [...(range?.values() ?? [])].map(({ cards, weight }) => ({ cards, weight })),
  ]));
  const scenario = {
    id,
    nodeIdentity: hashes,
    config: definition.config,
    buttonIndex: definition.buttonIndex,
    heroSeatId: definition.heroSeatId,
    actionTree: definition.actionTree,
    seed: definition.seed,
    ranges,
    fixedHoleCards: definition.fixedHoleCards ?? {},
    deadCards: definition.deadCards ?? [],
    futureBoard: definition.futureBoard ?? [],
    replay: definition.replay,
    expected: {
      ...definition.expected,
      actor: definition.expected.actor!,
      stacksBB: query.stacksBB,
    },
    sourceTags: definition.sourceTags,
  };
  return { node, scenario };
}

function multiNodeSolvedPack(): ValidatedStrategyPack {
  const first = solvedPackScenario(0.5, "solved-qsts-primary");
  const second = solvedPackScenario(0.25, "solved-qsts-narrower-range");
  return {
    schemaVersion: STRATEGY_PACK_SCHEMA_VERSION,
    packId: "integration-solved-pack",
    source: { name: "Integration Solver", version: "1.0", timestamp: "2026-08-28T12:00:00Z" },
    nodes: [first.node, second.node],
    scenarios: [first.scenario, second.scenario],
  };
}

describe("trainer session adapter", () => {
  it("keeps the answer concealed, submits through DrillSession, and continues the same hand", async () => {
    const controller = await createAcceptanceSession("Off");
    expect(controller.snapshot.phase).toBe("AWAITING_HERO");
    expect(JSON.stringify(controller.snapshot)).not.toContain("frequency");
    expect(JSON.stringify(controller.snapshot)).not.toContain("evBB");
    expect(JSON.stringify(controller.snapshot)).not.toContain("publicRanges");
    expect(controller.snapshot.legalActions.map(actionKey)).toEqual([
      "fold", "call:18000", "raise:55000", "raise:72000", "raise:90000", "jam:975000",
    ]);

    const call = controller.snapshot.legalActions.find(({ kind }) => kind === "call");
    expect(call).toBeDefined();
    const submitted = controller.session.submitHeroAction(call!);
    expect(submitted).toMatchObject({ accepted: true, snapshot: { phase: "REVEALED", reveal: { grade: { mode: "EV", grade: "BEST MOVE" } } } });
    expect(submitted.snapshot.reveal?.decisionMath.potOdds?.requiredEquity).toBeCloseTo(1.8 / 9.1, 12);
    expect(submitted.snapshot.reveal?.rangeConditioning).toMatchObject({
      available: true,
      priorComboCount: 411,
    });
    expect(submitted.snapshot.reveal?.rangeConditioning?.available && submitted.snapshot.reveal.rangeConditioning.posteriorNormalizedMass).toBeCloseTo(1, 12);
    expect(submitted.snapshot.reveal?.strategy).toMatchObject({
      provenance: "SOLVED",
      source: { id: "acceptance-qsts-postflop-2026-08-28", solver: "b-inary/postflop-solver" },
      convergence: { iterations: 290, exploitabilityPctPot: expect.any(Number) },
      configuration: { actionTreeId: "acceptance-fixed", potBB: submitted.snapshot.reveal?.decisionMath.potAtDecisionBB },
    });
    expect(submitted.snapshot.reveal?.strategy.actions).toHaveLength(6);
    expect(submitted.snapshot.reveal?.strategy.actions.every((item) => item.frequency !== undefined && item.evBB !== undefined)).toBe(true);
    expect(Object.keys(submitted.snapshot.reveal?.publicRanges ?? {}).sort()).toEqual(["seat-2", "seat-7"]);

    const turn = await controller.session.continue();
    expect(turn).toMatchObject({ phase: "AWAITING_HERO", state: { street: "turn", board: ["Qh", "8s", "4s", "2c"] } });
    expect(JSON.stringify(turn)).not.toContain("No exact node");
    expect(bbToNumber(turn.state!.potBB)).toBe(9.1);
  });

  it("queries only validated catalog entries and reports unsupported combinations as zero", async () => {
    const controller = await createAcceptanceSession("High RNG");
    expect(countCompatibleScenarios(controller.catalog, {
      tableSize: 8,
      heroPosition: "BB",
      opponentPosition: "CO",
      street: "flop",
      potType: "SRP",
      boardTexture: "queen-high",
    })).toBe(1);
    expect(countCompatibleScenarios(controller.catalog, { tableSize: 6 })).toBe(0);
    expect(controller.snapshot.rng).toMatchObject({ mode: "high", available: true, roll: expect.any(Number) });
    await expect(createTrainerSession("Off", { drillMode: "Node drill", nodeFilter: { tableSize: 6 } }))
      .rejects.toThrow("No validated node matches the selected filters");
  });

  it("loads a validated custom state as a playable drill and continues the same hand", async () => {
    const source = JSON.stringify({
      playerCount: 8,
      buttonIndex: 0,
      heroSeatIndex: 2,
      startingStacksBB: new Array(8).fill(100),
      fixedHoleCards: { "2": ["Qs", "Ts"] },
      futureBoard: ["Qh", "8s", "4s", "2c", "Kd"],
      actionTree: { flop: [{ type: "raise-to", toBB: 5.5 }, { type: "raise-to", toBB: 7.2 }, { type: "raise-to", toBB: 9 }, { type: "all-in" }] },
      actions: [
        { kind: "fold" }, { kind: "fold" }, { kind: "fold" }, { kind: "fold" },
        { kind: "raise", toBB: 2.5 }, { kind: "fold" }, { kind: "fold" },
        { kind: "call", amountBB: 1.5 }, { kind: "check" }, { kind: "bet", toBB: 1.8 },
      ],
      expected: { actorSeatIndex: 2, street: "flop", board: ["Qh", "8s", "4s"], potBB: 7.3, currentBetBB: 1.8 },
    });
    const controller = await createCustomSpotSession(source, createEducationalProvider(), "Off");
    expect(controller).toMatchObject({ mode: "Custom spot", snapshot: { phase: "AWAITING_HERO", state: { street: "flop", board: ["Qh", "8s", "4s"] } } });
    expect(controller.snapshot.legalActions.map(actionKey)).toEqual([
      "fold", "call:18000", "raise:55000", "raise:72000", "raise:90000", "jam:975000",
    ]);
    const call = controller.snapshot.legalActions.find(({ kind }) => kind === "call")!;
    const revealed = controller.session.submitHeroAction(call);
    expect(revealed.snapshot.reveal).toMatchObject({ strategy: { provenance: "HEURISTIC" }, publicDeadCards: [] });
    await expect(controller.session.continue()).resolves.toMatchObject({ phase: "AWAITING_HERO", state: { street: "turn", board: ["Qh", "8s", "4s", "2c"] } });
  });

  it("returns a precise failure for invalid untrusted strategy-pack JSON", async () => {
    const result = await importStrategyPackText("broken.json", "{not json}");
    expect(result).toMatchObject({ status: "error", fileName: "broken.json" });
    if (result.status === "error") expect(result.message.length).toBeGreaterThan(0);
  });

  it("imports every solved node as a selectable, legally replayed catalog drill with exact five-grade mechanics", async () => {
    const result = await importStrategyPackText("integration.json", JSON.stringify(multiNodeSolvedPack()));
    expect(result).toMatchObject({ status: "loaded", nodeCount: 2 });
    if (result.status !== "loaded") throw new Error(result.message);
    expect(result.catalog.all().map(({ facts }) => facts.id)).toEqual(["solved-qsts-primary", "solved-qsts-narrower-range"]);
    const registry = createAcceptanceProviderRegistry();
    registerImportedProvider(registry, result);
    const controller = await createTrainerSession("Off", {
      registry,
      activeProviderId: result.providerId,
      scenarioCatalog: result.catalog,
      nodeFilter: { scenarioId: "solved-qsts-primary" },
    });
    expect(controller.snapshot).toMatchObject({ phase: "AWAITING_HERO", state: { board: ["Qh", "8s", "4s"] } });
    const call = controller.snapshot.legalActions.find(({ kind }) => kind === "call")!;
    expect(controller.session.submitHeroAction(call).snapshot.reveal).toMatchObject({
      grade: { mode: "EV", grade: "BEST MOVE", evLossBB: bb(0) },
      strategy: { provenance: "SOLVED" },
    });
  });

  it("counts complete EV rows only when every node legal action occurs exactly once with an EV", async () => {
    const pack = multiNodeSolvedPack();
    const secondNode = pack.nodes[1]!;
    const firstRow = secondNode.comboPolicy[0]!;
    const secondRow = secondNode.comboPolicy[1]!;
    const partialFirstRow = {
      ...firstRow,
      actions: [{ ...firstRow.actions[0]!, frequency: 1 }],
    };
    const missingEvSecondRow = {
      ...secondRow,
      actions: secondRow.actions.map((item, index) => index === 0
        ? { action: item.action, frequency: item.frequency }
        : item),
    };
    const result = await importStrategyPackText("ev-coverage.json", JSON.stringify({
      ...pack,
      nodes: [pack.nodes[0], { ...secondNode, comboPolicy: [partialFirstRow, missingEvSecondRow] }],
    }));
    expect(result).toMatchObject({
      status: "loaded",
      comboRowCount: 4,
      completeEvComboRowCount: 2,
    });
  });

  it("rejects imported solved rows whose source weights diverge from the replayed public range", async () => {
    const pack = multiNodeSolvedPack();
    const firstNode = pack.nodes[0]!;
    const firstRow = firstNode.comboPolicy[0]!;
    const result = await importStrategyPackText("weight-mismatch.json", JSON.stringify({
      ...pack,
      nodes: [{
        ...firstNode,
        comboPolicy: [{ ...firstRow, weight: 0.9 }, ...firstNode.comboPolicy.slice(1)],
      }, pack.nodes[1]],
    }));
    expect(result).toMatchObject({ status: "error" });
    if (result.status === "error") expect(result.message).toMatch(/weight mismatch.*tolerance/iu);
  });

  it("rejects a pack atomically when a manifest cannot legally replay its claimed solved node", async () => {
    const pack = multiNodeSolvedPack();
    const tampered = {
      ...pack,
      scenarios: [{ ...pack.scenarios[0]!, replay: [{ kind: "check" }, ...pack.scenarios[0]!.replay.slice(1)] }, pack.scenarios[1]],
    };
    const result = await importStrategyPackText("tampered.json", JSON.stringify(tampered));
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toMatch(/not legal|replay action/iu);
  });

  it("requires an explicitly registered available provider and never silently substitutes education", async () => {
    const registry = createAcceptanceProviderRegistry();
    expect(registry.requireAvailable(EDUCATIONAL_PROVIDER_ID).id).toBe(EDUCATIONAL_PROVIDER_ID);
    await expect(createAcceptanceSession("Off", { registry, activeProviderId: "missing-provider" }))
      .rejects.toThrow("Provider is not registered");
  });

  it("keeps a configured-but-unreachable sidecar unavailable and does not activate fabricated fallback data", async () => {
    const registry = createAcceptanceProviderRegistry();
    const result = await configureAndProbeLocalSolver(registry, "http://127.0.0.1:4317/v1/solve", {
      fetch: async () => { throw new TypeError("connection refused"); },
      timeoutMs: 100,
      cache: new MemoryStrategyCache(),
    });
    expect(result).toMatchObject({ status: "error", providerId: LOCAL_SOLVER_PROVIDER_ID });
    expect(registry.get(LOCAL_SOLVER_PROVIDER_ID)?.availability).toMatchObject({ state: "ERROR" });
    expect(() => registry.requireAvailable(LOCAL_SOLVER_PROVIDER_ID)).toThrow("connection refused");
    const educational = await createAcceptanceSession("Off", { registry, activeProviderId: EDUCATIONAL_PROVIDER_ID });
    expect(educational.snapshot.phase).toBe("AWAITING_HERO");
    expect(educational.session.submitHeroAction(educational.snapshot.legalActions.find(({ kind }) => kind === "call")!).snapshot.reveal?.strategy.provenance).toBe("HEURISTIC");
  });

  it("marks a local sidecar available only after a strict exact-node SOLVED response and reuses its solved cache", async () => {
    const registry = createAcceptanceProviderRegistry();
    let calls = 0;
    const fetchMock: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as {
        identity: Record<string, string>;
        query: {
          actorSeatId: string;
          actorPosition: string;
          heroSeatId: string;
          potBB: number;
          stacksBB: Record<string, number>;
          rake: unknown;
          board: string[];
          legalActions: unknown[];
        };
      };
      return new Response(JSON.stringify({
        protocolVersion: "1.1.0",
        kind: "strategy-result",
        identity: request.identity,
        source: {
          sourceId: "test-sidecar",
          solver: "fixture-solver",
          version: "1.0.0",
          timestamp: "2026-08-26T12:00:00Z",
        },
        state: {
          actorSeatId: request.query.actorSeatId,
          actorPosition: request.query.actorPosition,
          heroSeatId: request.query.heroSeatId,
          potBB: request.query.potBB,
          stacksBB: request.query.stacksBB,
          rake: request.query.rake,
          board: request.query.board,
          legalActions: request.query.legalActions,
        },
        result: {
          provenance: "SOLVED",
          actions: request.query.legalActions.map((action, index) => ({
            action,
            frequency: 1 / request.query.legalActions.length,
            evBB: bb(index / 10),
          })),
          comboPolicy: [{
            cards: [card("Qs"), card("Ts")],
            weight: 1,
            actions: request.query.legalActions.map((action, index) => ({
              action,
              frequency: 1 / request.query.legalActions.length,
              evBB: bb(index / 10),
            })),
          }],
          convergence: { solver: "fixture-solver", iterations: 1200 },
          sourceNodeId: request.identity["nodeHash"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await configureAndProbeLocalSolver(registry, "http://127.0.0.1:4317/v1/solve", {
      fetch: fetchMock,
      cache: new MemoryStrategyCache(),
    });
    expect(result).toMatchObject({ status: "available", providerId: LOCAL_SOLVER_PROVIDER_ID, cacheKind: "memory" });
    expect(registry.get(LOCAL_SOLVER_PROVIDER_ID)?.availability).toMatchObject({ state: "AVAILABLE" });
    const controller = await createAcceptanceSession("Off", { registry, activeProviderId: LOCAL_SOLVER_PROVIDER_ID });
    expect(controller.snapshot.phase).toBe("AWAITING_HERO");
    expect(calls).toBe(1);
    const call = controller.snapshot.legalActions.find(({ kind }) => kind === "call")!;
    expect(controller.session.submitHeroAction(call).snapshot.reveal?.strategy).toMatchObject({
      provenance: "SOLVED",
      convergence: { solver: "fixture-solver", iterations: 1200 },
      source: { id: "test-sidecar", solver: "fixture-solver", version: "1.0.0" },
      configuration: { actionTreeId: "acceptance-fixed" },
    });
  });

  it("rejects a local sidecar unless the exact QsTs row has normalized, EV-complete coverage of every legal action", async () => {
    const cases = [
      {
        label: "missing exact row",
        comboPolicy: undefined,
        expected: /exact positive-weight QsTs combo-policy row/iu,
      },
      {
        label: "missing legal action",
        comboPolicy: "missing-action" as const,
        expected: /QsTs row must contain every live legal action exactly once/iu,
      },
      {
        label: "missing EV",
        comboPolicy: "missing-ev" as const,
        expected: /QsTs row requires an EV for every live legal action/iu,
      },
      {
        label: "unnormalized frequencies",
        comboPolicy: "bad-frequency" as const,
        expected: /frequencies total.*rounding tolerance/iu,
      },
    ];

    for (const testCase of cases) {
      const registry = createAcceptanceProviderRegistry();
      const result = await configureAndProbeLocalSolver(registry, "http://127.0.0.1:4317/v1/solve", {
        cache: new MemoryStrategyCache(),
        fetch: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as {
            identity: Record<string, string>;
            query: {
              actorSeatId: string;
              actorPosition: string;
              heroSeatId: string;
              potBB: number;
              stacksBB: Record<string, number>;
              rake: unknown;
              board: string[];
              legalActions: PokerAction[];
            };
          };
          const complete = request.query.legalActions.map((action, index) => ({
            action,
            frequency: 1 / request.query.legalActions.length,
            evBB: bb(index / 10),
          }));
          const comboActions = testCase.comboPolicy === "missing-action"
            ? [{ ...complete[0]!, frequency: 1 }]
            : testCase.comboPolicy === "missing-ev"
              ? complete.map((item, index) => index === 0 ? { action: item.action, frequency: item.frequency } : item)
              : testCase.comboPolicy === "bad-frequency"
                ? complete.map((item) => ({ ...item, frequency: 0.01 }))
                : complete;
          return new Response(JSON.stringify({
            protocolVersion: "1.1.0",
            kind: "strategy-result",
            identity: request.identity,
            source: {
              sourceId: `test-sidecar-${testCase.label}`,
              solver: "fixture-solver",
              version: "1.0.0",
              timestamp: "2026-08-26T12:00:00Z",
            },
            state: {
              actorSeatId: request.query.actorSeatId,
              actorPosition: request.query.actorPosition,
              heroSeatId: request.query.heroSeatId,
              potBB: request.query.potBB,
              stacksBB: request.query.stacksBB,
              rake: request.query.rake,
              board: request.query.board,
              legalActions: request.query.legalActions,
            },
            result: {
              provenance: "SOLVED",
              actions: complete,
              ...(testCase.comboPolicy === undefined ? {} : {
                comboPolicy: [{
                  cards: [card("Qs"), card("Ts")],
                  weight: 1,
                  actions: comboActions,
                }],
              }),
              sourceNodeId: request.identity["nodeHash"],
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      });
      expect(result, testCase.label).toMatchObject({ status: "error" });
      if (result.status === "error") expect(result.message, testCase.label).toMatch(testCase.expected);
      expect(registry.get(LOCAL_SOLVER_PROVIDER_ID)?.availability, testCase.label).toMatchObject({ state: "ERROR" });
    }
  });
});
