import { z } from "zod";
import { DEFAULT_LOCAL_SOLVER_ENDPOINT, validateLocalSolverEndpoint, type FetchLike } from "./httpLocalSolverTransport";

const count = z.number().int().nonnegative();
const statusSchema = z.object({
  status: z.literal("ok"),
  protocolVersion: z.string(),
  adapterVersion: z.string(),
  solver: z.string(),
  commit: z.string(),
  scope: z.literal("heads-up-postflop-chip-ev"),
  capabilities: z.object({
    streets: z.array(z.enum(["flop", "turn", "river"])),
    maxPlayersRemaining: z.literal(2),
    weightedRanges: z.literal(true),
    unequalStacks: z.literal(true),
    rake: z.literal(true),
    sizingModes: z.array(z.enum(["fixed", "dynamic", "geometric"])),
    unsupported: z.array(z.string()),
  }),
  limits: z.object({
    maxIterations: count,
    targetExploitabilityPctPot: z.number().nonnegative(),
    maxMemoryMB: count,
    maxSolveSeconds: count,
    maxTreeNodes: count,
    maxQueuedRequests: count,
  }),
  activity: z.object({
    phase: z.enum(["idle", "building", "solving"]),
    queuedRequests: count,
    iterations: count,
    elapsedSeconds: z.number().nonnegative(),
    completedSolves: count,
    rejectedSolves: count,
    lastError: z.string().nullable(),
  }),
  cache: z.object({
    persistent: z.boolean(),
    entries: count,
    bytes: count,
    maxEntries: count,
    maxBytes: count,
    hits: count,
    misses: count,
    writes: count,
    errors: count,
  }),
});

export type LocalSolverStatus = z.infer<typeof statusSchema>;

/** Read-only operational metadata. It deliberately contains no strategy or EV. */
export async function getLocalSolverStatus(
  endpoint = DEFAULT_LOCAL_SOLVER_ENDPOINT,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly fetch?: FetchLike } = {},
): Promise<LocalSolverStatus> {
  const url = validateLocalSolverEndpoint(endpoint);
  url.pathname = "/v1/status";
  url.search = "";
  url.hash = "";
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Solver status timed out", "TimeoutError")), options.timeoutMs ?? 2_000);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Solver status returned HTTP ${response.status}`);
    return statusSchema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
