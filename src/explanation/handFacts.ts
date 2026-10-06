import { createDeck, type Card, type Rank, type Suit } from "../domain/cards";
import { customSevenCardEvaluator } from "../domain/evaluator";

const rank = (card: Card): number => "23456789TJQKA".indexOf(card[0]!) + 2;
const suitNames: Readonly<Record<Suit, string>> = { c: "club", d: "diamond", h: "heart", s: "spade" };
const rankNames: Readonly<Record<Rank, string>> = { "2": "deuces", "3": "threes", "4": "fours", "5": "fives", "6": "sixes", "7": "sevens", "8": "eights", "9": "nines", T: "tens", J: "jacks", Q: "queens", K: "kings", A: "aces" };
const windows = Array.from({ length: 10 }, (_, index) => Array.from({ length: 5 }, (_, offset) => index + offset + 1).map((value) => value === 1 ? 14 : value));

export interface HandFacts {
  readonly madeHand: string;
  readonly detail: string;
  readonly drawLabels: readonly string[];
  readonly flushCompletingCards: readonly Card[];
  readonly straightCompletingCards: readonly Card[];
}

/** Pure card facts, not an equity calculation or a strategic label. */
export function describeHandFacts(hole: readonly [Card, Card], board: readonly Card[], dead: readonly Card[] = []): HandFacts {
  if (board.length < 3) {
    const pair = hole[0][0] === hole[1][0];
    return { madeHand: pair ? "pocket pair" : hole[0][1] === hole[1][1] ? "suited unpaired hand" : "offsuit unpaired hand",
      detail: pair ? `pocket ${rankNames[hole[0][0] as Rank]}` : `${hole[0][1] === hole[1][1] ? "suited" : "offsuit"} ${hole.map((card) => card[0]).join("-")}`,
      drawLabels: [], flushCompletingCards: [], straightCompletingCards: [] };
  }
  const cards = [...hole, ...board];
  const evaluation = customSevenCardEvaluator.evaluate(cards);
  let madeHand: string = evaluation.category.replaceAll("-", " ");
  let detail = madeHand;
  if (evaluation.category === "pair") {
    if (hole[0][0] === hole[1][0]) {
      const pocket = rank(hole[0]);
      madeHand = pocket > Math.max(...board.map(rank)) ? "overpair" : pocket < Math.min(...board.map(rank)) ? "underpair" : "pocket pair";
      detail = `${madeHand} (${rankNames[hole[0][0] as Rank]})`;
    } else {
      const matched = hole.find((held) => board.some((card) => card[0] === held[0]));
      if (matched !== undefined) {
        const boardRanks = [...new Set(board.map(rank))].sort((a, b) => b - a);
        const index = boardRanks.indexOf(rank(matched));
        madeHand = index === 0 ? "top pair" : index === boardRanks.length - 1 ? "bottom pair" : "middle pair";
        detail = `${madeHand} (${rankNames[matched[0] as Rank]})`;
      } else { madeHand = "board pair"; detail = "the board's pair with unpaired hole cards"; }
    }
  } else if (evaluation.category === "trips") {
    madeHand = hole[0][0] === hole[1][0] ? "set" : board.some((card) => hole.some((held) => held[0] === card[0])) ? "trips" : "board trips";
    detail = madeHand;
  }
  const blocked = new Set([...cards, ...dead]);
  const unseen = createDeck().filter((card) => !blocked.has(card));
  const drawLabels: string[] = [];
  let flushCompletingCards: readonly Card[] = [];
  let straightCompletingCards: readonly Card[] = [];
  if (board.length < 5) {
    for (const suit of ["c", "d", "h", "s"] as const) {
      const count = cards.filter((card) => card[1] === suit).length;
      if (!hole.some((card) => card[1] === suit)) continue;
      if (count === 4) {
        drawLabels.push(`${suitNames[suit]} flush draw`);
        flushCompletingCards = unseen.filter((card) => card[1] === suit);
      } else if (board.length === 3 && count === 3) drawLabels.push(`backdoor ${suitNames[suit]} flush draw`);
    }
    const values = new Set(cards.map(rank));
    const hasStraight = windows.some((window) => window.every((value) => values.has(value)));
    if (!hasStraight) {
      const missing = new Set<number>();
      for (const window of windows) {
        const absent = window.filter((value) => !values.has(value));
        if (absent.length === 1 && hole.some((held) => window.includes(rank(held)) && !board.some((card) => rank(card) === rank(held)))) missing.add(absent[0]!);
      }
      straightCompletingCards = unseen.filter((card) => missing.has(rank(card)));
      if (missing.size === 1) drawLabels.push("gutshot straight draw");
      if (missing.size >= 2) {
        const openEnded = Array.from({ length: 9 }, (_, i) => i + 2).some((low) => {
          const run = [low, low + 1, low + 2, low + 3];
          return run.every((value) => values.has(value)) && missing.has(low === 2 ? 14 : low - 1) && missing.has(low + 4);
        });
        drawLabels.push(openEnded ? "open-ended straight draw" : "double-gutshot straight draw");
      }
    }
  }
  return { madeHand, detail, drawLabels, flushCompletingCards, straightCompletingCards };
}
