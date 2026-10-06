import { describe, expect, it } from "vitest";
import { actionKey } from "../src/domain/actions";
import { parseStrategyPack } from "../src/domain/strategyPack";
import { createAcceptanceSession } from "../src/app/sessionAdapter";
import bundledPackJson from "../src/solutions/acceptance-qsts-solved.pack.json";

describe("bundled acceptance solution", () => {
  it("contains all 411 reached Hero combos with a complete frequency and EV row", () => {
    const pack = parseStrategyPack(bundledPackJson);
    const node = pack.nodes[0]!;
    const legal = new Set(node.legalActions.map(actionKey));
    expect(node.comboPolicy).toHaveLength(411);
    expect(node.convergence).toMatchObject({
      iterations: 290,
      exploitabilityBB: 0.023,
      exploitabilityPctPot: 0.41890891335227276,
      targetExploitabilityPctPot: 0.5,
    });
    expect(pack.source.version).toBe("2026-09-06.native-2.1.0");
    expect(node.notes?.join(" ")).toContain("exactly the manifest action tree");
    for (const row of node.comboPolicy) {
      expect(new Set(row.actions.map(({ action }) => actionKey(action)))).toEqual(legal);
      expect(row.actions.reduce((sum, { frequency }) => sum + frequency, 0)).toBeCloseTo(1, 3);
      expect(row.actions.every(({ evBB }) => Number.isSafeInteger(evBB))).toBe(true);
    }
  });

  it("grades the exact QsTs row across the five-step policy without leaking it before submission", async () => {
    const expected = new Map([
      ["fold", "BLUNDER"],
      ["call:18000", "BEST MOVE"],
      ["raise:55000", "MISTAKE"],
      ["raise:72000", "INACCURACY"],
      ["raise:90000", "GOOD MOVE"],
      ["jam:975000", "BLUNDER"],
    ]);
    for (const [key, grade] of expected) {
      const controller = await createAcceptanceSession("Off");
      expect(JSON.stringify(controller.snapshot)).not.toMatch(/frequency|evBB/u);
      const action = controller.snapshot.legalActions.find((candidate) => actionKey(candidate) === key);
      expect(action).toBeDefined();
      const result = controller.session.submitHeroAction(action!);
      expect(result.snapshot.reveal).toMatchObject({
        strategy: { provenance: "SOLVED", actions: { length: 6 } },
        grade: { mode: "EV", grade },
      });
    }
  });

  it("continues the exact hand and labels an unsupported turn node HEURISTIC after the next answer", async () => {
    const controller = await createAcceptanceSession("Off");
    const call = controller.snapshot.legalActions.find(({ kind }) => kind === "call")!;
    controller.session.submitHeroAction(call);
    const turn = await controller.session.continue();
    expect(turn).toMatchObject({ phase: "AWAITING_HERO", state: { street: "turn", board: ["Qh", "8s", "4s", "2c"] } });
    const check = turn.legalActions.find(({ kind }) => kind === "check")!;
    const revealed = controller.session.submitHeroAction(check).snapshot.reveal;
    expect(revealed).toMatchObject({ strategy: { provenance: "HEURISTIC" }, grade: { mode: "HEURISTIC" } });
    expect(revealed?.strategy.notes).toEqual(expect.arrayContaining([expect.stringMatching(/No exact node.*explicitly HEURISTIC/u)]));
    expect(revealed?.strategy.actions.every(({ evBB, frequency }) => evBB === undefined && frequency === undefined)).toBe(true);
  });
});
