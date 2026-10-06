export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUITS = ["c", "d", "h", "s"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

const cardPattern = /^(?:[2-9TJQKA])(?:[cdhs])$/u;

export function isCard(value: string): value is Card {
  return cardPattern.test(value);
}

export function card(value: string): Card {
  if (!isCard(value)) throw new RangeError(`Invalid card: ${value}`);
  return value;
}

export function createDeck(): readonly Card[] {
  return RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}` as Card));
}

export function assertUniqueCards(cards: readonly Card[]): void {
  const unique = new Set(cards);
  if (unique.size !== cards.length) throw new RangeError("Duplicate cards are not legal");
}

/** Fisher-Yates using an injected RNG so tests and drills can be replayed. */
export function shuffleDeck(random: () => number = Math.random): readonly Card[] {
  const deck = [...createDeck()];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const value = deck[index];
    const other = deck[swap];
    if (value === undefined || other === undefined) throw new Error("Deck invariant failed");
    deck[index] = other;
    deck[swap] = value;
  }
  return deck;
}

export function deal(deck: readonly Card[], count: number): { readonly dealt: readonly Card[]; readonly deck: readonly Card[] } {
  if (!Number.isSafeInteger(count) || count < 0 || count > deck.length) {
    throw new RangeError("Cannot deal requested card count");
  }
  return { dealt: deck.slice(0, count), deck: deck.slice(count) };
}
