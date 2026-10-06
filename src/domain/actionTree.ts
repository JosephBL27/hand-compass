import type { PokerAction } from "./actions";
import { bb, bbAdd, bbMin, bbMul, ZERO_BB, type BB } from "./money";
import { amountToCall, getLegalActions, type PokerState, type Street } from "./rules";
import { geometricSizing, type GeometricSizing } from "./math";

export type SizingCandidateScope = "bet" | "raise" | "both";

export type SizingCandidate =
  | { readonly type: "pot-fraction"; readonly fraction: number; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "raise-multiple"; readonly multiple: number; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "raise-to"; readonly toBB: BB; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean }
  | { readonly type: "all-in"; readonly scope?: SizingCandidateScope; readonly rootOnly?: boolean };

export type StreetSizingRules =
  | { readonly mode: "fixed"; readonly candidates: readonly SizingCandidate[] }
  | { readonly mode: "dynamic"; readonly candidates: readonly SizingCandidate[]; readonly retainedCandidateIndexes?: readonly number[] }
  | { readonly mode: "geometric"; readonly streetsRemaining: number; readonly includeAllIn?: boolean };

export interface PreflopSizingRules {
  readonly unopened: StreetSizingRules;
  readonly facingRaise: StreetSizingRules;
}

export interface ActionTreeConfig {
  readonly id: string;
  readonly preflop: PreflopSizingRules;
  readonly flop: StreetSizingRules;
  readonly turn: StreetSizingRules;
  readonly river: StreetSizingRules;
}

export interface ResolvedActionTree {
  readonly actions: readonly PokerAction[];
  readonly geometric?: GeometricSizing;
  readonly geometricUnavailable?: {
    readonly code: "FACING_WAGER" | "MULTIWAY" | "MISSING_OPPONENT" | "INVALID_STREET_COUNT";
    readonly reason: string;
  };
}

function candidateTarget(state: PokerState, candidate: SizingCandidate): BB | null {
  if (candidate.type === "all-in") return null;
  if (candidate.type === "raise-to") return candidate.toBB;
  if (candidate.type === "raise-multiple") return bbMul(state.currentBetBB, candidate.multiple);
  if (state.currentBetBB === 0) return bbMul(state.potBB, candidate.fraction);
  const actor = state.players.find((player) => player.id === state.actor);
  if (actor === undefined) throw new Error("Missing actor");
  const call = amountToCall(state);
  const potAfterCall = bbAdd(state.potBB, call);
  return bbAdd(actor.streetContributionBB, call, bbMul(potAfterCall, candidate.fraction));
}

function candidateApplies(state: PokerState, candidate: SizingCandidate): boolean {
  const scope = candidate.scope ?? "both";
  if (scope === "both") return true;
  return state.currentBetBB === ZERO_BB ? scope === "bet" : scope === "raise";
}

function streetRule(tree: ActionTreeConfig, state: PokerState): StreetSizingRules {
  if (state.street === "preflop") return state.currentBetBB <= state.config.bigBlindBB ? tree.preflop.unopened : tree.preflop.facingRaise;
  return tree[state.street satisfies Exclude<Street, "preflop">];
}

export function resolveActionTree(state: PokerState, tree: ActionTreeConfig): ResolvedActionTree {
  const rule = streetRule(tree, state);
  if (rule.mode === "geometric") {
    const expectedStreetsRemaining = { preflop: 4, flop: 3, turn: 2, river: 1 }[state.street];
    if (rule.streetsRemaining !== expectedStreetsRemaining) {
      return {
        actions: getLegalActions(state).filter((action) => rule.includeAllIn !== false || action.kind !== "jam"),
        geometricUnavailable: {
          code: "INVALID_STREET_COUNT",
          reason: `Geometric sizing on ${state.street} requires n = ${expectedStreetsRemaining}; the tree supplied n = ${rule.streetsRemaining}.`,
        },
      };
    }
    const actor = state.players.find((player) => player.id === state.actor);
    if (actor === undefined) return { actions: getLegalActions(state) };
    if (state.currentBetBB > ZERO_BB) {
      return {
        actions: getLegalActions(state).filter((action) => rule.includeAllIn !== false || action.kind !== "jam"),
        geometricUnavailable: {
          code: "FACING_WAGER",
          reason: "The first-bet geometric derivation does not define a raise size while facing a wager.",
        },
      };
    }
    const opponents = state.players.filter((player) => player.id !== actor.id && player.status !== "folded");
    if (opponents.length !== 1) {
      return {
        actions: getLegalActions(state).filter((action) => rule.includeAllIn !== false || action.kind !== "jam"),
        geometricUnavailable: opponents.length === 0
          ? { code: "MISSING_OPPONENT", reason: "Geometric sizing requires one live opponent." }
          : { code: "MULTIWAY", reason: "The heads-up geometric derivation is not applied silently to a multiway pot." },
      };
    }
    const opponent = opponents[0];
    if (opponent === undefined) throw new Error("Geometric opponent invariant failed");
    const geo = geometricSizing(state.potBB, bbMin(actor.stackBB, opponent.stackBB), rule.streetsRemaining);
    const target = bbAdd(actor.streetContributionBB, geo.betBB);
    const actions = getLegalActions(state, [target]).filter((action) => rule.includeAllIn !== false || action.kind !== "jam");
    return { actions, geometric: geo };
  }
  const selected = rule.mode === "dynamic" && rule.retainedCandidateIndexes !== undefined
    ? rule.retainedCandidateIndexes.map((index) => rule.candidates[index]).filter((value): value is SizingCandidate => value !== undefined)
    : rule.candidates;
  const applicable = selected.filter((candidate) => candidateApplies(state, candidate));
  const targets = applicable.map((candidate) => candidateTarget(state, candidate)).filter((value): value is BB => value !== null);
  let actions = getLegalActions(state, targets);
  if (!applicable.some((candidate) => candidate.type === "all-in")) actions = actions.filter((action) => action.kind !== "jam");
  return { actions };
}

export const standardActionTree: ActionTreeConfig = {
  id: "standard",
  preflop: {
    unopened: { mode: "fixed", candidates: [{ type: "raise-to", toBB: bb(2.5) }, { type: "all-in" }] },
    facingRaise: { mode: "fixed", candidates: [{ type: "raise-multiple", multiple: 3 }, { type: "all-in" }] },
  },
  flop: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 0.33, scope: "bet" }, { type: "raise-multiple", multiple: 2.5, scope: "raise" }, { type: "all-in", rootOnly: true }] },
  turn: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 0.66, scope: "bet" }, { type: "raise-multiple", multiple: 2.5, scope: "raise" }, { type: "all-in", rootOnly: true }] },
  river: { mode: "fixed", candidates: [{ type: "pot-fraction", fraction: 1, scope: "bet" }, { type: "raise-multiple", multiple: 2.5, scope: "raise" }, { type: "all-in", rootOnly: true }] },
};
