import { createDeck, RANKS, SUITS, type Card, type Rank } from "./cards";

export type ComboWeight = number;
export type ComboId = `${Card}|${Card}`;

export interface WeightedCombo {
  readonly id: ComboId;
  readonly cards: readonly [Card, Card];
  readonly weight: ComboWeight;
}

export type WeightedRange = ReadonlyMap<ComboId, WeightedCombo>;

const deck = createDeck();
const cardOrder = new Map(deck.map((value, index) => [value, index]));

export function comboId(first: Card, second: Card): ComboId {
  if (first === second) throw new RangeError("A combo requires two distinct cards");
  const firstIndex = cardOrder.get(first);
  const secondIndex = cardOrder.get(second);
  if (firstIndex === undefined || secondIndex === undefined) throw new RangeError("Unknown card");
  return firstIndex < secondIndex ? `${first}|${second}` : `${second}|${first}`;
}

export function allCombos(weight: ComboWeight = 1): WeightedRange {
  assertWeight(weight);
  const result = new Map<ComboId, WeightedCombo>();
  for (let first = 0; first < deck.length - 1; first += 1) {
    for (let second = first + 1; second < deck.length; second += 1) {
      const left = deck[first];
      const right = deck[second];
      if (left === undefined || right === undefined) throw new Error("Deck invariant failed");
      const id = comboId(left, right);
      result.set(id, { id, cards: [left, right], weight });
    }
  }
  return result;
}

function assertWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("Combo weight must be in [0, 1]");
}

export function createRange(entries: readonly { readonly cards: readonly [Card, Card]; readonly weight: ComboWeight }[]): WeightedRange {
  const range = new Map<ComboId, WeightedCombo>();
  for (const entry of entries) {
    assertWeight(entry.weight);
    const id = comboId(...entry.cards);
    range.set(id, { id, cards: entry.cards, weight: entry.weight });
  }
  return range;
}

export function removeCards(range: WeightedRange, deadCards: readonly Card[]): WeightedRange {
  const dead = new Set(deadCards);
  return new Map([...range].filter(([, combo]) => combo.cards.every((value) => !dead.has(value))));
}

export interface CardRemovalResult {
  readonly range: WeightedRange;
  readonly removedComboCount: number;
  readonly removedWeightedMass: number;
}

export function removeCardsWithStats(range: WeightedRange, deadCards: readonly Card[]): CardRemovalResult {
  const filtered = removeCards(range, deadCards);
  return {
    range: filtered,
    removedComboCount: range.size - filtered.size,
    removedWeightedMass: weightedComboCount(range) - weightedComboCount(filtered),
  };
}

export function setComboWeight(range: WeightedRange, cards: readonly [Card, Card], weight: ComboWeight): WeightedRange {
  assertWeight(weight);
  const next = new Map(range);
  const id = comboId(...cards);
  next.set(id, { id, cards, weight });
  return next;
}

export function weightedComboCount(range: WeightedRange): number {
  return [...range.values()].reduce((sum, combo) => sum + combo.weight, 0);
}

export function normalizeRange(range: WeightedRange): WeightedRange {
  const maximum = Math.max(0, ...[...range.values()].map(({ weight }) => weight));
  if (maximum === 0) return new Map(range);
  return new Map([...range].map(([id, combo]) => [id, { ...combo, weight: combo.weight / maximum }]));
}

/** Normalizes combo weights into a probability mass summing to one. */
export function normalizeRangeToUnitMass(range: WeightedRange): WeightedRange {
  const total = weightedComboCount(range);
  if (total <= 0) return new Map(range);
  return new Map([...range].map(([id, combo]) => [id, { ...combo, weight: combo.weight / total }]));
}

/** Bayesian conditioning by combo likelihood; no policy is inferred when a likelihood is absent. */
export function conditionRange(range: WeightedRange, actionLikelihoods: ReadonlyMap<ComboId, number>): WeightedRange {
  const conditioned = new Map<ComboId, WeightedCombo>();
  for (const [id, combo] of range) {
    const likelihood = actionLikelihoods.get(id);
    if (likelihood === undefined) continue;
    assertWeight(likelihood);
    const weight = combo.weight * likelihood;
    if (weight > 0) conditioned.set(id, { ...combo, weight });
  }
  return normalizeRange(conditioned);
}

export function topFractionOfRange(range: WeightedRange, fraction: number): WeightedRange {
  if (fraction < 0 || fraction > 1) throw new RangeError("Fraction must be in [0, 1]");
  const total = weightedComboCount(range);
  let remaining = total * fraction;
  const output = new Map<ComboId, WeightedCombo>();
  const sorted = [...range.values()].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
  for (const combo of sorted) {
    if (remaining <= 0) break;
    const included = Math.min(combo.weight, remaining);
    output.set(combo.id, { ...combo, weight: included });
    remaining -= included;
  }
  return output;
}

export interface MatrixCell {
  readonly label: string;
  readonly row: number;
  readonly column: number;
  readonly possibleCombos: number;
  readonly weightedCombos: number;
  readonly percentage: number;
}

const matrixRanks = [...RANKS].reverse();
const rankPosition = new Map<Rank, number>(matrixRanks.map((rank, index) => [rank, index]));

function comboClass(cards: readonly [Card, Card]): { readonly label: string; readonly row: number; readonly column: number; readonly possible: number } {
  const leftRank = cards[0][0] as Rank;
  const rightRank = cards[1][0] as Rank;
  const left = rankPosition.get(leftRank);
  const right = rankPosition.get(rightRank);
  if (left === undefined || right === undefined) throw new Error("Rank invariant failed");
  if (left === right) return { label: `${leftRank}${leftRank}`, row: left, column: left, possible: 6 };
  const high = Math.min(left, right);
  const low = Math.max(left, right);
  const highRank = matrixRanks[high];
  const lowRank = matrixRanks[low];
  if (highRank === undefined || lowRank === undefined) throw new Error("Matrix invariant failed");
  const suited = cards[0][1] === cards[1][1];
  return suited
    ? { label: `${highRank}${lowRank}s`, row: high, column: low, possible: SUITS.length }
    : { label: `${highRank}${lowRank}o`, row: low, column: high, possible: 12 };
}

export function projectRangeMatrix(range: WeightedRange): readonly MatrixCell[] {
  const cells = new Map<string, MatrixCell>();
  for (const combo of range.values()) {
    const group = comboClass(combo.cards);
    const existing = cells.get(group.label);
    const weightedCombos = (existing?.weightedCombos ?? 0) + combo.weight;
    cells.set(group.label, { label: group.label, row: group.row, column: group.column, possibleCombos: group.possible, weightedCombos, percentage: weightedCombos / group.possible });
  }
  return [...cells.values()].sort((left, right) => left.row - right.row || left.column - right.column);
}
