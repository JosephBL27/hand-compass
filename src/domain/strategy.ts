import { actionKey, type PokerAction } from "./actions";
import type { ActionTreeConfig } from "./actionTree";
import type { Card } from "./cards";
import type { ComboPolicy } from "./comboPolicy";
import type { GameConfig } from "./config";
import { cacheHashesKey, createStrategyQueryHashes, sameCacheHashes, type CacheHashes } from "./hash";
import type { BB } from "./money";
import { weightedComboCount, type WeightedRange } from "./ranges";
import type { SeatId } from "./seats";
import type { PlayerStatus, Street } from "./rules";
import {
  checkStrategyPackCompatibility,
  parseStrategyPack,
  parseStrategyPackCsv,
  parseStrategyPackJson,
  strategyResultFromPackNode,
  type ValidatedStrategyPack,
} from "./strategyPack";

export type StrategyProvenance = "SOLVED" | "EXACT_MATH" | "INTERPOLATED" | "HEURISTIC";

/**
 * Public rules-engine ledger required by a local solver to reconstruct the
 * current street. Private cards, the undealt deck, and future board cards are
 * intentionally excluded.
 */
export interface StrategyPublicState {
  readonly buttonIndex: number;
  readonly currentBetBB: BB;
  readonly lastFullRaiseBB: BB;
  readonly players: readonly {
    readonly id: SeatId;
    readonly stackBB: BB;
    readonly streetContributionBB: BB;
    readonly totalContributionBB: BB;
    readonly status: PlayerStatus;
  }[];
  readonly actionHistory: readonly {
    readonly seatId: SeatId;
    readonly street: Street;
    readonly action: PokerAction;
    readonly potAfterBB: BB;
  }[];
}

export interface StrategyQuery {
  readonly nodeHash: string;
  /** The seat whose legal action is being requested at this node. */
  readonly actorSeatId: SeatId;
  readonly actorPosition: string;
  /** The user-controlled seat remains stable while opponents are automated. */
  readonly heroSeatId: SeatId;
  readonly gameConfig: GameConfig;
  readonly street: Street;
  readonly board: readonly Card[];
  readonly actionHistory: readonly PokerAction[];
  /** Present on live rules-engine queries; legacy/import-only query fixtures may omit it. */
  readonly publicState?: StrategyPublicState;
  readonly potBB: BB;
  readonly stacksBB: Readonly<Record<SeatId, BB>>;
  readonly heroPosition: string;
  readonly opponentPositions: readonly string[];
  readonly ranges: Readonly<Partial<Record<SeatId, WeightedRange>>>;
  readonly legalActions: readonly PokerAction[];
  readonly actionTree: ActionTreeConfig;
  readonly rake: GameConfig["rake"];
  readonly deadCards: readonly Card[];
}

export interface StrategyAction {
  readonly action: PokerAction;
  readonly frequency?: number;
  readonly evBB?: BB;
}

export interface StrategyResult {
  readonly provenance: StrategyProvenance;
  readonly actions: readonly StrategyAction[];
  readonly comboPolicy?: ComboPolicy;
  readonly convergence?: {
    readonly exploitability?: number;
    readonly exploitabilityBB?: number;
    readonly exploitabilityPctPot?: number;
    readonly targetExploitabilityBB?: number;
    readonly targetExploitabilityPctPot?: number;
    readonly iterations?: number;
    readonly solver?: string;
    readonly compression?: string;
  };
  readonly sourceNodeId?: string;
  readonly confidence?: number;
  readonly notes?: readonly string[];
  readonly source?: {
    readonly id: string;
    readonly name?: string;
    readonly solver?: string;
    readonly version?: string;
    readonly timestamp?: string;
    readonly commit?: string;
    readonly sourceUrl?: string;
    readonly license?: string;
  };
  readonly configuration?: CacheHashes & {
    readonly actionTreeId: string;
    readonly potBB: BB;
    readonly stacksBB: Readonly<Record<SeatId, BB>>;
    readonly board: readonly Card[];
    readonly rake: GameConfig["rake"];
    readonly ranges: Readonly<Record<string, { readonly comboCount: number; readonly weightedComboCount: number }>>;
  };
}

export function strategyConfigurationForQuery(query: StrategyQuery): NonNullable<StrategyResult["configuration"]> {
  const hashes = createStrategyQueryHashes({ gameConfig: query.gameConfig, ranges: query.ranges, tree: query.actionTree, nodeHash: query.nodeHash, board: query.board });
  const ranges = Object.fromEntries(Object.entries(query.ranges)
    .filter((entry): entry is [string, WeightedRange] => entry[1] !== undefined)
    .map(([seat, range]) => [seat, { comboCount: range.size, weightedComboCount: weightedComboCount(range) }]));
  return {
    ...hashes,
    actionTreeId: query.actionTree.id,
    potBB: query.potBB,
    stacksBB: query.stacksBB,
    board: query.board,
    rake: query.rake,
    ranges,
  };
}

export interface StrategyProvider {
  readonly id: string;
  getStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult>;
}

export interface StrategyRequestContext {
  readonly signal?: AbortSignal;
}

export class StrategyUnavailableError extends Error {
  readonly providerId: string | undefined;
  readonly reason: string;

  constructor(reason: string, providerId?: string) {
    super(providerId === undefined ? reason : `${providerId}: ${reason}`);
    this.name = "StrategyUnavailableError";
    this.providerId = providerId;
    this.reason = reason;
  }
}

export function validateStrategyResult(result: StrategyResult, legalActions?: readonly PokerAction[]): StrategyResult {
  const legalKeys = legalActions === undefined ? null : new Set(legalActions.map(actionKey));
  const seen = new Set<string>();
  for (const item of result.actions) {
    const key = actionKey(item.action);
    if (seen.has(key)) throw new RangeError(`Duplicate strategy action: ${key}`);
    if (legalKeys !== null && !legalKeys.has(key)) throw new RangeError(`Strategy contains illegal action: ${key}`);
    seen.add(key);
    if (item.frequency !== undefined && (!Number.isFinite(item.frequency) || item.frequency < 0 || item.frequency > 1)) {
      throw new RangeError("Strategy frequency must be in [0, 1]");
    }
    if (item.evBB !== undefined && !Number.isSafeInteger(item.evBB)) throw new RangeError("EV must use fixed BB units");
  }
  return result;
}

export class SolvedStrategyProvider implements StrategyProvider {
  readonly id: string;
  readonly #nodes: ReadonlyMap<string, StrategyResult>;

  /** `nodes` must be keyed with cacheHashesKey(createStrategyQueryHashes(...)). */
  constructor(id: string, nodes: ReadonlyMap<string, StrategyResult>) {
    this.id = id;
    this.#nodes = nodes;
  }

  async getStrategy(query: StrategyQuery): Promise<StrategyResult> {
    const identity = createStrategyQueryHashes({
      gameConfig: query.gameConfig,
      ranges: query.ranges,
      tree: query.actionTree,
      nodeHash: query.nodeHash,
      board: query.board,
    });
    const result = this.#nodes.get(cacheHashesKey(identity));
    if (result === undefined) throw new StrategyUnavailableError("No solved node matched this exact configuration.", this.id);
    if (result.provenance !== "SOLVED") throw new RangeError("Solved provider accepts only SOLVED nodes");
    return validateStrategyResult(result, query.legalActions);
  }
}

export type ImportedStrategyPack = ValidatedStrategyPack;

export class ImportedSolutionProvider implements StrategyProvider {
  readonly id: string;
  readonly #pack: ValidatedStrategyPack;

  constructor(id: string, pack: unknown) {
    this.id = id;
    this.#pack = parseStrategyPack(pack);
  }

  static fromJson(id: string, json: string): ImportedSolutionProvider {
    return new ImportedSolutionProvider(id, parseStrategyPackJson(json));
  }

  /** Accepts only schema-defined combo-action CSV, never aggregate charts. */
  static fromCsv(id: string, _version: string, csv: string): ImportedSolutionProvider {
    return new ImportedSolutionProvider(id, parseStrategyPackCsv(csv));
  }

  async getStrategy(query: StrategyQuery): Promise<StrategyResult> {
    const expected = createStrategyQueryHashes({
      gameConfig: query.gameConfig,
      ranges: query.ranges,
      tree: query.actionTree,
      nodeHash: query.nodeHash,
      board: query.board,
    });
    const node = this.#pack.nodes.find((candidate) => sameCacheHashes(candidate, expected));
    if (node === undefined) {
      const sameNode = this.#pack.nodes.find((candidate) => candidate.nodeHash === query.nodeHash);
      if (sameNode !== undefined) {
        const mismatch = checkStrategyPackCompatibility(sameNode, query);
        throw new RangeError(`Imported node ${sameNode.nodeHash} is incompatible: ${mismatch.issues.join(", ")}`);
      }
      throw new StrategyUnavailableError(`Node absent from imported pack ${this.#pack.packId}.`, this.id);
    }
    const compatibility = checkStrategyPackCompatibility(node, query);
    if (!compatibility.compatible) {
      throw new RangeError(`Imported node ${node.nodeHash} is incompatible: ${compatibility.issues.join(", ")}`);
    }
    const policy = strategyResultFromPackNode(node);
    return validateStrategyResult({
      provenance: "SOLVED",
      actions: policy.actions,
      comboPolicy: policy.comboPolicy,
      sourceNodeId: node.nodeHash,
      source: {
        id: this.#pack.packId,
        name: this.#pack.source.name,
        ...(this.#pack.source.solver === undefined ? {} : { solver: this.#pack.source.solver }),
        version: this.#pack.source.version,
        timestamp: this.#pack.source.timestamp,
        ...(this.#pack.source.commit === undefined ? {} : { commit: this.#pack.source.commit }),
        ...(this.#pack.source.sourceUrl === undefined ? {} : { sourceUrl: this.#pack.source.sourceUrl }),
        ...(this.#pack.source.license === undefined ? {} : { license: this.#pack.source.license }),
      },
      ...(node.convergence === undefined ? {} : { convergence: node.convergence }),
      configuration: strategyConfigurationForQuery(query),
      notes: [
        ...(node.notes ?? []),
        `Validated imported pack ${this.#pack.packId} from ${this.#pack.source.name} ${this.#pack.source.version}.`,
      ],
    }, query.legalActions);
  }
}

export interface LocalSolverTransport {
  request(query: StrategyQuery, signal?: AbortSignal): Promise<unknown>;
}

export type LocalSolverDecoder = (payload: unknown, query: StrategyQuery) => StrategyResult;

export class LocalSolverProvider implements StrategyProvider {
  readonly id: string;
  readonly #transport: LocalSolverTransport;
  readonly #decoder: LocalSolverDecoder;

  constructor(id: string, transport: LocalSolverTransport, decoder: LocalSolverDecoder) {
    this.id = id;
    this.#transport = transport;
    this.#decoder = decoder;
  }

  async getStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult> {
    const payload = await this.#transport.request(query, context?.signal);
    const result = this.#decoder(payload, query);
    if (result.provenance !== "SOLVED") throw new RangeError("Local solver decoder must explicitly return SOLVED provenance");
    return validateStrategyResult(result, query.legalActions);
  }
}

export interface InterpolationBracket {
  readonly lower: StrategyResult;
  readonly upper: StrategyResult;
  readonly weight: number;
  readonly variables: Readonly<Record<string, readonly [number, number, number]>>;
  readonly compatible: boolean;
}

export type InterpolationResolver = (query: StrategyQuery) => Promise<InterpolationBracket | null>;

export class InterpolatedStrategyProvider implements StrategyProvider {
  readonly id: string;
  readonly #resolve: InterpolationResolver;

  constructor(id: string, resolve: InterpolationResolver) {
    this.id = id;
    this.#resolve = resolve;
  }

  async getStrategy(query: StrategyQuery): Promise<StrategyResult> {
    const bracket = await this.#resolve(query);
    if (bracket === null || !bracket.compatible) throw new StrategyUnavailableError("No compatible solved states were available for interpolation.", this.id);
    if (bracket.weight < 0 || bracket.weight > 1) throw new RangeError("Interpolation weight must be in [0, 1]");
    if (bracket.lower.provenance !== "SOLVED" || bracket.upper.provenance !== "SOLVED") throw new RangeError("Interpolation endpoints must be solved");
    const upper = new Map(bracket.upper.actions.map((item) => [actionKey(item.action), item]));
    const actions: StrategyAction[] = [];
    for (const lowerAction of bracket.lower.actions) {
      const upperAction = upper.get(actionKey(lowerAction.action));
      if (upperAction === undefined) continue;
      const item: { action: PokerAction; frequency?: number; evBB?: BB } = { action: lowerAction.action };
      if (lowerAction.frequency !== undefined && upperAction.frequency !== undefined) {
        item.frequency = lowerAction.frequency + (upperAction.frequency - lowerAction.frequency) * bracket.weight;
      }
      if (lowerAction.evBB !== undefined && upperAction.evBB !== undefined) {
        item.evBB = Math.round(lowerAction.evBB + (upperAction.evBB - lowerAction.evBB) * bracket.weight) as BB;
      }
      actions.push(item);
    }
    const endpointConfidence = Math.min(bracket.lower.confidence ?? 1, bracket.upper.confidence ?? 1);
    return validateStrategyResult({
      provenance: "INTERPOLATED",
      actions,
      confidence: endpointConfidence * (1 - Math.abs(0.5 - bracket.weight) * 0.2),
      notes: [`Interpolated explicitly between compatible solved nodes at weight ${bracket.weight}.`, `Variables: ${JSON.stringify(bracket.variables)}`],
    }, query.legalActions);
  }
}

export interface HeuristicAdvice {
  readonly actions: readonly PokerAction[];
  readonly notes: readonly string[];
}

export class HeuristicStrategyProvider implements StrategyProvider {
  readonly id: string;
  readonly #advise: (query: StrategyQuery) => HeuristicAdvice;

  constructor(id: string, advise: (query: StrategyQuery) => HeuristicAdvice) {
    this.id = id;
    this.#advise = advise;
  }

  async getStrategy(query: StrategyQuery): Promise<StrategyResult> {
    const advice = this.#advise(query);
    const legal = new Set(query.legalActions.map(actionKey));
    return {
      provenance: "HEURISTIC",
      actions: advice.actions.filter((action) => legal.has(actionKey(action))).map((action) => ({ action })),
      notes: [...advice.notes, "Exact frequencies and action EVs are unavailable in heuristic mode."],
    };
  }
}
