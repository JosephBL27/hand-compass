import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { actionKey, type PokerAction } from "../src/domain/actions";
import { card, type Card } from "../src/domain/cards";
import { createStrategyQueryHashes } from "../src/domain/hash";
import { bb } from "../src/domain/money";
import { createRange, type WeightedRange } from "../src/domain/ranges";
import type { StrategyProvider } from "../src/domain/strategy";
import { STRATEGY_PACK_SCHEMA_VERSION, parseStrategyPack } from "../src/domain/strategyPack";
import type { StrategyPackScenarioManifest } from "../src/domain/strategyPackScenario";
import { acceptanceActionTree, createAcceptanceNodeDefinition } from "../src/fixtures/acceptanceSpot";
import { buildStrategyQuery } from "../src/session/query";
import { ReplayRng } from "../src/session/rng";
import { reconstructNode } from "../src/session/scenario";

interface RawAction {
  readonly action: "fold" | "call" | "raise" | "all-in";
  readonly amount: number | null;
  readonly frequency: number;
  readonly ev: number;
}

interface RawCombo {
  readonly cards: string;
  readonly weight: number;
  readonly actions: readonly RawAction[];
}

interface RawRangeCombo {
  readonly cards: string;
  readonly weight: number;
}

interface RawExport {
  readonly solver: string;
  readonly solver_commit: string;
  readonly compression: string;
  readonly source_units_per_bb: number;
  readonly target_exploitability: number;
  readonly exploitability: number;
  readonly iterations: number;
  readonly starting_pot: number;
  readonly effective_stack: number;
  readonly board: string;
  readonly range_note: string;
  readonly target_path: readonly string[];
  readonly legal_actions: readonly string[];
  readonly hero_policy: readonly RawCombo[];
  readonly villain_range: readonly RawRangeCombo[];
}

function cards(value: string): readonly [Card, Card] {
  if (value.length !== 4) throw new RangeError(`Expected four-character hole cards, received ${value}`);
  return [card(value.slice(0, 2)), card(value.slice(2, 4))];
}

function normalizedRange(rows: readonly RawRangeCombo[]): WeightedRange {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!Number.isFinite(total) || total <= 0) throw new RangeError("Raw range has no positive mass");
  return createRange(rows.map((row) => ({ cards: cards(row.cards), weight: row.weight / total })));
}

function mapAction(raw: RawAction, legalActions: readonly PokerAction[], unitsPerBB: number): PokerAction {
  const expected = raw.action === "fold"
    ? "fold"
    : raw.action === "call"
      ? `call:${bb(1.8)}`
      : `${raw.action === "all-in" ? "jam" : "raise"}:${bb((raw.amount ?? 0) / unitsPerBB)}`;
  const action = legalActions.find((candidate) => actionKey(candidate) === expected);
  if (action === undefined) throw new RangeError(`Raw action ${raw.action}:${String(raw.amount)} does not match a legal target action`);
  return action;
}

async function main(): Promise<void> {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (inputPath === undefined || outputPath === undefined) {
    throw new RangeError("Usage: npm run solver:convert-acceptance -- RAW_EXPORT_JSON OUTPUT_PACK_JSON");
  }
  const rawText = await readFile(inputPath, "utf8");
  const raw = JSON.parse(rawText) as RawExport;
  if (raw.board !== "Qh8s4s" || raw.starting_pot !== 55 || raw.effective_stack !== 975) {
    throw new RangeError("Raw export is not the acceptance solve");
  }
  if (raw.hero_policy.length !== 411 || raw.legal_actions.join(",") !== "fold,call,raise:55,raise:72,raise:90,all-in:975") {
    throw new RangeError("Raw export has incomplete combo or target-action coverage");
  }

  const heroRange = normalizedRange(raw.hero_policy);
  const villainRange = normalizedRange(raw.villain_range);
  const provider: StrategyProvider = {
    id: "bundled:acceptance-qsts-postflop-2026-08-28",
    async getStrategy(): Promise<never> { throw new Error("Pack generation provider must never be queried"); },
  };
  const base = createAcceptanceNodeDefinition(provider, "off");
  const fixedHoleCards = Object.fromEntries(
    Object.entries(base.fixedHoleCards ?? {}).filter(([seat]) => seat !== "seat-7"),
  ) as NonNullable<typeof base.fixedHoleCards>;
  const definition = {
    ...base,
    id: "solved-bb-vs-co-qsts-qh8s4s",
    ranges: { "seat-2": heroRange, "seat-7": villainRange },
    fixedHoleCards,
    sourceTags: { ...base.sourceTags, strategicClasses: ["bluff-catcher", "mixed-action", "check-raise", "combo-draw", "close-EV-spot"] },
  };
  const prepared = reconstructNode(definition, new ReplayRng(definition.seed));
  if (!prepared.available) throw new RangeError(prepared.block.reason);
  const query = buildStrategyQuery({
    state: prepared.state,
    heroSeatId: definition.heroSeatId,
    ranges: prepared.ranges,
    actionTree: definition.actionTree,
  });
  const identity = createStrategyQueryHashes({
    gameConfig: query.gameConfig,
    ranges: query.ranges,
    tree: query.actionTree,
    nodeHash: query.nodeHash,
    board: query.board,
  });
  const sourceUnitsPerBB = raw.source_units_per_bb;
  const policyByCards = new Map(raw.hero_policy.map((row) => [row.cards, row]));
  const comboPolicy = [...heroRange.values()].map((combo) => {
    const key = `${combo.cards[0]}${combo.cards[1]}`;
    const reverseKey = `${combo.cards[1]}${combo.cards[0]}`;
    const rawRow = policyByCards.get(key) ?? policyByCards.get(reverseKey);
    if (rawRow === undefined) throw new RangeError(`Raw policy row missing for ${combo.id}`);
    return {
      cards: combo.cards,
      weight: combo.weight,
      actions: rawRow.actions.map((item) => ({
        action: mapAction(item, query.legalActions, sourceUnitsPerBB),
        frequency: item.frequency,
        evBB: bb(item.ev / sourceUnitsPerBB),
      })),
    };
  });
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");
  const exploitabilityBB = raw.exploitability / sourceUnitsPerBB;
  const targetExploitabilityBB = raw.target_exploitability / sourceUnitsPerBB;
  const startingPotBB = raw.starting_pot / sourceUnitsPerBB;
  const convergence = {
    exploitabilityBB,
    exploitabilityPctPot: exploitabilityBB / startingPotBB * 100,
    targetExploitabilityBB,
    targetExploitabilityPctPot: targetExploitabilityBB / startingPotBB * 100,
    iterations: raw.iterations,
    solver: raw.solver,
    compression: raw.compression,
  };
  const notes = [
    raw.range_note,
    "Current conditional Hero and Villain ranges are normalized to unit mass at the target node; combo-policy row weights exactly match the query ranges.",
    "Continuation tree: OOP checks at the flop root; IP may check or bet 1.8 BB; versus 1.8 BB, OOP may fold, call, raise to 5.5/7.2/9 BB, or jam. Later streets use 66% pot plus jam on turn and 100% pot plus jam on river, with jam-only re-raises.",
    "Action EV convention: postflop-solver expected_values_detail for the acting hand, converted from 10 solver units per BB. Fold is 0; EV differences at this node support regret grading.",
    `Raw exporter SHA-256 ${rawSha256}. All ${comboPolicy.length} positive-reach Hero combos include every target action, frequency, and action EV.`,
  ];
  const scenario: StrategyPackScenarioManifest = {
    id: definition.id,
    nodeIdentity: identity,
    config: definition.config,
    buttonIndex: definition.buttonIndex,
    heroSeatId: definition.heroSeatId,
    actionTree: acceptanceActionTree,
    seed: definition.seed,
    ranges: Object.fromEntries(Object.entries(prepared.ranges).map(([seat, range]) => [seat, [...range.values()].map(({ cards: comboCards, weight }) => ({ cards: comboCards, weight }))])),
    fixedHoleCards,
    deadCards: [],
    futureBoard: definition.futureBoard ?? [],
    replay: definition.replay,
    expected: {
      actor: query.actorSeatId,
      street: query.street,
      board: query.board,
      potBB: query.potBB,
      currentBetBB: prepared.state.currentBetBB,
      stacksBB: query.stacksBB,
    },
    sourceTags: definition.sourceTags,
  };
  const pack = parseStrategyPack({
    schemaVersion: STRATEGY_PACK_SCHEMA_VERSION,
    packId: "acceptance-qsts-postflop-2026-08-28",
    source: {
      name: "Bundled BB-vs-CO acceptance solve",
      version: "2026-08-28.1",
      timestamp: "2026-08-28T17:29:46Z",
      solver: raw.solver,
      commit: raw.solver_commit,
      sourceUrl: "https://github.com/b-inary/postflop-solver",
      license: "AGPL-3.0-or-later",
    },
    nodes: [{
      provenance: "SOLVED",
      ...identity,
      stackBB: query.stacksBB,
      potBB: query.potBB,
      rake: query.rake,
      board: query.board,
      legalActions: query.legalActions,
      convergence,
      notes,
      comboPolicy,
    }],
    scenarios: [scenario],
  });
  await writeFile(outputPath, `${JSON.stringify(pack)}\n`, "utf8");
  process.stdout.write(`Wrote ${comboPolicy.length} combo rows to ${outputPath}\n`);
}

await main();
