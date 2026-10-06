import { equityHoldem, evaluateHoldem } from "@poker-apprentice/hand-evaluator";
import { describe, expect, it } from "vitest";
import { card, customSevenCardEvaluator, sevenCardEvaluator, type Card } from "../src/domain";

const cards = (...values: readonly string[]): readonly Card[] => values.map(card);

function packageBackedEvaluation(hand: readonly Card[]) {
  const holeCardCount = Math.max(0, hand.length - 5);
  const result = evaluateHoldem({ holeCards: [...hand.slice(0, holeCardCount)], communityCards: [...hand.slice(holeCardCount)] });
  return customSevenCardEvaluator.evaluate(result.hand as Card[]);
}

describe("Hold'em evaluator adapter", () => {
  const fixtures = [
    ["high-card", cards("As", "Kd", "9c", "7h", "4s", "3d", "2c")],
    ["pair", cards("As", "Ad", "Kc", "Qh", "9s", "3d", "2c")],
    ["two-pair", cards("As", "Ad", "Kc", "Kh", "9s", "3d", "2c")],
    ["trips", cards("As", "Ad", "Ac", "Kh", "9s", "3d", "2c")],
    ["straight", cards("As", "Kd", "Qc", "Jh", "Ts", "3d", "2c")],
    ["flush", cards("As", "Js", "9s", "5s", "2s", "Kd", "Qc")],
    ["full-house", cards("As", "Ad", "Ac", "Kh", "Ks", "3d", "2c")],
    ["quads", cards("As", "Ad", "Ac", "Ah", "Ks", "3d", "2c")],
    ["straight-flush", cards("9s", "8s", "7s", "6s", "5s", "Kd", "Qc")],
  ] as const;

  it.each(fixtures)("agrees across the owned and package-backed evaluator for %s", (category, hand) => {
    const owned = customSevenCardEvaluator.evaluate(hand);
    const dependency = packageBackedEvaluation(hand);
    expect(owned.category).toBe(category);
    expect(dependency).toEqual(owned);
    expect(sevenCardEvaluator.evaluate(hand)).toEqual(dependency);
  });

  it("handles wheel straights and wheel straight flushes", () => {
    const wheel = cards("As", "2d", "3c", "4h", "5s", "Kd", "Qc");
    const wheelFlush = cards("As", "2s", "3s", "4s", "5s", "Kd", "Qc");
    expect(customSevenCardEvaluator.evaluate(wheel).category).toBe("straight");
    expect(packageBackedEvaluation(wheel)).toEqual(customSevenCardEvaluator.evaluate(wheel));
    expect(customSevenCardEvaluator.evaluate(wheelFlush).category).toBe("straight-flush");
    expect(packageBackedEvaluation(wheelFlush)).toEqual(customSevenCardEvaluator.evaluate(wheelFlush));
  });

  it("orders full houses and two-pair kickers correctly and preserves ties", () => {
    const acesFull = cards("As", "Ad", "Ac", "Kh", "Ks", "3d", "2c");
    const kingsFull = cards("Kc", "Kd", "Kh", "As", "Ah", "3d", "2c");
    const queenKicker = cards("As", "Ad", "Kc", "Kh", "Qs", "3d", "2c");
    const jackKicker = cards("Ac", "Ah", "Kd", "Ks", "Jc", "3d", "2c");
    const tiedCopy = cards("Ah", "Ac", "Ks", "Kd", "Qh", "3d", "2c");
    expect(sevenCardEvaluator.evaluate(acesFull).score).toBeGreaterThan(sevenCardEvaluator.evaluate(kingsFull).score);
    expect(sevenCardEvaluator.evaluate(queenKicker).score).toBeGreaterThan(sevenCardEvaluator.evaluate(jackKicker).score);
    expect(sevenCardEvaluator.evaluate(queenKicker).score).toBe(sevenCardEvaluator.evaluate(tiedCopy).score);
  });

  it("rejects duplicate cards before scoring", () => {
    const duplicate = cards("As", "As", "Kd", "Qc", "Jh", "Ts", "9d");
    expect(() => customSevenCardEvaluator.evaluate(duplicate)).toThrow(/Duplicate cards/u);
    expect(() => equityHoldem([[card("As"), card("As")], [card("Kd"), card("Kc")]], [])).toThrow();
  });
});
