import { describe, expect, it, vi } from "vitest";
import {
  HttpLocalSolverTransport,
  LOCAL_SOLVER_PROTOCOL_VERSION,
  LocalSolverProvider,
  bb,
  createLocalSolverRequest,
  decodeLocalSolverResponse,
  stableSolverJson,
  validateLocalSolverEndpoint,
  type PokerAction,
  type StrategyQuery,
} from "../src/domain";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";

function query(): StrategyQuery {
  const spot = createAcceptanceSpot();
  return {
    nodeHash: "local-solver-node",
    actorSeatId: "seat-2",
    actorPosition: "BB",
    heroSeatId: "seat-2",
    gameConfig: spot.config,
    street: spot.flopDecision.street,
    board: spot.flopDecision.board,
    actionHistory: spot.flopDecision.actionHistory.map(({ action }) => action),
    publicState: {
      buttonIndex: spot.flopDecision.buttonIndex,
      currentBetBB: spot.flopDecision.currentBetBB,
      lastFullRaiseBB: spot.flopDecision.lastFullRaiseBB,
      players: spot.flopDecision.players.map(({ id, stackBB, streetContributionBB, totalContributionBB, status }) => ({
        id, stackBB, streetContributionBB, totalContributionBB, status,
      })),
      actionHistory: spot.flopDecision.actionHistory.map(({ seatId, street, action, potAfterBB }) => ({ seatId, street, action, potAfterBB })),
    },
    potBB: spot.flopDecision.potBB,
    stacksBB: Object.fromEntries(spot.flopDecision.players.map((player) => [player.id, player.stackBB])) as StrategyQuery["stacksBB"],
    heroPosition: "BB",
    opponentPositions: ["CO"],
    ranges: {},
    legalActions: spot.legalActions,
    actionTree: { id: "strict", preflop: { unopened: { mode: "fixed", candidates: [] }, facingRaise: { mode: "fixed", candidates: [] } }, flop: { mode: "fixed", candidates: [] }, turn: { mode: "fixed", candidates: [] }, river: { mode: "fixed", candidates: [] } },
    rake: spot.config.rake,
    deadCards: [],
  };
}

function response(q = query()): Record<string, unknown> {
  const request = createLocalSolverRequest(q);
  const frequency = 1 / q.legalActions.length;
  return {
    protocolVersion: LOCAL_SOLVER_PROTOCOL_VERSION,
    kind: "strategy-result",
    identity: request.identity,
    source: { sourceId: "sidecar-fixture", solver: "FixtureSolver", version: "1.2.3", timestamp: "2026-08-26T12:00:00Z" },
    state: {
      actorSeatId: q.actorSeatId,
      actorPosition: q.actorPosition,
      heroSeatId: q.heroSeatId,
      potBB: q.potBB,
      stacksBB: q.stacksBB,
      rake: q.rake,
      board: q.board,
      legalActions: q.legalActions,
    },
    result: {
      provenance: "SOLVED",
      actions: q.legalActions.map((action, index) => ({ action, frequency, evBB: bb(index / 10) })),
      convergence: { iterations: 1000, exploitability: 0.01 },
      sourceNodeId: q.nodeHash,
    },
  };
}

describe("normalized local solver protocol", () => {
  it("round-trips a strict solved result and carries source provenance", () => {
    const q = query();
    const result = decodeLocalSolverResponse(response(q), q);
    expect(result).toMatchObject({ provenance: "SOLVED", sourceNodeId: q.nodeHash, convergence: { solver: "FixtureSolver", iterations: 1000 } });
    expect(result.actions).toHaveLength(q.legalActions.length);
    expect(result.notes?.join(" ")).toMatch(/sidecar-fixture.*FixtureSolver 1\.2\.3/u);
  });

  it("rejects unknown response fields, wrong protocol versions, and hash collisions", () => {
    const q = query();
    expect(() => decodeLocalSolverResponse({ ...response(q), invented: true }, q)).toThrow();
    expect(() => decodeLocalSolverResponse({ ...response(q), protocolVersion: "9.9.9" }, q)).toThrow();
    const wrong = response(q);
    wrong["identity"] = { ...createLocalSolverRequest(q).identity, treeHash: "wrong" };
    expect(() => decodeLocalSolverResponse(wrong, q)).toThrow(/identity mismatch: treeHash/u);
  });

  it("rejects stale actor, pot, stack, board, and legal-action echoes", () => {
    const q = query();
    const cases = [
      { ...response(q), state: { ...(response(q)["state"] as object), actorSeatId: "seat-7" } },
      { ...response(q), state: { ...(response(q)["state"] as object), actorPosition: "CO" } },
      { ...response(q), state: { ...(response(q)["state"] as object), heroSeatId: "seat-7" } },
      { ...response(q), state: { ...(response(q)["state"] as object), potBB: bb(99) } },
      { ...response(q), state: { ...(response(q)["state"] as object), stacksBB: { ...q.stacksBB, "seat-0": bb(1) } } },
      { ...response(q), state: { ...(response(q)["state"] as object), board: ["Ac", "Kd", "2h"] } },
      { ...response(q), state: { ...(response(q)["state"] as object), legalActions: q.legalActions.slice(1) } },
    ];
    for (const payload of cases) expect(() => decodeLocalSolverResponse(payload, q)).toThrow(/mismatch/u);
  });

  it("rejects missing/illegal result rows and fabricated partial frequency tables", () => {
    const q = query();
    const base = response(q);
    const original = (base["result"] as { actions: Array<{ action: PokerAction; frequency?: number }> }).actions;
    expect(() => decodeLocalSolverResponse({ ...base, result: { ...(base["result"] as object), actions: original.slice(1) } }, q)).toThrow(/every live legal action/u);
    const partial = original.map((item, index) => index === 0 ? { action: item.action } : item);
    expect(() => decodeLocalSolverResponse({ ...base, result: { ...(base["result"] as object), actions: partial } }, q)).toThrow(/present for every action/u);
    const badTotal = original.map((item) => ({ ...item, frequency: 0.01 }));
    expect(() => decodeLocalSolverResponse({ ...base, result: { ...(base["result"] as object), actions: badTotal } }, q)).toThrow(/sum to 1/u);
  });

  it("rejects combo-policy rows that collide with board or dead cards", () => {
    const q = query();
    const base = response(q);
    const actions = (base["result"] as { actions: Array<{ action: PokerAction }> }).actions;
    const colliding = [{ cards: [q.board[0], "As"], weight: 1, actions: [{ action: actions[0]?.action, frequency: 1 }] }];
    expect(() => decodeLocalSolverResponse({ ...base, result: { ...(base["result"] as object), comboPolicy: colliding } }, q)).toThrow(/collides/u);
  });

  it("serializes identical query maps deterministically", () => {
    const q = query();
    const left = stableSolverJson(createLocalSolverRequest(q));
    const reversedStacks = Object.fromEntries(Object.entries(q.stacksBB).reverse()) as StrategyQuery["stacksBB"];
    const right = stableSolverJson(createLocalSolverRequest({ ...q, stacksBB: reversedStacks }));
    expect(right).toBe(left);
  });

  it("passes the live query and caller signal through LocalSolverProvider", async () => {
    const q = query();
    const controller = new AbortController();
    const request = vi.fn(async (_query: StrategyQuery, signal?: AbortSignal) => {
      expect(_query).toBe(q);
      expect(signal).toBe(controller.signal);
      return response(q);
    });
    const provider = new LocalSolverProvider("local", { request }, decodeLocalSolverResponse);
    await expect(provider.getStrategy(q, { signal: controller.signal })).resolves.toMatchObject({ provenance: "SOLVED" });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("loopback HTTP solver transport", () => {
  it("rejects remote hosts and embedded credentials by default", () => {
    expect(() => validateLocalSolverEndpoint("https://solver.example/v1/solve")).toThrow(/loopback/u);
    expect(() => validateLocalSolverEndpoint("http://user:pass@127.0.0.1/v1/solve")).toThrow(/credentials/u);
    expect(validateLocalSolverEndpoint("http://[::1]:4317/v1/solve").hostname).toBe("[::1]");
  });

  it("POSTs normalized JSON and parses a bounded JSON response", async () => {
    const q = query();
    const payload = response(q);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ protocolVersion: LOCAL_SOLVER_PROTOCOL_VERSION, kind: "solve" });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    const transport = new HttpLocalSolverTransport({ fetch: fetchMock, maxResponseBytes: 1_000_000 });
    await expect(transport.request(q)).resolves.toEqual(payload);
  });

  it("rejects HTTP failures, non-JSON content, malformed JSON, and oversized bodies", async () => {
    const q = query();
    const make = (responseValue: Response) => new HttpLocalSolverTransport({ fetch: async () => responseValue, maxResponseBytes: 10 });
    await expect(make(new Response("{}", { status: 503, headers: { "content-type": "application/json" } })).request(q)).rejects.toThrow(/HTTP 503/u);
    await expect(make(new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })).request(q)).rejects.toThrow(/not JSON/u);
    await expect(make(new Response("{", { status: 200, headers: { "content-type": "application/json" } })).request(q)).rejects.toThrow(/malformed JSON/u);
    await expect(make(new Response("01234567890", { status: 200, headers: { "content-type": "application/json" } })).request(q)).rejects.toThrow(/byte limit/u);
  });

  it("composes caller cancellation into the fetch signal", async () => {
    const q = query();
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const transport = new HttpLocalSolverTransport({ fetch: fetchMock, timeoutMs: 1000 });
    const controller = new AbortController();
    const pending = transport.request(q, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a stopped sidecar as unavailable so the selected hybrid can continue honestly", async () => {
    const transport = new HttpLocalSolverTransport({ fetch: async () => { throw new TypeError("fetch failed"); } });
    await expect(transport.request(query())).rejects.toMatchObject({ name: "StrategyUnavailableError", reason: expect.stringContaining("fetch failed") });
  });

  it("reports an expired internal timeout as unavailable without swallowing user cancellation", async () => {
    const transport = new HttpLocalSolverTransport({ timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }) });
    await expect(transport.request(query())).rejects.toMatchObject({ name: "StrategyUnavailableError", reason: expect.stringContaining("timed out") });
  });
});
