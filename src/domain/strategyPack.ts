import { z } from "zod";
import { actionKey, type PokerAction } from "./actions";
import { assertUniqueCards, isCard, type Card } from "./cards";
import { aggregateComboPolicy, validateComboPolicy, type ComboPolicy } from "./comboPolicy";
import type { RakeConfig } from "./config";
import { cacheHashesKey, createStrategyQueryHashes, deterministicHash, type CacheHashes } from "./hash";
import type { BB } from "./money";
import { comboId } from "./ranges";
import type { StrategyAction, StrategyQuery } from "./strategy";
import {
  assertScenarioMatchesNodeIdentity,
  parseStrategyPackScenarioManifest,
  strategyPackScenarioIdentityKey,
  strategyPackScenarioManifestSchema,
  type StrategyPackScenarioManifest,
} from "./strategyPackScenario";

export const STRATEGY_PACK_SCHEMA_VERSION = "2.0.0";
export const LEGACY_STRATEGY_PACK_SCHEMA_VERSION = "1.0.0";

const finiteInteger = z.number().finite().int().safe();
const nonnegativeBB = finiteInteger.nonnegative();
const cardSchema = z.string().refine(isCard, "Invalid poker card");
const cardPairSchema = z.tuple([cardSchema, cardSchema]);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fold") }).strict(),
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("call"), amount: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("bet"), to: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("raise"), to: nonnegativeBB }).strict(),
  z.object({ kind: z.literal("jam"), to: nonnegativeBB }).strict(),
]);

const comboActionSchema = z.object({
  action: actionSchema,
  frequency: z.number().finite().min(0).max(1),
  evBB: finiteInteger.optional(),
}).strict();

const comboPolicyRowSchema = z.object({
  cards: cardPairSchema,
  weight: z.number().finite().min(0).max(1),
  actions: z.array(comboActionSchema).min(1),
}).strict();

const rakeSchema = z.object({
  enabled: z.boolean(),
  percentage: z.number().finite().min(0).max(1),
  capBB: nonnegativeBB,
  noFlopNoDrop: z.boolean(),
}).strict();

const convergenceSchema = z.object({
  exploitabilityBB: z.number().finite().nonnegative(),
  exploitabilityPctPot: z.number().finite().nonnegative(),
  targetExploitabilityBB: z.number().finite().nonnegative(),
  targetExploitabilityPctPot: z.number().finite().nonnegative(),
  iterations: finiteInteger.nonnegative(),
  solver: z.string().trim().min(1),
  compression: z.string().trim().min(1).optional(),
}).strict();

const strategyPackNodeSchema = z.object({
  provenance: z.literal("SOLVED"),
  gameConfigHash: z.string().trim().min(1),
  rangeHash: z.string().trim().min(1),
  treeHash: z.string().trim().min(1),
  nodeHash: z.string().trim().min(1),
  boardCanonicalHash: z.string().trim().min(1),
  stackBB: z.record(z.string().trim().min(1), nonnegativeBB),
  potBB: nonnegativeBB,
  rake: rakeSchema,
  board: z.array(cardSchema).max(5),
  legalActions: z.array(actionSchema).min(1),
  convergence: convergenceSchema.optional(),
  notes: z.array(z.string().trim().min(1)).optional(),
  comboPolicy: z.array(comboPolicyRowSchema).min(1),
}).strict();

const strategyPackSchema = z.object({
  schemaVersion: z.literal(STRATEGY_PACK_SCHEMA_VERSION),
  packId: z.string().trim().min(1),
  source: z.object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    solver: z.string().trim().min(1).optional(),
    commit: z.string().trim().min(7).optional(),
    sourceUrl: z.url().optional(),
    license: z.string().trim().min(1).optional(),
  }).strict(),
  nodes: z.array(strategyPackNodeSchema).min(1),
  scenarios: z.array(strategyPackScenarioManifestSchema).min(1),
}).strict();

export interface StrategyPackSource {
  readonly name: string;
  readonly version: string;
  readonly timestamp: string;
  readonly solver?: string;
  readonly commit?: string;
  readonly sourceUrl?: string;
  readonly license?: string;
}

export interface StrategyPackConvergence {
  readonly exploitabilityBB: number;
  readonly exploitabilityPctPot: number;
  readonly targetExploitabilityBB: number;
  readonly targetExploitabilityPctPot: number;
  readonly iterations: number;
  readonly solver: string;
  readonly compression?: string;
}

export interface ValidatedStrategyPackNode extends CacheHashes {
  readonly provenance: "SOLVED";
  /** Fixed-point BB units keyed by SeatId string, matching StrategyQuery.stacksBB. */
  readonly stackBB: Readonly<Record<string, BB>>;
  readonly potBB: BB;
  readonly rake: RakeConfig;
  readonly board: readonly Card[];
  readonly legalActions: readonly PokerAction[];
  readonly convergence?: StrategyPackConvergence;
  readonly notes?: readonly string[];
  readonly comboPolicy: ComboPolicy;
}

export interface ValidatedStrategyPack {
  readonly schemaVersion: typeof STRATEGY_PACK_SCHEMA_VERSION;
  readonly packId: string;
  readonly source: StrategyPackSource;
  readonly nodes: readonly ValidatedStrategyPackNode[];
  readonly scenarios: readonly StrategyPackScenarioManifest[];
}

function validateParsedPack(pack: ValidatedStrategyPack): ValidatedStrategyPack {
  const seenNodes = new Set<string>();
  for (const node of pack.nodes) {
    const identity = cacheHashesKey(node);
    if (seenNodes.has(identity)) throw new RangeError(`Duplicate strategy-pack state: ${node.nodeHash}`);
    seenNodes.add(identity);
    assertUniqueCards(node.board);
    if (Object.keys(node.stackBB).length === 0) throw new RangeError(`Strategy-pack node ${node.nodeHash} has no stack ledger`);
    const legalKeys = node.legalActions.map(actionKey);
    if (new Set(legalKeys).size !== legalKeys.length) throw new RangeError(`Strategy-pack node ${node.nodeHash} has duplicate legal actions`);
    validateComboPolicy(node.comboPolicy, node.legalActions);
    const board = new Set(node.board);
    for (const row of node.comboPolicy) {
      if (row.cards.some((value) => board.has(value))) {
        throw new RangeError(`Combo ${comboId(...row.cards)} collides with the board at node ${node.nodeHash}`);
      }
    }
  }
  const scenarios = pack.scenarios.map(parseStrategyPackScenarioManifest);
  const scenariosByIdentity = new Map<string, StrategyPackScenarioManifest>();
  const seenScenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenScenarioIds.has(scenario.id)) throw new RangeError(`Duplicate strategy-pack scenario id: ${scenario.id}`);
    seenScenarioIds.add(scenario.id);
    const identity = strategyPackScenarioIdentityKey(scenario);
    if (scenariosByIdentity.has(identity)) throw new RangeError(`Duplicate strategy-pack scenario for node ${scenario.nodeIdentity.nodeHash}`);
    scenariosByIdentity.set(identity, scenario);
  }
  for (const node of pack.nodes) {
    const identity = cacheHashesKey(node);
    const scenario = scenariosByIdentity.get(identity);
    if (scenario === undefined) throw new RangeError(`Strategy-pack node ${node.nodeHash} has no replayable scenario manifest`);
    assertScenarioMatchesNodeIdentity(scenario, node);
    if (deterministicHash(scenario.expected.board) !== deterministicHash(node.board)) {
      throw new RangeError(`Scenario ${scenario.id} expected board does not match solved node ${node.nodeHash}`);
    }
    if (scenario.expected.potBB !== node.potBB) {
      throw new RangeError(`Scenario ${scenario.id} expected pot does not match solved node ${node.nodeHash}`);
    }
    if (deterministicHash(scenario.expected.stacksBB) !== deterministicHash(node.stackBB)) {
      throw new RangeError(`Scenario ${scenario.id} expected stacks do not match solved node ${node.nodeHash}`);
    }
    if (deterministicHash(scenario.config.rake) !== deterministicHash(node.rake)) {
      throw new RangeError(`Scenario ${scenario.id} rake does not match solved node ${node.nodeHash}`);
    }
    scenariosByIdentity.delete(identity);
  }
  const orphan = scenariosByIdentity.values().next().value as StrategyPackScenarioManifest | undefined;
  if (orphan !== undefined) throw new RangeError(`Strategy-pack scenario ${orphan.id} has no matching solved node`);
  return { ...pack, scenarios };
}

export function parseStrategyPack(value: unknown): ValidatedStrategyPack {
  if (value !== null && typeof value === "object" && "schemaVersion" in value
    && (value as { readonly schemaVersion?: unknown }).schemaVersion === LEGACY_STRATEGY_PACK_SCHEMA_VERSION) {
    throw new RangeError("Strategy-pack schema 1.0.0 is not drillable and cannot be imported as SOLVED. Upgrade to schema 2.0.0 with exactly one replayable scenario manifest per node.");
  }
  const parsed = strategyPackSchema.parse(value) as unknown as ValidatedStrategyPack;
  return validateParsedPack(parsed);
}

export function parseStrategyPackJson(json: string): ValidatedStrategyPack {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new SyntaxError(`Malformed strategy-pack JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseStrategyPack(value);
}

export const STRATEGY_PACK_CSV_COLUMNS = [
  "schema_version", "pack_id", "source_name", "source_version", "source_timestamp", "provenance",
  "game_config_hash", "range_hash", "tree_hash", "node_hash", "board_canonical_hash",
  "scenario_json",
  "stack_units_json", "pot_units", "rake_json", "board_json", "legal_actions_json",
  "combo_cards_json", "combo_weight", "action_json", "frequency", "ev_units",
] as const;

function csvRows(source: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) throw new SyntaxError("CSV quote must begin at the start of a field");
      quoted = true;
    } else if (character === ",") {
      row.push(cell); cell = "";
    } else if (character === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else if (character !== "\r") cell += character;
  }
  if (quoted) throw new SyntaxError("CSV contains an unterminated quoted field");
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

function jsonCell(value: string, column: string, rowNumber: number): unknown {
  try { return JSON.parse(value) as unknown; }
  catch (error) { throw new SyntaxError(`CSV row ${rowNumber} ${column} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function numberCell(value: string, column: string, rowNumber: number, integer = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) throw new RangeError(`CSV row ${rowNumber} ${column} must be ${integer ? "a safe integer" : "finite"}`);
  return parsed;
}

/**
 * Parses RFC-4180-style combo-action rows. JSON-valued cells preserve nested
 * legal actions, stacks, rake, board, and exact two-card identities. BB money
 * columns are fixed-point integer units, matching the JSON schema.
 */
export function parseStrategyPackCsv(csv: string): ValidatedStrategyPack {
  const rows = csvRows(csv);
  const header = rows[0];
  if (header === undefined) throw new RangeError("Strategy-pack CSV is empty");
  const indexes = new Map(header.map((name, index) => [name.trim(), index]));
  const missing = STRATEGY_PACK_CSV_COLUMNS.filter((name) => !indexes.has(name));
  if (missing.length > 0) throw new RangeError(`Strategy-pack CSV is missing columns: ${missing.join(", ")}`);
  if (new Set(header.map((name) => name.trim())).size !== header.length) throw new RangeError("Strategy-pack CSV has duplicate columns");
  const unexpected = header.map((name) => name.trim()).filter((name) => !(STRATEGY_PACK_CSV_COLUMNS as readonly string[]).includes(name));
  if (unexpected.length > 0) throw new RangeError(`Strategy-pack CSV has unexpected columns: ${unexpected.join(", ")}`);
  const valueAt = (row: readonly string[], name: (typeof STRATEGY_PACK_CSV_COLUMNS)[number], rowNumber: number): string => {
    const value = row[indexes.get(name)!];
    if (value === undefined) throw new RangeError(`CSV row ${rowNumber} is missing ${name}`);
    return value.trim();
  };
  type ComboAccumulator = { cards: unknown; weight: number; actions: unknown[] };
  type NodeAccumulator = { base: Record<string, unknown>; scenario: unknown; combos: Map<string, ComboAccumulator> };
  const nodes = new Map<string, NodeAccumulator>();
  let packIdentity: { schemaVersion: string; packId: string; sourceName: string; sourceVersion: string; sourceTimestamp: string } | undefined;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rowNumber = index + 1;
    const identity = {
      schemaVersion: valueAt(row, "schema_version", rowNumber),
      packId: valueAt(row, "pack_id", rowNumber),
      sourceName: valueAt(row, "source_name", rowNumber),
      sourceVersion: valueAt(row, "source_version", rowNumber),
      sourceTimestamp: valueAt(row, "source_timestamp", rowNumber),
    };
    if (packIdentity === undefined) packIdentity = identity;
    else if (deterministicHash(packIdentity) !== deterministicHash(identity)) throw new RangeError(`CSV row ${rowNumber} changes pack/source metadata`);
    if (valueAt(row, "provenance", rowNumber) !== "SOLVED") throw new RangeError(`CSV row ${rowNumber} provenance must be SOLVED`);
    const hashes = {
      gameConfigHash: valueAt(row, "game_config_hash", rowNumber),
      rangeHash: valueAt(row, "range_hash", rowNumber),
      treeHash: valueAt(row, "tree_hash", rowNumber),
      nodeHash: valueAt(row, "node_hash", rowNumber),
      boardCanonicalHash: valueAt(row, "board_canonical_hash", rowNumber),
    };
    const nodeKey = cacheHashesKey(hashes);
    const scenario = jsonCell(valueAt(row, "scenario_json", rowNumber), "scenario_json", rowNumber);
    const base: Record<string, unknown> = {
      provenance: "SOLVED",
      ...hashes,
      stackBB: jsonCell(valueAt(row, "stack_units_json", rowNumber), "stack_units_json", rowNumber),
      potBB: numberCell(valueAt(row, "pot_units", rowNumber), "pot_units", rowNumber, true),
      rake: jsonCell(valueAt(row, "rake_json", rowNumber), "rake_json", rowNumber),
      board: jsonCell(valueAt(row, "board_json", rowNumber), "board_json", rowNumber),
      legalActions: jsonCell(valueAt(row, "legal_actions_json", rowNumber), "legal_actions_json", rowNumber),
    };
    let node = nodes.get(nodeKey);
    if (node === undefined) { node = { base, scenario, combos: new Map() }; nodes.set(nodeKey, node); }
    else {
      if (deterministicHash(node.base) !== deterministicHash(base)) throw new RangeError(`CSV row ${rowNumber} changes state metadata within node ${hashes.nodeHash}`);
      if (deterministicHash(node.scenario) !== deterministicHash(scenario)) throw new RangeError(`CSV row ${rowNumber} changes scenario manifest within node ${hashes.nodeHash}`);
    }
    const cards = jsonCell(valueAt(row, "combo_cards_json", rowNumber), "combo_cards_json", rowNumber);
    if (!Array.isArray(cards) || cards.length !== 2 || !cards.every((value) => typeof value === "string")) throw new RangeError(`CSV row ${rowNumber} combo_cards_json must be a two-card JSON array`);
    const comboKey = [...cards].sort().join("");
    const weight = numberCell(valueAt(row, "combo_weight", rowNumber), "combo_weight", rowNumber);
    let combo = node.combos.get(comboKey);
    if (combo === undefined) { combo = { cards, weight, actions: [] }; node.combos.set(comboKey, combo); }
    else if (combo.weight !== weight || deterministicHash(combo.cards) !== deterministicHash(cards)) throw new RangeError(`CSV row ${rowNumber} changes combo identity or weight`);
    const action = jsonCell(valueAt(row, "action_json", rowNumber), "action_json", rowNumber);
    const frequency = numberCell(valueAt(row, "frequency", rowNumber), "frequency", rowNumber);
    const ev = valueAt(row, "ev_units", rowNumber);
    combo.actions.push({ action, frequency, ...(ev === "" ? {} : { evBB: numberCell(ev, "ev_units", rowNumber, true) }) });
  }
  if (packIdentity === undefined) throw new RangeError("Strategy-pack CSV has no data rows");
  return parseStrategyPack({
    schemaVersion: packIdentity.schemaVersion,
    packId: packIdentity.packId,
    source: { name: packIdentity.sourceName, version: packIdentity.sourceVersion, timestamp: packIdentity.sourceTimestamp },
    nodes: [...nodes.values()].map(({ base, combos }) => ({ ...base, comboPolicy: [...combos.values()] })),
    scenarios: [...nodes.values()].map(({ scenario }) => scenario),
  });
}

export interface StrategyPackCompatibility {
  readonly compatible: boolean;
  readonly issues: readonly string[];
  readonly expectedHashes: CacheHashes;
}

function sameActionSet(left: readonly PokerAction[], right: readonly PokerAction[]): boolean {
  const leftKeys = [...left].map(actionKey).sort();
  const rightKeys = [...right].map(actionKey).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
}

export function checkStrategyPackCompatibility(node: ValidatedStrategyPackNode, query: StrategyQuery): StrategyPackCompatibility {
  const expectedHashes = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  const issues: string[] = [];
  for (const key of ["gameConfigHash", "rangeHash", "treeHash", "nodeHash", "boardCanonicalHash"] as const) {
    if (node[key] !== expectedHashes[key]) issues.push(`${key} mismatch`);
  }
  if (node.potBB !== query.potBB) issues.push("potBB mismatch");
  if (deterministicHash(node.stackBB) !== deterministicHash(query.stacksBB)) issues.push("stackBB mismatch");
  if (deterministicHash(node.rake) !== deterministicHash(query.rake)) issues.push("rake mismatch");
  if (deterministicHash(node.board) !== deterministicHash(query.board)) issues.push("board mismatch");
  if (!sameActionSet(node.legalActions, query.legalActions)) issues.push("legal actions mismatch");
  return { compatible: issues.length === 0, issues, expectedHashes };
}

export function strategyResultFromPackNode(node: ValidatedStrategyPackNode): {
  readonly actions: readonly StrategyAction[];
  readonly comboPolicy: ComboPolicy;
} {
  return { actions: aggregateComboPolicy(node.comboPolicy, node.legalActions), comboPolicy: node.comboPolicy };
}

export * from "./strategyPackScenario";
