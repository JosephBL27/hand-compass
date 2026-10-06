import { comboId, createRange } from "../domain/ranges";
import { cacheHashesKey, deterministicHash } from "../domain/hash";
import { checkStrategyPackCompatibility, type ValidatedStrategyPack, type ValidatedStrategyPackNode } from "../domain/strategyPack";
import type { StrategyPackScenarioManifest } from "../domain/strategyPackScenario";
import type { RngMode } from "../domain/grading";
import type { StrategyProvider } from "../domain/strategy";
import { ScenarioCatalog } from "./catalog";
import { buildStrategyQuery } from "./query";
import { ReplayRng } from "./rng";
import { reconstructNode, ScenarioValidationError } from "./scenario";
import { checkComboPolicyCoverage } from "./sampling";
import type { NodeScenarioDefinition } from "./types";

function definitionForManifest(
  manifest: StrategyPackScenarioManifest,
  provider: StrategyProvider,
  rngMode: RngMode,
): NodeScenarioDefinition {
  const ranges = Object.fromEntries(
    Object.entries(manifest.ranges).flatMap(([seat, rows]) => rows === undefined ? [] : [[seat, createRange(rows)]]),
  ) as NodeScenarioDefinition["ranges"];
  return {
    id: manifest.id,
    config: manifest.config,
    heroSeatId: manifest.heroSeatId,
    buttonIndex: manifest.buttonIndex,
    actionTree: manifest.actionTree,
    strategyProvider: provider,
    seed: manifest.seed,
    ranges,
    fixedHoleCards: manifest.fixedHoleCards,
    deadCards: manifest.deadCards,
    futureBoard: manifest.futureBoard,
    replay: manifest.replay,
    expected: {
      actor: manifest.expected.actor,
      street: manifest.expected.street,
      board: manifest.expected.board,
      potBB: manifest.expected.potBB,
      currentBetBB: manifest.expected.currentBetBB,
    },
    sourceTags: manifest.sourceTags,
    rng: { mode: rngMode, revealRollBeforeAction: true },
  };
}

function matchingNode(pack: ValidatedStrategyPack, manifest: StrategyPackScenarioManifest): ValidatedStrategyPackNode {
  const identity = cacheHashesKey(manifest.nodeIdentity);
  const node = pack.nodes.find((candidate) => cacheHashesKey(candidate) === identity);
  if (node === undefined) throw new ScenarioValidationError(`Scenario ${manifest.id} has no matching solved node.`);
  return node;
}

function validateManifestReplay(
  pack: ValidatedStrategyPack,
  manifest: StrategyPackScenarioManifest,
  definition: NodeScenarioDefinition,
): void {
  const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
  if (!prepared.available) throw new ScenarioValidationError(`Scenario ${manifest.id} cannot be reconstructed: ${prepared.block.reason}`);
  const state = prepared.state;
  if (state.terminal !== undefined || state.actor === null) throw new ScenarioValidationError(`Scenario ${manifest.id} reaches a terminal state instead of a decision.`);
  if (state.actor !== manifest.heroSeatId) throw new ScenarioValidationError(`Scenario ${manifest.id} expected Hero ${manifest.heroSeatId}, but ${state.actor} acts.`);
  const liveStacks = Object.fromEntries(state.players.map((player) => [player.id, player.stackBB]));
  if (deterministicHash(liveStacks) !== deterministicHash(manifest.expected.stacksBB)) {
    throw new ScenarioValidationError(`Scenario ${manifest.id} reconstructed stack ledger does not match its manifest.`);
  }
  const query = buildStrategyQuery({
    state,
    heroSeatId: definition.heroSeatId,
    ranges: prepared.ranges,
    actionTree: definition.actionTree,
    ...(definition.deadCards === undefined ? {} : { deadCards: definition.deadCards }),
  });
  const node = matchingNode(pack, manifest);
  const compatibility = checkStrategyPackCompatibility(node, query);
  if (!compatibility.compatible) {
    throw new ScenarioValidationError(`Scenario ${manifest.id} does not reproduce solved node ${node.nodeHash}: ${compatibility.issues.join(", ")}.`);
  }
  const heroRange = prepared.ranges[manifest.heroSeatId];
  if (heroRange === undefined) throw new ScenarioValidationError(`Scenario ${manifest.id} requires a public Hero range for drill-safe combo grading.`);
  const coverage = checkComboPolicyCoverage(heroRange, node.comboPolicy, [...state.board, ...(definition.deadCards ?? [])]);
  if (!coverage.complete) throw new ScenarioValidationError(`Scenario ${manifest.id} Hero combo-policy coverage is incomplete: ${coverage.reason ?? "missing source rows"}`);
  const fixedHero = definition.fixedHoleCards?.[manifest.heroSeatId];
  if (fixedHero !== undefined && !node.comboPolicy.some((row) => row.weight > 0 && comboId(...row.cards) === comboId(...fixedHero))) {
    throw new ScenarioValidationError(`Scenario ${manifest.id} has no positive solved row for Hero's fixed cards.`);
  }
}

/**
 * Converts untrusted wire recipes into engine-replayed catalog definitions.
 * Registration is atomic: one mismatch rejects the entire pack.
 */
export function validateStrategyPackScenarioCatalog(
  pack: ValidatedStrategyPack,
  provider: StrategyProvider,
  rngMode: RngMode = "off",
): ScenarioCatalog {
  const definitions = pack.scenarios.map((manifest) => definitionForManifest(manifest, provider, rngMode));
  definitions.forEach((definition, index) => validateManifestReplay(pack, pack.scenarios[index]!, definition));
  return new ScenarioCatalog(definitions);
}
