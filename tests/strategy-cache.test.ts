import { describe, expect, it, vi } from "vitest";
import {
  CachingStrategyProvider,
  MemoryStrategyCache,
  bb,
  cacheHashesKey,
  createStrategyQueryHashes,
  type StrategyProvider,
  type StrategyQuery,
  type StrategyResult,
} from "../src/domain";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";

function query(nodeHash = "cache-node"): StrategyQuery {
  const spot = createAcceptanceSpot();
  return {
    nodeHash,
    actorSeatId: "seat-2",
    actorPosition: "BB",
    heroSeatId: "seat-2",
    gameConfig: spot.config,
    street: spot.flopDecision.street,
    board: spot.flopDecision.board,
    actionHistory: spot.flopDecision.actionHistory.map(({ action }) => action),
    potBB: spot.flopDecision.potBB,
    stacksBB: Object.fromEntries(spot.flopDecision.players.map((player) => [player.id, player.stackBB])) as StrategyQuery["stacksBB"],
    heroPosition: "BB",
    opponentPositions: ["CO"],
    ranges: {},
    legalActions: spot.legalActions,
    actionTree: { id: "cache", preflop: { unopened: { mode: "fixed", candidates: [] }, facingRaise: { mode: "fixed", candidates: [] } }, flop: { mode: "fixed", candidates: [] }, turn: { mode: "fixed", candidates: [] }, river: { mode: "fixed", candidates: [] } },
    rake: spot.config.rake,
    deadCards: [],
  };
}

function solved(q: StrategyQuery): StrategyResult {
  return { provenance: "SOLVED", actions: q.legalActions.map((action) => ({ action, evBB: bb(0) })), sourceNodeId: q.nodeHash };
}

describe("five-hash strategy cache", () => {
  it("caches SOLVED results and reuses the exact five-hash state", async () => {
    const q = query();
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache());
    await provider.getStrategy(q);
    await provider.getStrategy(q);
    expect(getStrategy).toHaveBeenCalledOnce();
  });

  it("does not cache HEURISTIC or INTERPOLATED output", async () => {
    const q = query();
    const getStrategy = vi.fn(async (): Promise<StrategyResult> => ({ provenance: "HEURISTIC", actions: [] }));
    const provider = new CachingStrategyProvider("cached", { id: "education", getStrategy }, new MemoryStrategyCache());
    await provider.getStrategy(q);
    await provider.getStrategy(q);
    expect(getStrategy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates a live call while allowing one consumer to abort independently", async () => {
    const q = query();
    let release: ((value: StrategyResult) => void) | undefined;
    const getStrategy = vi.fn(async () => new Promise<StrategyResult>((resolve) => { release = resolve; }));
    const provider = new CachingStrategyProvider("cached", { id: "slow-source", getStrategy }, new MemoryStrategyCache());
    const controller = new AbortController();
    const first = provider.getStrategy(q, { signal: controller.signal });
    const second = provider.getStrategy(q);
    await vi.waitFor(() => expect(getStrategy).toHaveBeenCalledOnce());
    controller.abort(new DOMException("consumer cancelled", "AbortError"));
    release?.(solved(q));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ provenance: "SOLVED" });
    expect(getStrategy).toHaveBeenCalledOnce();
  });

  it("aborts the underlying shared call only after every consumer cancels", async () => {
    const q = query();
    let underlyingSignal: AbortSignal | undefined;
    const source: StrategyProvider = {
      id: "abort-aware",
      async getStrategy(_live, context) {
        underlyingSignal = context?.signal;
        return new Promise<StrategyResult>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
        });
      },
    };
    const provider = new CachingStrategyProvider("cached", source, new MemoryStrategyCache());
    const left = new AbortController();
    const right = new AbortController();
    const first = provider.getStrategy(q, { signal: left.signal });
    const second = provider.getStrategy(q, { signal: right.signal });
    await vi.waitFor(() => expect(underlyingSignal).toBeDefined());
    left.abort(new DOMException("left", "AbortError"));
    expect(underlyingSignal?.aborted).toBe(false);
    right.abort(new DOMException("right", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingSignal?.aborted).toBe(true);
  });

  it("evicts a corrupt or foreign-provider cache entry before use", async () => {
    const q = query();
    const identity = createStrategyQueryHashes({ gameConfig: q.gameConfig, ranges: q.ranges, tree: q.actionTree, nodeHash: q.nodeHash, board: q.board });
    const cache = new MemoryStrategyCache();
    await cache.set({ key: cacheHashesKey(identity), identity, providerId: "other", storedAt: new Date().toISOString(), result: solved(q) });
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, cache);
    await expect(provider.getStrategy(q)).resolves.toMatchObject({ provenance: "SOLVED" });
    expect(getStrategy).toHaveBeenCalledOnce();
  });

  it("does not collide when the nodeHash is reused with a different board", async () => {
    const q = query("shared-node");
    const changed = { ...q, board: [q.board[0]!, q.board[1]!, "2h"] as StrategyQuery["board"] };
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache());
    await provider.getStrategy(q);
    await provider.getStrategy(changed);
    expect(getStrategy).toHaveBeenCalledTimes(2);
  });

  it("requires full query equality even when all five hashes are unchanged", async () => {
    const q = query("accidentally-reused-node");
    const changed = { ...q, potBB: bb(21) };
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache());
    await provider.getStrategy(q);
    await provider.getStrategy(changed);
    expect(getStrategy).toHaveBeenCalledTimes(2);
  });

  it("does not combine concurrent calls whose five hashes match but public query differs", async () => {
    const q = query();
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache());
    await Promise.all([provider.getStrategy(q), provider.getStrategy({ ...q, deadCards: ["Ac"] })]);
    expect(getStrategy).toHaveBeenCalledTimes(2);
  });

  it("bounds memory entries and preserves recently used results", async () => {
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache({ maxEntries: 2 }));
    await provider.getStrategy(query("a"));
    await provider.getStrategy(query("b"));
    await provider.getStrategy(query("a"));
    await provider.getStrategy(query("c"));
    await provider.getStrategy(query("a"));
    expect(getStrategy).toHaveBeenCalledTimes(3);
    await provider.getStrategy(query("b"));
    expect(getStrategy).toHaveBeenCalledTimes(4);
  });

  it("does not retain an entry larger than the configured byte budget", async () => {
    const getStrategy = vi.fn(async (live: StrategyQuery) => solved(live));
    const provider = new CachingStrategyProvider("cached", { id: "source", getStrategy }, new MemoryStrategyCache({ maxBytes: 64 }));
    await provider.getStrategy(query());
    await provider.getStrategy(query());
    expect(getStrategy).toHaveBeenCalledTimes(2);
  });
});
