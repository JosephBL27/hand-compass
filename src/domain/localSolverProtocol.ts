import { z } from "zod";
import { actionKey, type PokerAction } from "./actions";
import { isCard, type Card } from "./cards";
import { validateComboPolicy, type ComboPolicy } from "./comboPolicy";
import type { RakeConfig } from "./config";
import {
  CACHE_HASH_FIELDS,
  createStrategyQueryHashes,
  deterministicHash,
  sameCacheHashes,
  type CacheHashes,
} from "./hash";
import type { BB } from "./money";
import type { ComboId, WeightedRange } from "./ranges";
import {
  strategyConfigurationForQuery,
  validateStrategyResult,
  type StrategyAction,
  type StrategyQuery,
  type StrategyResult,
} from "./strategy";

export const LOCAL_SOLVER_PROTOCOL_VERSION = "1.1.0";

const safeInteger = z.number().finite().int().safe();
const nonnegativeUnits = safeInteger.nonnegative();
const cardSchema = z.string().refine(isCard, "Invalid poker card");
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fold") }).strict(),
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("call"), amount: nonnegativeUnits }).strict(),
  z.object({ kind: z.literal("bet"), to: nonnegativeUnits }).strict(),
  z.object({ kind: z.literal("raise"), to: nonnegativeUnits }).strict(),
  z.object({ kind: z.literal("jam"), to: nonnegativeUnits }).strict(),
]);
const identitySchema = z.object({
  gameConfigHash: z.string().min(1),
  rangeHash: z.string().min(1),
  treeHash: z.string().min(1),
  nodeHash: z.string().min(1),
  boardCanonicalHash: z.string().min(1),
}).strict();
const rakeSchema = z.object({
  enabled: z.boolean(),
  percentage: z.number().finite().min(0).max(1),
  capBB: nonnegativeUnits,
  noFlopNoDrop: z.boolean(),
}).strict();
const strategyActionSchema = z.object({
  action: actionSchema,
  frequency: z.number().finite().min(0).max(1).optional(),
  evBB: safeInteger.optional(),
}).strict();
const comboActionSchema = z.object({
  action: actionSchema,
  frequency: z.number().finite().min(0).max(1),
  evBB: safeInteger.optional(),
}).strict();
const comboPolicySchema = z.array(z.object({
  cards: z.tuple([cardSchema, cardSchema]),
  weight: z.number().finite().min(0).max(1),
  actions: z.array(comboActionSchema).min(1),
}).strict()).min(1);
const convergenceSchema = z.object({
  exploitability: z.number().finite().nonnegative().optional(),
  exploitabilityBB: safeInteger.nonnegative().optional(),
  exploitabilityPctPot: z.number().finite().nonnegative().optional(),
  targetExploitabilityBB: safeInteger.nonnegative().optional(),
  targetExploitabilityPctPot: z.number().finite().nonnegative().optional(),
  iterations: z.number().finite().int().safe().nonnegative().optional(),
  solver: z.string().trim().min(1).optional(),
  compression: z.string().trim().min(1).optional(),
}).strict();
const responseSchema = z.object({
  protocolVersion: z.literal(LOCAL_SOLVER_PROTOCOL_VERSION),
  kind: z.literal("strategy-result"),
  identity: identitySchema,
  source: z.object({
    sourceId: z.string().trim().min(1),
    solver: z.string().trim().min(1),
    version: z.string().trim().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    commit: z.string().trim().min(1).optional(),
    sourceUrl: z.url().optional(),
    license: z.string().trim().min(1).optional(),
  }).strict(),
  state: z.object({
    actorSeatId: z.string().min(1),
    actorPosition: z.string().min(1),
    heroSeatId: z.string().min(1),
    potBB: nonnegativeUnits,
    stacksBB: z.record(z.string().min(1), nonnegativeUnits),
    rake: rakeSchema,
    board: z.array(cardSchema).max(5),
    legalActions: z.array(actionSchema).min(1),
  }).strict(),
  result: z.object({
    provenance: z.literal("SOLVED"),
    actions: z.array(strategyActionSchema).min(1),
    comboPolicy: comboPolicySchema.optional(),
    convergence: convergenceSchema.optional(),
    sourceNodeId: z.string().trim().min(1).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    notes: z.array(z.string()).optional(),
  }).strict(),
}).strict();

export interface SerializedWeightedCombo {
  readonly id: ComboId;
  readonly cards: readonly [Card, Card];
  readonly weight: number;
}

export interface NormalizedLocalSolverRequest {
  readonly protocolVersion: typeof LOCAL_SOLVER_PROTOCOL_VERSION;
  readonly kind: "solve";
  readonly identity: CacheHashes;
  readonly query: {
    readonly nodeHash: string;
    readonly actorSeatId: StrategyQuery["actorSeatId"];
    readonly actorPosition: string;
    readonly heroSeatId: StrategyQuery["heroSeatId"];
    readonly gameConfig: unknown;
    readonly street: StrategyQuery["street"];
    readonly board: readonly Card[];
    readonly actionHistory: readonly PokerAction[];
    readonly publicState?: NonNullable<StrategyQuery["publicState"]>;
    readonly potBB: BB;
    readonly stacksBB: Readonly<Record<string, BB>>;
    readonly heroPosition: string;
    readonly opponentPositions: readonly string[];
    readonly ranges: Readonly<Record<string, readonly SerializedWeightedCombo[]>>;
    readonly legalActions: readonly PokerAction[];
    readonly actionTree: unknown;
    readonly rake: RakeConfig;
    readonly deadCards: readonly Card[];
  };
}

function sortedRecord<T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function serializeRange(range: WeightedRange): readonly SerializedWeightedCombo[] {
  return [...range.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, cards, weight }) => ({ id, cards, weight }));
}

function serializeRanges(ranges: StrategyQuery["ranges"]): Readonly<Record<string, readonly SerializedWeightedCombo[]>> {
  return Object.fromEntries(
    Object.entries(ranges)
      .filter((entry): entry is [string, WeightedRange] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([seat, range]) => [seat, serializeRange(range)]),
  );
}

/** Builds the normalized browser/sidecar contract. It is deliberately not raw TexasSolver JSON. */
export function createLocalSolverRequest(query: StrategyQuery): NormalizedLocalSolverRequest {
  const identity = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  return {
    protocolVersion: LOCAL_SOLVER_PROTOCOL_VERSION,
    kind: "solve",
    identity,
    query: {
      nodeHash: query.nodeHash,
      actorSeatId: query.actorSeatId,
      actorPosition: query.actorPosition,
      heroSeatId: query.heroSeatId,
      gameConfig: query.gameConfig,
      street: query.street,
      board: query.board,
      actionHistory: query.actionHistory,
      ...(query.publicState === undefined ? {} : { publicState: query.publicState }),
      potBB: query.potBB,
      stacksBB: sortedRecord(query.stacksBB),
      heroPosition: query.heroPosition,
      opponentPositions: query.opponentPositions,
      ranges: serializeRanges(query.ranges),
      legalActions: query.legalActions,
      actionTree: query.actionTree,
      rake: query.rake,
      deadCards: query.deadCards,
    },
  };
}

function canonicalWireValue(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, item]) => [key, canonicalWireValue(item)]);
  }
  if (Array.isArray(value)) return value.map(canonicalWireValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalWireValue(item)]),
    );
  }
  return value;
}

export function stableSolverJson(value: unknown): string {
  return JSON.stringify(canonicalWireValue(value));
}

function sameActionSet(left: readonly PokerAction[], right: readonly PokerAction[]): boolean {
  const leftKeys = left.map(actionKey).sort();
  const rightKeys = right.map(actionKey).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
}

function assertIdentity(actual: CacheHashes, expected: CacheHashes): void {
  if (!sameCacheHashes(actual, expected)) {
    const mismatches = CACHE_HASH_FIELDS.filter((field) => actual[field] !== expected[field]);
    throw new RangeError(`Local solver response identity mismatch: ${mismatches.join(", ")}`);
  }
}

function assertFrequencyShape(actions: readonly StrategyAction[]): void {
  const withFrequency = actions.filter((item) => item.frequency !== undefined);
  if (withFrequency.length !== 0 && withFrequency.length !== actions.length) {
    throw new RangeError("Local solver frequencies must be present for every action or omitted for every action");
  }
  if (withFrequency.length === actions.length) {
    const sum = actions.reduce((total, item) => total + (item.frequency ?? 0), 0);
    if (Math.abs(sum - 1) > 1e-6) throw new RangeError(`Local solver action frequencies must sum to 1; received ${sum}`);
  }
}

/** Strictly decodes only our normalized sidecar response and revalidates it against the live query. */
export function decodeLocalSolverResponse(payload: unknown, query: StrategyQuery): StrategyResult {
  const parsed = responseSchema.parse(payload);
  const echoedLegalActions = parsed.state.legalActions as unknown as readonly PokerAction[];
  const parsedActions = parsed.result.actions as unknown as readonly StrategyAction[];
  const parsedComboPolicy = parsed.result.comboPolicy as unknown as ComboPolicy | undefined;
  const expected = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  assertIdentity(parsed.identity, expected);
  if (parsed.state.actorSeatId !== query.actorSeatId) throw new RangeError("Local solver response actorSeatId mismatch");
  if (parsed.state.actorPosition !== query.actorPosition) throw new RangeError("Local solver response actorPosition mismatch");
  if (parsed.state.heroSeatId !== query.heroSeatId) throw new RangeError("Local solver response heroSeatId mismatch");
  if (parsed.state.potBB !== query.potBB) throw new RangeError("Local solver response potBB mismatch");
  if (deterministicHash(parsed.state.stacksBB) !== deterministicHash(query.stacksBB)) throw new RangeError("Local solver response stacksBB mismatch");
  if (deterministicHash(parsed.state.rake) !== deterministicHash(query.rake)) throw new RangeError("Local solver response rake mismatch");
  if (deterministicHash(parsed.state.board) !== deterministicHash(query.board)) throw new RangeError("Local solver response board mismatch");
  if (!sameActionSet(echoedLegalActions, query.legalActions)) throw new RangeError("Local solver response legal-action set mismatch");
  if (!sameActionSet(parsedActions.map(({ action }) => action), query.legalActions)) {
    throw new RangeError("Local solver result must contain every live legal action exactly once");
  }
  assertFrequencyShape(parsedActions);
  if (parsedComboPolicy !== undefined) {
    validateComboPolicy(parsedComboPolicy, query.legalActions);
    const unavailableCards = new Set<Card>([...query.board, ...query.deadCards]);
    for (const row of parsedComboPolicy) {
      if (row.cards.some((card) => unavailableCards.has(card))) {
        throw new RangeError("Local solver combo policy collides with a board or dead card");
      }
    }
  }

  const convergence: NonNullable<StrategyResult["convergence"]> = {
    ...(parsed.result.convergence?.exploitability === undefined ? {} : { exploitability: parsed.result.convergence.exploitability }),
    ...(parsed.result.convergence?.exploitabilityBB === undefined ? {} : { exploitabilityBB: parsed.result.convergence.exploitabilityBB }),
    ...(parsed.result.convergence?.exploitabilityPctPot === undefined ? {} : { exploitabilityPctPot: parsed.result.convergence.exploitabilityPctPot }),
    ...(parsed.result.convergence?.targetExploitabilityBB === undefined ? {} : { targetExploitabilityBB: parsed.result.convergence.targetExploitabilityBB }),
    ...(parsed.result.convergence?.targetExploitabilityPctPot === undefined ? {} : { targetExploitabilityPctPot: parsed.result.convergence.targetExploitabilityPctPot }),
    ...(parsed.result.convergence?.iterations === undefined ? {} : { iterations: parsed.result.convergence.iterations }),
    solver: parsed.result.convergence?.solver ?? parsed.source.solver,
    ...(parsed.result.convergence?.compression === undefined ? {} : { compression: parsed.result.convergence.compression }),
  };

  const result: StrategyResult = {
    provenance: "SOLVED",
    actions: parsedActions,
    ...(parsedComboPolicy === undefined ? {} : { comboPolicy: parsedComboPolicy }),
    convergence,
    sourceNodeId: parsed.result.sourceNodeId ?? parsed.identity.nodeHash,
    ...(parsed.result.confidence === undefined ? {} : { confidence: parsed.result.confidence }),
    source: {
      id: parsed.source.sourceId,
      name: parsed.source.sourceId,
      solver: parsed.source.solver,
      version: parsed.source.version,
      timestamp: parsed.source.timestamp,
      ...(parsed.source.commit === undefined ? {} : { commit: parsed.source.commit }),
      ...(parsed.source.sourceUrl === undefined ? {} : { sourceUrl: parsed.source.sourceUrl }),
      ...(parsed.source.license === undefined ? {} : { license: parsed.source.license }),
    },
    configuration: strategyConfigurationForQuery(query),
    notes: [
      ...(parsed.result.notes ?? []),
      `Normalized local source ${parsed.source.sourceId}; ${parsed.source.solver} ${parsed.source.version}; ${parsed.source.timestamp}.`,
    ],
  };
  return validateStrategyResult(result, query.legalActions);
}
