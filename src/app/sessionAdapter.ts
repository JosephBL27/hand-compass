import { actionKey, type PokerAction } from "../domain/actions";
import { card, type Card } from "../domain/cards";
import { COMBO_POLICY_ROUNDING_TOLERANCE, type ComboPolicy } from "../domain/comboPolicy";
import type { RngMode } from "../domain/grading";
import { DEFAULT_LOCAL_SOLVER_ENDPOINT, HttpLocalSolverTransport } from "../domain/httpLocalSolverTransport";
import { decodeLocalSolverResponse } from "../domain/localSolverProtocol";
import {
  StrategyProviderRegistry,
  type RegisteredStrategyProvider,
} from "../domain/providerRegistry";
import {
  ImportedSolutionProvider,
  LocalSolverProvider,
  StrategyUnavailableError,
  strategyConfigurationForQuery,
  type StrategyProvider,
  type StrategyRequestContext,
} from "../domain/strategy";
import {
  CachingStrategyProvider,
  IndexedDbStrategyCache,
  MemoryStrategyCache,
  type StrategyCache,
  type StrategyCacheEntry,
} from "../domain/strategyCache";
import { parseStrategyPackCsv, parseStrategyPackJson } from "../domain/strategyPack";
import { parseStrategyPack } from "../domain/strategyPack";
import { comboId } from "../domain/ranges";
import { createAcceptanceNodeDefinition } from "../fixtures/acceptanceSpot";
import { createFullHandDefinition, type FullHandDealOptions } from "../fixtures/fullHand";
import { ScenarioCatalog } from "../session/catalog";
import { createGeneratedScenarioDefinitions } from "../session/generatedScenarios";
import { DrillSession } from "../session/DrillSession";
import { validateStrategyPackScenarioCatalog } from "../session/packScenario";
import type { DrillSnapshot, ScenarioFilter } from "../session/types";
import { parseCustomSpotJson, prepareCustomSpot } from "../builder";
import bundledAcceptancePackJson from "../solutions/acceptance-qsts-solved.pack.json";

export type UiRngMode = "Off" | "High RNG" | "Low RNG";
export type UiDrillMode = "Node drill" | "Full hand" | "Custom spot";
export const EDUCATIONAL_PROVIDER_ID = "acceptance-education";
export const BUNDLED_SOLVED_PROVIDER_ID = "bundled:acceptance-qsts-postflop-2026-08-28";
export const LOCAL_SOLVER_PROVIDER_ID = "local-solver";
export { DEFAULT_LOCAL_SOLVER_ENDPOINT };

export interface AcceptanceSessionController {
  readonly session: DrillSession;
  readonly catalog: ScenarioCatalog;
  readonly snapshot: DrillSnapshot;
  readonly mode: UiDrillMode;
  readonly scenarioId?: string;
}

export interface ImportedPackSummary {
  readonly status: "loaded";
  readonly fileName: string;
  readonly packId: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly timestamp: string;
  readonly nodeCount: number;
  readonly comboRowCount: number;
  readonly completeEvComboRowCount: number;
  readonly providerId: string;
  readonly provider: StrategyProvider;
  readonly catalog: ScenarioCatalog;
}

export interface ImportedPackFailure {
  readonly status: "error";
  readonly fileName: string;
  readonly message: string;
}

export type ImportedPackResult = ImportedPackSummary | ImportedPackFailure;

export function domainRngMode(mode: UiRngMode): RngMode {
  if (mode === "High RNG") return "high";
  if (mode === "Low RNG") return "low";
  return "off";
}

function educationalActions(legalActions: readonly PokerAction[]): readonly PokerAction[] {
  const preferred = legalActions.find(({ kind }) => kind === "call")
    ?? legalActions.find(({ kind }) => kind === "check")
    ?? legalActions[0];
  if (preferred === undefined) return [];
  const smallestNonJamRaise = legalActions.find(({ kind }) => kind === "raise" || kind === "bet");
  return smallestNonJamRaise === undefined ? [preferred] : [preferred, smallestNonJamRaise];
}

const RANK_SCORE: Readonly<Record<string, number>> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function profileCombo(cards: readonly [Card, Card], board: readonly Card[]) {
  const firstRank = cards[0][0] ?? "2";
  const secondRank = cards[1][0] ?? "2";
  const first = RANK_SCORE[firstRank] ?? 2;
  const second = RANK_SCORE[secondRank] ?? 2;
  const pocketPair = first === second;
  const suited = cards[0][1] === cards[1][1];
  const connected = Math.abs(first - second) <= 1;
  const boardRanks = new Set(board.map((value) => value[0]));
  const madePair = pocketPair || boardRanks.has(firstRank) || boardRanks.has(secondRank);
  const flushDraw = board.length < 5 && ["s", "h", "d", "c"].some((suit) => {
    const holeCount = cards.filter((value) => value[1] === suit).length;
    const totalCount = holeCount + board.filter((value) => value[1] === suit).length;
    return holeCount > 0 && totalCount === 4;
  });
  const premium = pocketPair && first >= 10 || first + second >= 25 || Math.max(first, second) === 14 && Math.min(first, second) >= 11;
  const playable = pocketPair || premium || suited && Math.min(first, second) >= 6 || connected && Math.max(first, second) >= 9 || Math.max(first, second) === 14;
  return { pocketPair, madePair, flushDraw, premium, playable };
}

function comboActionForQuery(
  cards: readonly [Card, Card],
  query: Parameters<StrategyProvider["getStrategy"]>[0],
): PokerAction {
  const profile = profileCombo(cards, query.board);
  const legal = query.legalActions;
  const check = legal.find((action) => action.kind === "check");
  const call = legal.find((action) => action.kind === "call");
  const fold = legal.find((action) => action.kind === "fold");
  const aggressive = legal.find((action) => action.kind === "bet" || action.kind === "raise");
  const fallback = check ?? call ?? fold ?? legal[0];
  if (fallback === undefined) throw new RangeError("Heuristic policy received a node with no legal actions.");

  if (query.street === "preflop") {
    if (aggressive !== undefined && profile.premium) return aggressive;
    if (call !== undefined && profile.playable) return call;
    return fold ?? call ?? aggressive ?? fallback;
  }
  if (check !== undefined) {
    if (aggressive !== undefined && profile.pocketPair && profile.madePair) return aggressive;
    return check;
  }
  if (call !== undefined && (profile.madePair || profile.flushDraw || profile.premium)) return call;
  return fold ?? call ?? fallback;
}

function heuristicComboPolicy(query: Parameters<StrategyProvider["getStrategy"]>[0]): ComboPolicy {
  const actorRange = query.ranges[query.actorSeatId];
  const byCombo = new Map<string, { readonly cards: readonly [Card, Card]; readonly weight: number }>();
  for (const combo of actorRange?.values() ?? []) {
    if (combo.weight <= 0) continue;
    byCombo.set(combo.id, combo);
  }
  if (byCombo.size === 0) throw new RangeError("Heuristic combo policy requires at least one positive-mass public range.");
  return [...byCombo.values()].map((combo) => {
    const action = comboActionForQuery(combo.cards, query);
    return { cards: combo.cards, weight: combo.weight, actions: [{ action, frequency: 1 }] };
  });
}

export function createEducationalProvider(): StrategyProvider {
  return {
    id: EDUCATIONAL_PROVIDER_ID,
    async getStrategy(query) {
      return {
        provenance: "HEURISTIC",
        actions: educationalActions(query.legalActions).map((action) => ({ action })),
        comboPolicy: heuristicComboPolicy(query),
        source: { id: EDUCATIONAL_PROVIDER_ID, name: "Built-in educational policy" },
        configuration: strategyConfigurationForQuery(query),
        notes: [
          query.street === "preflop"
            ? "Educational automation uses card-class rules: stronger holdings raise, playable holdings continue, and weaker holdings fold."
            : "Educational automation checks when available, continues made hands and draws versus bets, and may value-bet very strong made hands.",
          "Every opponent action is selected from the row for its already-dealt combo and dispatched through the legal action set.",
          "HEURISTIC only: no equilibrium frequency, action EV, or GTO claim is available.",
          "Exact frequencies and action EVs are unavailable in heuristic mode.",
        ],
      };
    },
  };
}

const bundledAcceptancePack = parseStrategyPack(bundledAcceptancePackJson);

function createBundledSolvedProvider(): StrategyProvider {
  const solved = new ImportedSolutionProvider(BUNDLED_SOLVED_PROVIDER_ID, bundledAcceptancePack);
  const educational = createEducationalProvider();
  return {
    id: BUNDLED_SOLVED_PROVIDER_ID,
    async getStrategy(query, context) {
      try {
        return await solved.getStrategy(query);
      } catch (error) {
        if (!(error instanceof StrategyUnavailableError)) throw error;
        const fallback = await educational.getStrategy(query, context);
        return {
          ...fallback,
          notes: [
            `No exact node for ${query.nodeHash} exists in bundled solved pack ${bundledAcceptancePack.packId}; this continuation is explicitly HEURISTIC.`,
            ...(fallback.notes ?? []),
          ],
        };
      }
    },
  };
}

function bundledScenarioCatalog(provider: StrategyProvider): ScenarioCatalog {
  return validateStrategyPackScenarioCatalog(bundledAcceptancePack, provider);
}

/** Replayed training inputs and real imported evidence share a single browsable deck. */
export function createPracticeCatalog(provider: StrategyProvider): ScenarioCatalog {
  return new ScenarioCatalog([
    ...bundledScenarioCatalog(provider).all().map(({ definition }) => definition),
    ...createGeneratedScenarioDefinitions({ strategyProvider: provider, variantsPerFamily: 2 }),
  ]);
}

export function createAcceptanceProviderRegistry(): StrategyProviderRegistry {
  const registry = new StrategyProviderRegistry();
  registry.register({
    provider: createBundledSolvedProvider(),
    metadata: {
      label: "Bundled acceptance solve",
      kind: "SOLVED_PACK",
      description: "411 exact Hero combo rows with complete six-action EVs at the acceptance node; unsupported continuation nodes switch visibly to HEURISTIC.",
      possibleProvenance: ["SOLVED", "HEURISTIC"],
      source: `${bundledAcceptancePack.source.name} ${bundledAcceptancePack.source.version} · ${bundledAcceptancePack.source.timestamp}`,
    },
    availability: { state: "AVAILABLE", checkedAt: bundledAcceptancePack.source.timestamp },
  });
  registry.register({
    provider: createEducationalProvider(),
    metadata: {
      label: "Educational fallback",
      kind: "HEURISTIC",
      description: "Local explanatory rules with no solver frequency or EV claims.",
      possibleProvenance: ["HEURISTIC"],
      source: "Built-in educational policy",
    },
    availability: { state: "AVAILABLE" },
  });
  return registry;
}

export interface CreateAcceptanceSessionOptions {
  readonly registry?: StrategyProviderRegistry;
  readonly activeProviderId?: string;
  readonly context?: StrategyRequestContext;
}

export interface CreateTrainerSessionOptions extends CreateAcceptanceSessionOptions {
  readonly drillMode?: UiDrillMode;
  readonly fullHand?: FullHandDealOptions;
  readonly nodeFilter?: ScenarioFilter;
  readonly scenarioCatalog?: ScenarioCatalog;
}

export const DEFAULT_FULL_HAND_OPTIONS: FullHandDealOptions = {
  playerCount: 8,
  startingStacksBB: [100, 75, 120, 60, 150, 90, 110, 100],
  buttonIndex: 0,
  seed: 20_260_826,
};

export async function createTrainerSession(mode: UiRngMode, options: CreateTrainerSessionOptions = {}): Promise<AcceptanceSessionController> {
  const registry = options.registry ?? createAcceptanceProviderRegistry();
  const provider = registry.requireAvailable(options.activeProviderId ?? BUNDLED_SOLVED_PROVIDER_ID);
  if ((options.drillMode ?? "Node drill") === "Full hand") {
    const definition = createFullHandDefinition(provider, domainRngMode(mode), options.fullHand ?? DEFAULT_FULL_HAND_OPTIONS);
    const session = DrillSession.createFullHand(definition);
    const snapshot = await session.runUntilHeroOrTerminal(options.context);
    return { session, catalog: new ScenarioCatalog([]), snapshot, mode: "Full hand" };
  }
  const catalog = options.scenarioCatalog
    ?? (provider.id === BUNDLED_SOLVED_PROVIDER_ID
      ? bundledScenarioCatalog(provider)
      : new ScenarioCatalog([createAcceptanceNodeDefinition(provider, domainRngMode(mode))]));
  const definition = catalog.filter(options.nodeFilter ?? {})[0]?.definition;
  if (definition === undefined) throw new StrategyUnavailableError("No validated node matches the selected filters; the trainer will not synthesize one.", provider.id);
  const session = DrillSession.loadNode({
    ...definition,
    strategyProvider: provider,
    rng: { mode: domainRngMode(mode), revealRollBeforeAction: true },
  });
  const snapshot = await session.runUntilHeroOrTerminal(options.context);
  return { session, catalog, snapshot, mode: "Node drill", scenarioId: definition.id };
}

export async function createCustomSpotSession(
  source: string,
  provider: StrategyProvider,
  mode: UiRngMode,
  context?: StrategyRequestContext,
): Promise<AcceptanceSessionController> {
  const prepared = prepareCustomSpot(parseCustomSpotJson(source));
  if (prepared.issues.length > 0) throw new RangeError(`Custom spot expectations failed: ${prepared.issues.join(" ")}`);
  const config = {
    ...prepared.config,
    actionTreeId: prepared.actionTree.id,
    strategyProviderId: provider.id,
  };
  const session = DrillSession.loadPreparedState({
    config,
    state: { ...prepared.state, config },
    heroSeatId: prepared.heroSeatId,
    buttonIndex: prepared.state.buttonIndex,
    actionTree: prepared.actionTree,
    strategyProvider: provider,
    seed: prepared.seed,
    ranges: prepared.ranges,
    deadCards: prepared.deadCards,
    rng: { mode: domainRngMode(mode), revealRollBeforeAction: true },
  });
  const snapshot = await session.runUntilHeroOrTerminal(context);
  return { session, catalog: new ScenarioCatalog([]), snapshot, mode: "Custom spot" };
}

export async function createAcceptanceSession(mode: UiRngMode, options: CreateAcceptanceSessionOptions = {}): Promise<AcceptanceSessionController> {
  return createTrainerSession(mode, { ...options, drillMode: "Node drill" });
}

export function registerImportedProvider(registry: StrategyProviderRegistry, result: ImportedPackSummary): RegisteredStrategyProvider {
  registry.unregister(result.providerId);
  const entry: RegisteredStrategyProvider = {
    provider: result.provider,
    metadata: {
      label: `${result.sourceName} ${result.sourceVersion}`,
      kind: "SOLVED_PACK",
      description: `${result.nodeCount} legally replayed drill${result.nodeCount === 1 ? "" : "s"} · ${result.comboRowCount} exact combo rows · ${result.completeEvComboRowCount} with complete action EVs · ${result.fileName}.`,
      possibleProvenance: ["SOLVED"],
      source: `${result.sourceName} ${result.sourceVersion} · ${result.timestamp}`,
    },
    availability: { state: "AVAILABLE", checkedAt: new Date().toISOString() },
  };
  registry.register(entry);
  return entry;
}

export type LocalSolverCacheKind = "IndexedDB" | "memory";

export interface LocalSolverProbeSuccess {
  readonly status: "available";
  readonly providerId: typeof LOCAL_SOLVER_PROVIDER_ID;
  readonly endpoint: string;
  readonly cacheKind: LocalSolverCacheKind;
  readonly message: string;
}

export interface LocalSolverProbeFailure {
  readonly status: "error";
  readonly providerId: typeof LOCAL_SOLVER_PROVIDER_ID;
  readonly endpoint: string;
  readonly message: string;
}

export type LocalSolverProbeResult = LocalSolverProbeSuccess | LocalSolverProbeFailure;

export interface ProbeLocalSolverOptions {
  readonly context?: StrategyRequestContext;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly cache?: StrategyCache;
}

class IndexedDbWithMemoryFallback implements StrategyCache {
  readonly #persistent: StrategyCache;
  readonly #memory = new MemoryStrategyCache();
  #persistentFailed = false;

  constructor(persistent: StrategyCache) {
    this.#persistent = persistent;
  }

  async get(key: string): Promise<StrategyCacheEntry | undefined> {
    if (!this.#persistentFailed) {
      try { return await this.#persistent.get(key); } catch { this.#persistentFailed = true; }
    }
    return this.#memory.get(key);
  }

  async set(entry: StrategyCacheEntry): Promise<void> {
    if (!this.#persistentFailed) {
      try { await this.#persistent.set(entry); return; } catch { this.#persistentFailed = true; }
    }
    await this.#memory.set(entry);
  }

  async delete(key: string): Promise<void> {
    if (!this.#persistentFailed) {
      try { await this.#persistent.delete(key); } catch { this.#persistentFailed = true; }
    }
    await this.#memory.delete(key);
  }

  async clear(): Promise<void> {
    if (!this.#persistentFailed) {
      try { await this.#persistent.clear(); } catch { this.#persistentFailed = true; }
    }
    await this.#memory.clear();
  }
}

function browserCache(): { cache: StrategyCache; kind: LocalSolverCacheKind } {
  try {
    return { cache: new IndexedDbWithMemoryFallback(new IndexedDbStrategyCache()), kind: "IndexedDB" };
  } catch {
    return { cache: new MemoryStrategyCache(), kind: "memory" };
  }
}

function localMetadata(endpoint: string): RegisteredStrategyProvider["metadata"] {
  return {
    label: "Local solver + honest fallback",
    kind: "LOCAL_SOLVER",
    description: "On-demand exact-combo heads-up postflop solves; unsupported preflop, multiway, ICM/PKO, dead-card, resource-limit, and unconverged nodes continue visibly as HEURISTIC with no fabricated EV.",
    possibleProvenance: ["SOLVED", "HEURISTIC"],
    source: endpoint,
  };
}

function localSolverWithHonestFallback(exact: StrategyProvider): StrategyProvider {
  const educational = createEducationalProvider();
  return {
    id: LOCAL_SOLVER_PROVIDER_ID,
    async getStrategy(query, context) {
      const livePlayers = query.publicState?.players.filter(({ status }) => status !== "folded").length;
      const unsupported = query.street === "preflop"
        ? "The integrated local engine is postflop-only."
        : livePlayers !== undefined && livePlayers !== 2
          ? `The integrated local engine is heads-up-only; this node has ${livePlayers} live players.`
          : query.deadCards.length > 0
            ? "The integrated local engine does not silently ignore known dead cards."
            : undefined;
      if (unsupported === undefined) {
        try {
          return await exact.getStrategy(query, context);
        } catch (error) {
          if (!(error instanceof StrategyUnavailableError)) throw error;
          const fallback = await educational.getStrategy(query, context);
          return {
            ...fallback,
            notes: [
              `HEURISTIC fallback: the exact local solve was unavailable. ${error.message}`,
              ...(fallback.notes ?? []),
            ],
          };
        }
      }
      const fallback = await educational.getStrategy(query, context);
      return {
        ...fallback,
        notes: [
          `HEURISTIC fallback: ${unsupported} No solver frequency or EV is claimed for this node.`,
          ...(fallback.notes ?? []),
        ],
      };
    },
  };
}

function registerLocalEntry(
  registry: StrategyProviderRegistry,
  provider: StrategyProvider,
  endpoint: string,
  availability: RegisteredStrategyProvider["availability"],
): void {
  registry.unregister(LOCAL_SOLVER_PROVIDER_ID);
  registry.register({ provider, metadata: localMetadata(endpoint), availability });
}

function unavailableLocalProvider(message: string): StrategyProvider {
  return {
    id: LOCAL_SOLVER_PROVIDER_ID,
    async getStrategy(): Promise<never> {
      throw new StrategyUnavailableError(message, LOCAL_SOLVER_PROVIDER_ID);
    },
  };
}

function assertProbeHeldComboEvidence(
  result: Awaited<ReturnType<StrategyProvider["getStrategy"]>>,
  legalActions: readonly PokerAction[],
): void {
  const heldComboId = comboId(card("Qs"), card("Ts"));
  const row = result.comboPolicy?.find((candidate) => candidate.weight > 0 && comboId(...candidate.cards) === heldComboId);
  if (row === undefined) {
    throw new RangeError("Local solver acceptance probe requires an exact positive-weight QsTs combo-policy row.");
  }
  const legalKeys = legalActions.map(actionKey);
  const rowKeys = row.actions.map(({ action }) => actionKey(action));
  const uniqueRowKeys = new Set(rowKeys);
  if (rowKeys.length !== legalKeys.length
    || uniqueRowKeys.size !== rowKeys.length
    || legalKeys.some((key) => !uniqueRowKeys.has(key))) {
    throw new RangeError("Local solver acceptance probe QsTs row must contain every live legal action exactly once.");
  }
  const frequencyTotal = row.actions.reduce((sum, item) => sum + item.frequency, 0);
  if (!Number.isFinite(frequencyTotal) || Math.abs(frequencyTotal - 1) > COMBO_POLICY_ROUNDING_TOLERANCE) {
    throw new RangeError(`Local solver acceptance probe QsTs action frequencies must normalize to 1 within the ±${COMBO_POLICY_ROUNDING_TOLERANCE} rounding tolerance; received ${frequencyTotal}.`);
  }
  if (row.actions.some(({ evBB }) => evBB === undefined)) {
    throw new RangeError("Local solver acceptance probe QsTs row requires an EV for every live legal action.");
  }
}

/** Marks the sidecar available only after its normalized SOLVED response matches the exact acceptance query. */
export async function configureAndProbeLocalSolver(
  registry: StrategyProviderRegistry,
  endpoint: string,
  options: ProbeLocalSolverOptions = {},
): Promise<LocalSolverProbeResult> {
  let provider: StrategyProvider;
  let cacheKind: LocalSolverCacheKind = "memory";
  try {
    const transport = new HttpLocalSolverTransport({
      endpoint,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const selectedCache = options.cache === undefined ? browserCache() : { cache: options.cache, kind: "memory" as const };
    cacheKind = selectedCache.kind;
    const local = new LocalSolverProvider(`${LOCAL_SOLVER_PROVIDER_ID}:source:${transport.endpoint.href}`, transport, decodeLocalSolverResponse);
    provider = new CachingStrategyProvider(LOCAL_SOLVER_PROVIDER_ID, local, selectedCache.cache);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registerLocalEntry(registry, unavailableLocalProvider(message), endpoint, {
      state: "ERROR",
      reason: message,
      checkedAt: new Date().toISOString(),
    });
    return { status: "error", providerId: LOCAL_SOLVER_PROVIDER_ID, endpoint, message };
  }

  registerLocalEntry(registry, provider, endpoint, {
    state: "CHECKING",
    reason: "Querying the exact acceptance node; configuration alone does not prove availability.",
  });
  try {
    const probeProvider: StrategyProvider = {
      id: provider.id,
      async getStrategy(query, context) {
        const result = await provider.getStrategy(query, context);
        assertProbeHeldComboEvidence(result, query.legalActions);
        return result;
      },
    };
    const definition = createAcceptanceNodeDefinition(probeProvider, "off");
    const session = DrillSession.loadNode(definition);
    const snapshot = await session.runUntilHeroOrTerminal(options.context);
    if (snapshot.phase !== "AWAITING_HERO") {
      throw new StrategyUnavailableError(
        snapshot.blocked?.reason ?? `Acceptance probe ended in ${snapshot.phase}.`,
        LOCAL_SOLVER_PROVIDER_ID,
      );
    }
    if (registry.get(LOCAL_SOLVER_PROVIDER_ID)?.provider !== provider) {
      throw new DOMException("A newer local solver configuration replaced this verification", "AbortError");
    }
    const hybrid = localSolverWithHonestFallback(provider);
    registerLocalEntry(registry, hybrid, endpoint, { state: "AVAILABLE", checkedAt: new Date().toISOString() });
    return {
      status: "available",
      providerId: LOCAL_SOLVER_PROVIDER_ID,
      endpoint,
      cacheKind,
      message: `Exact acceptance node verified through the normalized sidecar protocol; supported heads-up postflop nodes solve on demand and unsupported nodes continue with a visible HEURISTIC badge and no invented EV. Solved results cache in ${cacheKind}${cacheKind === "IndexedDB" ? " with automatic memory fallback" : ""}.`,
    };
  } catch (error) {
    if (options.context?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
      if (registry.get(LOCAL_SOLVER_PROVIDER_ID)?.provider === provider) {
        registry.setAvailability(LOCAL_SOLVER_PROVIDER_ID, {
          state: "UNAVAILABLE",
          reason: "Sidecar verification was cancelled before an exact-node result was received.",
          checkedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (registry.get(LOCAL_SOLVER_PROVIDER_ID)?.provider === provider) {
      registry.setAvailability(LOCAL_SOLVER_PROVIDER_ID, { state: "ERROR", reason: message, checkedAt: new Date().toISOString() });
    }
    return { status: "error", providerId: LOCAL_SOLVER_PROVIDER_ID, endpoint, message };
  }
}

export function countCompatibleScenarios(catalog: ScenarioCatalog, filter: ScenarioFilter): number {
  return catalog.filter(filter).length;
}

function importErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues)) {
    const messages = error.issues.slice(0, 4).map((issue: unknown) => {
      if (typeof issue !== "object" || issue === null) return String(issue);
      const path = "path" in issue && Array.isArray(issue.path) ? issue.path.join(".") : "pack";
      const message = "message" in issue ? String(issue.message) : "Invalid value";
      return `${path || "pack"}: ${message}`;
    });
    return messages.join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function importStrategyPackText(fileName: string, json: string): Promise<ImportedPackResult> {
  try {
    const pack = fileName.toLowerCase().endsWith(".csv") ? parseStrategyPackCsv(json) : parseStrategyPackJson(json);
    const providerId = `imported:${pack.packId}`;
    // Construction revalidates the untrusted object before it can act as a provider.
    const provider = new ImportedSolutionProvider(providerId, pack);
    // Every imported node must first be reached by a legal engine replay and
    // reproduce all five hashes plus the concrete state compatibility fields.
    const catalog = validateStrategyPackScenarioCatalog(pack, provider);
    return {
      status: "loaded",
      fileName,
      packId: pack.packId,
      sourceName: pack.source.name,
      sourceVersion: pack.source.version,
      timestamp: pack.source.timestamp,
      nodeCount: pack.nodes.length,
      comboRowCount: pack.nodes.reduce((sum, node) => sum + node.comboPolicy.length, 0),
      completeEvComboRowCount: pack.nodes.reduce((sum, node) => {
        const legalKeys = new Set(node.legalActions.map(actionKey));
        return sum + node.comboPolicy.filter((row) => {
          const rowKeys = row.actions.map(({ action }) => actionKey(action));
          return row.actions.length === legalKeys.size
            && new Set(rowKeys).size === legalKeys.size
            && rowKeys.every((key) => legalKeys.has(key))
            && row.actions.every(({ evBB }) => evBB !== undefined);
        }).length;
      }, 0),
      providerId: provider.id,
      provider,
      catalog,
    };
  } catch (error) {
    return { status: "error", fileName, message: importErrorMessage(error) };
  }
}
