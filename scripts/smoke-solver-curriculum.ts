import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalSolverRequest, decodeLocalSolverResponse, stableSolverJson } from "../src/domain/localSolverProtocol";
import { getLocalSolverStatus } from "../src/domain/localSolverStatus";
import { createGeneratedScenarioDefinitions } from "../src/session/generatedScenarios";
import { reconstructNode } from "../src/session/scenario";
import { ReplayRng } from "../src/session/rng";
import { buildStrategyQuery } from "../src/session/query";
import type { StrategyProvider, StrategyQuery } from "../src/domain/strategy";

// Real engine verification: authored focused ranges remain exactly as generated.
// The test does not narrow them, change the configured tree, or accept fallback.
const provider: StrategyProvider = { id: "native-curriculum-verification", async getStrategy() { throw new Error("Smoke queries go directly to the real sidecar"); } };
const definitions = createGeneratedScenarioDefinitions({
  strategyProvider: provider, tableSizes: [4, 6], stackDepthsBB: [20],
  streets: ["flop", "turn", "river"], potFamilies: ["SRP"], rangeProfile: "focused", seed: 20260906,
});
const queries = definitions.map((definition) => {
  const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
  assert(prepared.available);
  return buildStrategyQuery({ state: prepared.state, heroSeatId: definition.heroSeatId, ranges: prepared.ranges, actionTree: definition.actionTree });
});

const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
assert(address !== null && typeof address !== "string");
const port = address.port;
listener.close();
await once(listener, "close");
const endpoint = `http://127.0.0.1:${port}/v1/solve`;
const cacheDirectory = await mkdtemp(join(tmpdir(), "poker-curriculum-cache-"));
let child: ChildProcess | undefined;
let stderr = "";

async function start(): Promise<void> {
  stderr = "";
  child = spawn(resolve("tools/local-solver/target/release/poker-solver-sidecar"), [], {
    env: { ...process.env, POKER_SOLVER_ADDR: `127.0.0.1:${port}`, POKER_SOLVER_CACHE_DIR: cacheDirectory,
      POKER_SOLVER_MAX_ITERATIONS: "600", POKER_SOLVER_MAX_SOLVE_SECONDS: "120", POKER_SOLVER_MAX_MEMORY_MB: "4096" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Sidecar exited: ${stderr}`);
    try { await getLocalSolverStatus(endpoint); return; } catch { await delay(100); }
  }
  throw new Error(`Sidecar did not start: ${stderr}`);
}

async function stop(): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  child = undefined;
}

async function solve(query: StrategyQuery) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: stableSolverJson(createLocalSolverRequest(query)), signal: AbortSignal.timeout(150_000),
  });
  const payload = await response.json();
  assert(response.ok, JSON.stringify(payload));
  const result = decodeLocalSolverResponse(payload, query);
  assert.equal(result.provenance, "SOLVED");
  assert((result.comboPolicy?.length ?? 0) > 30);
  assert(result.comboPolicy?.every((row) => row.actions.every((action) => action.evBB !== undefined)));
  assert((result.convergence?.exploitabilityPctPot ?? Infinity) <= 0.5);
  return { payload, cache: response.headers.get("X-Poker-Solver-Cache"), seconds: (performance.now() - started) / 1000, result };
}

try {
  await start();
  const records = [];
  const firstResponses = [];
  for (const query of queries) {
    const result = await solve(query);
    assert.equal(result.cache, "MISS");
    firstResponses.push(result.payload);
    const record = { street: query.street, board: query.board, table: query.gameConfig.playerCount, actor: query.actorPosition,
      combos: result.result.comboPolicy?.length, seconds: result.seconds, exploitabilityPctPot: result.result.convergence?.exploitabilityPctPot, cache: result.cache };
    records.push(record);
    console.log(JSON.stringify(record));
  }
  const beforeRestart = await getLocalSolverStatus(endpoint);
  assert.equal(beforeRestart.cache.entries, queries.length);
  assert.equal(beforeRestart.activity.completedSolves, queries.length);
  await stop();
  await start();
  for (const [index, query] of queries.entries()) {
    const result = await solve(query);
    assert.equal(result.cache, "HIT");
    assert.deepEqual(result.payload, firstResponses[index]);
  }
  const afterRestart = await getLocalSolverStatus(endpoint);
  assert.equal(afterRestart.activity.completedSolves, 0);
  assert.equal(afterRestart.cache.hits, queries.length);
  console.log(JSON.stringify({ status: "PASS", distinctRealSolves: records.length, streets: [...new Set(records.map(({ street }) => street))],
    cacheRestartHits: afterRestart.cache.hits, recomputationsAfterRestart: afterRestart.activity.completedSolves,
    cacheDirectory, cacheBytes: afterRestart.cache.bytes, records }, null, 2));
} finally {
  await stop();
}
