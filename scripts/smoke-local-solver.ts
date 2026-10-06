import {
  configureAndProbeLocalSolver,
  createAcceptanceProviderRegistry,
  createCustomSpotSession,
  LOCAL_SOLVER_PROVIDER_ID,
} from "../src/app/sessionAdapter";

const endpoint = process.env.POKER_SOLVER_ENDPOINT ?? "http://127.0.0.1:4317/v1/solve";
const registry = createAcceptanceProviderRegistry();
const probe = await configureAndProbeLocalSolver(registry, endpoint, { timeoutMs: 180_000 });
if (probe.status !== "available") throw new Error(probe.message);

const secondBoard = JSON.stringify({
  playerCount: 6,
  buttonIndex: 0,
  heroSeatIndex: 2,
  startingStacksBB: [100, 100, 100, 100, 100, 100],
  fixedHoleCards: { "2": ["As", "7s"] },
  futureBoard: ["Ah", "7d", "2c", "Ks", "3h"],
  ranges: {
    "2": [
      { cards: ["As", "7s"], weight: 1 },
      { cards: ["Qs", "Ts"], weight: 0.5 },
    ],
    "5": [
      { cards: ["Ad", "Kd"], weight: 1 },
      { cards: ["Kc", "Qc"], weight: 0.5 },
    ],
  },
  actionTree: { river: [{ type: "raise-to", toBB: 12 }, { type: "all-in" }] },
  actions: [
    { kind: "fold" }, { kind: "fold" }, { kind: "raise", toBB: 2.5 },
    { kind: "fold" }, { kind: "fold" }, { kind: "call", amountBB: 1.5 },
    { kind: "check" }, { kind: "check" }, { kind: "check" }, { kind: "check" },
    { kind: "check" }, { kind: "bet", toBB: 4.1 },
  ],
  expected: {
    actorSeatIndex: 2,
    street: "river",
    board: ["Ah", "7d", "2c", "Ks", "3h"],
    potBB: 9.6,
    currentBetBB: 4.1,
  },
});

const controller = await createCustomSpotSession(
  secondBoard,
  registry.requireAvailable(LOCAL_SOLVER_PROVIDER_ID),
  "Off",
);
if (controller.snapshot.phase !== "AWAITING_HERO") {
  throw new Error(controller.snapshot.blocked?.reason ?? `Second-board solve ended in ${controller.snapshot.phase}`);
}
if (JSON.stringify(controller.snapshot).includes("frequency") || JSON.stringify(controller.snapshot).includes("evBB")) {
  throw new Error("Strategy leaked before the Hero decision");
}
const call = controller.snapshot.legalActions.find((action) => action.kind === "call");
if (call === undefined) throw new Error("Second-board solve did not return a legal call");
const submitted = controller.session.submitHeroAction(call);
const reveal = submitted.snapshot.reveal;
if (!submitted.accepted || reveal?.strategy.provenance !== "SOLVED") {
  throw new Error("Second-board action did not produce a solved reveal");
}
if (reveal.strategy.actions.some((action) => action.frequency === undefined || action.evBB === undefined)) {
  throw new Error("Second-board held-combo row is missing a frequency or EV");
}

console.log(JSON.stringify({
  acceptanceProbe: probe.status,
  secondBoard: controller.snapshot.state?.board,
  secondBoardLegalActions: controller.snapshot.legalActions,
  grade: reveal.grade,
  source: reveal.strategy.source,
  convergence: reveal.strategy.convergence,
}, null, 2));

