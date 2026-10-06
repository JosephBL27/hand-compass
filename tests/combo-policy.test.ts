import { describe, expect, it } from "vitest";
import {
  aggregateComboPolicy,
  bb,
  card,
  conditionRangeByAction,
  createRange,
  sampleComboThenAction,
  strategyActionsForHeldCombo,
  weightedComboCount,
  type ComboPolicy,
  type PokerAction,
} from "../src/domain";

const fold = { kind: "fold" } as const satisfies PokerAction;
const call = { kind: "call", amount: bb(1.8) } as const satisfies PokerAction;

const policy: ComboPolicy = [
  {
    cards: [card("As"), card("Ah")],
    weight: 0.75,
    actions: [
      { action: fold, frequency: 0.2, evBB: bb(1) },
      { action: call, frequency: 0.8, evBB: bb(2) },
    ],
  },
  {
    cards: [card("Kc"), card("Kd")],
    weight: 0.25,
    actions: [
      { action: fold, frequency: 0.6, evBB: bb(3) },
      { action: call, frequency: 0.4 },
    ],
  },
];

describe("combo-level policy math", () => {
  it("conditions by Bayes multiplication and reports card-removal and posterior mass", () => {
    const queens = [card("Qs"), card("Qh")] as const;
    const prior = createRange([
      { cards: [card("As"), card("Ah")], weight: 1 },
      { cards: [card("Kc"), card("Kd")], weight: 0.5 },
      { cards: queens, weight: 0.25 },
    ]);
    const completePolicy: ComboPolicy = [
      ...policy,
      { cards: queens, weight: 0.25, actions: [{ action: fold, frequency: 1 }, { action: call, frequency: 0 }] },
    ];
    const result = conditionRangeByAction(prior, completePolicy, call, [card("Qs")]);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result).toMatchObject({
      priorWeightedMass: 1.75,
      cardFilteredWeightedMass: 1.5,
      retainedActionMass: 1,
      priorComboCount: 3,
      cardFilteredComboCount: 2,
      posteriorComboCount: 2,
      removedCardComboCount: 1,
      removedCardWeightedMass: 0.25,
    });
    expect(result.posteriorNormalizedMass).toBeCloseTo(1, 12);
    expect(weightedComboCount(result.posterior)).toBeCloseTo(1, 12);
    expect([...result.posterior.values()].map(({ weight }) => weight)).toEqual([0.8, 0.2]);
  });

  it("does not mutate a prior or automate when combo policy is absent or incomplete", () => {
    const prior = createRange([
      { cards: [card("As"), card("Ah")], weight: 1 },
      { cards: [card("Kc"), card("Kd")], weight: 1 },
    ]);
    const absent = conditionRangeByAction(prior, undefined, call);
    expect(absent).toMatchObject({ available: false });
    if (absent.available) return;
    expect(absent.unchangedRange).toBe(prior);

    const incomplete = conditionRangeByAction(prior, policy.slice(0, 1), call);
    expect(incomplete).toMatchObject({ available: false });
    if (incomplete.available) return;
    expect(incomplete.unchangedRange).toBe(prior);
    expect(incomplete.reason).toMatch(/missing 1 positive-weight prior combo/u);

    expect(sampleComboThenAction(undefined, { seed: 7 })).toMatchObject({ available: false });
  });

  it("aggregates frequencies by combo weight and omits EV unless every reached row supplies it", () => {
    const aggregate = aggregateComboPolicy(policy, [fold, call]);
    expect(aggregate).toHaveLength(2);
    expect(aggregate[0]).toMatchObject({ action: fold, evBB: bb(2) });
    expect(aggregate[0]?.frequency).toBeCloseTo(0.3, 12);
    expect(aggregate[1]).toMatchObject({ action: call });
    expect(aggregate[1]?.frequency).toBeCloseTo(0.7, 12);
    expect(aggregate[1]).not.toHaveProperty("evBB");
    expect(aggregate.reduce((sum, item) => sum + (item.frequency ?? 0), 0)).toBeCloseTo(1, 12);
  });

  it("returns the concrete held-combo strategy without substituting range aggregates", () => {
    const aces = strategyActionsForHeldCombo(policy, [card("As"), card("Ah")], [fold, call]);
    expect(aces).toEqual([
      { action: fold, frequency: 0.2, evBB: bb(1) },
      { action: call, frequency: 0.8, evBB: bb(2) },
    ]);
    expect(strategyActionsForHeldCombo(policy, [card("Qs"), card("Qh")], [fold, call])).toBeUndefined();
  });

  it("samples a legal combo then that exact combo's action deterministically after removal", () => {
    const input = {
      seed: 991,
      heroCards: [card("As"), card("Ah")] as const,
      board: [card("Qh"), card("8s"), card("4s")],
      deadCards: [card("2c")],
    };
    const first = sampleComboThenAction(policy, input);
    const replay = sampleComboThenAction(policy, input);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ available: true, cards: [card("Kc"), card("Kd")], eligibleComboCount: 1, removedCardComboCount: 1 });
    if (!first.available) return;
    expect(policy[1]?.actions.some(({ action }) => JSON.stringify(action) === JSON.stringify(first.action))).toBe(true);
    expect([...input.heroCards, ...input.board, ...input.deadCards]).not.toContain(first.cards[0]);
    expect([...input.heroCards, ...input.board, ...input.deadCards]).not.toContain(first.cards[1]);
  });
});
