import { cacheHashesKey, createStrategyQueryHashes, sameCacheHashes, type CacheHashes } from "./hash";
import { createLocalSolverRequest, stableSolverJson } from "./localSolverProtocol";
import {
  validateStrategyResult,
  type StrategyProvider,
  type StrategyQuery,
  type StrategyRequestContext,
  type StrategyResult,
} from "./strategy";

export interface StrategyCacheEntry {
  readonly key: string;
  readonly identity: CacheHashes;
  readonly providerId: string;
  readonly storedAt: string;
  /** Full canonical query. Hash equality alone cannot certify an exact solve. */
  readonly queryIdentity?: string;
  readonly result: StrategyResult;
}

export interface StrategyCache {
  get(key: string): Promise<StrategyCacheEntry | undefined>;
  set(entry: StrategyCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStrategyCache implements StrategyCache {
  readonly #entries = new Map<string, StrategyCacheEntry>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: { readonly maxEntries?: number; readonly maxBytes?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new RangeError("Cache limits must be positive integers");
    }
  }

  async get(key: string): Promise<StrategyCacheEntry | undefined> {
    const entry = this.#entries.get(key);
    if (entry !== undefined) { this.#entries.delete(key); this.#entries.set(key, entry); }
    return entry;
  }

  async set(entry: StrategyCacheEntry): Promise<void> {
    if (entryBytes(entry) > this.#maxBytes) return;
    this.#entries.delete(entry.key);
    this.#entries.set(entry.key, entry);
    while (this.#entries.size > this.#maxEntries || [...this.#entries.values()].reduce((total, item) => total + entryBytes(item), 0) > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }
}

const CACHE_STORE = "strategy-results";

export interface IndexedDbStrategyCacheOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

function entryBytes(entry: StrategyCacheEntry): number {
  return new TextEncoder().encode(stableSolverJson(entry)).byteLength;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

/** Browser-persistent cache. The normalized sidecar remains the authority for solver truth. */
export class IndexedDbStrategyCache implements StrategyCache {
  readonly #database: Promise<IDBDatabase>;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: IndexedDbStrategyCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 512;
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new RangeError("Cache limits must be positive integers");
    }
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) throw new Error("IndexedDB is unavailable in this runtime");
    const request = factory.open(options.databaseName ?? "poker-trainer-strategy-cache", 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: "key" });
    });
    this.#database = requestResult(request);
  }

  async get(key: string): Promise<StrategyCacheEntry | undefined> {
    const database = await this.#database;
    const transaction = database.transaction(CACHE_STORE, "readonly");
    const value = await requestResult(transaction.objectStore(CACHE_STORE).get(key));
    await transactionDone(transaction);
    return value === undefined ? undefined : value as StrategyCacheEntry;
  }

  async set(entry: StrategyCacheEntry): Promise<void> {
    if (entryBytes(entry) > this.#maxBytes) return;
    const database = await this.#database;
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    const store = transaction.objectStore(CACHE_STORE);
    store.put(entry);
    // Keep pruning inside this transaction's request callback so browsers do
    // not auto-close the transaction across an unrelated asynchronous turn.
    const request = store.getAll();
    request.addEventListener("success", () => {
      const entries = (request.result as StrategyCacheEntry[]).sort((a, b) => Date.parse(a.storedAt) - Date.parse(b.storedAt));
      let bytes = entries.reduce((total, item) => total + entryBytes(item), 0);
      let count = entries.length;
      for (const item of entries) {
        if (count <= this.#maxEntries && bytes <= this.#maxBytes) break;
        store.delete(item.key);
        count -= 1;
        bytes -= entryBytes(item);
      }
    }, { once: true });
    await transactionDone(transaction);
  }

  async delete(key: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(key);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).clear();
    await transactionDone(transaction);
  }
}

function identityFor(query: StrategyQuery): CacheHashes {
  return createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The strategy request was aborted", "AbortError");
}

function validEntry(entry: StrategyCacheEntry, key: string, identity: CacheHashes, providerId: string, queryIdentity: string, legalActions: StrategyQuery["legalActions"]): boolean {
  try {
    if (entry.key !== key || entry.providerId !== providerId || !sameCacheHashes(entry.identity, identity)) return false;
    if (entry.queryIdentity !== queryIdentity) return false;
    if (!Number.isFinite(Date.parse(entry.storedAt))) return false;
    if (entry.result.provenance !== "SOLVED") return false;
    validateStrategyResult(entry.result, legalActions);
    return true;
  } catch {
    return false;
  }
}

interface InFlightStrategy {
  promise: Promise<StrategyResult>;
  readonly controller: AbortController;
  subscribers: number;
  settled: boolean;
}

/**
 * Exact-state cache and single-flight wrapper. Consumers may cancel their own wait;
 * a consumer abort never cancels a shared solver call still needed by another consumer.
 */
export class CachingStrategyProvider implements StrategyProvider {
  readonly id: string;
  readonly #provider: StrategyProvider;
  readonly #cache: StrategyCache;
  readonly #inFlight = new Map<string, InFlightStrategy>();

  constructor(id: string, provider: StrategyProvider, cache: StrategyCache) {
    if (!id.trim()) throw new RangeError("Caching provider id is required");
    this.id = id;
    this.#provider = provider;
    this.#cache = cache;
  }

  #observe(entry: InFlightStrategy, signal?: AbortSignal): Promise<StrategyResult> {
    entry.subscribers += 1;
    let complete = false;
    const finish = (): void => {
      if (complete) return;
      complete = true;
      entry.subscribers -= 1;
      if (entry.subscribers === 0 && !entry.settled) {
        entry.controller.abort(new DOMException("All strategy request consumers cancelled", "AbortError"));
      }
    };
    if (signal?.aborted === true) {
      finish();
      return Promise.reject(abortReason(signal));
    }
    return new Promise<StrategyResult>((resolve, reject) => {
      const onAbort = (): void => {
        finish();
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (result) => { finish(); resolve(result); },
        (error: unknown) => { finish(); reject(error); },
      ).finally(() => signal?.removeEventListener("abort", onAbort)).catch(() => undefined);
    });
  }

  async getStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult> {
    const identity = identityFor(query);
    // v2.1 invalidates responses produced before carried-pot sizing was fixed
    // in the native tree materializer. Never reuse those old descendant EVs.
    const key = `exact-adapter-v2.1:${cacheHashesKey(identity)}`;
    const queryIdentity = stableSolverJson(createLocalSolverRequest(query));
    let cached: StrategyCacheEntry | undefined;
    try {
      cached = await this.#cache.get(key);
    } catch {
      cached = undefined;
    }
    if (cached !== undefined) {
      if (validEntry(cached, key, identity, this.#provider.id, queryIdentity, query.legalActions)) return cached.result;
      try { await this.#cache.delete(key); } catch { /* A cache failure must not become solver truth. */ }
    }

    // Protect single-flight reuse against digest collisions and callers that
    // accidentally reuse nodeHash for a changed public betting ledger.
    const flightKey = `${key}|${queryIdentity}`;
    let request = this.#inFlight.get(flightKey);
    if (request === undefined) {
      const controller = new AbortController();
      const created: InFlightStrategy = {
        controller,
        subscribers: 0,
        settled: false,
        promise: Promise.resolve({ provenance: "HEURISTIC", actions: [] }),
      };
      created.promise = this.#provider.getStrategy(query, { signal: controller.signal }).then(async (result) => {
        const validated = validateStrategyResult(result, query.legalActions);
        if (validated.provenance === "SOLVED") {
          const entry: StrategyCacheEntry = {
            key,
            identity,
            providerId: this.#provider.id,
            storedAt: new Date().toISOString(),
            queryIdentity,
            result: validated,
          };
          try { await this.#cache.set(entry); } catch { /* Continue with the live solved result. */ }
        }
        return validated;
      }).finally(() => {
        created.settled = true;
        if (this.#inFlight.get(flightKey) === created) this.#inFlight.delete(flightKey);
      });
      request = created;
      this.#inFlight.set(flightKey, created);
    }
    return this.#observe(request, context?.signal);
  }
}
