import { sevenCardEvaluator } from "../domain/evaluator";
import { deterministicHash } from "../domain/hash";
import { RANKS, type Card, type Rank } from "../domain/cards";
import { positionLabel, seatIndex, type SeatId } from "../domain/seats";
import { ReplayRng } from "./rng";
import { reconstructNode, ScenarioValidationError } from "./scenario";
import type { NodeScenarioDefinition, ScenarioCatalogMatch, ScenarioFacts, ScenarioFilter, StackFilter } from "./types";

const rankValue = new Map<Rank, number>(RANKS.map((rank, index) => [rank, index + 2]));

function boardTextures(board: readonly Card[]): readonly string[] {
  if (board.length === 0) return [];
  const textures = new Set<string>();
  const values = board.map((value) => rankValue.get(value[0] as Rank) ?? 0);
  const highest = Math.max(...values);
  if (highest === 14) textures.add("ace-high");
  else if (highest === 13) textures.add("king-high");
  else if (highest === 12) textures.add("queen-high");
  if (highest >= 12) textures.add("high-card-board");
  if (highest <= 9) textures.add("low-board");
  if (values.filter((value) => value >= 10).length >= 2) textures.add("Broadway-heavy");
  const rankCounts = new Map<number, number>();
  for (const value of values) rankCounts.set(value, (rankCounts.get(value) ?? 0) + 1);
  const pairedRanks = [...rankCounts.values()].filter((count) => count >= 2).length;
  if (pairedRanks >= 2) textures.add("double-paired");
  else if (pairedRanks === 1) textures.add("paired");
  const suitCounts = new Map<string, number>();
  for (const value of board) suitCounts.set(value[1] ?? "", (suitCounts.get(value[1] ?? "") ?? 0) + 1);
  const maximumSuit = Math.max(...suitCounts.values());
  if (maximumSuit === board.length && board.length >= 3) textures.add("monotone");
  else if (maximumSuit >= 2) textures.add("two-tone");
  else textures.add("rainbow");
  const unique = [...new Set(values)].sort((left, right) => left - right);
  const maximumGap = unique.length < 2 ? Number.POSITIVE_INFINITY : Math.max(...unique.slice(1).map((value, index) => value - (unique[index] ?? value)));
  if (maximumGap <= 2) textures.add("connected");
  else textures.add("disconnected");
  if (board.length >= 3) {
    if ((maximumSuit >= 2 || maximumGap <= 2) && pairedRanks === 0) textures.add("dynamic");
    else textures.add("static");
  }
  if (board.length >= 4) {
    const prior = board.slice(0, 3);
    const turn = board[3]!;
    const turnRank = rankValue.get(turn[0] as Rank) ?? 0;
    const priorValues = prior.map((value) => rankValue.get(value[0] as Rank) ?? 0);
    const priorRanks = new Set(prior.map((value) => value[0]));
    const priorSuitCount = prior.filter((value) => value[1] === turn[1]).length;
    if (priorRanks.has(turn[0])) textures.add("paired-turn");
    if (priorSuitCount === 2) textures.add("flush-completing-turn");
    if (turnRank > Math.max(...priorValues)) textures.add("overcard");
    if (turnRank < Math.min(...priorValues)) textures.add("undercard");
    const priorSet = new Set(priorValues);
    const turnSet = new Set([...priorValues, turnRank]);
    if (priorSet.has(14)) priorSet.add(1);
    if (turnSet.has(14)) turnSet.add(1);
    const createsFourCardWindow = Array.from({ length: 10 }, (_, index) => index + 1).some((low) => {
      const window = Array.from({ length: 5 }, (_, offset) => low + offset);
      return window.filter((value) => turnSet.has(value)).length >= 4
        && window.filter((value) => priorSet.has(value)).length < 4;
    });
    if (createsFourCardWindow) textures.add("straight-completing-turn");
    if (!["paired-turn", "flush-completing-turn", "straight-completing-turn", "overcard"].some((tag) => textures.has(tag))) textures.add("blank");
  }
  return [...textures].sort();
}

function heroHandClass(holeCards: readonly [Card, Card], board: readonly Card[]): string | undefined {
  if (board.length < 3) return undefined;
  const evaluation = sevenCardEvaluator.evaluate([...holeCards, ...board]);
  if (evaluation.category === "high-card") return holeCards.some((value) => value[0] === "A") ? "ace-high" : "air";
  if (evaluation.category === "pair") {
    const holeRanks = holeCards.map((value) => rankValue.get(value[0] as Rank) ?? 0);
    const boardRanks = board.map((value) => rankValue.get(value[0] as Rank) ?? 0);
    if (holeRanks[0] === holeRanks[1]) {
      if ((holeRanks[0] ?? 0) > Math.max(...boardRanks)) return "overpair";
      if ((holeRanks[0] ?? 0) < Math.min(...boardRanks)) return "underpair";
    }
    const pairedHoleRank = holeRanks.find((value) => boardRanks.includes(value));
    if (pairedHoleRank !== undefined) {
      const distinctBoard = [...new Set(boardRanks)].sort((left, right) => right - left);
      if (pairedHoleRank === distinctBoard[0]) return "top-pair";
      if (pairedHoleRank === distinctBoard[1]) return "middle-pair";
    }
    return "pair";
  }
  if (evaluation.category === "trips") {
    return holeCards[0][0] === holeCards[1][0] && board.some((value) => value[0] === holeCards[0][0]) ? "set" : "trips";
  }
  return evaluation.category;
}

function hasMadeStraight(cards: readonly Card[]): boolean {
  const values = new Set(cards.map((value) => rankValue.get(value[0] as Rank) ?? 0));
  if (values.has(14)) values.add(1);
  return Array.from({ length: 10 }, (_, index) => index + 1)
    .some((low) => Array.from({ length: 5 }, (_, offset) => low + offset).every((value) => values.has(value)));
}

function straightDrawClass(cards: readonly Card[]): "OESD" | "gutshot" | undefined {
  if (hasMadeStraight(cards)) return undefined;
  const values = new Set(cards.map((value) => rankValue.get(value[0] as Rank) ?? 0));
  if (values.has(14)) values.add(1);
  const completionRanks = new Set<number>();
  for (let low = 1; low <= 10; low += 1) {
    const window = Array.from({ length: 5 }, (_, offset) => low + offset);
    const missing = window.filter((value) => !values.has(value));
    if (missing.length === 1) completionRanks.add(missing[0] === 1 ? 14 : missing[0]!);
  }
  // Two different inside completions are a double gutshot, not necessarily an
  // open-ended draw. OESD specifically requires a run with both ends available.
  const openEnded = Array.from({ length: 9 }, (_, index) => index + 2).some((low) =>
    Array.from({ length: 4 }, (_, offset) => low + offset).every((value) => values.has(value)));
  if (completionRanks.size >= 2 && openEnded) return "OESD";
  if (completionRanks.size >= 2) return "gutshot";
  if (completionRanks.size === 1) return "gutshot";
  return undefined;
}

function drawClasses(holeCards: readonly [Card, Card], board: readonly Card[]): readonly string[] {
  if (board.length < 3 || board.length >= 5) return [];
  const draws = new Set<string>();
  const cards = [...holeCards, ...board];
  for (const suit of ["c", "d", "h", "s"] as const) {
    const suited = cards.filter((value) => value[1] === suit);
    if (suited.length === 4 && holeCards.some((value) => value[1] === suit)) {
      draws.add("flush-draw");
      const highestAvailable = [...RANKS].reverse().find((rank) => !board.includes(`${rank}${suit}` as Card));
      if (highestAvailable !== undefined && holeCards.some((value) => value === `${highestAvailable}${suit}`)) draws.add("nut-flush-draw");
    } else if (board.length === 3 && suited.length === 3 && holeCards.some((value) => value[1] === suit)) {
      draws.add("backdoor-flush");
    }
  }
  const straight = straightDrawClass(cards);
  if (straight !== undefined) draws.add(straight);
  if (straight === undefined && board.length === 3 && !hasMadeStraight(cards)) {
    const values = new Set(cards.map((value) => rankValue.get(value[0] as Rank) ?? 0));
    if (values.has(14)) values.add(1);
    const backdoorStraight = Array.from({ length: 10 }, (_, index) => index + 1).some((low) => {
      const window = Array.from({ length: 5 }, (_, offset) => low + offset);
      return window.filter((value) => !values.has(value)).length === 2;
    });
    if (backdoorStraight) draws.add("backdoor-straight");
  }
  if ((draws.has("flush-draw") || draws.has("nut-flush-draw")) && (draws.has("OESD") || draws.has("gutshot"))) draws.add("combo-draw");
  if (draws.size === 0) draws.add("no-draw");
  return [...draws].sort();
}

function stackFacts(definition: NodeScenarioDefinition): StackFilter {
  const stacks = definition.config.startingStacksBB;
  const values = Array.from({ length: definition.config.playerCount }, (_, index) => stacks[`seat-${index}` as SeatId]);
  const first = values[0];
  if (first !== undefined && values.every((value) => value === first)) return { mode: "fixed", stackBB: first };
  return { mode: "per-player", stacksBB: stacks };
}

function factsFor(definition: NodeScenarioDefinition): ScenarioFacts {
  const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
  if (!prepared.available) throw new ScenarioValidationError(`Scenario ${definition.id} cannot enter the catalog: ${prepared.block.reason}`);
  const state = prepared.state;
  const hero = state.players.find((player) => player.id === definition.heroSeatId);
  if (hero?.holeCards === undefined) throw new ScenarioValidationError(`Scenario ${definition.id} has no internally assigned Hero cards`);
  const playersInPot = state.players.filter(({ status }) => status !== "folded");
  const classifiedHand = heroHandClass(hero.holeCards, state.board);
  return {
    id: definition.id,
    tableSize: definition.config.playerCount,
    heroPosition: positionLabel(seatIndex(definition.heroSeatId), state.buttonIndex, state.config.playerCount),
    opponentPositions: playersInPot
      .filter(({ id }) => id !== definition.heroSeatId)
      .map(({ id }) => positionLabel(seatIndex(id), state.buttonIndex, state.config.playerCount)),
    stack: stackFacts(definition),
    street: state.street,
    playersCurrentlyInPot: playersInPot.length,
    preflopLine: definition.sourceTags.preflopLine,
    potType: definition.sourceTags.potType,
    board: state.board,
    boardTextures: boardTextures(state.board),
    ...(classifiedHand === undefined ? {} : { heroHandClass: classifiedHand }),
    drawClasses: drawClasses(hero.holeCards, state.board),
    strategicClasses: [...(definition.sourceTags.strategicClasses ?? [])],
  };
}

function sameCards(left: readonly Card[], right: readonly Card[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matches(match: ScenarioCatalogMatch, filter: ScenarioFilter): boolean {
  const facts = match.facts;
  if (filter.scenarioId !== undefined && facts.id !== filter.scenarioId) return false;
  if (filter.tableSize !== undefined && facts.tableSize !== filter.tableSize) return false;
  if (filter.heroPosition !== undefined && facts.heroPosition !== filter.heroPosition) return false;
  if (filter.opponentPosition !== undefined && !facts.opponentPositions.includes(filter.opponentPosition)) return false;
  if (filter.stack !== undefined && deterministicHash(facts.stack) !== deterministicHash(filter.stack)) return false;
  if (filter.street !== undefined && facts.street !== filter.street) return false;
  if (filter.playersCurrentlyInPot !== undefined && facts.playersCurrentlyInPot !== filter.playersCurrentlyInPot) return false;
  if (filter.preflopLine !== undefined && facts.preflopLine !== filter.preflopLine) return false;
  if (filter.potType !== undefined && facts.potType !== filter.potType) return false;
  if (filter.exactBoard !== undefined && !sameCards(facts.board, filter.exactBoard)) return false;
  if (filter.requiredBoardCards !== undefined && !filter.requiredBoardCards.every((card) => facts.board.includes(card))) return false;
  if (filter.boardTexture !== undefined && !facts.boardTextures.includes(filter.boardTexture)) return false;
  if (filter.heroHandClass !== undefined && facts.heroHandClass !== filter.heroHandClass) return false;
  if (filter.drawClass !== undefined && !facts.drawClasses.includes(filter.drawClass)) return false;
  if (filter.strategicClass !== undefined && !facts.strategicClasses.includes(filter.strategicClass)) return false;
  return true;
}

export class ScenarioCatalog {
  readonly #matches: readonly ScenarioCatalogMatch[];

  constructor(definitions: readonly NodeScenarioDefinition[]) {
    const seen = new Set<string>();
    this.#matches = definitions.map((definition) => {
      if (!definition.id.trim()) throw new ScenarioValidationError("Catalog scenario ids cannot be blank");
      if (seen.has(definition.id)) throw new ScenarioValidationError(`Duplicate catalog scenario id: ${definition.id}`);
      seen.add(definition.id);
      return { definition, facts: factsFor(definition) };
    });
  }

  filter(filter: ScenarioFilter = {}): readonly ScenarioCatalogMatch[] {
    return this.#matches.filter((entry) => matches(entry, filter));
  }

  all(): readonly ScenarioCatalogMatch[] {
    return this.#matches;
  }
}

export function createScenarioCatalog(definitions: readonly NodeScenarioDefinition[]): ScenarioCatalog {
  return new ScenarioCatalog(definitions);
}
