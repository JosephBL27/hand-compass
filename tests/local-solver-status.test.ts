import { describe, expect, it, vi } from "vitest";
import { getLocalSolverStatus } from "../src/domain/localSolverStatus";

const status = {
  status: "ok", protocolVersion: "1.1.0", adapterVersion: "2.0.0", solver: "b-inary/postflop-solver", commit: "pinned",
  scope: "heads-up-postflop-chip-ev",
  capabilities: { streets: ["flop", "turn", "river"], maxPlayersRemaining: 2, weightedRanges: true, unequalStacks: true, rake: true,
    sizingModes: ["fixed", "dynamic", "geometric"], unsupported: ["Preflop equilibrium"] },
  limits: { maxIterations: 2000, targetExploitabilityPctPot: 0.5, maxMemoryMB: 4096, maxSolveSeconds: 120, maxTreeNodes: 200000, maxQueuedRequests: 8 },
  activity: { phase: "idle", queuedRequests: 0, iterations: 0, elapsedSeconds: 0, completedSolves: 3, rejectedSolves: 1, lastError: null },
  cache: { persistent: true, entries: 3, bytes: 12000, maxEntries: 1024, maxBytes: 268435456, hits: 2, misses: 3, writes: 3, errors: 0 },
};

describe("solver operational status", () => {
  it("reads the loopback status route and validates capacity, runtime and cache without strategy output", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:4317/v1/status");
      return Response.json(status);
    });
    const result = await getLocalSolverStatus("http://127.0.0.1:4317/v1/solve?obsolete=1", { fetch });
    expect(result.cache.entries).toBe(3);
    expect(result.activity.completedSolves).toBe(3);
    expect(result).not.toHaveProperty("actions");
  });

  it("rejects a health-only old sidecar instead of inventing its capabilities", async () => {
    await expect(getLocalSolverStatus(undefined, { fetch: async () => Response.json({ status: "ok" }) })).rejects.toThrow();
  });

  it("respects cancellation and refuses arbitrary remote endpoints", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getLocalSolverStatus(undefined, { signal: controller.signal, fetch: async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    } })).rejects.toMatchObject({ name: "AbortError" });
    await expect(getLocalSolverStatus("http://remote.example/v1/solve")).rejects.toThrow(/loopback/u);
  });
});
