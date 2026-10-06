import { assertUniqueCards, RANKS, type Card } from "./cards";

export interface HandEvaluation {
  readonly score: number;
  readonly category: "high-card" | "pair" | "two-pair" | "trips" | "straight" | "flush" | "full-house" | "quads" | "straight-flush";
}

export interface HandEvaluator {
  evaluate(cards: readonly Card[]): HandEvaluation;
}

const rankValue = new Map(RANKS.map((rank, index) => [rank, index + 2]));
const categoryNames = ["high-card", "pair", "two-pair", "trips", "straight", "flush", "full-house", "quads", "straight-flush"] as const;

function encode(category: number, kickers: readonly number[]): number {
  return kickers.reduce((score, kicker) => score * 15 + kicker, category) * 15 ** (5 - kickers.length);
}

function evaluateFive(cards: readonly Card[]): HandEvaluation {
  if (cards.length !== 5) throw new RangeError("Five cards are required");
  assertUniqueCards(cards);
  const values = cards.map((value) => rankValue.get(value[0] as (typeof RANKS)[number]) ?? 0).sort((a, b) => b - a);
  const suits = cards.map((value) => value[1]);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const unique = [...counts.keys()].sort((a, b) => b - a);
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const high = unique[index];
    const low = unique[index + 4];
    if (high !== undefined && low !== undefined && high - low === 4) {
      straightHigh = high;
      break;
    }
  }
  const flush = new Set(suits).size === 1;
  let category = 0;
  let kickers: readonly number[] = values;
  if (flush && straightHigh > 0) {
    category = 8;
    kickers = [straightHigh];
  } else if (groups[0]?.[1] === 4) {
    category = 7;
    kickers = [groups[0][0], groups[1]?.[0] ?? 0];
  } else if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) {
    category = 6;
    kickers = [groups[0][0], groups[1][0]];
  } else if (flush) {
    category = 5;
  } else if (straightHigh > 0) {
    category = 4;
    kickers = [straightHigh];
  } else if (groups[0]?.[1] === 3) {
    category = 3;
    kickers = [groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  } else if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) {
    category = 2;
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    kickers = [...pairs, groups[2]?.[0] ?? 0];
  } else if (groups[0]?.[1] === 2) {
    category = 1;
    kickers = [groups[0][0], ...groups.slice(1).map(([value]) => value).sort((a, b) => b - a)];
  }
  return { score: encode(category, kickers), category: categoryNames[category] ?? "high-card" };
}

export const customSevenCardEvaluator: HandEvaluator = {
  evaluate(cards) {
    if (cards.length < 5 || cards.length > 7) throw new RangeError("Evaluator accepts five to seven cards");
    assertUniqueCards(cards);
    let best: HandEvaluation | undefined;
    for (let a = 0; a < cards.length - 4; a += 1) {
      for (let b = a + 1; b < cards.length - 3; b += 1) {
        for (let c = b + 1; c < cards.length - 2; c += 1) {
          for (let d = c + 1; d < cards.length - 1; d += 1) {
            for (let e = d + 1; e < cards.length; e += 1) {
              const selected = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              if (selected.some((value) => value === undefined)) throw new Error("Card selection invariant failed");
              const result = evaluateFive(selected as Card[]);
              if (best === undefined || result.score > best.score) best = result;
            }
          }
        }
      }
    }
    if (best === undefined) throw new Error("Evaluation failed");
    return best;
  },
};

// Keep the synchronous rules ledger dependency-free; expensive package-backed
// evaluation/equity lives behind the worker adapter.
export const sevenCardEvaluator = customSevenCardEvaluator;
