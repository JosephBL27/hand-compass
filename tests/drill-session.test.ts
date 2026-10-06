import { describe, expect, it } from "vitest";
import {
  actionKey,
  bb,
  bbToNumber,
  card,
  createCashConfig,
  createRange,
  seatId,
  standardActionTree,
  type ActionTreeConfig,
  type ComboPolicy,
  type GameConfig,
  type PokerAction,
  type SeatId,
  type StrategyProvider,
  type StrategyQuery,
  type StrategyRequestContext,
  type StrategyResult,
  type WeightedRange,
} from "../src/domain";
import {
  DrillSession,
  ReplayRng,
  ScenarioValidationError,
  createNodeDescriptor,
  sampleJointHoleCards,
  type NodeScenarioDefinition,
} from "../src/session";

const acceptanceTree: ActionTreeConfig = {
  id: "acceptance-fixed",
  preflop: {
    unopened: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(2.5) }] },
    facingRaise: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(8.5) }, { type: "all-in" }] },
  },
  flop: {
    mode: "fixed",
    candidates: [
      { type: "raise-to", toBB: bb(5.5) },
      { type: "raise-to", toBB: bb(7.2) },
      { type: "raise-to", toBB: bb(9) },
      { type: "all-in" },
    ],
  },
  turn: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 0.66 }, { type: "all-in" }] },
  river: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 1 }, { type: "all-in" }] },
};

class RecordingProvider implements StrategyProvider {
  readonly id: string;
  readonly queries: StrategyQuery[] = [];
  readonly #resolve: (query: StrategyQuery) => StrategyResult | Promise<StrategyResult>;

  constructor(id: string, resolve: (query: StrategyQuery) => StrategyResult | Promise<StrategyResult>) {
    this.id = id;
    this.#resolve = resolve;
  }

  async getStrategy(query: StrategyQuery): Promise<StrategyResult> {
    this.queries.push(query);
    return this.#resolve(query);
  }
}

function withProvider(config: GameConfig, tree: ActionTreeConfig, provider: StrategyProvider): GameConfig {
  return { ...config, actionTreeId: tree.id, strategyProviderId: provider.id };
}

const fixedEight = {
  [seatId(0)]: [card("Ac"), card("Ad")],
  [seatId(1)]: [card("Kc"), card("Kh")],
  [seatId(2)]: [card("Qs"), card("Ts")],
  [seatId(3)]: [card("3c"), card("3d")],
  [seatId(4)]: [card("5c"), card("5d")],
  [seatId(5)]: [card("6c"), card("6d")],
  [seatId(6)]: [card("7c"), card("7d")],
  [seatId(7)]: [card("As"), card("Js")],
} as const;

function range(...combos: readonly (readonly [string, string])[]): WeightedRange {
  return createRange(combos.map(([first, second]) => ({ cards: [card(first), card(second)] as const, weight: 1 })));
}

function acceptanceDefinition(provider: StrategyProvider, seed = 17): NodeScenarioDefinition {
  return {
    id: "acceptance-qsts",
    config: withProvider(createCashConfig(8, bb(100)), acceptanceTree, provider),
    heroSeatId: seatId(2),
    buttonIndex: 0,
    actionTree: acceptanceTree,
    strategyProvider: provider,
    seed,
    fixedHoleCards: fixedEight,
    ranges: {
      [seatId(2)]: range(["Qs", "Ts"], ["Qc", "Tc"]),
      [seatId(7)]: range(["As", "Js"], ["Ah", "Jh"]),
    },
    futureBoard: [card("Qh"), card("8s"), card("4s"), card("2c"), card("Kd")],
    replay: [
      { kind: "fold" },
      { kind: "fold" },
      { kind: "fold" },
      { kind: "fold" },
      { kind: "raise", to: bb(2.5) },
      { kind: "fold" },
      { kind: "fold" },
      { kind: "call", amount: bb(1.5) },
      { kind: "check" },
      { kind: "bet", to: bb(1.8) },
    ],
    expected: {
      actor: seatId(2),
      street: "flop",
      board: [card("Qh"), card("8s"), card("4s")],
      potBB: bb(7.3),
      currentBetBB: bb(1.8),
    },
    sourceTags: { preflopLine: "vs-open", potType: "SRP", strategicClasses: ["bluff-catcher"] },
  };
}

function solvedHeroResult(query: StrategyQuery): StrategyResult {
  const fold = query.legalActions.find((action) => action.kind === "fold")!;
  const call = query.legalActions.find((action) => action.kind === "call")!;
  const policy: ComboPolicy = [
    { cards: [card("Qs"), card("Ts")], weight: 0.75, actions: [{ action: fold, frequency: 0.25, evBB: bb(1) }, { action: call, frequency: 0.75, evBB: bb(2) }] },
    { cards: [card("Qc"), card("Tc")], weight: 0.25, actions: [{ action: fold, frequency: 0.5, evBB: bb(1.5) }, { action: call, frequency: 0.5, evBB: bb(1.9) }] },
  ];
  return {
    provenance: "SOLVED",
    actions: [
      { action: fold, frequency: 0.3125, evBB: bb(1.25) },
      { action: call, frequency: 0.6875, evBB: bb(1.95) },
    ],
    comboPolicy: policy,
  };
}

function fourFixed(): Readonly<Record<SeatId, readonly [ReturnType<typeof card>, ReturnType<typeof card>]>> {
  return {
    [seatId(0)]: [card("Qc"), card("Qd")],
    [seatId(1)]: [card("Jc"), card("Jd")],
    [seatId(2)]: [card("Tc"), card("Td")],
    [seatId(3)]: [card("As"), card("Ah")],
  };
}

function fourRanges(): Readonly<Partial<Record<SeatId, WeightedRange>>> {
  return {
    [seatId(0)]: range(["Qc", "Qd"]),
    [seatId(1)]: range(["Jc", "Jd"]),
    [seatId(2)]: range(["Tc", "Td"]),
    [seatId(3)]: range(["As", "Ah"], ["Kc", "Kd"]),
  };
}

describe("headless deterministic drill session", () => {
  it("propagates cancellation without a provider block and rolls back session, rules, and RNG state", async () => {
    let requests = 0;
    const provider: StrategyProvider = {
      id: "abortable",
      async getStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult> {
        requests += 1;
        if (requests === 1) {
          return new Promise<StrategyResult>((_resolve, reject) => {
            const rejectAbort = () => reject(context?.signal?.reason ?? new DOMException("cancelled", "AbortError"));
            if (context?.signal?.aborted === true) rejectAbort();
            else context?.signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        const call = query.legalActions.find((action) => action.kind === "call") ?? query.legalActions[0]!;
        return { provenance: "HEURISTIC", actions: [{ action: call }] };
      },
    };
    const session = DrillSession.loadNode(acceptanceDefinition(provider));
    const before = session.snapshot();
    const controller = new AbortController();
    const pending = session.runUntilHeroOrTerminal({ signal: controller.signal });
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(session.snapshot()).toEqual(before);
    expect(session.snapshot().blocked).toBeUndefined();
    await expect(session.runUntilHeroOrTerminal()).resolves.toMatchObject({ phase: "AWAITING_HERO" });
  });

  it("restores the revealed decision when a continuation provider request is cancelled", async () => {
    let requests = 0;
    const provider: StrategyProvider = {
      id: "abortable-continuation",
      async getStrategy(query: StrategyQuery, context?: StrategyRequestContext): Promise<StrategyResult> {
        requests += 1;
        if (requests === 2) {
          return new Promise<StrategyResult>((_resolve, reject) => {
            const rejectAbort = () => reject(context?.signal?.reason ?? new DOMException("cancelled", "AbortError"));
            if (context?.signal?.aborted === true) rejectAbort();
            else context?.signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        const preferred = query.legalActions.find((action) => action.kind === "call" || action.kind === "check") ?? query.legalActions[0]!;
        return { provenance: "HEURISTIC", actions: [{ action: preferred }] };
      },
    };
    const session = DrillSession.loadNode(acceptanceDefinition(provider));
    const awaiting = await session.runUntilHeroOrTerminal();
    const call = awaiting.legalActions.find((action) => action.kind === "call")!;
    const revealed = session.submitHeroAction(call).snapshot;
    const controller = new AbortController();
    const pending = session.continue({ signal: controller.signal });
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(session.snapshot()).toEqual(revealed);
    expect(session.snapshot()).toMatchObject({ phase: "REVEALED" });
    await expect(session.continue()).resolves.toMatchObject({ phase: "AWAITING_HERO", state: { street: "turn" } });
  });

  it("reconstructs the 7.3 BB acceptance node, keeps the query hole-free, and conceals strategy until submission", async () => {
    const provider = new RecordingProvider("solved-fixture", (query) => query.street === "flop"
      ? solvedHeroResult(query)
      : { provenance: "HEURISTIC", actions: [{ action: query.legalActions.find((action) => action.kind === "check")! }] });
    const session = DrillSession.loadNode(acceptanceDefinition(provider));
    const awaiting = await session.runUntilHeroOrTerminal();
    expect(awaiting.phase).toBe("AWAITING_HERO");
    expect(bbToNumber(awaiting.state!.potBB)).toBe(7.3);
    expect(awaiting.legalActions.map(actionKey)).toEqual([
      "fold", "call:18000", "raise:55000", "raise:72000", "raise:90000", "jam:975000",
    ]);
    expect(awaiting.decisionMath?.potOdds?.value).toBeCloseTo(1.8 / 9.1, 12);
    const serialized = JSON.stringify(awaiting);
    expect(serialized).not.toContain("frequency");
    expect(serialized).not.toContain("evBB");
    expect(serialized).not.toContain("publicRanges");
    expect(awaiting).not.toHaveProperty("reveal");
    expect(awaiting.state?.players.find(({ id }) => id === seatId(7))).not.toHaveProperty("holeCards");
    expect(provider.queries).toHaveLength(1);
    expect(provider.queries[0]).toMatchObject({
      street: "flop",
      board: ["Qh", "8s", "4s"],
      potBB: bb(7.3),
      actorSeatId: "seat-2",
      actorPosition: "BB",
      heroSeatId: "seat-2",
      heroPosition: "BB",
      opponentPositions: ["CO"],
    });
    expect(provider.queries[0]?.actionHistory).toHaveLength(10);
    expect(provider.queries[0]?.legalActions.map(actionKey)).toEqual(awaiting.legalActions.map(actionKey));
    expect(JSON.stringify(createNodeDescriptor(awaiting.state!))).not.toContain("holeCards");
    expect(provider.queries[0]).not.toHaveProperty("holeCards");
    expect(provider.queries[0]?.nodeHash).toMatch(/^[0-9a-f]{8}$/u);

    const call = awaiting.legalActions.find((action) => action.kind === "call")!;
    const submitted = session.submitHeroAction(call);
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot.phase).toBe("REVEALED");
    expect(submitted.snapshot.reveal?.grade).toEqual({ mode: "REFERENCE_ONLY", grade: "REFERENCE UNAVAILABLE" });
    expect(JSON.stringify(submitted.snapshot.reveal)).toContain("frequency");
    expect(submitted.snapshot.reveal?.strategy.actions.find(({ action }) => action.kind === "call")?.frequency).toBe(0.75);
    expect(submitted.snapshot.reveal?.strategy.actions.find(({ action }) => action.kind === "fold")?.frequency).toBe(0.25);
    expect(submitted.snapshot.reveal?.strategy.notes?.join(" ")).toMatch(/exact held-combo row/iu);
    expect(submitted.snapshot.reveal?.rangeConditioning).toMatchObject({ available: true, retainedActionMass: 1.25 });
    const publicRangesAtDecision = submitted.snapshot.reveal?.publicRangesAtDecision;
    const publicRangesAfterHeroAction = submitted.snapshot.reveal?.publicRangesAfterHeroAction;
    expect(publicRangesAtDecision?.[seatId(2)]?.size).toBe(2);
    expect(publicRangesAfterHeroAction?.[seatId(2)]?.size).toBe(2);
    expect([...publicRangesAtDecision![seatId(2)]!.values()].map(({ weight }) => weight)).toEqual([1, 1]);
    expect([...publicRangesAfterHeroAction![seatId(2)]!.values()].map(({ weight }) => weight)).toEqual([0.6, 0.4]);
    expect(submitted.snapshot.reveal?.publicRanges).toBe(publicRangesAfterHeroAction);
    expect(publicRangesAtDecision?.[seatId(7)]?.size).toBeGreaterThan(0);
    expect(publicRangesAfterHeroAction?.[seatId(7)]?.size).toBeGreaterThan(0);
    expect(publicRangesAtDecision).not.toHaveProperty(seatId(3));
    expect(publicRangesAfterHeroAction).not.toHaveProperty(seatId(3));
    expect(submitted.snapshot.state?.players.find(({ id }) => id === seatId(7))).not.toHaveProperty("holeCards");
    const fullySerializedPublicSnapshot = JSON.stringify(submitted.snapshot, (_key, value) => value instanceof Map ? [...value.values()] : value);
    expect(fullySerializedPublicSnapshot).not.toContain('"3c","3d"');
    const turn = await session.continue();
    expect(turn.phase).toBe("AWAITING_HERO");
    expect(turn.state?.street).toBe("turn");
    expect(turn.state?.board).toEqual(["Qh", "8s", "4s", "2c"]);
    expect(bbToNumber(turn.state!.potBB)).toBe(9.1);
  });

  it("keeps the public prior after a legal zero-frequency Hero action instead of erasing continuation range", async () => {
    const provider = new RecordingProvider("off-policy-range", solvedHeroResult);
    const session = DrillSession.loadNode(acceptanceDefinition(provider));
    const awaiting = await session.runUntilHeroOrTerminal();
    const raise = awaiting.legalActions.find((action) => action.kind === "raise")!;
    const submitted = session.submitHeroAction(raise);

    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot.reveal?.rangeConditioning).toMatchObject({
      available: false,
      reason: expect.stringMatching(/zero probability/iu),
    });
    const before = submitted.snapshot.reveal?.publicRangesAtDecision[seatId(2)];
    const after = submitted.snapshot.reveal?.publicRangesAfterHeroAction[seatId(2)];
    expect(after).toBe(before);
    expect(after?.size).toBe(2);
  });

  it("grades a concealed held-combo frequency prediction and samples only to continue the same hand", async () => {
    const provider = new RecordingProvider("frequency-fixture", (query) => query.street === "flop"
      ? solvedHeroResult(query)
      : { provenance: "HEURISTIC", actions: [{ action: query.legalActions.find((action) => action.kind === "check")! }] });
    const session = DrillSession.loadNode(acceptanceDefinition(provider, 1000));
    const awaiting = await session.runUntilHeroOrTerminal();
    expect(awaiting.mixPredictionAvailable).toBe(true);
    expect(JSON.stringify(awaiting)).not.toContain("0.75");
    const prediction = Object.fromEntries(awaiting.legalActions.map((action) => [actionKey(action), action.kind === "fold" ? 0.25 : action.kind === "call" ? 0.75 : 0]));
    const submitted = session.submitHeroFrequencyPrediction(prediction);
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot).toMatchObject({
      phase: "REVEALED",
      mixPredictionAvailable: false,
      reveal: { frequencyPrediction: { grade: "EXCELLENT MIX", totalVariationDistance: 0 } },
    });
    expect(["fold", "call"]).toContain(submitted.snapshot.reveal?.frequencyPrediction?.rolloutAction.kind);
    expect(submitted.snapshot.rng.cursor).toBe(awaiting.rng.cursor + 1);
    if (submitted.snapshot.reveal?.frequencyPrediction?.rolloutAction.kind === "call") {
      await expect(session.continue()).resolves.toMatchObject({ phase: "AWAITING_HERO", state: { street: "turn", board: ["Qh", "8s", "4s", "2c"] } });
    }
  });

  it("refuses frequency prediction when the source lacks exact held-combo frequencies", async () => {
    const provider = new RecordingProvider("heuristic-frequency", (query) => ({ provenance: "HEURISTIC", actions: [{ action: query.legalActions[0]! }] }));
    const session = DrillSession.loadNode(acceptanceDefinition(provider));
    const awaiting = await session.runUntilHeroOrTerminal();
    expect(awaiting.mixPredictionAvailable).toBe(false);
    const prediction = Object.fromEntries(awaiting.legalActions.map((action, index) => [actionKey(action), index === 0 ? 1 : 0]));
    const submitted = session.submitHeroFrequencyPrediction(prediction);
    expect(submitted.accepted).toBe(false);
    expect(submitted.reason).toMatch(/SOLVED|INTERPOLATED/iu);
    expect(submitted.snapshot).toEqual(awaiting);
  });

  it("replays deterministically and lets different seeds reach genuine held-combo policy branches", async () => {
    const run = async (seed: number) => {
      const provider = new RecordingProvider("mixed", (query) => {
        const fold = query.legalActions.find((action) => action.kind === "fold")!;
        const raise = query.legalActions.find((action) => action.kind === "raise")!;
        return {
          provenance: "SOLVED",
          actions: [{ action: fold, frequency: 0.5 }, { action: raise, frequency: 0.5 }],
          comboPolicy: [
            { cards: [card("As"), card("Ah")], weight: 1, actions: [{ action: fold, frequency: 0.5 }, { action: raise, frequency: 0.5 }] },
            { cards: [card("Kc"), card("Kd")], weight: 1, actions: [{ action: fold, frequency: 0.5 }, { action: raise, frequency: 0.5 }] },
          ],
        };
      });
      const config = withProvider(createCashConfig(4, bb(100)), standardActionTree, provider);
      const session = DrillSession.createFullHand({
        config,
        heroSeatId: seatId(0),
        buttonIndex: 0,
        actionTree: standardActionTree,
        strategyProvider: provider,
        seed,
        fixedHoleCards: fourFixed(),
        ranges: fourRanges(),
      });
      const snapshot = await session.runUntilHeroOrTerminal();
      return { snapshot, action: snapshot.state?.actionHistory[0]?.action };
    };
    const first = await run(22);
    const replay = await run(22);
    expect(replay).toEqual(first);
    const branchKeys = new Set<string>();
    for (let seed = 1; seed <= 24; seed += 1) {
      const result = await run(seed);
      if (result.action !== undefined) branchKeys.add(actionKey(result.action));
    }
    expect(branchKeys).toEqual(new Set(["fold", "raise:25000"]));
  });

  it("jointly samples weighted holes without collisions and blocks impossible assignments without a fallback", () => {
    const ranges = {
      [seatId(0)]: range(["As", "Ah"], ["Ks", "Kh"]),
      [seatId(1)]: range(["As", "Ah"], ["Qs", "Qh"]),
      [seatId(2)]: range(["Js", "Jh"]),
      [seatId(3)]: range(["Ts", "Th"]),
    };
    const sampled = sampleJointHoleCards({ playerCount: 4, ranges, reservedCards: [card("2c")], maxAttempts: 100, rng: new ReplayRng(7) });
    expect(sampled.available).toBe(true);
    if (sampled.available) {
      const cards = Object.values(sampled.holeCards).flatMap((hole) => [...hole]);
      expect(new Set(cards).size).toBe(8);
      expect(cards).not.toContain("2c");
    }
    const same = range(["As", "Ah"]);
    const impossibleProvider = new RecordingProvider("unused", () => ({ provenance: "HEURISTIC", actions: [] }));
    const impossible = DrillSession.createFullHand({
      config: withProvider(createCashConfig(4), standardActionTree, impossibleProvider),
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: standardActionTree,
      strategyProvider: impossibleProvider,
      seed: 3,
      ranges: { [seatId(0)]: same, [seatId(1)]: same, [seatId(2)]: same, [seatId(3)]: same },
      maxAssignmentAttempts: 5,
    });
    expect(impossible.snapshot()).toMatchObject({ phase: "BLOCKED", state: null, blocked: { code: "IMPOSSIBLE_HOLE_ASSIGNMENT" } });
  });

  it("uses only the held opponent combo row and blocks absent or incomplete policies without changing rules state", async () => {
    const heldProvider = new RecordingProvider("held-row", (query) => {
      const fold = query.legalActions.find((action) => action.kind === "fold")!;
      const raise = query.legalActions.find((action) => action.kind === "raise")!;
      return {
        provenance: "SOLVED",
        actions: [{ action: fold, frequency: 0.5 }, { action: raise, frequency: 0.5 }],
        comboPolicy: [
          { cards: [card("As"), card("Ah")], weight: 1, actions: [{ action: fold, frequency: 1 }, { action: raise, frequency: 0 }] },
          { cards: [card("Kc"), card("Kd")], weight: 1, actions: [{ action: fold, frequency: 0 }, { action: raise, frequency: 1 }] },
        ],
      };
    });
    const make = (provider: StrategyProvider) => DrillSession.createFullHand({
      config: withProvider(createCashConfig(4), standardActionTree, provider),
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: standardActionTree,
      strategyProvider: provider,
      seed: 9,
      fixedHoleCards: fourFixed(),
      ranges: fourRanges(),
    });
    const held = await make(heldProvider).runUntilHeroOrTerminal();
    expect(held.state?.actionHistory[0]?.action).toEqual({ kind: "fold" });
    expect(held.phase).toBe("AWAITING_HERO");

    for (const provider of [
      new RecordingProvider("missing", () => ({ provenance: "SOLVED", actions: [] })),
      new RecordingProvider("incomplete", (query) => {
        const fold = query.legalActions.find((action) => action.kind === "fold")!;
        return { provenance: "SOLVED", actions: [{ action: fold, frequency: 1 }], comboPolicy: [{ cards: [card("As"), card("Ah")], weight: 1, actions: [{ action: fold, frequency: 1 }] }] };
      }),
    ]) {
      const session = make(provider);
      const before = session.snapshot();
      const blocked = await session.runUntilHeroOrTerminal();
      expect(blocked.phase).toBe("BLOCKED");
      expect(blocked.state?.actor).toBe(before.state?.actor);
      expect(blocked.state?.potBB).toBe(before.state?.potBB);
      expect(blocked.state?.actionHistory).toEqual(before.state?.actionHistory);
      expect(blocked.blocked?.code).toMatch(/MISSING_COMBO_POLICY|INCOMPLETE_COMBO_POLICY/u);
    }
  });

  it("blocks provider failures and a missing held-combo row before state or RNG commit", async () => {
    const providerFailure = new RecordingProvider("throws", () => { throw new Error("transport offline"); });
    const makeSession = (provider: StrategyProvider, actorRange: WeightedRange) => DrillSession.createFullHand({
      config: withProvider(createCashConfig(4), standardActionTree, provider),
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: standardActionTree,
      strategyProvider: provider,
      seed: 12,
      fixedHoleCards: fourFixed(),
      ranges: { ...fourRanges(), [seatId(3)]: actorRange },
    });
    const failed = makeSession(providerFailure, fourRanges()[seatId(3)]!);
    const failedBefore = failed.snapshot();
    const failedAfter = await failed.runUntilHeroOrTerminal();
    expect(failedAfter).toMatchObject({ phase: "BLOCKED", blocked: { code: "PROVIDER_ERROR" } });
    expect(failedAfter.state).toEqual(failedBefore.state);
    expect(failedAfter.rng.cursor).toBe(failedBefore.rng.cursor);

    const missingRowProvider = new RecordingProvider("missing-held", (query) => {
      const fold = query.legalActions.find((action) => action.kind === "fold")!;
      return {
        provenance: "SOLVED",
        actions: [{ action: fold, frequency: 1 }],
        comboPolicy: [{ cards: [card("Kc"), card("Kd")], weight: 1, actions: [{ action: fold, frequency: 1 }] }],
      };
    });
    const missing = makeSession(missingRowProvider, range(["Kc", "Kd"]));
    const missingBefore = missing.snapshot();
    const missingAfter = await missing.runUntilHeroOrTerminal();
    expect(missingAfter).toMatchObject({ phase: "BLOCKED", blocked: { code: "MISSING_HELD_COMBO_ROW" } });
    expect(missingAfter.state).toEqual(missingBefore.state);
    expect(missingAfter.rng.cursor).toBe(missingBefore.rng.cursor);
  });

  it("makes an illegal Hero submission a complete state and RNG no-op and separates solved from heuristic grading", async () => {
    const solvedProvider = new RecordingProvider("rng-solved", solvedHeroResult);
    const solved = DrillSession.loadNode({ ...acceptanceDefinition(solvedProvider), rng: { mode: "high", revealRollBeforeAction: true } });
    const awaiting = await solved.runUntilHeroOrTerminal();
    expect(awaiting.rng.available).toBe(true);
    const before = solved.snapshot();
    const illegal = solved.submitHeroAction({ kind: "check" });
    expect(illegal.accepted).toBe(false);
    expect(illegal.snapshot).toEqual(before);
    expect(illegal.snapshot.rng.cursor).toBe(awaiting.rng.cursor);
    const call = awaiting.legalActions.find((action) => action.kind === "call")!;
    const acceptedSolved = solved.submitHeroAction(call);
    expect(acceptedSolved.snapshot.reveal?.grade.mode).toBe("REFERENCE_ONLY");

    const heuristicProvider = new RecordingProvider("heuristic", (query) => ({ provenance: "HEURISTIC", actions: [{ action: query.legalActions.find((action) => action.kind === "call")! }] }));
    const heuristic = DrillSession.loadNode({ ...acceptanceDefinition(heuristicProvider), rng: { mode: "high", revealRollBeforeAction: true } });
    const heuristicAwaiting = await heuristic.runUntilHeroOrTerminal();
    const acceptedHeuristic = heuristic.submitHeroAction(heuristicAwaiting.legalActions.find((action) => action.kind === "call")!);
    expect(acceptedHeuristic.snapshot.reveal?.grade).toEqual({ mode: "HEURISTIC", grade: "HEURISTIC BEST" });
    expect(acceptedHeuristic.snapshot.rng.available).toBe(false);
  });

  it("settles fold and all-in terminals conservatively while revealing only live showdown hands", async () => {
    const provider = new RecordingProvider("terminal-policy", (query) => {
      const desired = query.legalActions.find((action) => action.kind === "call");
      if (desired === undefined) return { provenance: "HEURISTIC", actions: [] };
      const rows = query.actorPosition === "CO" ? [
        { cards: [card("As"), card("Ah")] as const, weight: 1, actions: [{ action: desired, frequency: 1 }] },
        { cards: [card("Kc"), card("Kd")] as const, weight: 1, actions: [{ action: desired, frequency: 1 }] },
      ] : [{ cards: [card("Jc"), card("Jd")] as const, weight: 1, actions: [{ action: desired, frequency: 1 }] }];
      return { provenance: "SOLVED", actions: [{ action: desired, frequency: 1 }], comboPolicy: rows };
    });
    const one = createCashConfig(4, bb(1));
    const allIn = DrillSession.createFullHand({
      config: withProvider(one, standardActionTree, provider),
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: standardActionTree,
      strategyProvider: provider,
      seed: 31,
      fixedHoleCards: fourFixed(),
      ranges: fourRanges(),
      futureBoard: [card("2c"), card("3d"), card("4h"), card("5s"), card("9c")],
    });
    const hero = await allIn.runUntilHeroOrTerminal();
    expect(hero.phase).toBe("AWAITING_HERO");
    const call = hero.legalActions.find((action) => action.kind === "call")!;
    expect(allIn.submitHeroAction(call).accepted).toBe(true);
    const terminal = await allIn.continue();
    expect(terminal.phase).toBe("TERMINAL");
    expect(terminal.settlement).toMatchObject({ terminalType: "showdown", conserved: true });
    expect(terminal.state?.players.filter(({ status }) => status !== "folded").every((player) => player.holeCards !== undefined)).toBe(true);

    const foldProvider = new RecordingProvider("fold-policy", (query) => {
      const fold = query.legalActions.find((action) => action.kind === "fold")!;
      const rows = query.actorPosition === "CO" ? [
        { cards: [card("As"), card("Ah")] as const, weight: 1, actions: [{ action: fold, frequency: 1 }] },
        { cards: [card("Kc"), card("Kd")] as const, weight: 1, actions: [{ action: fold, frequency: 1 }] },
      ] : [{ cards: [card("Jc"), card("Jd")] as const, weight: 1, actions: [{ action: fold, frequency: 1 }] }];
      return {
        provenance: "SOLVED",
        actions: [{ action: fold, frequency: 1 }],
        comboPolicy: rows,
      };
    });
    const folding = DrillSession.createFullHand({
      config: withProvider(createCashConfig(4), standardActionTree, foldProvider),
      heroSeatId: seatId(0),
      buttonIndex: 0,
      actionTree: standardActionTree,
      strategyProvider: foldProvider,
      seed: 5,
      fixedHoleCards: fourFixed(),
      ranges: fourRanges(),
    });
    const heroFold = await folding.runUntilHeroOrTerminal();
    expect(heroFold.phase).toBe("AWAITING_HERO");
    expect(folding.submitHeroAction(heroFold.legalActions.find((action) => action.kind === "fold")!).accepted).toBe(true);
    const foldTerminal = await folding.continue();
    expect(foldTerminal.phase).toBe("TERMINAL");
    expect(foldTerminal.settlement).toMatchObject({ terminalType: "fold", conserved: true });
    expect(foldTerminal.state?.players.filter(({ id }) => id !== seatId(0)).every((player) => player.holeCards === undefined)).toBe(true);
  });

  it("rejects a node whose replay does not match the declared actor, street, board, pot, or current bet", () => {
    const provider = new RecordingProvider("mismatch", () => ({ provenance: "HEURISTIC", actions: [] }));
    const definition = acceptanceDefinition(provider);
    expect(() => DrillSession.loadNode({ ...definition, expected: { ...definition.expected, potBB: bb(7.2) } })).toThrow(ScenarioValidationError);
  });
});
