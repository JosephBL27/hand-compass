function canonicalize(value: unknown): unknown {
  if (value instanceof Map) return [...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))).map(([key, item]) => [key, canonicalize(item)]);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function deterministicHash(value: unknown): string {
  const input = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface CacheHashes {
  readonly gameConfigHash: string;
  readonly rangeHash: string;
  readonly treeHash: string;
  readonly nodeHash: string;
  readonly boardCanonicalHash: string;
}

export const CACHE_HASH_FIELDS = ["gameConfigHash", "rangeHash", "treeHash", "nodeHash", "boardCanonicalHash"] as const;

/** Unambiguous, versioned identity for one exact strategy state. */
export function cacheHashesKey(hashes: CacheHashes): string {
  return `strategy-cache:v1:${CACHE_HASH_FIELDS.map((field) => `${field.length}:${field}=${String(hashes[field]).length}:${hashes[field]}`).join("|")}`;
}

export function sameCacheHashes(left: CacheHashes, right: CacheHashes): boolean {
  return CACHE_HASH_FIELDS.every((field) => left[field] === right[field]);
}

function canonicalBoardValue(board: unknown): unknown {
  if (!Array.isArray(board) || !board.every((value): value is Card => typeof value === "string" && isCard(value))) return board;
  const suitIds = new Map<string, number>();
  return board.map((value) => {
    const suit = value[1] ?? "";
    let id = suitIds.get(suit);
    if (id === undefined) {
      id = suitIds.size;
      suitIds.set(suit, id);
    }
    return `${value[0]}${id}`;
  });
}

export function canonicalBoardHash(board: readonly Card[]): string {
  return deterministicHash(canonicalBoardValue(board));
}

export function createCacheHashes(input: { readonly gameConfig: unknown; readonly ranges: unknown; readonly tree: unknown; readonly node: unknown; readonly board: unknown }): CacheHashes {
  return {
    gameConfigHash: deterministicHash(input.gameConfig),
    rangeHash: deterministicHash(input.ranges),
    treeHash: deterministicHash(input.tree),
    nodeHash: deterministicHash(input.node),
    boardCanonicalHash: deterministicHash(canonicalBoardValue(input.board)),
  };
}

export function createStrategyQueryHashes(input: {
  readonly gameConfig: unknown;
  readonly ranges: unknown;
  readonly tree: unknown;
  readonly nodeHash: string;
  readonly board: readonly Card[];
}): CacheHashes {
  return {
    gameConfigHash: deterministicHash(input.gameConfig),
    rangeHash: deterministicHash(input.ranges),
    treeHash: deterministicHash(input.tree),
    nodeHash: input.nodeHash,
    boardCanonicalHash: canonicalBoardHash(input.board),
  };
}
import { isCard, type Card } from "./cards";
