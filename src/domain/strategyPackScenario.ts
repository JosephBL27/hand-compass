import { z } from "zod";
import type { PokerAction } from "./actions";
import type { ActionTreeConfig, SizingCandidate, StreetSizingRules } from "./actionTree";
import { assertUniqueCards, isCard, type Card } from "./cards";
import { validateGameConfig, type GameConfig } from "./config";
import { CACHE_HASH_FIELDS, cacheHashesKey, deterministicHash, type CacheHashes } from "./hash";
import type { BB } from "./money";
import { comboId } from "./ranges";
import { seatId, type SeatId } from "./seats";

const finiteInteger = z.number().finite().int().safe();
const nonnegativeBB = finiteInteger.nonnegative();
const positiveBB = finiteInteger.positive();
const finiteWeight = z.number().finite().min(0).max(1);
const seatIdSchema = z.string().regex(/^seat-[0-7]$/u, "Invalid SeatId");
const cardSchema = z.string().refine(isCard, "Invalid poker card");
const cardPairSchema = z.tuple([cardSchema, cardSchema]);

export const strategyPackActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fold") }).strict(),
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("call"), amount: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("bet"), to: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("raise"), to: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("jam"), to: nonnegativeBB }).strict(),
]);

export const strategyPackRakeSchema = z.object({
  enabled: z.boolean(),
  percentage: z.number().finite().min(0).max(1),
  capBB: nonnegativeBB,
  noFlopNoDrop: z.boolean(),
}).strict();

const tournamentSchema = z.object({
  payouts: z.array(z.number().finite().nonnegative()).optional(),
  playersRemaining: finiteInteger.positive().optional(),
  bountyType: z.enum(["none", "PKO"]).optional(),
  bounties: z.record(seatIdSchema, z.number().finite().nonnegative()).optional(),
  icmEnabled: z.boolean().optional(),
}).strict();

const gameConfigSchema = z.object({
  playerCount: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  gameType: z.enum(["cash", "tournament"]),
  smallBlindBB: nonnegativeBB,
  bigBlindBB: positiveBB,
  anteBB: nonnegativeBB,
  bigBlindAnteBB: nonnegativeBB,
  straddleBB: positiveBB.optional(),
  startingStacksBB: z.record(seatIdSchema, positiveBB),
  rake: strategyPackRakeSchema,
  tournament: tournamentSchema.optional(),
  actionTreeId: z.string().trim().min(1),
  strategyProviderId: z.string().trim().min(1),
}).strict();

const sizingCandidateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pot-fraction"), fraction: z.number().finite().positive(), scope: z.enum(["bet", "raise", "both"]).optional(), rootOnly: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("raise-multiple"), multiple: z.number().finite().gt(1), scope: z.enum(["bet", "raise", "both"]).optional(), rootOnly: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("raise-to"), toBB: positiveBB, scope: z.enum(["bet", "raise", "both"]).optional(), rootOnly: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("all-in"), scope: z.enum(["bet", "raise", "both"]).optional(), rootOnly: z.boolean().optional() }).strict(),
]);

const fixedSizingSchema = z.object({
  mode: z.literal("fixed"),
  candidates: z.array(sizingCandidateSchema),
}).strict();

const dynamicSizingSchema = z.object({
  mode: z.literal("dynamic"),
  candidates: z.array(sizingCandidateSchema),
  retainedCandidateIndexes: z.array(finiteInteger.nonnegative()).optional(),
}).strict();

const geometricSizingSchema = z.object({
  mode: z.literal("geometric"),
  streetsRemaining: finiteInteger.min(1).max(4),
  includeAllIn: z.boolean().optional(),
}).strict();

const streetSizingSchema = z.discriminatedUnion("mode", [fixedSizingSchema, dynamicSizingSchema, geometricSizingSchema]);

const actionTreeSchema = z.object({
  id: z.string().trim().min(1),
  preflop: z.object({ unopened: streetSizingSchema, facingRaise: streetSizingSchema }).strict(),
  flop: streetSizingSchema,
  turn: streetSizingSchema,
  river: streetSizingSchema,
}).strict();

const rangeComboSchema = z.object({ cards: cardPairSchema, weight: finiteWeight }).strict();

const nodeIdentitySchema = z.object({
  gameConfigHash: z.string().trim().min(1),
  rangeHash: z.string().trim().min(1),
  treeHash: z.string().trim().min(1),
  nodeHash: z.string().trim().min(1),
  boardCanonicalHash: z.string().trim().min(1),
}).strict();

const expectedSchema = z.object({
  actor: seatIdSchema,
  street: z.enum(["preflop", "flop", "turn", "river"]),
  board: z.array(cardSchema).max(5),
  potBB: nonnegativeBB,
  currentBetBB: nonnegativeBB,
  stacksBB: z.record(seatIdSchema, nonnegativeBB),
}).strict();

const sourceTagsSchema = z.object({
  preflopLine: z.enum(["RFI", "vs-limp", "vs-open", "squeeze", "vs-3-bet", "vs-4-bet", "vs-shove", "blind-vs-blind", "multiway"]),
  potType: z.enum(["limped", "SRP", "3-bet", "4-bet", "5-bet", "multiway"]),
  strategicClasses: z.array(z.string().trim().min(1)).optional(),
}).strict();

export const strategyPackScenarioManifestSchema = z.object({
  id: z.string().trim().min(1),
  nodeIdentity: nodeIdentitySchema,
  config: gameConfigSchema,
  buttonIndex: finiteInteger.nonnegative().max(7),
  heroSeatId: seatIdSchema,
  actionTree: actionTreeSchema,
  seed: finiteInteger,
  ranges: z.record(seatIdSchema, z.array(rangeComboSchema).min(1)),
  fixedHoleCards: z.record(seatIdSchema, cardPairSchema),
  deadCards: z.array(cardSchema),
  futureBoard: z.array(cardSchema).max(5),
  replay: z.array(strategyPackActionSchema),
  expected: expectedSchema,
  sourceTags: sourceTagsSchema,
}).strict();

export interface StrategyPackRangeCombo {
  readonly cards: readonly [Card, Card];
  readonly weight: number;
}

export interface StrategyPackScenarioExpected {
  readonly actor: SeatId;
  readonly street: "preflop" | "flop" | "turn" | "river";
  readonly board: readonly Card[];
  readonly potBB: BB;
  readonly currentBetBB: BB;
  readonly stacksBB: Readonly<Record<SeatId, BB>>;
}

export interface StrategyPackScenarioSourceTags {
  readonly preflopLine: "RFI" | "vs-limp" | "vs-open" | "squeeze" | "vs-3-bet" | "vs-4-bet" | "vs-shove" | "blind-vs-blind" | "multiway";
  readonly potType: "limped" | "SRP" | "3-bet" | "4-bet" | "5-bet" | "multiway";
  readonly strategicClasses?: readonly string[];
}

export interface StrategyPackScenarioManifest {
  readonly id: string;
  readonly nodeIdentity: CacheHashes;
  readonly config: GameConfig;
  readonly buttonIndex: number;
  readonly heroSeatId: SeatId;
  readonly actionTree: ActionTreeConfig;
  readonly seed: number;
  readonly ranges: Readonly<Partial<Record<SeatId, readonly StrategyPackRangeCombo[]>>>;
  readonly fixedHoleCards: Readonly<Partial<Record<SeatId, readonly [Card, Card]>>>;
  readonly deadCards: readonly Card[];
  readonly futureBoard: readonly Card[];
  readonly replay: readonly PokerAction[];
  readonly expected: StrategyPackScenarioExpected;
  readonly sourceTags: StrategyPackScenarioSourceTags;
}

function assertSeatLedger(
  ledger: Readonly<Record<string, unknown>>,
  playerCount: number,
  label: string,
  requireAllSeats: boolean,
): void {
  const valid = new Set(Array.from({ length: playerCount }, (_, index) => seatId(index)));
  const keys = Object.keys(ledger);
  const outside = keys.filter((key) => !valid.has(key as SeatId));
  if (outside.length > 0) throw new RangeError(`${label} contains seats outside the configured table: ${outside.join(", ")}`);
  if (requireAllSeats) {
    const missing = [...valid].filter((key) => !(key in ledger));
    if (missing.length > 0) throw new RangeError(`${label} is missing configured seats: ${missing.join(", ")}`);
  }
}

function validateSizingRule(rule: StreetSizingRules, label: string): void {
  if (rule.mode === "dynamic" && rule.retainedCandidateIndexes !== undefined) {
    const indexes = rule.retainedCandidateIndexes;
    if (new Set(indexes).size !== indexes.length) throw new RangeError(`${label} has duplicate retained candidate indexes`);
    if (indexes.some((index) => index >= rule.candidates.length)) throw new RangeError(`${label} retains a candidate index outside its candidate pool`);
  }
  if (rule.mode !== "geometric") {
    const keys = rule.candidates.map((candidate: SizingCandidate) => deterministicHash(candidate));
    if (new Set(keys).size !== keys.length) throw new RangeError(`${label} has duplicate sizing candidates`);
  }
}

function validateScenarioManifest(manifest: StrategyPackScenarioManifest): StrategyPackScenarioManifest {
  validateGameConfig(manifest.config);
  const count = manifest.config.playerCount;
  if (manifest.buttonIndex >= count) throw new RangeError(`Scenario ${manifest.id} buttonIndex is outside the configured table`);
  const tableSeats = new Set(Array.from({ length: count }, (_, index) => seatId(index)));
  if (!tableSeats.has(manifest.heroSeatId)) throw new RangeError(`Scenario ${manifest.id} heroSeatId is outside the configured table`);
  if (!tableSeats.has(manifest.expected.actor)) throw new RangeError(`Scenario ${manifest.id} expected actor is outside the configured table`);
  if (manifest.config.actionTreeId !== manifest.actionTree.id) {
    throw new RangeError(`Scenario ${manifest.id} config.actionTreeId does not match actionTree.id`);
  }
  assertSeatLedger(manifest.config.startingStacksBB, count, `Scenario ${manifest.id} startingStacksBB`, true);
  assertSeatLedger(manifest.expected.stacksBB, count, `Scenario ${manifest.id} expected.stacksBB`, true);
  assertSeatLedger(manifest.ranges, count, `Scenario ${manifest.id} ranges`, false);
  assertSeatLedger(manifest.fixedHoleCards, count, `Scenario ${manifest.id} fixedHoleCards`, false);
  validateSizingRule(manifest.actionTree.preflop.unopened, `Scenario ${manifest.id} preflop unopened tree`);
  validateSizingRule(manifest.actionTree.preflop.facingRaise, `Scenario ${manifest.id} preflop facing-raise tree`);
  validateSizingRule(manifest.actionTree.flop, `Scenario ${manifest.id} flop tree`);
  validateSizingRule(manifest.actionTree.turn, `Scenario ${manifest.id} turn tree`);
  validateSizingRule(manifest.actionTree.river, `Scenario ${manifest.id} river tree`);

  const fixedCards: Card[] = [];
  for (const [seat, cards] of Object.entries(manifest.fixedHoleCards) as [SeatId, readonly [Card, Card]][]) {
    assertUniqueCards(cards);
    fixedCards.push(...cards);
    const seatRange = manifest.ranges[seat];
    if (seatRange !== undefined) {
      const heldId = comboId(...cards);
      const held = seatRange.find((entry) => comboId(...entry.cards) === heldId);
      if (held === undefined || held.weight <= 0) throw new RangeError(`Scenario ${manifest.id} fixed cards for ${seat} have no positive range weight`);
    }
  }
  assertUniqueCards([...fixedCards, ...manifest.deadCards, ...manifest.futureBoard]);
  assertUniqueCards(manifest.expected.board);
  if (manifest.expected.board.length > manifest.futureBoard.length
    || manifest.expected.board.some((value, index) => value !== manifest.futureBoard[index])) {
    throw new RangeError(`Scenario ${manifest.id} expected board is not a prefix of futureBoard`);
  }

  for (const seat of tableSeats) {
    const entries = manifest.ranges[seat];
    if (manifest.fixedHoleCards[seat] === undefined && entries === undefined) {
      throw new RangeError(`Scenario ${manifest.id} ${seat} requires fixed cards or a positive-mass range`);
    }
    if (entries === undefined) continue;
    const ids = entries.map((entry) => {
      assertUniqueCards(entry.cards);
      return comboId(...entry.cards);
    });
    if (new Set(ids).size !== ids.length) throw new RangeError(`Scenario ${manifest.id} range for ${seat} has duplicate combos`);
    if (!entries.some(({ weight }) => weight > 0)) throw new RangeError(`Scenario ${manifest.id} range for ${seat} has no positive mass`);
  }
  const strategicClasses = manifest.sourceTags.strategicClasses ?? [];
  if (new Set(strategicClasses).size !== strategicClasses.length) throw new RangeError(`Scenario ${manifest.id} has duplicate strategic classes`);
  return manifest;
}

export function parseStrategyPackScenarioManifest(value: unknown): StrategyPackScenarioManifest {
  const parsed = strategyPackScenarioManifestSchema.parse(value) as unknown as StrategyPackScenarioManifest;
  return validateScenarioManifest(parsed);
}

export function strategyPackScenarioIdentityKey(manifest: Pick<StrategyPackScenarioManifest, "nodeIdentity">): string {
  return cacheHashesKey(manifest.nodeIdentity);
}

export function assertScenarioMatchesNodeIdentity(manifest: StrategyPackScenarioManifest, node: CacheHashes): void {
  const mismatches = CACHE_HASH_FIELDS.filter((field) => manifest.nodeIdentity[field] !== node[field]);
  if (mismatches.length > 0) throw new RangeError(`Scenario ${manifest.id} nodeIdentity mismatch: ${mismatches.join(", ")}`);
}
