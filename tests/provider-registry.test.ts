import { describe, expect, it } from "vitest";
import { HeuristicStrategyProvider, StrategyProviderRegistry } from "../src/domain";

function provider(id: string) {
  return new HeuristicStrategyProvider(id, () => ({ actions: [], notes: ["fixture"] }));
}

describe("strategy provider registry", () => {
  it("tracks explicit availability and never falls back silently", () => {
    const registry = new StrategyProviderRegistry();
    registry.register({
      provider: provider("local"),
      metadata: { label: "Local solver", kind: "LOCAL_SOLVER", possibleProvenance: ["SOLVED"] },
      availability: { state: "UNAVAILABLE", reason: "Sidecar is not running", checkedAt: "2026-08-26T12:00:00Z" },
    });
    expect(() => registry.requireAvailable("local")).toThrow(/Sidecar is not running/u);
    expect(() => registry.requireAvailable("missing")).toThrow(/not registered/u);
    registry.setAvailability("local", { state: "AVAILABLE", checkedAt: "2026-08-26T12:01:00Z" });
    expect(registry.requireAvailable("local").id).toBe("local");
  });

  it("rejects duplicate ids and unexplained non-available states", () => {
    const registry = new StrategyProviderRegistry();
    const entry = {
      provider: provider("one"),
      metadata: { label: "One", kind: "HEURISTIC" as const, possibleProvenance: ["HEURISTIC" as const] },
      availability: { state: "AVAILABLE" as const },
    };
    registry.register(entry);
    expect(() => registry.register(entry)).toThrow(/Duplicate/u);
    expect(() => registry.setAvailability("one", { state: "ERROR" })).toThrow(/requires a reason/u);
  });
});

