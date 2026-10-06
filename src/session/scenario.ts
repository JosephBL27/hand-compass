import { actionKey } from "../domain/actions";
import { assertUniqueCards, type Card } from "../domain/cards";
import { PokerRulesEngine, type PokerState } from "../domain/rules";
import { seatIndex } from "../domain/seats";
import { ReplayRng } from "./rng";
import { sampleJointHoleCards, shuffledAvailableDeck } from "./sampling";
import type { FullHandInput, MutableSeatRangeMap, NodeScenarioDefinition, SessionBlock } from "./types";

export class ScenarioValidationError extends Error {
  override readonly name = "ScenarioValidationError";
}

export interface PreparedScenario {
  readonly available: true;
  readonly state: PokerState;
  readonly ranges: MutableSeatRangeMap;
}

export interface BlockedScenario {
  readonly available: false;
  readonly block: SessionBlock;
}

export type ScenarioPreparation = PreparedScenario | BlockedScenario;

function prepareInitialState(input: FullHandInput, rng: ReplayRng): ScenarioPreparation {
  if (seatIndex(input.heroSeatId) >= input.config.playerCount) throw new ScenarioValidationError("Hero seat is outside the configured table");
  const deadCards = [...(input.deadCards ?? [])];
  const futureBoard = [...(input.futureBoard ?? [])];
  if (futureBoard.length > 5) throw new ScenarioValidationError("Future board cannot contain more than five cards");
  try {
    assertUniqueCards([...deadCards, ...futureBoard]);
  } catch (error) {
    throw new ScenarioValidationError(error instanceof Error ? error.message : String(error));
  }
  const assignment = sampleJointHoleCards({
    playerCount: input.config.playerCount,
    ranges: input.ranges,
    ...(input.fixedHoleCards === undefined ? {} : { fixedHoleCards: input.fixedHoleCards }),
    reservedCards: [...deadCards, ...futureBoard],
    ...(input.maxAssignmentAttempts === undefined ? {} : { maxAttempts: input.maxAssignmentAttempts }),
    rng,
  });
  if (!assignment.available) {
    return { available: false, block: { code: "IMPOSSIBLE_HOLE_ASSIGNMENT", reason: assignment.reason } };
  }
  const allHoleCards = Object.values(assignment.holeCards).flatMap((cards) => [...cards]);
  const deck = shuffledAvailableDeck(rng, [...deadCards, ...futureBoard, ...allHoleCards]);
  const engine = new PokerRulesEngine();
  const state = engine.create(input.config, {
    buttonIndex: input.buttonIndex,
    holeCards: assignment.holeCards,
    futureBoard,
    deck,
  });
  return { available: true, state, ranges: { ...input.ranges } };
}

export function prepareFullHand(input: FullHandInput, rng: ReplayRng): ScenarioPreparation {
  return prepareInitialState(input, rng);
}

function assertExpectedState(state: PokerState, definition: NodeScenarioDefinition): void {
  const expected = definition.expected;
  const issues: string[] = [];
  if (state.actor !== expected.actor) issues.push(`actor expected ${String(expected.actor)}, received ${String(state.actor)}`);
  if (state.street !== expected.street) issues.push(`street expected ${expected.street}, received ${state.street}`);
  if (state.potBB !== expected.potBB) issues.push(`pot expected ${expected.potBB}, received ${state.potBB}`);
  if (state.currentBetBB !== expected.currentBetBB) issues.push(`current bet expected ${expected.currentBetBB}, received ${state.currentBetBB}`);
  if (state.board.length !== expected.board.length || state.board.some((value, index) => value !== expected.board[index])) {
    issues.push(`board expected ${expected.board.join(" ")}, received ${state.board.join(" ")}`);
  }
  if (issues.length > 0) throw new ScenarioValidationError(`Scenario ${definition.id} reconstruction mismatch: ${issues.join("; ")}`);
}

export function reconstructNode(definition: NodeScenarioDefinition, rng: ReplayRng): ScenarioPreparation {
  const prepared = prepareInitialState(definition, rng);
  if (!prepared.available) return prepared;
  const engine = new PokerRulesEngine();
  let state = prepared.state;
  for (let index = 0; index < definition.replay.length; index += 1) {
    const action = definition.replay[index];
    if (action === undefined) throw new Error("Replay action invariant failed");
    const issued = engine.legalActions(state, "to" in action ? [action.to] : []);
    if (!issued.some((candidate) => actionKey(candidate) === actionKey(action))) {
      throw new ScenarioValidationError(`Scenario ${definition.id} replay action ${index} (${actionKey(action)}) is not legal in the reconstructed state`);
    }
    try {
      state = engine.dispatch(state, action);
    } catch (error) {
      throw new ScenarioValidationError(`Scenario ${definition.id} replay action ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assertExpectedState(state, definition);
  return { ...prepared, state };
}

export function publicCardsForScenario(definition: NodeScenarioDefinition): readonly Card[] {
  return [...definition.expected.board, ...(definition.deadCards ?? [])];
}
