import { bb, type BB } from "./money";
import { seatId, type PlayerCount, type SeatId } from "./seats";

export interface RakeConfig {
  readonly enabled: boolean;
  readonly percentage: number;
  readonly capBB: BB;
  readonly noFlopNoDrop: boolean;
}

export interface TournamentConfig {
  readonly payouts?: readonly number[];
  readonly playersRemaining?: number;
  readonly bountyType?: "none" | "PKO";
  readonly bounties?: Readonly<Partial<Record<SeatId, number>>>;
  readonly icmEnabled?: boolean;
}

export interface GameConfig {
  readonly playerCount: PlayerCount;
  readonly gameType: "cash" | "tournament";
  readonly smallBlindBB: BB;
  readonly bigBlindBB: BB;
  readonly anteBB: BB;
  readonly bigBlindAnteBB: BB;
  readonly straddleBB?: BB;
  readonly startingStacksBB: Readonly<Record<SeatId, BB>>;
  readonly rake: RakeConfig;
  readonly tournament?: TournamentConfig;
  readonly actionTreeId: string;
  readonly strategyProviderId: string;
}

export function validateGameConfig(config: GameConfig): GameConfig {
  if (![4, 5, 6, 7, 8].includes(config.playerCount)) throw new RangeError("playerCount must be 4–8");
  if (config.bigBlindBB !== bb(1)) throw new RangeError("bigBlindBB must equal 1 BB");
  if (config.smallBlindBB < 0 || config.smallBlindBB >= config.bigBlindBB) throw new RangeError("small blind must be between 0 and 1 BB");
  if (config.anteBB < 0 || config.bigBlindAnteBB < 0) throw new RangeError("antes cannot be negative");
  if (config.straddleBB !== undefined && config.straddleBB < config.bigBlindBB * 2) throw new RangeError("live straddle must be at least 2 BB");
  if (!config.actionTreeId.trim() || !config.strategyProviderId.trim()) throw new RangeError("provider and action tree ids are required");
  for (let index = 0; index < config.playerCount; index += 1) {
    const stack = config.startingStacksBB[seatId(index)];
    if (stack === undefined || stack <= 0) throw new RangeError(`Missing positive stack for ${seatId(index)}`);
  }
  if (config.rake.percentage < 0 || config.rake.percentage > 1 || config.rake.capBB < 0) throw new RangeError("Invalid rake configuration");
  if (config.gameType === "tournament" && config.tournament === undefined) throw new RangeError("Tournament config is required");
  return config;
}

export function createCashConfig(playerCount: PlayerCount = 8, stack = bb(100)): GameConfig {
  const stacks = Object.fromEntries(
    Array.from({ length: playerCount }, (_, index) => [seatId(index), stack]),
  ) as Record<SeatId, BB>;
  return validateGameConfig({
    playerCount,
    gameType: "cash",
    smallBlindBB: bb(0.5),
    bigBlindBB: bb(1),
    anteBB: bb(0),
    bigBlindAnteBB: bb(0),
    startingStacksBB: stacks,
    rake: { enabled: false, percentage: 0, capBB: bb(0), noFlopNoDrop: true },
    actionTreeId: "standard",
    strategyProviderId: "heuristic",
  });
}
