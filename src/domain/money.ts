/** Fixed precision: one unit is 0.0001 big blinds. */
export const BB_SCALE = 10_000;

declare const bbBrand: unique symbol;
export type BB = number & { readonly [bbBrand]: "BB" };

export const ZERO_BB = 0 as BB;

export function bb(value: number): BB {
  if (!Number.isFinite(value)) throw new RangeError("BB value must be finite");
  return Math.round((value + Number.EPSILON) * BB_SCALE) as BB;
}

export function bbFromUnits(units: number): BB {
  if (!Number.isSafeInteger(units)) throw new RangeError("BB units must be a safe integer");
  return units as BB;
}

export function bbToNumber(value: BB): number {
  return value / BB_SCALE;
}

export function bbAdd(...values: readonly BB[]): BB {
  return values.reduce<number>((sum, value) => sum + value, 0) as BB;
}

export function bbSub(left: BB, right: BB): BB {
  return (left - right) as BB;
}

export function bbMin(...values: readonly BB[]): BB {
  if (values.length === 0) throw new RangeError("bbMin requires at least one value");
  return Math.min(...values) as BB;
}

export function bbMax(...values: readonly BB[]): BB {
  if (values.length === 0) throw new RangeError("bbMax requires at least one value");
  return Math.max(...values) as BB;
}

export function bbMul(value: BB, multiplier: number): BB {
  return Math.round(value * multiplier) as BB;
}

export function formatBB(value: BB, decimals = 4): string {
  const rendered = bbToNumber(value).toFixed(decimals).replace(/\.0+$|(?<=\.[0-9]*?)0+$/u, "");
  return `${rendered} BB`;
}
