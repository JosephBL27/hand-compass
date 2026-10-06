import type { BB } from "./money";

export type PassiveAction =
  | { readonly kind: "fold" }
  | { readonly kind: "check" }
  | { readonly kind: "call"; readonly amount: BB };

export type AggressiveAction =
  | { readonly kind: "bet"; readonly to: BB }
  | { readonly kind: "raise"; readonly to: BB }
  | { readonly kind: "jam"; readonly to: BB };

export type PokerAction = PassiveAction | AggressiveAction;

export function actionKey(action: PokerAction): string {
  switch (action.kind) {
    case "fold":
    case "check":
      return action.kind;
    case "call":
      return `call:${action.amount}`;
    case "bet":
    case "raise":
    case "jam":
      return `${action.kind}:${action.to}`;
  }
}
