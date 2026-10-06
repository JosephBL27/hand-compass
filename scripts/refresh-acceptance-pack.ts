import { readFile, writeFile } from "node:fs/promises";
import { HttpLocalSolverTransport } from "../src/domain/httpLocalSolverTransport";
import { decodeLocalSolverResponse } from "../src/domain/localSolverProtocol";
import { getLocalSolverStatus } from "../src/domain/localSolverStatus";
import { bbToNumber } from "../src/domain/money";
import { parseStrategyPack } from "../src/domain/strategyPack";
import type { StrategyProvider } from "../src/domain/strategy";
import { validateStrategyPackScenarioCatalog } from "../src/session/packScenario";
import { reconstructNode } from "../src/session/scenario";
import { ReplayRng } from "../src/session/rng";
import { buildStrategyQuery } from "../src/session/query";

// Regenerates frequencies/EVs only from the real native engine. Existing ranges,
// replay, stack, tree, and exact legal action configuration are preserved.
const outputPath = process.argv[2];
if (outputPath === undefined) throw new Error("Usage: node --import tsx scripts/refresh-acceptance-pack.ts OUTPUT_PACK_JSON");
const sourcePath = "src/solutions/acceptance-qsts-solved.pack.json";
const pack = parseStrategyPack(JSON.parse(await readFile(sourcePath, "utf8")));
const provider: StrategyProvider = { id: "bundled:acceptance-qsts-postflop-2026-08-28", async getStrategy() { throw new Error("Replay-only provider"); } };
const definition = validateStrategyPackScenarioCatalog(pack, provider).all()[0]!.definition;
const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
if (!prepared.available) throw new Error(prepared.block.reason);
const query = buildStrategyQuery({ state: prepared.state, heroSeatId: definition.heroSeatId, ranges: prepared.ranges, actionTree: definition.actionTree });
const endpoint = process.env.POKER_SOLVER_ENDPOINT ?? "http://127.0.0.1:4317/v1/solve";
const status = await getLocalSolverStatus(endpoint);
if (status.adapterVersion !== "2.1.0") throw new Error(`Expected corrected adapter 2.1.0; received ${status.adapterVersion}`);
const transport = new HttpLocalSolverTransport({ endpoint, timeoutMs: 180_000 });
const start = performance.now();
const result = decodeLocalSolverResponse(await transport.request(query), query);
if (result.provenance !== "SOLVED" || result.comboPolicy === undefined || result.source === undefined) throw new Error("Native source did not supply a complete SOLVED policy");
if (result.comboPolicy.length !== pack.nodes[0]!.comboPolicy.length) throw new Error("Native policy changed the supplied range coverage");
const oldNode = pack.nodes[0]!;
const refreshed = parseStrategyPack({ ...pack,
  source: { ...pack.source, version: "2026-09-06.native-2.1.0", timestamp: result.source.timestamp,
    solver: result.source.solver, commit: result.source.commit },
  nodes: [{ ...oldNode, comboPolicy: result.comboPolicy,
    convergence: {
      iterations: result.convergence?.iterations,
      solver: result.convergence?.solver,
      compression: result.convergence?.compression,
      exploitabilityPctPot: result.convergence?.exploitabilityPctPot,
      targetExploitabilityPctPot: result.convergence?.targetExploitabilityPctPot,
      exploitabilityBB: result.convergence?.exploitabilityBB === undefined ? undefined : bbToNumber(result.convergence.exploitabilityBB),
      targetExploitabilityBB: result.convergence?.targetExploitabilityBB === undefined ? undefined : bbToNumber(result.convergence.targetExploitabilityBB) },
    notes: [oldNode.notes?.[0] ?? "Supplied custom public ranges retained.",
      "Recomputed by native adapter 2.1.0 using exactly the manifest action tree and current supplied ranges. Future-street pot-fraction sizes include all prior called bets.",
      ...(result.notes ?? [])] }],
});
validateStrategyPackScenarioCatalog(refreshed, provider);
await writeFile(outputPath, `${JSON.stringify(refreshed)}\n`);
console.log(JSON.stringify({ outputPath, combos: result.comboPolicy.length, elapsedSeconds: (performance.now() - start) / 1000, convergence: refreshed.nodes[0]!.convergence, source: refreshed.source }, null, 2));
