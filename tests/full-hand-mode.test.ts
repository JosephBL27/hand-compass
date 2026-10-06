import { describe, expect, it } from "vitest";
import { actionKey } from "../src/domain/actions";
import { createAcceptanceProviderRegistry, createEducationalProvider, createTrainerSession, EDUCATIONAL_PROVIDER_ID } from "../src/app/sessionAdapter";
import { createFullHandDefinition } from "../src/fixtures/fullHand";
import { prepareFullHand } from "../src/session/scenario";
import { ReplayRng } from "../src/session/rng";
import { buildStrategyQuery } from "../src/session/query";
import { comboId } from "../src/domain/ranges";
import { bb } from "../src/domain/money";

describe("full-hand trainer mode", () => {
  it("constructs 4-, 6-, and 8-handed private ledgers with exact unequal stacks and no card collisions", () => {
    const provider = createEducationalProvider();
    for (const playerCount of [4, 5, 6, 7, 8] as const) {
      const startingStacksBB = Array.from({ length: playerCount }, (_, index) => 35 + index * 13);
      const definition = createFullHandDefinition(provider, "off", { playerCount, startingStacksBB, buttonIndex: playerCount - 1, seed: 100 + playerCount });
      const prepared = prepareFullHand(definition, new ReplayRng(definition.seed));
      expect(prepared.available).toBe(true);
      if (!prepared.available) continue;
      const privateCards = prepared.state.players.flatMap((player) => player.holeCards ?? []);
      expect(privateCards).toHaveLength(playerCount * 2);
      expect(new Set(privateCards).size).toBe(privateCards.length);
      expect(prepared.state.players.map(({ stackBB, totalContributionBB }) => stackBB + totalContributionBB))
        .toEqual(startingStacksBB.map((value) => bb(value)));
      expect(Object.values(prepared.ranges).every((range) => range?.size === 1326)).toBe(true);
    }
  });

  it("deals unique private cards, hides opponents, and pauses at Hero without revealing strategy", async () => {
    const controller = await createTrainerSession("Off", {
      drillMode: "Full hand",
      fullHand: {
        playerCount: 8,
        startingStacksBB: [100, 75, 120, 60, 150, 90, 110, 100],
        buttonIndex: 0,
        seed: 20_260_826,
      },
    });
    expect(controller.mode).toBe("Full hand");
    expect(controller.snapshot.phase).toBe("AWAITING_HERO");
    expect(controller.snapshot.state?.players.map(({ stackBB }) => stackBB)).not.toEqual(new Array(8).fill(100));
    const visibleHoleCards = controller.snapshot.state?.players.flatMap((player) => player.holeCards ?? []) ?? [];
    expect(visibleHoleCards).toHaveLength(2);
    expect(new Set([...visibleHoleCards, ...(controller.snapshot.state?.board ?? [])]).size)
      .toBe(visibleHoleCards.length + (controller.snapshot.state?.board.length ?? 0));
    expect(JSON.stringify(controller.snapshot)).not.toContain("comboPolicy");
    expect(JSON.stringify(controller.snapshot)).not.toContain("evBB");
    expect(controller.snapshot.legalActions.length).toBeGreaterThan(0);
  });

  it("reveals a HEURISTIC verdict, continues the same hand, and never adds solver precision", async () => {
    const controller = await createTrainerSession("High RNG", {
      drillMode: "Full hand",
      fullHand: {
        playerCount: 4,
        startingStacksBB: [80, 45, 120, 67],
        buttonIndex: 0,
        seed: 20_260_829,
      },
    });
    expect(controller.snapshot.phase).toBe("AWAITING_HERO");
    const action = controller.snapshot.legalActions.find(({ kind }) => kind === "call") ?? controller.snapshot.legalActions[0];
    expect(action).toBeDefined();
    const historyBefore = controller.snapshot.state?.actionHistory.map(({ action: item }) => actionKey(item));
    const submitted = controller.session.submitHeroAction(action!);
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot.reveal?.strategy).toMatchObject({ provenance: "HEURISTIC" });
    expect(submitted.snapshot.reveal?.strategy.actions.every((item) => item.frequency === undefined && item.evBB === undefined)).toBe(true);
    expect(submitted.snapshot.rng.available).toBe(false);
    const next = await controller.session.continue();
    expect(next.state?.actionHistory.slice(0, historyBefore?.length).map(({ action: item }) => actionKey(item))).toEqual(historyBefore);
    expect(["AWAITING_HERO", "TERMINAL", "BLOCKED"]).toContain(next.phase);
  });

  it("automates the first opponent from the deterministic row for its dealt combo", async () => {
    const provider = createEducationalProvider();
    const options = {
      playerCount: 4,
      startingStacksBB: [100, 82, 140, 61],
      buttonIndex: 0,
      seed: 901,
    } as const;
    const definition = createFullHandDefinition(provider, "off", options);
    const prepared = prepareFullHand(definition, new ReplayRng(definition.seed));
    expect(prepared.available).toBe(true);
    if (!prepared.available || prepared.state.actor === null) return;
    const actor = prepared.state.players.find(({ id }) => id === prepared.state.actor)!;
    const query = buildStrategyQuery({ state: prepared.state, heroSeatId: definition.heroSeatId, ranges: prepared.ranges, actionTree: definition.actionTree });
    const result = await provider.getStrategy(query);
    const heldRow = result.comboPolicy?.find((row) => comboId(...row.cards) === comboId(...actor.holeCards!));
    expect(result).toMatchObject({ provenance: "HEURISTIC" });
    expect(result.comboPolicy).toHaveLength(1326);
    expect(heldRow?.actions).toHaveLength(1);

    const session = await createTrainerSession("Off", { drillMode: "Full hand", fullHand: options });
    const firstAction = session.snapshot.state?.actionHistory[0]?.action;
    expect(firstAction).toBeDefined();
    expect(actionKey(firstAction!)).toBe(actionKey(heldRow!.actions[0]!.action));
  });

  it("blocks an unavailable selected provider instead of substituting the heuristic policy", async () => {
    const registry = createAcceptanceProviderRegistry();
    await expect(createTrainerSession("Off", {
      registry,
      activeProviderId: "unregistered-solver",
      drillMode: "Full hand",
      fullHand: { playerCount: 6, startingStacksBB: [100, 90, 80, 70, 60, 50], buttonIndex: 2, seed: 41 },
    })).rejects.toThrow("Provider is not registered");
    expect(registry.requireAvailable(EDUCATIONAL_PROVIDER_ID).id).toBe(EDUCATIONAL_PROVIDER_ID);
  });
});
