import { standardActionTree } from "../domain/actionTree";
import { createCashConfig, validateGameConfig, type GameConfig } from "../domain/config";
import { bb, type BB } from "../domain/money";
import { allCombos } from "../domain/ranges";
import { seatId, type PlayerCount, type SeatId } from "../domain/seats";
import type { RngMode } from "../domain/grading";
import type { StrategyProvider } from "../domain/strategy";
import type { FullHandInput } from "../session/types";

export const FULL_HAND_HERO_SEAT = seatId(2);

export interface FullHandDealOptions {
  readonly playerCount: PlayerCount;
  readonly startingStacksBB: readonly number[];
  readonly buttonIndex: number;
  readonly seed: number;
}

function stackRecord(playerCount: PlayerCount, values: readonly number[]): Readonly<Record<SeatId, BB>> {
  if (values.length !== playerCount) {
    throw new RangeError(`Full-hand mode requires exactly ${playerCount} starting stacks.`);
  }
  return Object.fromEntries(values.map((value, index) => {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Seat ${index + 1} needs a positive starting stack.`);
    return [seatId(index), bb(value)];
  })) as Record<SeatId, BB>;
}

/**
 * Builds a complete dealt hand from public 1,326-combo priors. These priors are
 * deliberately neutral deal ranges, not claims about equilibrium participation.
 */
export function createFullHandDefinition(
  strategyProvider: StrategyProvider,
  rngMode: RngMode,
  options: FullHandDealOptions,
): FullHandInput {
  if (!Number.isSafeInteger(options.seed)) throw new RangeError("Deal seed must be a safe integer.");
  if (!Number.isSafeInteger(options.buttonIndex) || options.buttonIndex < 0 || options.buttonIndex >= options.playerCount) {
    throw new RangeError(`Button index must be between 0 and ${options.playerCount - 1}.`);
  }
  const base = createCashConfig(options.playerCount);
  const config: GameConfig = validateGameConfig({
    ...base,
    startingStacksBB: stackRecord(options.playerCount, options.startingStacksBB),
    actionTreeId: standardActionTree.id,
    strategyProviderId: strategyProvider.id,
  });
  const publicDealRange = allCombos(1);
  const ranges = Object.fromEntries(
    Array.from({ length: options.playerCount }, (_, index) => [seatId(index), publicDealRange]),
  );
  return {
    config,
    heroSeatId: FULL_HAND_HERO_SEAT,
    buttonIndex: options.buttonIndex,
    actionTree: standardActionTree,
    strategyProvider,
    seed: options.seed,
    ranges,
    rng: { mode: rngMode, revealRollBeforeAction: true },
  };
}
