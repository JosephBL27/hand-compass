import { createLocalSolverRequest, stableSolverJson } from "./localSolverProtocol";
import { StrategyUnavailableError, type LocalSolverTransport, type StrategyQuery } from "./strategy";

export const DEFAULT_LOCAL_SOLVER_ENDPOINT = "http://127.0.0.1:4317/v1/solve";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpLocalSolverTransportOptions {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowRemoteEndpoint?: boolean;
  readonly fetch?: FetchLike;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateLocalSolverEndpoint(value: string, allowRemoteEndpoint = false): URL {
  const endpoint = new URL(value);
  if (endpoint.username || endpoint.password) throw new RangeError("Local solver endpoint must not contain credentials");
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new RangeError("Local solver endpoint must use HTTP(S)");
  if (!allowRemoteEndpoint && !isLoopbackHostname(endpoint.hostname)) {
    throw new RangeError("Local solver endpoint must be loopback unless remote access is explicitly enabled");
  }
  return endpoint;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "The local solver request was aborted", "AbortError");
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel("response byte limit exceeded");
        throw new StrategyUnavailableError("Sidecar response exceeds the configured byte limit.", "local-solver-http");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class HttpLocalSolverTransport implements LocalSolverTransport {
  readonly endpoint: URL;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly #fetch: FetchLike;

  constructor(options: HttpLocalSolverTransportOptions = {}) {
    this.endpoint = validateLocalSolverEndpoint(options.endpoint ?? DEFAULT_LOCAL_SOLVER_ENDPOINT, options.allowRemoteEndpoint ?? false);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("Local solver timeout must be a positive integer");
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) throw new RangeError("Local solver response limit must be a positive integer");
    const runtimeFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (runtimeFetch === undefined) throw new StrategyUnavailableError("Fetch is unavailable in this runtime.", "local-solver-http");
    this.#fetch = runtimeFetch;
  }

  async request(query: StrategyQuery, callerSignal?: AbortSignal): Promise<unknown> {
    if (callerSignal?.aborted === true) throw abortError(callerSignal.reason);
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException(`Local solver timed out after ${this.timeoutMs} ms`, "TimeoutError")), this.timeoutMs);
    try {
      const response = await this.#fetch(this.endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: stableSolverJson(createLocalSolverRequest(query)),
        signal: controller.signal,
      });
      if (!isJsonContentType(response.headers.get("content-type"))) {
        if (!response.ok) throw new StrategyUnavailableError(`Sidecar returned HTTP ${response.status}.`, "local-solver-http");
        throw new StrategyUnavailableError("Sidecar response is not JSON.", "local-solver-http");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (!Number.isFinite(length) || length < 0 || length > this.maxResponseBytes) {
          throw new StrategyUnavailableError("Sidecar response exceeds the configured byte limit.", "local-solver-http");
        }
      }
      const bytes = await readBoundedBody(response, this.maxResponseBytes);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch (error) {
        throw new StrategyUnavailableError(`Sidecar returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`, "local-solver-http");
      }
      if (!response.ok) {
        const detail = typeof payload === "object" && payload !== null && "error" in payload
          && typeof payload.error === "object" && payload.error !== null && "message" in payload.error
          && typeof payload.error.message === "string"
          ? ` ${payload.error.message}`
          : "";
        throw new StrategyUnavailableError(`Sidecar returned HTTP ${response.status}.${detail}`, "local-solver-http");
      }
      return payload;
    } catch (error) {
      if (callerSignal?.aborted) throw abortError(callerSignal.reason);
      if (error instanceof StrategyUnavailableError) throw error;
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      throw new StrategyUnavailableError(`Local solver connection failed: ${reason instanceof Error ? reason.message : String(reason)}`, "local-solver-http");
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
