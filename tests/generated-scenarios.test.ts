import { describe, expect, it } from "vitest";
import { actionKey } from "../src/domain/actions";
import { assertUniqueCards, card, type Card } from "../src/domain/cards";
import { standardActionTree } from "../src/domain/actionTree";
import { createCashConfig } from "../src/domain/config";
import { bb, bbToNumber } from "../src/domain/money";
import { allCombos, comboId } from "../src/domain/ranges";
import { strategyConfigurationForQuery, type StrategyProvider } from "../src/domain/strategy";
import { DrillSession } from "../src/session/DrillSession";
import { createGeneratedScenarioDefinitions, generateScenarioCatalog, generatedPracticeRange } from "../src/session/generatedScenarios";
import { createPracticeQueue } from "../src/session/practiceQueue";
import { decisionMathForState } from "../src/session/query";
import { reconstructNode } from "../src/session/scenario";
import { ReplayRng } from "../src/session/rng";
import { createScenarioCatalog } from "../src/session/catalog";
import { seatId } from "../src/domain/seats";

const passiveProvider: StrategyProvider = {
  id: "generated-passive-test",
  async getStrategy(query) {
    const action = query.legalActions.find(({ kind }) => kind === "check")
      ?? query.legalActions.find(({ kind }) => kind === "call")
      ?? query.legalActions[0]!;
    return {
      provenance: "HEURISTIC",
      actions: [{ action }],
      comboPolicy: [...query.ranges[query.actorSeatId]!.values()].map((combo) => ({
        cards: combo.cards, weight: combo.weight, actions: [{ action, frequency: 1 }],
      })),
      configuration: strategyConfigurationForQuery(query),
      notes: ["Test-only passive policy; no equilibrium or EV claim."],
    };
  },
};

const catalog = generateScenarioCatalog(passiveProvider);

describe("generated practice catalog", () => {
  it("constructs 480 distinct replayed decisions across every table, depth, street and pot family", () => {
    const matches = catalog.all();
    expect(matches).toHaveLength(480);
    expect(new Set(matches.map(({ definition }) => definition.id)).size).toBe(480);
    expect(new Set(matches.map(({ facts }) => facts.tableSize))).toEqual(new Set([4, 5, 6, 7, 8]));
    expect(new Set(matches.map(({ facts }) => facts.street))).toEqual(new Set(["preflop", "flop", "turn", "river"]));
    expect(new Set(matches.map(({ facts }) => facts.potType))).toEqual(new Set(["SRP", "3-bet", "limped", "multiway"]));
    expect(new Set(matches.map(({ facts }) => facts.heroPosition))).toEqual(new Set(["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"]));
    expect(new Set(matches.map(({ facts }) => facts.stack.mode === "fixed" ? bbToNumber(facts.stack.stackBB) : -1)))
      .toEqual(new Set([20, 40, 75, 100, 150, 200]));
    expect(new Set(matches.filter(({ facts }) => facts.street !== "preflop").map(({ facts }) => facts.board.join(""))).size).toBeGreaterThan(150);
    expect(new Set(matches.map(({ definition }) => comboId(...definition.fixedHoleCards![definition.heroSeatId]!))).size).toBeGreaterThan(100);
    expect(matches.flatMap(({ facts }) => facts.drawClasses)).toEqual(expect.arrayContaining(["flush-draw", "gutshot", "OESD", "combo-draw", "backdoor-flush", "no-draw"]));
    for (const match of matches.filter(({ facts }) => facts.street !== "preflop")) {
      expect(match.facts.playersCurrentlyInPot).toBe(match.facts.potType === "multiway" ? 3 : 2);
    }
  });

  it("preserves exact units, money, private cards, legal replay, and declared public ranges at every node", () => {
    for (const { definition } of catalog.all()) {
      const preparation = reconstructNode(definition, new ReplayRng(definition.seed));
      expect(preparation.available).toBe(true);
      if (!preparation.available) throw new Error(preparation.block.reason);
      const { state } = preparation;
      expect(state.actor).toBe(definition.heroSeatId);
      expect(state.potBB).toBe(state.players.reduce((total, player) => total + player.totalContributionBB, 0));
      const cards = state.players.flatMap(({ holeCards }) => holeCards ?? []);
      expect(() => assertUniqueCards([...cards, ...definition.futureBoard!])).not.toThrow();
      for (const player of state.players) {
        expect(player.stackBB + player.totalContributionBB).toBe(definition.config.startingStacksBB[player.id]);
        expect(definition.ranges[player.id]!.has(comboId(...player.holeCards!))).toBe(true);
        expect(definition.ranges[player.id]!.size).toBeGreaterThan(70);
      }
      const math = decisionMathForState(state);
      if (math.amountToCallBB > 0) {
        expect(math.potOdds?.requiredEquity).toBeCloseTo(math.amountToCallBB / (math.contestablePotAtDecisionBB + math.amountToCallBB), 12);
      }
      // A generated postflop first bet never risks over 35% of the stack;
      // this catches accidental double conversion into fixed-point BB units.
      for (const record of state.actionHistory.filter((item) => item.street !== "preflop")) {
        if (record.action.kind === "bet") {
          expect(record.action.to).toBeGreaterThanOrEqual(bb(1));
          expect(record.action.to).toBeLessThan(definition.config.startingStacksBB[record.seatId]! * 0.36);
        }
      }
      expect(definition.presentation?.rangeAssumption).toContain("not solved preflop or equilibrium ranges");
    }
  });

  it("is deterministic, permits new card orbits and exposes the exact chosen range profile", () => {
    const first = createGeneratedScenarioDefinitions({ strategyProvider: passiveProvider, tableSizes: [6], stackDepthsBB: [40], variantsPerFamily: 2, seed: 812 });
    const again = createGeneratedScenarioDefinitions({ strategyProvider: passiveProvider, tableSizes: [6], stackDepthsBB: [40], variantsPerFamily: 2, seed: 812 });
    expect(first).toHaveLength(32);
    expect(first.map((node) => [node.id, node.replay, node.fixedHoleCards])).toEqual(again.map((node) => [node.id, node.replay, node.fixedHoleCards]));
    expect(new Set(first.map(({ id }) => id)).size).toBe(32);
    expect(generatedPracticeRange("focused", "open").size).toBe(104);
    expect(generatedPracticeRange("broad", "open").size).toBe(398);
    const broad = generateScenarioCatalog(passiveProvider, "high", { tableSizes: [8], stackDepthsBB: [200], rangeProfile: "broad", seed: 918 });
    expect(broad.all()).toHaveLength(16);
    expect(broad.all().every(({ definition }) => definition.presentation?.rangeProfile === "broad")).toBe(true);
    expect(broad.all().every(({ definition }) => definition.rng?.mode === "high")).toBe(true);
  });

  it("continues every generated decision to showdown without leaking private future cards or inventing EV", async () => {
    let completed = 0;
    for (const { definition } of catalog.all()) {
      const session = DrillSession.loadNode(definition);
      let snapshot = await session.runUntilHeroOrTerminal();
      expect(snapshot.phase, definition.id).toBe("AWAITING_HERO");
      const initialHistory = snapshot.state!.actionHistory.map(({ action }) => actionKey(action));
      const heroCards = snapshot.state!.players.find(({ id }) => id === definition.heroSeatId)!.holeCards;
      expect(snapshot.state!.players.flatMap(({ holeCards }) => holeCards ?? [])).toHaveLength(2);
      expect(snapshot.reveal).toBeUndefined();
      for (let guard = 0; snapshot.phase !== "TERMINAL" && guard < 32; guard += 1) {
        expect(snapshot.phase, definition.id).toBe("AWAITING_HERO");
        const action = snapshot.legalActions.find(({ kind }) => kind === "check")
          ?? snapshot.legalActions.find(({ kind }) => kind === "call")!;
        const result = session.submitHeroAction(action);
        expect(result.accepted).toBe(true);
        expect(result.snapshot.reveal!.strategy.actions.every((item) => item.evBB === undefined && item.frequency === undefined)).toBe(true);
        snapshot = await session.continue();
      }
      expect(snapshot.phase, definition.id).toBe("TERMINAL");
      expect(snapshot.state!.board).toEqual(definition.futureBoard);
      expect(snapshot.state!.players.find(({ id }) => id === definition.heroSeatId)!.holeCards).toEqual(heroCards);
      expect(snapshot.state!.actionHistory.slice(0, initialHistory.length).map(({ action }) => actionKey(action))).toEqual(initialHistory);
      expect(snapshot.settlement!.terminalType).toBe("showdown");
      completed += 1;
    }
    expect(completed).toBe(480);
  }, 30_000);
});

describe("continuous practice queue", () => {
  it("serves an entire filtered orbit without replacement and avoids repeating at the cycle boundary", () => {
    const filter = { tableSize: 8, street: "turn" } as const;
    const queue = createPracticeQueue(catalog, { seed: 345 });
    const size = catalog.filter(filter).length;
    const firstOrbit = Array.from({ length: size }, () => queue.next(filter)!.definition.id);
    expect(new Set(firstOrbit).size).toBe(size);
    expect(queue.stats(filter)).toMatchObject({ served: size, uniqueServed: size, remaining: 0, matching: size, cycle: 1 });
    expect(queue.next(filter)!.definition.id).not.toBe(firstOrbit.at(-1));
    expect(queue.stats(filter).cycle).toBe(2);
    expect(queue.next({ scenarioId: "does-not-exist" })).toBeUndefined();
  });

  it("replays the same seed deterministically, keeps exact filters, and resets its cursor", () => {
    const one = createPracticeQueue(catalog, { seed: 312 });
    const two = createPracticeQueue(catalog, { seed: 312 });
    const filter = { heroPosition: "BB", potType: "3-bet" } as const;
    const ids = Array.from({ length: 12 }, () => one.next(filter)!.definition.id);
    expect(ids).toEqual(Array.from({ length: 12 }, () => two.next(filter)!.definition.id));
    one.reset();
    expect(one.stats(filter).served).toBe(0);
    expect(one.next(filter)!.definition.id).toBe(ids[0]);
  });
});

describe("generated hand and draw filter accuracy", () => {
  function factsForCards(hole: readonly [Card, Card], board: readonly Card[]) {
    return createScenarioCatalog([{
      id: "draw-accuracy", config: createCashConfig(4), heroSeatId: seatId(2), buttonIndex: 0,
      strategyProvider: passiveProvider, actionTree: standardActionTree, seed: 65,
      ranges: { [seatId(0)]: allCombos(), [seatId(1)]: allCombos(), [seatId(2)]: allCombos(), [seatId(3)]: allCombos() },
      fixedHoleCards: { [seatId(2)]: hole }, futureBoard: board,
      replay: [{ kind: "fold" }, { kind: "raise", to: bb(2.5) }, { kind: "fold" }, { kind: "call", amount: bb(1.5) }],
      expected: { actor: seatId(2), street: "flop", board, potBB: bb(5.5), currentBetBB: bb(0) },
      sourceTags: { preflopLine: "vs-open", potType: "SRP" },
    }]).all()[0]!.facts;
  }

  it("does not label an already made straight as an open-ended or backdoor straight draw", () => {
    const facts = factsForCards([card("9s"), card("8s")], [card("7h"), card("6d"), card("5c")]);
    expect(facts.heroHandClass).toBe("straight");
    expect(facts.drawClasses).not.toEqual(expect.arrayContaining(["OESD"]));
    expect(facts.drawClasses).not.toEqual(expect.arrayContaining(["gutshot"]));
    expect(facts.drawClasses).not.toEqual(expect.arrayContaining(["backdoor-straight"]));
  });

  it("recognizes the king as the nut-flush draw when the suited ace is on the board", () => {
    const board = [card("As"), card("7s"), card("2d")];
    expect(factsForCards([card("Ks"), card("Ts")], board).drawClasses).toContain("nut-flush-draw");
    expect(factsForCards([card("Qs"), card("Ts")], board).drawClasses).not.toContain("nut-flush-draw");
  });
});
