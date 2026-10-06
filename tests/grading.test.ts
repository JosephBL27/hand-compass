import { describe, expect, it } from "vitest";
import {
  bb,
  gradeAction,
  gradeFrequencyPrediction,
  partitionStrategyFrequencies,
  selectReferenceAction,
  sampleStrategyActionByUnitRoll,
  actionKey,
  type PokerAction,
  type StrategyResult,
} from "../src/domain";

const fold = { kind: "fold" } as const satisfies PokerAction;
const call = { kind: "call", amount: bb(2) } as const satisfies PokerAction;
const raise = { kind: "raise", to: bb(8) } as const satisfies PokerAction;
const jam = { kind: "jam", to: bb(100) } as const satisfies PokerAction;

function solvedWithChosenLoss(lossBB: number, chosenFrequency = 0.1): StrategyResult {
  return {
    provenance: "SOLVED",
    actions: [
      { action: fold, frequency: 0.8, evBB: bb(10) },
      { action: call, frequency: chosenFrequency, evBB: bb(10 - lossBB) },
      { action: raise, frequency: Math.max(0, 0.2 - chosenFrequency), evBB: bb(9) },
    ],
  };
}

describe("reference selection and grading policy", () => {
  it("selects the highest-frequency action with RNG off, independent of EV", () => {
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: [
        { action: fold, frequency: 0.6, evBB: bb(9.9) },
        { action: call, frequency: 0.4, evBB: bb(10) },
      ],
    };
    expect(selectReferenceAction(strategy, "off")?.action).toBe(fold);
    expect(gradeAction(fold, strategy, bb(10))).toMatchObject({ mode: "EV", grade: "BEST MOVE", evLossBB: bb(0.1) });
    expect(gradeAction(call, strategy, bb(10))).toMatchObject({ mode: "EV", grade: "GOOD MOVE", evLossBB: bb(0) });
  });

  it("partitions high RNG from passive to aggressive and low RNG in reverse", () => {
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: [
        { action: raise, frequency: 0.2 },
        { action: fold, frequency: 0.4 },
        { action: jam, frequency: 0.05 },
        { action: call, frequency: 0.35 },
      ],
    };
    expect(partitionStrategyFrequencies(strategy, "high").map(({ item, start, end }) => [item.action.kind, start, end])).toEqual([
      ["fold", 1, 40],
      ["call", 41, 75],
      ["raise", 76, 95],
      ["jam", 96, 100],
    ]);
    expect(partitionStrategyFrequencies(strategy, "low").map(({ item, start, end }) => [item.action.kind, start, end])).toEqual([
      ["jam", 1, 5],
      ["raise", 6, 25],
      ["call", 26, 60],
      ["fold", 61, 100],
    ]);
    expect(selectReferenceAction(strategy, "high", 95)?.action.kind).toBe("raise");
    expect(selectReferenceAction(strategy, "high", 96)?.action.kind).toBe("jam");
    expect(selectReferenceAction(strategy, "low", 5)?.action.kind).toBe("jam");
    expect(selectReferenceAction(strategy, "low", 6)?.action.kind).toBe("raise");
    expect(() => selectReferenceAction(strategy, "high", 0)).toThrow(/1 through 100/u);
  });

  it("never fabricates buckets from missing, legally incomplete, malformed, or heuristic frequencies", () => {
    const missing: StrategyResult = {
      provenance: "SOLVED",
      actions: [{ action: fold, frequency: 0.7 }, { action: call }],
    };
    const missingLegalAction: StrategyResult = {
      provenance: "SOLVED",
      actions: [{ action: fold, frequency: 0.7 }, { action: call, frequency: 0.3 }],
    };
    const nonNormalized: StrategyResult = {
      provenance: "SOLVED",
      actions: [{ action: fold, frequency: 0.7 }, { action: call, frequency: 0.2 }],
    };
    const heuristic: StrategyResult = {
      provenance: "HEURISTIC",
      actions: [{ action: fold, frequency: 0.7 }, { action: call, frequency: 0.3 }],
    };

    expect(partitionStrategyFrequencies(missing, "high")).toEqual([]);
    expect(partitionStrategyFrequencies(missingLegalAction, "high", [fold, call, raise])).toEqual([]);
    expect(partitionStrategyFrequencies(nonNormalized, "low")).toEqual([]);
    expect(partitionStrategyFrequencies(heuristic, "high")).toEqual([]);
  });

  it("grades the RNG-bucket-selected equilibrium action as BEST MOVE", () => {
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: [
        { action: fold, frequency: 0.7, evBB: bb(10) },
        { action: jam, frequency: 0.3, evBB: bb(9.8) },
      ],
    };
    expect(gradeAction(jam, strategy, bb(10), undefined, { rngMode: "high", roll: 100 })).toMatchObject({
      mode: "EV",
      grade: "BEST MOVE",
      evLossBB: bb(0.2),
    });
  });

  it.each([
    [0.0499, "GOOD MOVE"],
    [0.05, "INACCURACY"],
    [0.2, "INACCURACY"],
    [0.2001, "MISTAKE"],
    [0.5, "MISTAKE"],
    [0.5001, "BLUNDER"],
  ] as const)("applies the exact EV-loss boundary for %s BB in a 10 BB pot", (loss, expected) => {
    expect(gradeAction(call, solvedWithChosenLoss(loss), bb(10))).toMatchObject({ mode: "EV", grade: expected });
  });

  it("applies the configurable 3.5% low-frequency boundary", () => {
    expect(gradeAction(call, solvedWithChosenLoss(0, 0.0349), bb(10))).toMatchObject({ mode: "EV", grade: "INACCURACY" });
    expect(gradeAction(call, solvedWithChosenLoss(0, 0.035), bb(10))).toMatchObject({ mode: "EV", grade: "GOOD MOVE" });
  });

  it("keeps missing EV or frequency data out of exact-regret grading", () => {
    const frequencyOnly: StrategyResult = { provenance: "SOLVED", actions: [{ action: fold, frequency: 0.7 }, { action: call, frequency: 0.3 }] };
    const supported = gradeAction(call, frequencyOnly, bb(10));
    expect(supported).toEqual({ mode: "REFERENCE_ONLY", grade: "SUPPORTED MIX" });
    expect(supported).not.toHaveProperty("evLossBB");
    expect(gradeAction(fold, frequencyOnly, bb(10))).toEqual({ mode: "REFERENCE_ONLY", grade: "REFERENCE ACTION" });

    const evOnly: StrategyResult = { provenance: "SOLVED", actions: [{ action: fold, evBB: bb(2) }, { action: call, evBB: bb(1.9) }] };
    expect(gradeAction(fold, evOnly, bb(10))).toEqual({ mode: "REFERENCE_ONLY", grade: "REFERENCE UNAVAILABLE" });
    expect(gradeAction(raise, frequencyOnly, bb(10))).toEqual({ mode: "REFERENCE_ONLY", grade: "OUTSIDE REFERENCE" });
  });

  it("requires EV coverage for every issued legal action before activating five-grade EV loss", () => {
    const partial: StrategyResult = {
      provenance: "SOLVED",
      actions: [
        { action: fold, frequency: 0.7, evBB: bb(3) },
        { action: call, frequency: 0.3, evBB: bb(2.9) },
      ],
    };
    expect(gradeAction(fold, partial, bb(10), undefined, { legalActions: [fold, call, raise] })).toEqual({
      mode: "REFERENCE_ONLY",
      grade: "REFERENCE UNAVAILABLE",
    });
  });

  it("withholds a reference when legal-action frequencies are incomplete or not normalized", () => {
    expect(selectReferenceAction({ provenance: "SOLVED", actions: [{ action: fold, frequency: 0.8 }] })).toBeUndefined();
    expect(selectReferenceAction({ provenance: "SOLVED", actions: [{ action: fold, frequency: 0 }, { action: call, frequency: 0 }] })).toBeUndefined();
    expect(selectReferenceAction({ provenance: "SOLVED", actions: [{ action: fold, frequency: 0.6 }, { action: call, frequency: 0.6 }] })).toBeUndefined();
    expect(gradeAction(fold, {
      provenance: "SOLVED",
      actions: [{ action: fold, frequency: 0.8, evBB: bb(2) }, { action: call, evBB: bb(1.9) }],
    }, bb(10), undefined, { legalActions: [fold, call] })).toEqual({ mode: "REFERENCE_ONLY", grade: "REFERENCE UNAVAILABLE" });
  });

  it("rejects undefined percentage grading and malformed grading policies", () => {
    expect(() => gradeAction(fold, solvedWithChosenLoss(0), bb(0))).toThrow(/positive pot/u);
    expect(() => gradeAction(fold, solvedWithChosenLoss(0), bb(10), {
      lowFrequencyBoundary: 0.035,
      goodMaxLossPctPot: 3,
      inaccuracyMaxLossPctPot: 2,
      mistakeMaxLossPctPot: 5,
    })).toThrow(/ordered/u);
  });

  it("keeps heuristic verdicts visibly separate", () => {
    const strategy: StrategyResult = { provenance: "HEURISTIC", actions: [{ action: call }, { action: fold }] };
    expect(gradeAction(call, strategy, bb(10))).toEqual({ mode: "HEURISTIC", grade: "HEURISTIC BEST" });
    expect(gradeAction(fold, strategy, bb(10))).toEqual({ mode: "HEURISTIC", grade: "HEURISTIC ACCEPTABLE" });
    expect(gradeAction(raise, strategy, bb(10))).toEqual({ mode: "HEURISTIC", grade: "HEURISTIC QUESTIONABLE" });
  });

  it("grades frequency predictions by total-variation distance and samples only from the reference mix", () => {
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: [
        { action: fold, frequency: 0.4 },
        { action: call, frequency: 0.35 },
        { action: raise, frequency: 0.25 },
      ],
    };
    const exact = gradeFrequencyPrediction({ [actionKey(fold)]: 0.4, [actionKey(call)]: 0.35, [actionKey(raise)]: 0.25 }, strategy);
    expect(exact).toMatchObject({ grade: "EXCELLENT MIX", totalVariationDistance: 0, maximumAbsoluteError: 0 });
    const off = gradeFrequencyPrediction({ [actionKey(fold)]: 0.8, [actionKey(call)]: 0.1, [actionKey(raise)]: 0.1 }, strategy);
    expect(off.grade).toBe("OFF TARGET");
    expect(off.totalVariationDistance).toBeCloseTo(0.4, 12);
    expect(sampleStrategyActionByUnitRoll(strategy, 0).action).toBe(fold);
    expect(sampleStrategyActionByUnitRoll(strategy, 0.4).action).toBe(call);
    expect(sampleStrategyActionByUnitRoll(strategy, 0.75).action).toBe(raise);
    expect(() => gradeFrequencyPrediction({ [actionKey(fold)]: 1 }, { provenance: "HEURISTIC", actions: [{ action: fold }] })).toThrow(/SOLVED/iu);
  });
});
