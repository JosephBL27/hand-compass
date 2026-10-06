import { describe, expect, it } from "vitest";
import { toTrainerState } from "../src/app/trainerModel";
import { createAcceptanceSpot } from "../src/fixtures/acceptanceSpot";
import { applyAction, getLegalActions, type PokerState } from "../src/domain/rules";
import { bb } from "../src/domain/money";
import { seatId } from "../src/domain/seats";

describe("trainer presentation adapter", () => {
  it("renders an all-in river terminal instead of rejecting the settled state", () => {
    const spot = createAcceptanceSpot();
    const jam = spot.legalActions.find(({ kind }) => kind === "jam");
    expect(jam).toBeDefined();
    let state = spot.continueWith(jam!);
    const call = getLegalActions(state).find(({ kind }) => kind === "call");
    expect(call).toBeDefined();
    state = applyAction(state, call!);
    expect(state).toMatchObject({ street: "river", actor: null, terminal: { type: "showdown" } });

    const model = toTrainerState(state, []);
    expect(model).toMatchObject({ street: "River", actorLabel: "Hand complete", legalActions: [] });
    expect(model.board).toHaveLength(5);
  });

  it("preserves flop-start SPR on the turn instead of relabeling turn-start stacks", () => {
    const spot = createAcceptanceSpot();
    const call = spot.legalActions.find(({ kind }) => kind === "call");
    expect(call).toBeDefined();
    const turn = spot.continueWith(call!);
    const model = toTrainerState(turn, getLegalActions(turn));
    expect(model.street).toBe("Turn");
    expect(model.flopStartPotBB).toBe(5.5);
    expect(model.exactFlopStartSpr).toBeCloseTo(97.5 / 5.5, 2);
    expect(model.exactCurrentSpr).toBeCloseTo(95.7 / 9.1, 2);
  });

  it("labels the contestable called pot and separates a short opponent's uncalled return", () => {
    const spot = createAcceptanceSpot();
    const short: PokerState = {
      ...spot.flopDecision,
      players: spot.flopDecision.players.map((player) => player.id === seatId(7) ? { ...player, stackBB: bb(40) } : player),
    };
    const jam = spot.legalActions.find(({ kind }) => kind === "jam");
    expect(jam).toBeDefined();
    const model = toTrainerState(short, [jam!]);
    expect(model.legalActions[0]?.uncalledReturnBB).toBeGreaterThan(0);
    expect(model.legalActions[0]?.detail).toMatch(/Contestable pot.*Uncalled excess returned/u);
  });

  it("does not promise an uncalled return before a multiway caller is specified", () => {
    const spot = createAcceptanceSpot();
    // Presentation-only boundary: another seat can still respond to this jam.
    const multiway: PokerState = {
      ...spot.flopDecision,
      players: spot.flopDecision.players.map((player) => player.id === seatId(0)
        ? { ...player, status: "active" as const } : player),
    };
    const jam = spot.legalActions.find(({ kind }) => kind === "jam")!;
    const action = toTrainerState(multiway, [jam]).legalActions[0]!;
    expect(action.uncalledReturnBB).toBeUndefined();
    expect(action.detail).not.toContain("Uncalled excess returned");
    expect(action.potIfCalledBB).toBeUndefined();
  });
});
