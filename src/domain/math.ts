import { bb, bbToNumber, type BB } from "./money";

export interface ExactValue {
  readonly provenance: "EXACT_MATH";
  readonly value: number;
  readonly formula: string;
  readonly inputs: Readonly<Record<string, number>>;
}

export interface PotOddsValue extends ExactValue {
  /** Alias retained beside `value` so callers do not have to infer its meaning. */
  readonly requiredEquity: number;
  /** Pot available at the decision divided by the call risk; null for a free action. */
  readonly potToCallRatio: number | null;
  readonly ratio: Readonly<{ pot: number; call: number }>;
}

function exact(value: number, formula: string, inputs: Readonly<Record<string, number>>): ExactValue {
  if (!Number.isFinite(value)) throw new RangeError("Math result is not finite");
  return { provenance: "EXACT_MATH", value, formula, inputs };
}

export function potOdds(callBB: BB, potAtDecisionBB: BB): PotOddsValue {
  const call = bbToNumber(callBB);
  const pot = bbToNumber(potAtDecisionBB);
  if (call < 0 || pot < 0 || pot + call <= 0) throw new RangeError("Invalid pot-odds inputs");
  const requiredEquity = call / (pot + call);
  return {
    ...exact(requiredEquity, "call / (potAtDecision + call)", { callBB: call, potAtDecisionBB: pot }),
    requiredEquity,
    potToCallRatio: call === 0 ? null : pot / call,
    ratio: { pot, call },
  };
}

/**
 * Exact incremental call threshold after a known rake amount. This is useful
 * only when the projected final contestable pot and rake are both fixed by an
 * explicit assumption (for example, no further wagering after a closing call).
 */
export function potOddsAfterRake(callBB: BB, potAtDecisionBB: BB, rakeBB: BB): PotOddsValue {
  const call = bbToNumber(callBB);
  const pot = bbToNumber(potAtDecisionBB);
  const rake = bbToNumber(rakeBB);
  const finalDistributablePot = pot + call - rake;
  if (call < 0 || pot < 0 || rake < 0 || rake > pot + call || finalDistributablePot <= 0) {
    throw new RangeError("Invalid rake-adjusted pot-odds inputs");
  }
  const requiredEquity = call / finalDistributablePot;
  return {
    ...exact(requiredEquity, "call / (potAtDecision + call - projectedRake)", { callBB: call, potAtDecisionBB: pot, projectedRakeBB: rake }),
    requiredEquity,
    potToCallRatio: call === 0 ? null : (pot - rake) / call,
    ratio: { pot: pot - rake, call },
  };
}

function combinations(n: number, k: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0 || k > n) return 0;
  const choose = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= choose; index += 1) result = (result * (n - choose + index)) / index;
  return result;
}

/** Exact number of remaining Hold'em board runouts for two concrete hole-card hands. */
export function holdemRunoutCount(boardCardCount: number, deadCardCount = 0): number {
  if (!Number.isSafeInteger(boardCardCount) || boardCardCount < 0 || boardCardCount > 5) {
    throw new RangeError("Board card count must be an integer in [0, 5]");
  }
  if (!Number.isSafeInteger(deadCardCount) || deadCardCount < 0 || deadCardCount > 48 - boardCardCount) {
    throw new RangeError("Invalid dead-card count");
  }
  const cardsToCome = 5 - boardCardCount;
  const availableCards = 52 - 4 - boardCardCount - deadCardCount;
  return combinations(availableCards, cardsToCome);
}

export function breakEvenBluffFrequency(betBB: BB, potBeforeBetBB: BB): ExactValue {
  const bet = bbToNumber(betBB);
  const pot = bbToNumber(potBeforeBetBB);
  if (bet < 0 || pot < 0 || pot + bet <= 0) throw new RangeError("Invalid bluff inputs");
  return exact(bet / (pot + bet), "bet / (potBeforeBet + bet)", { betBB: bet, potBeforeBetBB: pot });
}

export function headsUpMdf(betBB: BB, potBeforeBetBB: BB): ExactValue {
  const bet = bbToNumber(betBB);
  const pot = bbToNumber(potBeforeBetBB);
  if (bet < 0 || pot < 0 || pot + bet <= 0) throw new RangeError("Invalid MDF inputs");
  return exact(pot / (pot + bet), "potBeforeBet / (potBeforeBet + bet)", { betBB: bet, potBeforeBetBB: pot });
}

export function riverPolarizedBluffFraction(betAsPotFraction: number): ExactValue {
  if (betAsPotFraction < 0) throw new RangeError("Bet fraction cannot be negative");
  return exact(betAsPotFraction / (1 + 2 * betAsPotFraction), "b / (1 + 2b)", { b: betAsPotFraction });
}

export function bluffToValueRatio(betAsPotFraction: number): ExactValue {
  if (betAsPotFraction < 0) throw new RangeError("Bet fraction cannot be negative");
  return exact(betAsPotFraction / (1 + betAsPotFraction), "b / (1 + b)", { b: betAsPotFraction });
}

export function spr(effectiveStackBB: BB, potBB: BB): ExactValue {
  const stack = bbToNumber(effectiveStackBB);
  const pot = bbToNumber(potBB);
  if (stack < 0 || pot <= 0) throw new RangeError("Invalid SPR inputs");
  return exact(stack / pot, "effectiveStack / pot", { effectiveStackBB: stack, potBB: pot });
}

export interface GeometricSizing extends ExactValue {
  readonly betBB: BB;
  readonly streetsRemaining: number;
}

export function geometricSizing(potBB: BB, effectiveStackBB: BB, streetsRemaining: number): GeometricSizing {
  const pot = bbToNumber(potBB);
  const stack = bbToNumber(effectiveStackBB);
  if (pot <= 0 || stack < 0 || !Number.isSafeInteger(streetsRemaining) || streetsRemaining <= 0) {
    throw new RangeError("Invalid geometric sizing inputs");
  }
  const fraction = (Math.pow(1 + (2 * stack) / pot, 1 / streetsRemaining) - 1) / 2;
  return {
    ...exact(fraction, "((1 + 2S/P)^(1/n) - 1) / 2", { P: pot, S: stack, n: streetsRemaining }),
    betBB: bb(pot * fraction),
    streetsRemaining,
  };
}
