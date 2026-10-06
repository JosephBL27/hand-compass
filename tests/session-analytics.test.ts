import { describe, expect, it } from "vitest";
import { emptySessionAnalytics, largestLeak, parseSessionAnalytics, recordDecision, recordFrequencyPrediction, selectScenarioForAnalyticsReview, startAnalyticsHand, summarizeAnalytics } from "../src/analytics";
import type { StrategyProvider } from "../src/domain/strategy";
import { createAcceptanceNodeDefinition, createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { createScenarioCatalog } from "../src/session/catalog";
import { decisionMathForState } from "../src/session/query";
import { bb } from "../src/domain/money";
import { seatId } from "../src/domain/seats";

describe("session analytics and conceptual review", () => {
  it("records heuristic evidence without inventing EV or frequency metrics", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find(({ kind }) => kind === "call")!;
    const state = recordDecision(startAnalyticsHand(emptySessionAnalytics()), {
      handId: "hand-1",
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      chosenAction: call,
      grade: { mode: "HEURISTIC", grade: "HEURISTIC BEST" },
      strategy: { provenance: "HEURISTIC", actions: [{ action: call }] },
      decisionMath: decisionMathForState(spot.flopDecision),
      decidedAt: new Date("2026-08-27T00:00:00.000Z"),
    });
    const summary = summarizeAnalytics(state);
    expect(summary).toMatchObject({ handsStarted: 1, totalDecisions: 1, evKnownDecisions: 0, frequencyKnownDecisions: 0 });
    expect(summary.totalEvLossBB).toBeUndefined();
    expect(state.records[0]).toMatchObject({ handClass: "Pair", sizingBucket: "Call" });
    expect(state.records[0]?.conceptTags).toContain("FACING_SMALL_BET");
    expect(largestLeak(state)).toMatchObject({ available: false });
  });

  it("tracks exact-mix exercises separately from source-sampled rollout actions", () => {
    const spot = createAcceptanceSpot();
    const math = decisionMathForState(spot.flopDecision);
    const state = recordFrequencyPrediction(startAnalyticsHand(emptySessionAnalytics()), {
      handId: "mix-hand",
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      provenance: "SOLVED",
      decisionMath: math,
      grade: {
        grade: "CLOSE MIX",
        totalVariationDistance: 0.06,
        meanAbsoluteError: 0.02,
        maximumAbsoluteError: 0.04,
        actions: [],
      },
      decidedAt: new Date("2026-08-27T00:00:00.000Z"),
    });
    const summary = summarizeAnalytics(state);
    expect(summary).toMatchObject({ totalDecisions: 0, frequencyPredictionCount: 1, averageMixDistance: 0.06 });
    expect(summary.mixByStreet["flop"]).toEqual({ attempts: 1, meanDistance: 0.06 });
    expect(state.frequencyPredictions[0]).toMatchObject({ grade: "CLOSE MIX", handClass: "Pair", success: true });
  });

  it("aggregates only genuine complete EV/frequency decisions and schedules failed concepts sooner", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find(({ kind }) => kind === "call")!;
    const fold = spot.legalActions.find(({ kind }) => kind === "fold")!;
    const strategy = {
      provenance: "SOLVED" as const,
      actions: spot.legalActions.map((action) => ({ action, frequency: action.kind === "call" ? 0.6 : 0.4 / (spot.legalActions.length - 1), evBB: action.kind === "call" ? bb(8.4) : bb(8.2) })),
    };
    let state = startAnalyticsHand(emptySessionAnalytics());
    for (let index = 0; index < 5; index += 1) {
      state = recordDecision(state, {
        handId: "hand-1",
        state: spot.flopDecision,
        heroSeatId: seatId(2),
        chosenAction: fold,
        grade: { mode: "EV", grade: "MISTAKE", evLossBB: bb(0.2), evLossPctPot: 2.74 },
        strategy,
        decisionMath: decisionMathForState(spot.flopDecision),
        decidedAt: new Date(index),
      });
    }
    const summary = summarizeAnalytics(state);
    expect(summary.totalEvLossBB).toBeCloseTo(1);
    expect(summary.averageEvLossPerDecisionBB).toBeCloseTo(0.2);
    expect(summary.frequencyKnownDecisions).toBe(5);
    expect(largestLeak(state)).toMatchObject({ available: true, decisions: 5 });
    expect(Object.values(state.concepts).some((item) => (item?.samplingWeight ?? 0) > 1)).toBe(true);
  });

  it("fails closed when persisted analytics has an unknown or malformed schema", () => {
    expect(parseSessionAnalytics("not json")).toEqual(emptySessionAnalytics());
    expect(parseSessionAnalytics(JSON.stringify({ schemaVersion: 99, records: [] }))).toEqual(emptySessionAnalytics());
  });

  it("migrates version-one analytics without inventing frequency exercises", () => {
    const legacy = { schemaVersion: 1, handsStarted: 2, records: [], concepts: {} };
    expect(parseSessionAnalytics(JSON.stringify(legacy))).toMatchObject({ schemaVersion: 2, handsStarted: 2, frequencyPredictions: [] });
  });

  it("adapts persisted due-concept state into deterministic catalog review selection", () => {
    const provider: StrategyProvider = { id: "analytics-review", async getStrategy() { return { provenance: "HEURISTIC", actions: [] }; } };
    const base = createAcceptanceNodeDefinition(provider);
    const matches = createScenarioCatalog([{ ...base, id: "review-general" }, { ...base, id: "review-small-bet" }]).all();
    const analytics = {
      ...emptySessionAnalytics(),
      concepts: {
        FACING_SMALL_BET: {
          tag: "FACING_SMALL_BET" as const,
          attempts: 2,
          successes: 0,
          failures: 2,
          streak: 0,
          nextDueDecision: 0,
          samplingWeight: 8,
          lastGrade: "MISTAKE" as const,
        },
      },
    };
    const select = (seed: number) => selectScenarioForAnalyticsReview({
      matches,
      analytics,
      seed,
      conceptTagsForMatch: ({ definition }) => definition.id === "review-small-bet" ? ["FACING_SMALL_BET"] : ["GENERAL_DECISION_QUALITY"],
    });
    expect(select(73)).toBe(select(73));
    const dueCount = Array.from({ length: 300 }, (_, seed) => select(seed)?.definition.id).filter((id) => id === "review-small-bet").length;
    expect(dueCount).toBeGreaterThan(240);
  });
});
