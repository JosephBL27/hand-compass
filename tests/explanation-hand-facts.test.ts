import { describe, expect, it } from "vitest";
import { describeHandFacts } from "../src/explanation/handFacts";
import { buildExplanation } from "../src/explanation";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { decisionMathForState } from "../src/session/query";
import { createRange } from "../src/domain/ranges";
import { card } from "../src/domain/cards";
import type { StrategyResult } from "../src/domain/strategy";
import { parseStrategyPack } from "../src/domain/strategyPack";
import pack from "../src/solutions/acceptance-qsts-solved.pack.json";

describe("state-specific explanation facts", () => {
  it("recognizes top pair with nine flush-completing cards without calling them winning outs", () => {
    const facts = describeHandFacts([card("Qs"), card("Ts")], [card("Qh"), card("8s"), card("4s")]);
    expect(facts.madeHand).toBe("top pair");
    expect(facts.drawLabels).toContain("spade flush draw");
    expect(facts.flushCompletingCards).toHaveLength(9);
    expect(facts.straightCompletingCards).toHaveLength(0);
    expect(describeHandFacts([card("Qs"), card("Ts")], [card("Qh"), card("8s"), card("4s")], [card("As")]).flushCompletingCards).toHaveLength(8);
  });

  it("distinguishes an open-ended draw from a double gutshot", () => {
    const open = describeHandFacts([card("9c"), card("8d")], [card("7h"), card("6s"), card("Ac")]);
    expect(open.drawLabels).toContain("open-ended straight draw");
    expect(open.straightCompletingCards).toHaveLength(8);
    const double = describeHandFacts([card("Js"), card("9s")], [card("Kc"), card("Td"), card("7h")]);
    expect(double.drawLabels).toContain("double-gutshot straight draw");
    expect(double.straightCompletingCards).toHaveLength(8);
  });

  it("does not invent future draws after the river or a flush draw when a flush is already made", () => {
    const made = describeHandFacts([card("As"), card("Ks")], [card("Qs"), card("8s"), card("4s")]);
    expect(made.madeHand).toBe("flush");
    expect(made.flushCompletingCards).toHaveLength(0);
    const river = describeHandFacts([card("Qs"), card("Ts")], [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")]);
    expect(river.drawLabels).toEqual([]);
    expect(river.flushCompletingCards).toEqual([]);
  });

  it("explains removed hand regions using board-compatible supplied combinations", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find(({ kind }) => kind === "call")!;
    const model = buildExplanation({ state: spot.flopDecision, heroSeatId: "seat-2", legalActions: spot.legalActions,
      chosenAction: call, strategy: { provenance: "HEURISTIC", actions: [{ action: call }] },
      decisionMath: decisionMathForState(spot.flopDecision),
      publicRanges: { "seat-7": createRange([
        { cards: [card("Qs"), card("As")], weight: 1 },
        { cards: [card("Ts"), card("9s")], weight: 0.5 },
        { cards: [card("Qh"), card("Qs")], weight: 1 },
      ]) } });
    const queen = model.blockers.heroCards.find(({ card }) => card === "Qs")!;
    const groups = queen.statements.find(({ text }) => text.includes("Among combinations"))!;
    expect(groups.provenance).toBe("EXACT_MATH");
    expect(groups.text).toContain("1 top pair combo(s)");
    expect(groups.text).toContain("1 spade flush draw combo(s)");
    expect(groups.text).not.toContain("set combo"); // QhQs was already blocked by the board.
    expect(model.actionRationale.statements.map(({ text }) => text).join(" ")).toContain("not guaranteed winning outs");
    expect(model.ruleOfThumb.rule).toContain("pair plus a flush draw");
    expect(model.actionRationale.statements.map(({ text }) => text).join(" ")).not.toContain("highest action EV");
  });

  it("describes the actual closest-EV option from the native source rather than inferring regret from frequency", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find(({ kind }) => kind === "call")!;
    const row = parseStrategyPack(pack).nodes[0]!.comboPolicy.find(({ cards }) => cards.includes(card("Qs")) && cards.includes(card("Ts")))!;
    const strategy: StrategyResult = { provenance: "SOLVED", actions: row.actions };
    const model = buildExplanation({ state: spot.flopDecision, heroSeatId: "seat-2", legalActions: spot.legalActions,
      chosenAction: call, strategy, decisionMath: decisionMathForState(spot.flopDecision) });
    const source = model.actionRationale.statements.find(({ text }) => text.includes("highest action EV"))!;
    expect(source.provenance).toBe("SOLVED");
    expect(source.text).toContain("call 1.8 BB at 7.0386 BB");
    expect(source.text).toContain("raise to 9 BB, 0.01 BB lower");
    expect(source.text).toContain("0.14% of the decision pot");
  });
});
