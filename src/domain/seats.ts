export type PlayerCount = 4 | 5 | 6 | 7 | 8;
export type SeatId = `seat-${number}`;

const labelsByCount: Record<PlayerCount, readonly string[]> = {
  4: ["BTN", "SB", "BB", "CO"],
  5: ["BTN", "SB", "BB", "HJ", "CO"],
  6: ["BTN", "SB", "BB", "LJ", "HJ", "CO"],
  7: ["BTN", "SB", "BB", "UTG", "LJ", "HJ", "CO"],
  8: ["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"],
};

export function seatId(index: number): SeatId {
  if (!Number.isSafeInteger(index) || index < 0 || index > 7) throw new RangeError("Invalid seat index");
  return `seat-${index}`;
}

export function seatIndex(id: SeatId): number {
  const index = Number(id.slice(5));
  if (!Number.isSafeInteger(index) || index < 0 || index > 7) throw new RangeError(`Invalid seat id: ${id}`);
  return index;
}

export function clockwiseIndex(index: number, offset: number, count: PlayerCount): number {
  return ((index + offset) % count + count) % count;
}

export function positionLabel(seatIndexValue: number, buttonIndex: number, count: PlayerCount): string {
  const relative = clockwiseIndex(seatIndexValue - buttonIndex, 0, count);
  const label = labelsByCount[count][relative];
  if (label === undefined) throw new Error("Position label invariant failed");
  return label;
}

export function orderedSeatIds(count: PlayerCount, startIndex: number): readonly SeatId[] {
  return Array.from({ length: count }, (_, offset) => seatId(clockwiseIndex(startIndex, offset, count)));
}

export function preflopFirstActorIndex(count: PlayerCount, buttonIndex: number, liveStraddle = false): number {
  return clockwiseIndex(buttonIndex, liveStraddle ? 4 : 3, count);
}

export function postflopFirstActorIndex(count: PlayerCount, buttonIndex: number): number {
  return clockwiseIndex(buttonIndex, 1, count);
}
