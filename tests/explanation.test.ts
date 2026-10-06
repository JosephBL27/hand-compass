import { describe, expect, it } from "vitest";
import { buildExplanation } from "../src/explanation";
import { card } from "../src/domain/cards";
import { createCashConfig } from "../src/domain/config";
import { bb } from "../src/domain/money";
import { createRange } from "../src/domain/ranges";
import { applyAction, createHand, getLegalActions, type PokerState } from "../src/domain/rules";
import { seatId } from "../src/domain/seats";
import type { StrategyResult } from "../src/domain/strategy";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { decisionMathForState } from "../src/session/query";

function heuristicFor(actions: StrategyResult["actions"]): StrategyResult {
  return {
    provenance: "HEURISTIC",
    actions,
    notes: ["Educational fallback; no solved node is loaded."],
  };
}

function act(state: PokerState, action: Parameters<typeof applyAction>[1]): PokerState {
  return applyAction(state, action);
}

function riverFacingPotBet(): PokerState {
  let state = createHand(createCashConfig(4, bb(100)), {
    buttonIndex: 0,
    holeCards: { [seatId(2)]: [card("Ac"), card("Kd")] },
    futureBoard: [card("2c"), card("7d"), card("9h"), card("Js"), card("Qc")],
  });
  // CO folds, BTN opens, SB folds, BB calls.
  state = act(state, { kind: "fold" });
  state = act(state, { kind: "raise", to: bb(2.5) });
  state = act(state, { kind: "fold" });
  state = act(state, { kind: "call", amount: bb(1.5) });
  // Check through flop and turn; BB checks river and BTN bets one pot.
  state = act(state, { kind: "check" });
  state = act(state, { kind: "check" });
  state = act(state, { kind: "check" });
  state = act(state, { kind: "check" });
  state = act(state, { kind: "check" });
  state = act(state, { kind: "bet", to: bb(5.5) });
  return state;
}

describe("structured explanation engine", () => {
  it("derives the acceptance spot and enumerates J/9 gutshot cards without reading the fixed runout", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("Acceptance call missing");
    const model = buildExplanation({
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      legalActions: spot.legalActions,
      chosenAction: call,
      strategy: heuristicFor([{ action: call }]),
      decisionMath: decisionMathForState(spot.flopDecision),
    });

    expect(model.futureStreet.unseenCardCount).toBe(47);
    expect([...model.futureStreet.byTag.ADDS_GUTSHOT].sort()).toEqual(
      ["9c", "9d", "9h", "9s", "Jc", "Jd", "Jh", "Js"].sort(),
    );
    expect(model.futureStreet.byTag.COMPLETES_HERO_FLUSH).toHaveLength(9);
    expect(model.futureStreet.cards.find(({ card: candidate }) => candidate === "2c")).toBeDefined();
    expect(model.futureStreet.statements.some(({ text }) => text.includes("not source frequencies"))).toBe(true);

    const potOdds = model.exactMath.find(({ id }) => id === "POT_ODDS");
    const alpha = model.exactMath.find(({ id }) => id === "BLUFF_BREAK_EVEN");
    const mdf = model.exactMath.find(({ id }) => id === "HEADS_UP_MDF");
    expect(potOdds?.value.value).toBeCloseTo(1.8 / 9.1, 10);
    expect(alpha?.value.value).toBeCloseTo(1.8 / 7.3, 10);
    expect(mdf?.value.value).toBeCloseTo(5.5 / 7.3, 10);
    expect(model.sizingRationale.applies).toBe(false);
    expect(model.actionRationale.statements.some(({ text }) => text.includes("not proof"))).toBe(true);
  });

  it("enumerates exact weighted blocker removal when a public opponent range is supplied", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("Acceptance call missing");
    const opponentRange = createRange([
      { cards: [card("Qs"), card("As")], weight: 1 },
      { cards: [card("Ts"), card("9s")], weight: 0.5 },
      { cards: [card("Qh"), card("Jh")], weight: 0.25 },
      { cards: [card("Ac"), card("Kc")], weight: 1 },
    ]);
    const model = buildExplanation({
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      legalActions: spot.legalActions,
      chosenAction: call,
      strategy: heuristicFor([{ action: call }]),
      decisionMath: decisionMathForState(spot.flopDecision),
      publicRanges: { [seatId(7)]: opponentRange },
    });

    expect(model.blockers.provenance).toBe("EXACT_MATH");
    expect(model.blockers.opponentRangeCoverage).toBe("COMPLETE");
    expect(model.blockers.blockedCombos).toHaveLength(3);
    expect(model.blockers.heroCards.find(({ card: heroCard }) => heroCard === "Qs")).toMatchObject({
      blockedComboCount: 1,
      blockedWeightedMass: 1,
      sameRankBoardCards: ["Qh"],
    });
    expect(model.blockers.heroCards.find(({ card: heroCard }) => heroCard === "Ts")).toMatchObject({
      blockedComboCount: 1,
      blockedWeightedMass: 0.5,
    });
    expect(model.blockers.rangeRemoval[0]).toMatchObject({
      removedByHeroComboCount: 2,
      removedByHeroWeightedMass: 1.5,
      removedByBoardComboCount: 1,
      removedByBoardWeightedMass: 0.25,
      removedByAnyKnownCardComboCount: 3,
    });
    expect(model.blockers.strategicNetEffect).toEqual([
      expect.objectContaining({ provenance: "UNAVAILABLE" }),
    ]);
  });

  it("states the narrower card-removal fact and withholds strategic effect without ranges", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("Acceptance call missing");
    const model = buildExplanation({
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      legalActions: spot.legalActions,
      chosenAction: call,
      strategy: heuristicFor([{ action: call }]),
      decisionMath: decisionMathForState(spot.flopDecision),
    });

    expect(model.blockers.provenance).toBe("UNAVAILABLE");
    expect(model.blockers.blockedCombos).toEqual([]);
    expect(model.blockers.heroCards[0]?.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({ provenance: "EXACT_MATH", text: expect.stringContaining("unavailable to every opponent") }),
      expect.objectContaining({ provenance: "UNAVAILABLE", text: expect.stringContaining("cannot be enumerated") }),
    ]));
    expect(model.blockers.strategicNetEffect[0]?.text).toContain("requires a compatible conditional strategy");
  });

  it("shows polarized river equations only in a heads-up river first-bet context", () => {
    const state = riverFacingPotBet();
    const legalActions = getLegalActions(state, [bb(11)]);
    const call = legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("River call missing");
    const model = buildExplanation({
      state,
      heroSeatId: seatId(2),
      legalActions,
      chosenAction: call,
      strategy: heuristicFor([{ action: call }]),
      decisionMath: decisionMathForState(state),
    });
    const values = new Map(model.exactMath.map((panel) => [panel.id, panel.value.value]));
    expect(values.get("BLUFF_BREAK_EVEN")).toBeCloseTo(0.5, 10);
    expect(values.get("HEADS_UP_MDF")).toBeCloseTo(0.5, 10);
    expect(values.get("RIVER_POLARIZED_BLUFF_FRACTION")).toBeCloseTo(1 / 3, 10);
    expect(values.get("RIVER_BLUFF_TO_VALUE")).toBeCloseTo(1 / 2, 10);
    expect(model.futureStreet).toMatchObject({ provenance: "UNAVAILABLE", cardsToCome: 0, unseenCardCount: 0 });
  });

  it("adds multiway caveats and never emits a heads-up MDF for a multiway decision", () => {
    const state = createHand(createCashConfig(4, bb(100)), {
      buttonIndex: 0,
      holeCards: { [seatId(3)]: [card("Ah"), card("Kh")] },
    });
    const legalActions = getLegalActions(state);
    const call = legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("Multiway preflop call missing");
    const model = buildExplanation({
      state,
      heroSeatId: seatId(3),
      legalActions,
      chosenAction: call,
      strategy: heuristicFor([{ action: call }]),
      decisionMath: decisionMathForState(state),
    });

    expect(model.multiway).toMatchObject({ applies: true, liveOpponentCount: 3 });
    expect(model.multiway.statements.some(({ text }) => text.includes("intentionally withheld"))).toBe(true);
    expect(model.exactMath.some(({ id }) => id === "HEADS_UP_MDF")).toBe(false);
    expect(model.futureStreet.provenance).toBe("UNAVAILABLE");
  });

  it("does not infer EV loss from a frequency-only solved result", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find((action) => action.kind === "call");
    if (call === undefined) throw new Error("Acceptance call missing");
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: spot.legalActions.map((action, index) => ({ action, frequency: index === 1 ? 0.8 : 0.04 })),
      sourceNodeId: "frequency-only-node",
    };
    const model = buildExplanation({
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      legalActions: spot.legalActions,
      chosenAction: call,
      strategy,
      decisionMath: decisionMathForState(spot.flopDecision),
    });

    expect(model.verdict.frequencyCoverage).toBe("COMPLETE");
    expect(model.verdict.evCoverage).toBe("UNAVAILABLE");
    expect(model.verdict.referenceAction?.action).toEqual(call);
    expect(model.verdict.evLossBB).toBeUndefined();
    expect(model.alternatives.every(({ statements }) => statements.some(({ provenance, text }) => provenance === "UNAVAILABLE" && text.includes("No comparable source EV")))).toBe(true);
  });

  it("uses the roll-selected equilibrium action in the verdict instead of the highest-frequency action", () => {
    const spot = createAcceptanceSpot();
    const fold = spot.legalActions.find((action) => action.kind === "fold");
    const jam = spot.legalActions.find((action) => action.kind === "jam");
    if (fold === undefined || jam === undefined) throw new Error("Acceptance fold or jam missing");
    const strategy: StrategyResult = {
      provenance: "SOLVED",
      actions: spot.legalActions.map((action) => ({
        action,
        frequency: action.kind === "fold" ? 0.7 : action.kind === "jam" ? 0.3 : 0,
      })),
      sourceNodeId: "rng-reference-node",
    };
    const model = buildExplanation({
      state: spot.flopDecision,
      heroSeatId: seatId(2),
      legalActions: spot.legalActions,
      chosenAction: jam,
      strategy,
      decisionMath: decisionMathForState(spot.flopDecision),
      referenceSelection: { rngMode: "high", roll: 100 },
    });

    expect(model.verdict.referenceAction?.action).toEqual(jam);
    expect(model.verdict.referenceAction?.action).not.toEqual(fold);
    expect(model.verdict.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provenance: "SOLVED",
        text: expect.stringMatching(/High RNG roll 100 selects jam.*bucket 71\u2013100.*passive at 1 to aggressive at 100/iu),
      }),
    ]));
    expect(model.verdict.statements.some(({ text }) => text.includes("highest-frequency action"))).toBe(false);
  });
});
