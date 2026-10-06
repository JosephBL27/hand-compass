import { evaluateHoldem } from "@poker-apprentice/hand-evaluator";
import { describe, expect, it } from "vitest";
import { createDeck, customSevenCardEvaluator, type Card } from "../src/domain";

const runtime = globalThis as typeof globalThis & { readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> } };
const sampleCount = Number(runtime.process?.env?.["POKER_PARITY_SAMPLES"] ?? 0);

function packageBackedEvaluation(hand: readonly Card[]) {
  const result = evaluateHoldem({ holeCards: [...hand.slice(0, 2)], communityCards: [...hand.slice(2)] });
  return customSevenCardEvaluator.evaluate(result.hand as Card[]);
}

describe.skipIf(sampleCount <= 0)("optional randomized evaluator parity", () => {
  it(`cross-checks ${sampleCount} deterministic seven-card deals`, () => {
    const deck = [...createDeck()];
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let sample = 0; sample < sampleCount; sample += 1) {
      for (let index = 0; index < 7; index += 1) {
        const swap = index + Math.floor(random() * (deck.length - index));
        const value = deck[index];
        const other = deck[swap];
        if (value === undefined || other === undefined) throw new Error("Shuffle invariant failed");
        deck[index] = other;
        deck[swap] = value;
      }
      const hand = deck.slice(0, 7);
      expect(packageBackedEvaluation(hand)).toEqual(customSevenCardEvaluator.evaluate(hand));
    }
  });
});
