import { describe, expect, it } from "vitest";
import { buildCoachingLesson } from "../src/explanation/coachingLesson";
import type { ExplanationInput } from "../src/explanation/types";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { card, type Card } from "../src/domain/cards";
import { createCashConfig } from "../src/domain/config";
import { bb } from "../src/domain/money";
import { applyAction, createHand, getLegalActions, type PokerState } from "../src/domain/rules";
import { seatId } from "../src/domain/seats";
import { decisionMathForState } from "../src/session/query";

function inputFor(state: PokerState): ExplanationInput {
  const legalActions = getLegalActions(state);
  const chosenAction = legalActions.find((action) => action.kind === "call" || action.kind === "check")!;
  return { state, heroSeatId: state.actor!, legalActions, chosenAction,
    strategy: { provenance: "HEURISTIC", actions: [{ action: chosenAction }] }, decisionMath: decisionMathForState(state) };
}

function headsUp(hole: readonly [string, string], board: readonly string[], stack = 100, facingBet = true): PokerState {
  let state = createHand(createCashConfig(4, bb(stack)), {
    holeCards: { [seatId(2)]: hole.map(card) as [Card, Card] }, futureBoard: board.map(card), buttonIndex: 0,
  });
  state = applyAction(state, { kind: "fold" });
  state = applyAction(state, { kind: "raise", to: bb(2.5) });
  state = applyAction(state, { kind: "fold" });
  state = applyAction(state, { kind: "call", amount: bb(1.5) });
  while (state.board.length < board.length) {
    state = applyAction(state, { kind: "check" });
    state = applyAction(state, { kind: "check" });
  }
  if (facingBet) {
    state = applyAction(state, { kind: "check" });
    state = applyAction(state, { kind: "bet", to: bb(1.8) });
  }
  return state;
}

describe("plain-language coaching lessons", () => {
  it("teaches the pair-plus-draw concept before applying it to QsTs", () => {
    const input = inputFor(createAcceptanceSpot().flopDecision);
    const lesson = buildCoachingLesson(input);
    expect(lesson.title).toBe("A pair and a draw give you options");
    expect(lesson.inThisHand).toContain("top pair (queens): your pair matches the highest board card");
    expect(lesson.inThisHand).toContain("One more spade makes a flush");
    expect(lesson.inThisHand).toContain("Calling costs 1.8 BB");
    expect(lesson.watchOut).toContain("not always the winning hand");
    expect(Object.keys(lesson)).toEqual(["title", "principle", "inThisHand", "watchOut"]);
  });

  it("distinguishes a bare draw from a made hand and does not turn draw cards into winning odds", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["As", "Js"], ["Qh", "8s", "4s"])));
    expect(lesson.title).toBe("A draw needs the right price");
    expect(lesson.inThisHand).toContain("no pair, straight, or flush");
    expect(lesson.watchOut).toContain("not guaranteed winners");
    expect(JSON.stringify(lesson)).not.toMatch(/\d+(?:\.\d+)?%/);
  });

  it("explains straight completion without requiring the user to know OESD or gutshot", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["9c", "8d"], ["7h", "6s", "Ac"])));
    expect(lesson.inThisHand).toContain("5 or ten completes a straight, five ranks in a row");
    expect(JSON.stringify(lesson)).not.toMatch(/OESD|gutshot|equity realization/);
  });

  it("defines river bluff-catching conditionally instead of claiming every pair beats only bluffs", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["Qs", "Td"], ["Qh", "8s", "4c", "2h", "Kd"])));
    expect(lesson.title).toBe("A river call needs enough hands you beat");
    expect(lesson.principle).toContain("If you beat only bluffs");
    expect(lesson.principle).toContain("no cards left");
    expect(lesson.watchOut).toContain("not automatically a call");
  });

  it("teaches strong-hand sizing without claiming the largest bet or a solver rationale", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["8c", "8d"], ["Qh", "8s", "4c"], 100, false)));
    expect(lesson.title).toBe("Get paid by hands you can beat");
    expect(lesson.inThisHand).toContain("three of a kind made with your pocket pair");
    expect(lesson.watchOut).toContain("not automatically the best size");
  });

  it("does not mistake a shared river straight for Hero's private value advantage", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["2c", "3d"], ["9h", "Ts", "Jc", "Qh", "Kd"])));
    expect(lesson.title).toBe("A strong board is not your private advantage");
    expect(lesson.watchOut).toContain("does not guarantee a split pot");
  });

  it("adjusts the lesson for the actual number of live opponents", () => {
    let state = createHand(createCashConfig(4, bb(100)), { holeCards: { "seat-2": [card("Qs"), card("Ts")] }, futureBoard: [card("Qh"), card("8s"), card("4s")] });
    state = applyAction(state, { kind: "raise", to: bb(2.5) });
    state = applyAction(state, { kind: "call", amount: bb(2.5) });
    state = applyAction(state, { kind: "fold" });
    state = applyAction(state, { kind: "call", amount: bb(1.5) });
    const lesson = buildCoachingLesson(inputFor(state));
    expect(lesson.title).toBe("More opponents means more hands to beat");
    expect(lesson.inThisHand).toContain("2 opponents remain");
    expect(lesson.watchOut).toContain("one-opponent calling rule cannot decide");
  });

  it("teaches preflop position and actual call price without a universal blind defense rule", () => {
    let state = createHand(createCashConfig(4, bb(100)), { holeCards: { "seat-2": [card("Qs"), card("Ts")] } });
    state = applyAction(state, { kind: "fold" });
    state = applyAction(state, { kind: "raise", to: bb(2.5) });
    state = applyAction(state, { kind: "fold" });
    const lesson = buildCoachingLesson(inputFor(state));
    expect(lesson.inThisHand).toContain("BB:");
    expect(lesson.inThisHand).toContain("Calling costs 1.5 BB");
    expect(lesson.inThisHand).toContain("No other player is waiting");
    expect(lesson.watchOut).toContain("not automatically a good call");
    const early = createHand(createCashConfig(8, bb(100)));
    expect(buildCoachingLesson(inputFor(early)).inThisHand).toContain("7 other players are still waiting");
  });

  it("explains short stack-to-pot depth using real BB amounts, never forced commitment", () => {
    const lesson = buildCoachingLesson(inputFor(headsUp(["Qd", "Tc"], ["Qh", "8s", "4c"], 8)));
    expect(lesson.title).toBe("A short stack leaves less room for later");
    expect(lesson.inThisHand).toContain("3.7 BB");
    expect(lesson.inThisHand).toContain("7.3 BB in the pot");
    expect(lesson.watchOut).toContain("does not force you to call");
  });

  it("separates air and a backdoor possibility from a one-card draw", () => {
    const air = buildCoachingLesson(inputFor(headsUp(["Ah", "Kd"], ["8c", "6s", "2h"], 100, false)));
    expect(air.title).toBe("A bluff needs a reason to get folds");
    expect(air.inThisHand).toContain("do not have a one-card straight or flush draw");
    const backdoor = buildCoachingLesson(inputFor(headsUp(["Ah", "Kh"], ["8c", "6s", "2h"], 100, false)));
    expect(backdoor.inThisHand).toContain("two favorable cards in a row");
  });

  it("withholds hand-specific claims when Hero's cards are unknown", () => {
    const input = inputFor(createAcceptanceSpot().flopDecision);
    const state: PokerState = { ...input.state, players: input.state.players.map((player) => {
      if (player.id !== input.heroSeatId) return player;
      const { holeCards: _hidden, ...publicPlayer } = player;
      return publicPlayer;
    }) };
    const lesson = buildCoachingLesson({ ...input, state });
    expect(lesson.title).toBe("Start with the hand and the price");
    expect(lesson.watchOut).toContain("not an action recommendation");
  });

  it("is deterministic, leaves its input unchanged, and ignores private runouts and solver output", () => {
    const input = inputFor(createAcceptanceSpot().flopDecision);
    const before = JSON.stringify(input);
    const lesson = buildCoachingLesson(input);
    const other = buildCoachingLesson({ ...input,
      strategy: { provenance: "SOLVED", actions: [{ action: input.chosenAction, frequency: 1, evBB: bb(900) }] },
      state: { ...input.state, futureBoard: [card("Ac"), card("Ad")], deck: [],
        players: input.state.players.map((player) => player.id === input.heroSeatId ? player : { ...player, holeCards: [card("As"), card("Ks")] }) } });
    expect(other).toEqual(lesson);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(lesson)).not.toMatch(/GTO says|solver prefers|900|EV loss/);
  });
});
