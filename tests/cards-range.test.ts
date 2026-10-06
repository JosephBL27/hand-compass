import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  allCombos,
  assertUniqueCards,
  card,
  createDeck,
  projectRangeMatrix,
  removeCards,
  shuffleDeck,
  weightedComboCount,
} from "../src/domain";

describe("cards and ranges", () => {
  it("builds a unique 52-card deck", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck)).toHaveLength(52);
    expect(() => assertUniqueCards([card("As"), card("As")])).toThrow(/Duplicate/u);
  });

  it("preserves uniqueness for arbitrary deterministic shuffles", () => {
    fc.assert(fc.property(fc.integer(), (seed) => {
      let value = seed >>> 0;
      const random = (): number => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 0x1_0000_0000;
      };
      const shuffled = shuffleDeck(random);
      return shuffled.length === 52 && new Set(shuffled).size === 52;
    }));
  });

  it("enumerates exactly 1,326 weighted combinations and applies removal", () => {
    const range = allCombos();
    expect(range.size).toBe(1326);
    expect(weightedComboCount(range)).toBe(1326);
    expect(removeCards(range, [card("As")]).size).toBe(1275);
    expect(removeCards(range, [card("As"), card("Kd")]).size).toBe(1225);
  });

  it("projects all combos into a complete 13×13 matrix", () => {
    const matrix = projectRangeMatrix(allCombos());
    expect(matrix).toHaveLength(169);
    expect(matrix.reduce((sum, cell) => sum + cell.weightedCombos, 0)).toBe(1326);
    expect(matrix.find(({ label }) => label === "AA")?.possibleCombos).toBe(6);
    expect(matrix.find(({ label }) => label === "AKs")?.possibleCombos).toBe(4);
    expect(matrix.find(({ label }) => label === "AKo")?.possibleCombos).toBe(12);
  });
});
