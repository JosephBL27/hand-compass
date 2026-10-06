import { customSevenCardEvaluator } from "../domain/evaluator";
import { bbToNumber, formatBB } from "../domain/money";
import { positionLabel, seatIndex } from "../domain/seats";
import { describeHandFacts, type HandFacts } from "./handFacts";
import type { ExplanationInput } from "./types";

export interface CoachingLesson {
  readonly title: string;
  readonly principle: string;
  readonly inThisHand: string;
  readonly watchOut: string;
}

const pairHands = new Set(["top pair", "middle pair", "bottom pair", "overpair", "underpair", "pocket pair"]);
const strongHands = new Set(["two pair", "set", "trips", "straight", "flush", "full house", "quads", "straight flush"]);

function plainHand(facts: HandFacts): string {
  switch (facts.madeHand) {
    case "top pair": return `${facts.detail}: your pair matches the highest board card`;
    case "middle pair": return `${facts.detail}: your pair is between the highest and lowest board cards`;
    case "bottom pair": return `${facts.detail}: your pair matches the lowest board card`;
    case "overpair": return `${facts.detail}: your pocket pair is higher than every board card`;
    case "underpair": return `${facts.detail}: your pocket pair is lower than every board card`;
    case "set": return "three of a kind made with your pocket pair";
    case "trips": return "three of a kind made with a pair on the board";
    case "straight": return "a straight, five ranks in a row";
    case "flush": return "a flush, five cards of the same suit";
    case "full house": return "a full house, three of a kind plus a pair";
    case "quads": return "four of a kind";
    case "straight flush": return "a straight flush, five ranks in a row in the same suit";
    case "high card": return "no pair, straight, or flush";
    default: return facts.detail;
  }
}

function drawApplication(facts: HandFacts): string {
  const flush = facts.drawLabels.find((label) => label.endsWith("flush draw") && !label.startsWith("backdoor"));
  const parts: string[] = [];
  if (flush !== undefined) {
    const suit = flush.split(" ")[0]!;
    parts.push(`One more ${suit} makes a flush, five cards of the same suit`);
  }
  if (facts.straightCompletingCards.length > 0) {
    const ranks = [...new Set(facts.straightCompletingCards.map((card) => card[0]!))];
    const names: Readonly<Record<string, string>> = { A: "ace", K: "king", Q: "queen", J: "jack", T: "ten" };
    parts.push(`${ranks.map((rank) => names[rank] ?? rank).join(" or ")} completes a straight, five ranks in a row`);
  }
  return parts.join(". ") + (parts.length > 0 ? "." : "");
}

/**
 * Educational principles plus public, deterministic hand facts. This is not
 * a solver explanation, a grade, an equity estimate, or a recommendation.
 * Keep it labeled as coaching; source action mixes/EV belong in their own UI.
 */
export function buildCoachingLesson(input: ExplanationInput): CoachingLesson {
  const { state, decisionMath } = input;
  const hero = state.players.find((player) => player.id === input.heroSeatId);
  const position = positionLabel(seatIndex(input.heroSeatId), state.buttonIndex, state.config.playerCount);
  const opponents = state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded");
  const facingBet = decisionMath.amountToCallBB > 0;
  const price = facingBet
    ? `Calling costs ${formatBB(decisionMath.amountToCallBB)}.`
    : "Checking costs nothing here.";
  const facts = hero?.holeCards === undefined ? undefined : describeHandFacts(hero.holeCards, state.board, input.deadCards);
  const hand = facts === undefined ? "Your hole cards are not available." : `You have ${plainHand(facts)}.`;

  if (state.street === "preflop") {
    const blind = position === "BB" || position === "SB";
    const pendingOthers = state.pending.filter((id) => id !== input.heroSeatId).length;
    return {
      title: blind ? "Price matters, but position still counts" : "Count the players who can still act",
      principle: blind
        ? "Money already posted in a blind can make calling cheaper. But acting before your opponent after the flop makes the hand harder to play."
        : "Acting later gives you more information. Before entering a pot, consider both your cards and the players who can still call or raise.",
      inThisHand: `${position}: ${hand} ${price} ${pendingOthers === 0 ? "No other player is waiting to act behind this decision." : `${pendingOthers} other player${pendingOthers === 1 ? " is" : "s are"} still waiting to act.`}`,
      watchOut: "A cheap call is not automatically a good call. An opponent who opens only strong hands, another raise, or a short stack can change the decision.",
    };
  }

  if (opponents.length > 1) {
    return {
      title: "More opponents means more hands to beat",
      principle: "A bluff must get past everyone. With several opponents, give extra thought to strong made hands and draws that can make the best possible hand.",
      inThisHand: `${hand} ${opponents.length} opponents remain, not just one. ${price}`,
      watchOut: "This does not mean always fold or never bluff. A strong draw or a very favorable price can still justify continuing; a one-opponent calling rule cannot decide this pot.",
    };
  }

  if (facts === undefined) {
    return {
      title: "Start with the hand and the price",
      principle: "First ask what you already beat, what can improve, and how much continuing costs.",
      inThisHand: `${hand} ${price}`,
      watchOut: "Without your cards, this lesson cannot identify a pair, draw, or reason to bet. It is not an action recommendation.",
    };
  }

  // A strong community-card hand belongs to everyone, not uniquely to Hero.
  const playsBoard = state.board.length === 5 && hero?.holeCards !== undefined
    && customSevenCardEvaluator.evaluate([...hero.holeCards, ...state.board]).score
      === customSevenCardEvaluator.evaluate(state.board).score;
  if (playsBoard) {
    return {
      title: "A strong board is not your private advantage",
      principle: "Everyone can use the five community cards. Check whether your own cards actually improve that hand before treating it as a reason to bet.",
      inThisHand: `Your best five-card hand is already on the board. ${price}`,
      watchOut: "An opponent may improve on the board even when you cannot. Sharing the board does not guarantee a split pot.",
    };
  }

  if (decisionMath.currentSPR !== undefined && decisionMath.currentSPR.value <= 1
    && bbToNumber(decisionMath.effectiveStackBB) > 0) {
    return {
      title: "A short stack leaves less room for later",
      principle: "When the remaining stack is no bigger than the pot, one bet can commit most of the money. Decide how your hand fares against hands willing to play for it all.",
      inThisHand: `${hand} The smaller remaining stack is ${formatBB(decisionMath.effectiveStackBB)}, compared with ${formatBB(decisionMath.potAtDecisionBB)} in the pot. ${price}`,
      watchOut: "A small remaining stack does not force you to call. Weak hands can still fold, and strong-looking pairs can still be behind.",
    };
  }

  const directDraw = facts.flushCompletingCards.length > 0 || facts.straightCompletingCards.length > 0;
  if (pairHands.has(facts.madeHand) && directDraw) {
    return {
      title: "A pair and a draw give you options",
      principle: "You may already have the best hand and can still improve. Calling can keep weaker hands involved; raising builds a bigger pot but may leave you against stronger hands.",
      inThisHand: `${hand} ${drawApplication(facts)} ${price}`,
      watchOut: "A completed draw is not always the winning hand. The bet size and the opponent's possible hands still determine whether calling or raising makes sense.",
    };
  }

  if (directDraw && !strongHands.has(facts.madeHand)) {
    return {
      title: facingBet ? "A draw needs the right price" : "Improvement gives a bluff a second chance",
      principle: facingBet
        ? "Do not call just because you can improve. Compare the cost with your chance of winning, and remember that another bet may come before you see the final card."
        : "A bet can win through folds now or improvement later. That makes a draw worth considering for a bluff, but it does not make betting automatic.",
      inThisHand: `${hand} ${drawApplication(facts)} ${price}`,
      watchOut: "Cards that complete a draw are not guaranteed winners. Do not treat the chance of improving as your chance of winning, or assume you will see both remaining cards for one call.",
    };
  }

  if (state.street === "river" && facingBet && !strongHands.has(facts.madeHand)) {
    return {
      title: "A river call needs enough hands you beat",
      principle: "There are no cards left to improve your hand. If you beat only bluffs, you are bluff-catching: paying to find out whether this bet is one of them.",
      inThisHand: `${hand} ${price} Ask which worse hands would actually make this bet, not just which worse hands are possible.`,
      watchOut: "A pair is not automatically a call, and a large bet is not automatically a bluff. The price matters, but so does how often this opponent reaches the river with a worse betting hand.",
    };
  }

  if (strongHands.has(facts.madeHand) || facts.madeHand === "overpair") {
    return {
      title: "Get paid by hands you can beat",
      principle: "A strong hand earns money when a worse hand continues. Before choosing a size, ask what can call it and whether a bigger bet would drive those hands away.",
      inThisHand: `${hand} ${facingBet ? `${price} Raising would ask the opponent to put in more with a narrower selection of hands.` : "You can consider betting to get called by worse hands, or checking to keep those hands involved."}`,
      watchOut: "Strong is not the same as unbeatable. The board and earlier actions may leave an opponent with better hands; the largest legal bet is not automatically the best size.",
    };
  }

  if (pairHands.has(facts.madeHand) || facts.madeHand === "board pair" || facts.madeHand === "board trips") {
    return {
      title: "Having a pair is different from wanting a big pot",
      principle: "A hand can beat some opponents without wanting more money in the pot. Ask whether betting gets called by worse, or mainly makes worse hands fold.",
      inThisHand: `${hand} ${price} Think about the hands that would continue, not just the strength of your hand's name.`,
      watchOut: "Checking does not always preserve value, and calling is not always safe. Some bets protect against improving hands; some opponents mainly bet hands that beat you.",
    };
  }

  return {
    title: "A bluff needs a reason to get folds",
    principle: "A weak hand is not, by itself, a reason to bluff. Ask which better hands can fold and whether your bet fits the story told by the earlier actions.",
    inThisHand: `${hand} ${facts.drawLabels.some((label) => label.startsWith("backdoor")) ? "Your flush possibility needs two favorable cards in a row, not just one." : state.street === "river" ? "There are no cards left to improve." : "You do not have a one-card straight or flush draw."} ${price}`,
    watchOut: "Holding a card an opponent might need can remove some of their strong hands, but it can also remove hands that would fold. That alone does not prove a bluff is profitable.",
  };
}
