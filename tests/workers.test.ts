import { describe, expect, it } from "vitest";
import {
  bb,
  card,
  conditionRangeByAction,
  createRange,
  sampleComboThenAction,
  type ComboPolicy,
} from "../src/domain";
import { calculateEquity, calculateRangeStrengthComparison } from "../src/workers/equity.worker";
import { handleRangeWorkerRequest } from "../src/workers/range.worker";

describe("worker-owned calculations", () => {
  it("enumerates ranges away from the rendering thread", () => {
    const result = handleRangeWorkerRequest({ id: "range", type: "enumerate", deadCards: [card("As"), card("Kd")] });
    expect(result.weightedCombos).toBe(1225);
  });

  it("shares conditioning and seeded sampling exactly with the synchronous combo-policy core", () => {
    const call = { kind: "call", amount: bb(2) } as const;
    const policy: ComboPolicy = [
      { cards: [card("As"), card("Ah")], weight: 0.75, actions: [{ action: { kind: "fold" }, frequency: 0.2 }, { action: call, frequency: 0.8 }] },
      { cards: [card("Kc"), card("Kd")], weight: 0.25, actions: [{ action: { kind: "fold" }, frequency: 0.6 }, { action: call, frequency: 0.4 }] },
    ];
    const prior = createRange(policy.map(({ cards, weight }) => ({ cards, weight })));
    const syncCondition = conditionRangeByAction(prior, policy, call, [card("2c")]);
    const workerCondition = handleRangeWorkerRequest({ id: "condition", type: "condition", prior, comboPolicy: policy, observedAction: call, blockedCards: [card("2c")] });
    expect(workerCondition.result).toEqual(syncCondition);

    const sampleInput = { seed: 77, heroCards: [card("As"), card("Ah")] as const, board: [card("Qh"), card("8s"), card("4s")] };
    const syncSample = sampleComboThenAction(policy, sampleInput);
    const workerSample = handleRangeWorkerRequest({ id: "sample", type: "sample", comboPolicy: policy, ...sampleInput });
    expect(workerSample.result).toEqual(syncSample);
  });

  it("runs deterministic Monte Carlo equity with explicit estimate metadata", () => {
    const result = calculateEquity({
      id: "equity",
      hero: [card("As"), card("Ah")],
      opponentRange: [{ cards: [card("Kc"), card("Kd")], weight: 1 }],
      board: [card("Ac"), card("2d"), card("7h"), card("9s"), card("Jc")],
      mode: "monte-carlo",
      iterations: 50,
      seed: 7,
    });
    expect(result).toMatchObject({
      provenance: "ESTIMATE",
      method: "monte-carlo",
      sampleCount: 50,
      scenarioCount: 50,
      seed: 7,
      wins: 50,
      ties: 0,
      losses: 0,
      equity: 1,
      standardError: 0,
      confidence95: [1, 1],
    });
  });

  it("enumerates and normalizes weighted hero/villain combo pairs exactly", () => {
    const result = calculateEquity({
      id: "weighted-exact",
      heroRange: [
        { cards: [card("As"), card("Ah")], weight: 1 },
        { cards: [card("Kc"), card("Kd")], weight: 0.5 },
      ],
      opponentRange: [
        { cards: [card("Qh"), card("Qd")], weight: 1 },
        { cards: [card("Ad"), card("Ac")], weight: 0.25 },
      ],
      board: [card("2c"), card("3d"), card("4h"), card("5s"), card("9c")],
      mode: "exact",
    });
    expect(result).toMatchObject({
      provenance: "EXACT_MATH",
      method: "exact-enumeration",
      runoutCount: 1,
      scenarioCount: 4,
      pairCount: 4,
      iterations: 1,
    });
    expect(result.totalPairWeight).toBeCloseTo(1.875, 12);
    expect(result.wins).toBeCloseTo(0.8, 12);
    expect(result.ties).toBeCloseTo(2 / 15, 12);
    expect(result.losses).toBeCloseTo(1 / 15, 12);
    expect(result.equity).toBeCloseTo(13 / 15, 12);
  });

  it("profiles current nut and top-five-percent range density from legal combos exactly", () => {
    const result = calculateRangeStrengthComparison({
      heroRange: [
        { cards: [card("Js"), card("Ts")], weight: 1 },
        { cards: [card("Ac"), card("Ad")], weight: 1 },
      ],
      opponentRange: [{ cards: [card("Kh"), card("Kc")], weight: 1 }],
      board: [card("As"), card("Kd"), card("Qh"), card("2c"), card("3d")],
    });
    expect(result).toBeDefined();
    expect(result).toMatchObject({
      provenance: "EXACT_MATH",
      basis: "CURRENT_BOARD_PUBLIC_RANGES",
      legalComboCount: 1081,
      hero: {
        comboCount: 2,
        weightedComboCount: 2,
        nutComboCount: 1,
        weightedNutCombos: 1,
        nutDensity: 0.5,
      },
      opponent: {
        comboCount: 1,
        weightedComboCount: 1,
        nutComboCount: 0,
        weightedNutCombos: 0,
        nutDensity: 0,
      },
    });
    expect(result?.hero.categoryWeightedCombos.Straight).toBe(1);
    expect(result?.hero.categoryWeightedCombos.Trips).toBe(1);
    expect(result?.opponent.categoryWeightedCombos.Trips).toBe(1);
    expect(result?.topFiveCutoffComboCount).toBeGreaterThanOrEqual(Math.ceil(1081 * 0.05));
  });

  it("filters card collisions and honors dead cards in exact runouts", () => {
    const result = calculateEquity({
      id: "dead-card-exact",
      hero: [card("As"), card("Ah")],
      opponentRange: [
        { cards: [card("As"), card("Kd")], weight: 1 },
        { cards: [card("Kc"), card("Kh")], weight: 1 },
      ],
      board: [card("2c"), card("3d"), card("4h"), card("9s")],
      deadCards: [card("Qd")],
      mode: "exact",
    });
    expect(result.pairCount).toBe(1);
    expect(result.runoutCount).toBe(43);
    expect(result.scenarioCount).toBe(43);
    expect(result.notes.join(" ")).toMatch(/dead-card-aware/iu);
  });

  it("falls back only as a labeled estimate when auto exact work exceeds budget", () => {
    const request = {
      id: "budget",
      hero: [card("As"), card("Ah")] as const,
      opponentRange: [{ cards: [card("Kc"), card("Kd")] as const, weight: 1 }],
      board: [card("2c"), card("3d"), card("4h")],
      maximumExactScenarios: 10,
      iterations: 100,
      seed: 11,
    };
    const first = calculateEquity(request);
    const replay = calculateEquity(request);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ provenance: "ESTIMATE", method: "monte-carlo", sampleCount: 100, seed: 11 });
    expect(first.notes.join(" ")).toMatch(/990 scenarios/u);
    expect(() => calculateEquity({ ...request, mode: "exact" })).toThrow(/exceeding the configured budget/u);
  });

  it("rejects invalid weights and empty legal pair sets", () => {
    expect(() => calculateEquity({
      id: "bad-weight",
      hero: [card("As"), card("Ah")],
      opponentRange: [{ cards: [card("Kc"), card("Kd")], weight: 1.1 }],
      board: [],
      mode: "monte-carlo",
      iterations: 1,
    })).toThrow(/weight/u);
    expect(() => calculateEquity({
      id: "blocked",
      hero: [card("As"), card("Ah")],
      opponentRange: [{ cards: [card("As"), card("Kd")], weight: 1 }],
      board: [],
      mode: "monte-carlo",
      iterations: 1,
    })).toThrow(/No legal weighted/u);
  });
});
