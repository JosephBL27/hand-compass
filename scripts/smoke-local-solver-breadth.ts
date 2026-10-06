import {
  configureAndProbeLocalSolver,
  createAcceptanceProviderRegistry,
  createCustomSpotSession,
  LOCAL_SOLVER_PROVIDER_ID,
} from "../src/app/sessionAdapter";
import { allCombos } from "../src/domain/ranges";

const rankValue = (card: string): number => "23456789TJQKA".indexOf(card[0] ?? "") + 2;
const publicCombos = [...allCombos().values()];
const rangeRows = (role: "OPEN" | "DEFEND") => publicCombos.filter(({ cards }) => {
  const high = Math.max(rankValue(cards[0]), rankValue(cards[1]));
  const low = Math.min(rankValue(cards[0]), rankValue(cards[1]));
  const pair = high === low;
  const suited = cards[0][1] === cards[1][1];
  if (role === "OPEN") {
    return pair || (high === 14 && low >= 8) || (high >= 12 && low >= 10) || (suited && high >= 10 && low >= 7);
  }
  return pair || high === 14 || (high >= 11 && low >= 9) || (suited && high >= 8 && low >= 5 && high - low <= 4);
}).sort((left, right) => {
  const score = ({ cards }: typeof left): number => {
    const high = Math.max(rankValue(cards[0]), rankValue(cards[1]));
    const low = Math.min(rankValue(cards[0]), rankValue(cards[1]));
    return high * 20 + low + (high === low ? 120 : 0) + (cards[0][1] === cards[1][1] ? 8 : 0);
  };
  return score(right) - score(left);
}).slice(0, role === "OPEN" ? 145 : 210).map(({ cards, weight }) => ({ cards, weight }));

const endpoint = process.env.POKER_SOLVER_ENDPOINT ?? "http://127.0.0.1:4317/v1/solve";
const registry = createAcceptanceProviderRegistry();
const probe = await configureAndProbeLocalSolver(registry, endpoint, { timeoutMs: 600_000 });
if (probe.status !== "available") throw new Error(probe.message);

const heroDefend = rangeRows("DEFEND");
const heldQsts = publicCombos.find(({ cards }) => cards.includes("Qs") && cards.includes("Ts"));
if (heldQsts === undefined) throw new Error("QsTs combo missing from the 1,326-combo deck");
if (!heroDefend.some(({ cards }) => cards.includes("Qs") && cards.includes("Ts"))) {
  heroDefend[heroDefend.length - 1] = { cards: heldQsts.cards, weight: heldQsts.weight };
}
const villainOpen = rangeRows("OPEN");

// These are intentionally broad public subgame ranges, not the two-combo
// acceptance fixture and not claimed to be a solver-derived preflop chart.
const fullRangeFlop = JSON.stringify({
  playerCount: 6,
  buttonIndex: 0,
  heroSeatIndex: 2,
  startingStacksBB: [100, 100, 100, 100, 100, 100],
  fixedHoleCards: { "2": ["Qs", "Ts"] },
  futureBoard: ["Kh", "7d", "2c", "4s", "Jh"],
  ranges: { "2": heroDefend, "5": villainOpen },
  actions: [
    { kind: "fold" }, { kind: "fold" }, { kind: "raise", toBB: 2.5 },
    { kind: "fold" }, { kind: "fold" }, { kind: "call", amountBB: 1.5 },
  ],
  expected: {
    actorSeatIndex: 2,
    street: "flop",
    board: ["Kh", "7d", "2c"],
    potBB: 5.5,
    currentBetBB: 0,
  },
});

const startedAt = performance.now();
const controller = await createCustomSpotSession(
  fullRangeFlop,
  registry.requireAvailable(LOCAL_SOLVER_PROVIDER_ID),
  "Off",
  { signal: AbortSignal.timeout(600_000) },
);
if (controller.snapshot.phase !== "AWAITING_HERO") {
  throw new Error(controller.snapshot.blocked?.reason ?? `Full-range solve ended in ${controller.snapshot.phase}`);
}
const check = controller.snapshot.legalActions.find((action) => action.kind === "check");
if (check === undefined) throw new Error("Full-range solve did not expose check");
const submitted = controller.session.submitHeroAction(check);
const strategy = submitted.snapshot.reveal?.strategy;
if (!submitted.accepted || strategy?.provenance !== "SOLVED") {
  throw new Error(`Full-range action did not reveal a SOLVED result: ${JSON.stringify({ accepted: submitted.accepted, provenance: strategy?.provenance, notes: strategy?.notes })}`);
}
const positiveRows = strategy.comboPolicy?.filter((row) => row.weight > 0) ?? [];
if (positiveRows.length < 180) {
  throw new Error(`Full-range result contained only ${positiveRows.length} positive Hero combo rows`);
}
if (positiveRows.some((row) => row.actions.some((action) => action.evBB === undefined))) {
  throw new Error("Full-range result contains a combo action without EV");
}

console.log(JSON.stringify({
  board: controller.snapshot.state?.board,
  legalActions: controller.snapshot.legalActions,
  positiveHeroComboRows: positiveRows.length,
  suppliedHeroRangeRows: heroDefend.length,
  suppliedVillainRangeRows: villainOpen.length,
  elapsedSeconds: (performance.now() - startedAt) / 1_000,
  convergence: strategy.convergence,
  source: strategy.source,
}, null, 2));
