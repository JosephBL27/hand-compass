import { actionKey, type PokerAction } from "../domain/actions";
import { assertUniqueCards, createDeck, type Card, type Rank, type Suit } from "../domain/cards";
import { actionEconomics } from "../domain/economics";
import { customSevenCardEvaluator } from "../domain/evaluator";
import {
  bluffToValueRatio,
  breakEvenBluffFrequency,
  headsUpMdf,
  riverPolarizedBluffFraction,
} from "../domain/math";
import { bbSub, bbToNumber, ZERO_BB, type BB } from "../domain/money";
import { partitionStrategyFrequencies, selectReferenceAction } from "../domain/grading";
import type { WeightedCombo, WeightedRange } from "../domain/ranges";
import type { ActionRecord, PlayerState } from "../domain/rules";
import type { SeatId } from "../domain/seats";
import type { StrategyAction } from "../domain/strategy";
import { describeHandFacts } from "./handFacts";
import type {
  AlternativeExplanation,
  BlockedComboDetail,
  EvidenceCoverage,
  ExactMathPanel,
  ExplanationInput,
  ExplanationModel,
  ExplanationProvenance,
  ExplanationStatement,
  FutureCardDetail,
  FutureCardTag,
  FutureStreetPlan,
  OpponentRangeRemovalSummary,
  RuleOfThumb,
} from "./types";

const ranks: Readonly<Record<Rank, number>> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const straightWindows: readonly (readonly number[])[] = [
  [14, 2, 3, 4, 5],
  [2, 3, 4, 5, 6],
  [3, 4, 5, 6, 7],
  [4, 5, 6, 7, 8],
  [5, 6, 7, 8, 9],
  [6, 7, 8, 9, 10],
  [7, 8, 9, 10, 11],
  [8, 9, 10, 11, 12],
  [9, 10, 11, 12, 13],
  [10, 11, 12, 13, 14],
];

function statement(provenance: ExplanationProvenance, text: string): ExplanationStatement {
  return { provenance, text };
}

function formatBb(value: BB): string {
  return `${bbToNumber(value).toFixed(4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/u, "")} BB`;
}

function formatCard(card: Card): string {
  const suit = ({ s: "♠", h: "♥", d: "♦", c: "♣" } as const)[card[1] as Suit];
  return `${card[0]}${suit}`;
}

function playerById(players: readonly PlayerState[], seatId: SeatId): PlayerState {
  const player = players.find((candidate) => candidate.id === seatId);
  if (player === undefined) throw new RangeError(`Explanation hero is absent from the player ledger: ${seatId}`);
  return player;
}

function sourceActionFor(actions: readonly StrategyAction[], action: PokerAction): StrategyAction | undefined {
  const key = actionKey(action);
  return actions.find((candidate) => actionKey(candidate.action) === key);
}

function readableAction(action: PokerAction): string {
  if (action.kind === "fold" || action.kind === "check") return action.kind;
  if (action.kind === "call") return `call ${formatBb(action.amount)}`;
  return `${action.kind}${action.kind === "raise" ? " to" : ""} ${formatBb(action.to)}`;
}

function handContext(input: ExplanationInput): readonly ExplanationStatement[] {
  const heroCards = playerById(input.state.players, input.heroSeatId).holeCards;
  if (heroCards === undefined) return [];
  const facts = describeHandFacts(heroCards, input.state.board, input.deadCards);
  const result = [statement("EXACT_MATH", `${heroCards.map(formatCard).join(" ")} has ${facts.detail}${facts.drawLabels.length > 0 ? ` plus ${facts.drawLabels.join(" and ")}` : ""}${input.state.board.length > 0 ? ` on ${input.state.board.map(formatCard).join(" ")}` : " before the flop"}.`)];
  if (facts.flushCompletingCards.length > 0 || facts.straightCompletingCards.length > 0) {
    const parts = [facts.flushCompletingCards.length > 0 ? `${facts.flushCompletingCards.length} publicly unseen cards complete a flush` : "",
      facts.straightCompletingCards.length > 0 ? `${facts.straightCompletingCards.length} complete a straight` : ""].filter(Boolean);
    result.push(statement("EXACT_MATH", `${parts.join("; ")} on the next card. These completion counts can overlap and are not guaranteed winning outs; opponent holdings and later redraws still matter.`));
  }
  const madeAndDraw = facts.madeHand.includes("pair") && facts.flushCompletingCards.length > 0;
  if (madeAndDraw) {
    result.push(statement("HEURISTIC", "A pair plus a flush draw combines current showdown value with a second route to a strong hand. Calling keeps the opponent's betting range intact; raising puts in more money but can narrow that range toward stronger continuations. This explains the trade-off, not the solver's private reason for its mix."));
  } else if (facts.madeHand === "high card" && facts.drawLabels.some((label) => !label.startsWith("backdoor"))) {
    result.push(statement("HEURISTIC", "This hand's draw supplies a way to improve when continued against; an aggressive line can also win through folds. Draw completion alone does not establish enough equity or fold equity to make that line profitable."));
  }
  return result;
}

function sourceComparison(input: ExplanationInput): readonly ExplanationStatement[] {
  if (input.strategy.provenance === "HEURISTIC") return [];
  const source = input.legalActions.map((action) => sourceActionFor(input.strategy.actions, action));
  if (source.some((row) => row?.evBB === undefined)) return [];
  const ranked = (source as StrategyAction[]).sort((a, b) => b.evBB! - a.evBB!);
  const best = ranked[0];
  const next = ranked[1];
  if (best === undefined || next === undefined) return [];
  const delta = bbSub(best.evBB!, next.evBB!);
  return [statement(input.strategy.provenance, `For this exact hand, the source's highest action EV is ${readableAction(best.action)} at ${formatBb(best.evBB!)}. The closest alternative is ${readableAction(next.action)}, ${formatBb(delta)} lower${input.state.potBB > 0 ? ` (${(delta / input.state.potBB * 100).toFixed(2)}% of the decision pot)` : ""}. These values compare the configured actions; they do not prove a unique causal sizing explanation.`)];
}

function coverage(count: number, expected: number): EvidenceCoverage {
  if (count === 0 || expected === 0) return "UNAVAILABLE";
  return count === expected ? "COMPLETE" : "PARTIAL";
}

function buildVerdict(input: ExplanationInput): ExplanationModel["verdict"] {
  const legalKeys = new Set(input.legalActions.map(actionKey));
  if (!legalKeys.has(actionKey(input.chosenAction))) throw new RangeError("Chosen explanation action was not issued as legal");
  const legalSourceActions = input.legalActions
    .map((action) => sourceActionFor(input.strategy.actions, action))
    .filter((item): item is StrategyAction => item !== undefined);
  const chosenSourceAction = sourceActionFor(legalSourceActions, input.chosenAction);
  const frequencyCount = legalSourceActions.filter(({ frequency }) => frequency !== undefined && Number.isFinite(frequency) && frequency >= 0).length;
  const evCount = legalSourceActions.filter(({ evBB }) => evBB !== undefined).length;
  const frequencyCoverage = coverage(frequencyCount, input.legalActions.length);
  const evCoverage = coverage(evCount, input.legalActions.length);
  const statements: ExplanationStatement[] = [];
  let referenceAction: StrategyAction | undefined;
  let evLossBB: BB | undefined;

  if (input.strategy.provenance === "HEURISTIC") {
    statements.push(statement("HEURISTIC", "The active source supplies educational action guidance only; it does not establish an equilibrium verdict."));
  } else if (frequencyCoverage === "COMPLETE") {
    const legalStrategy = { ...input.strategy, actions: legalSourceActions };
    const rngMode = input.referenceSelection?.rngMode ?? "off";
    const roll = input.referenceSelection?.roll;
    if (rngMode !== "off" && (!Number.isSafeInteger(roll) || roll === undefined || roll < 1 || roll > 100)) {
      statements.push(statement("UNAVAILABLE", `${rngMode === "high" ? "High" : "Low"} RNG reference is unavailable because no revealed integer roll from 1 through 100 was supplied.`));
    } else {
      referenceAction = selectReferenceAction(legalStrategy, rngMode, roll);
    }
    if (referenceAction !== undefined) {
      if (rngMode === "off") {
        statements.push(statement(input.strategy.provenance, `With RNG off, the equilibrium reference is the source's highest-frequency action: ${actionKey(referenceAction.action)} at ${((referenceAction.frequency ?? 0) * 100).toFixed(1)}%.`));
      } else if (roll !== undefined) {
        const bucket = partitionStrategyFrequencies(legalStrategy, rngMode, input.legalActions)
          .find(({ start, end }) => roll >= start && roll <= end);
        const order = rngMode === "high" ? "passive at 1 to aggressive at 100" : "aggressive at 1 to passive at 100";
        const bucketRange = bucket === undefined ? "" : ` from bucket ${bucket.start}\u2013${bucket.end}`;
        statements.push(statement(input.strategy.provenance, `${rngMode === "high" ? "High" : "Low"} RNG roll ${roll} selects ${actionKey(referenceAction.action)}${bucketRange} as the equilibrium reference (${order}); its source frequency is ${((referenceAction.frequency ?? 0) * 100).toFixed(1)}%.`));
      }
    } else if (rngMode === "off" || roll !== undefined) {
      statements.push(statement("UNAVAILABLE", "A normalized, complete solved or interpolated frequency set is required before an equilibrium reference can be named."));
    }
  } else {
    statements.push(statement("UNAVAILABLE", `A complete reference mix is unavailable: ${frequencyCount} of ${input.legalActions.length} legal actions have source frequencies.`));
  }

  if (evCoverage === "COMPLETE" && chosenSourceAction?.evBB !== undefined) {
    const best = Math.max(...legalSourceActions.map(({ evBB }) => evBB ?? Number.NEGATIVE_INFINITY));
    evLossBB = Math.max(0, best - chosenSourceAction.evBB) as BB;
    statements.push(statement(input.strategy.provenance, `Source EV loss for the chosen action is ${formatBb(evLossBB)}; it is computed only because every issued legal action has source EV.`));
  } else {
    statements.push(statement("UNAVAILABLE", "Exact chosen-action EV loss is unavailable because the source did not provide comparable EV for every issued legal action."));
  }

  if (chosenSourceAction === undefined) {
    statements.push(statement("UNAVAILABLE", "The chosen legal action has no row in the active strategy result."));
  } else if (chosenSourceAction.frequency !== undefined) {
    statements.push(statement(input.strategy.provenance, `The source supplies ${(chosenSourceAction.frequency * 100).toFixed(1)}% for the chosen action.`));
  } else {
    statements.push(statement(input.strategy.provenance === "HEURISTIC" ? "HEURISTIC" : "UNAVAILABLE", "The source includes the chosen action but supplies no frequency for it."));
  }

  return {
    provenance: input.strategy.provenance,
    chosenAction: input.chosenAction,
    ...(chosenSourceAction === undefined ? {} : { chosenSourceAction }),
    frequencyCoverage,
    evCoverage,
    ...(referenceAction === undefined ? {} : { referenceAction }),
    ...(evLossBB === undefined ? {} : { evLossBB }),
    statements,
  };
}

function buildActionRationale(input: ExplanationInput): ExplanationModel["actionRationale"] {
  const action = input.chosenAction;
  const call = input.decisionMath.amountToCallBB;
  const statements: ExplanationStatement[] = [...handContext(input)];
  switch (action.kind) {
    case "fold":
      statements.push(statement("EXACT_MATH", `Folding invests no additional chips and relinquishes Hero's claim to the ${formatBb(input.decisionMath.contestablePotAtDecisionBB)} contestable pot.`));
      break;
    case "check":
      statements.push(statement("EXACT_MATH", "Checking is legal because no call is due; it preserves Hero's current stack and passes action without wagering."));
      break;
    case "call":
      statements.push(statement("EXACT_MATH", `Calling commits the forced ${formatBb(action.amount)} price rather than choosing an aggressive size.`));
      if (input.decisionMath.potOdds !== undefined) {
        statements.push(statement("EXACT_MATH", `The raw pre-rake showdown threshold is ${(input.decisionMath.potOdds.requiredEquity * 100).toFixed(1)}%; this is a price, not proof that calling is strategically correct.`));
      }
      if (input.state.pending.some((seatId) => seatId !== input.heroSeatId)) {
        statements.push(statement("HEURISTIC", "Action can continue behind Hero, so realized equity and the final price may differ from a closing-action call."));
      }
      break;
    case "bet":
      statements.push(statement("HEURISTIC", "Betting trades showdown realization for value extraction, denial, and fold equity; which motive dominates requires validated ranges or source strategy."));
      break;
    case "raise":
      statements.push(statement("HEURISTIC", "Raising rejects the offered call price and creates a new price for every remaining opponent; whether that improves EV requires source ranges and response strategy."));
      break;
    case "jam":
      statements.push(statement("EXACT_MATH", "Jamming puts Hero's entire available betting stack at risk in this betting round."));
      statements.push(statement("HEURISTIC", "An all-in maximizes pressure and removes future sizing choices, but legality alone does not imply strategic support."));
      break;
  }
  if (call > ZERO_BB && action.kind !== "fold" && action.kind !== "call") {
    statements.push(statement("EXACT_MATH", `Hero first covers the ${formatBb(call)} call component before any additional aggressive increment.`));
  }
  statements.push(...sourceComparison(input));
  return { action, statements };
}

function buildSizingRationale(input: ExplanationInput): ExplanationModel["sizingRationale"] {
  const action = input.chosenAction;
  if (action.kind === "fold" || action.kind === "check") {
    return { applies: false, statements: [statement("UNAVAILABLE", "This action has no wager size to explain.")] };
  }
  if (action.kind === "call") {
    return {
      applies: false,
      statements: [statement("EXACT_MATH", `The ${formatBb(action.amount)} call is fixed by the rules state; Hero did not choose a sizing.`)],
    };
  }
  const economics = actionEconomics(input.state, action);
  const sourceAction = sourceActionFor(input.strategy.actions, action);
  const statements = [
    statement("EXACT_MATH", `${action.kind === "jam" ? "The all-in" : "This size"} adds ${formatBb(economics.amountAddedBB)} and reaches ${formatBb(economics.totalToBB)} total.`),
    statement("EXACT_MATH", economics.opponentSelection === "MULTIWAY_UNSPECIFIED"
      ? "A single pot-if-called and projected SPR are withheld because no one opponent represents a multiway response."
      : `If the selected opponent calls, the contestable pot is ${formatBb(economics.contestablePotIfCalledByOneBB)}${economics.projectedSPR === undefined ? "." : ` and projected SPR is ${economics.projectedSPR.toFixed(2)}.`}`),
  ];
  if (economics.raiseFractionOfPotAfterCall !== undefined) {
    statements.push(statement("EXACT_MATH", `The aggressive increment is ${(economics.raiseFractionOfPotAfterCall * 100).toFixed(1)}% of the pot after first matching the current wager.`));
  }
  if (economics.previousBetMultiple !== undefined) {
    statements.push(statement("EXACT_MATH", `The total target is ${economics.previousBetMultiple.toFixed(2)} times the previous total bet.`));
  }
  if (sourceAction?.frequency !== undefined) {
    statements.push(statement(input.strategy.provenance, `The active source assigns this exact size ${(sourceAction.frequency * 100).toFixed(1)}%.`));
  } else {
    statements.push(statement("UNAVAILABLE", "No source frequency supports a claim that this exact size is preferred."));
  }
  return { applies: true, statements };
}

function positiveRange(range: WeightedRange): readonly WeightedCombo[] {
  return [...range.values()].filter(({ weight }) => weight > 0);
}

function blockedDetails(
  input: ExplanationInput,
  heroCards: readonly [Card, Card],
  board: readonly Card[],
): { readonly details: readonly BlockedComboDetail[]; readonly summaries: readonly OpponentRangeRemovalSummary[]; readonly suppliedCount: number } {
  const liveOpponentIds = new Set(input.state.players
    .filter((player) => player.id !== input.heroSeatId && player.status !== "folded")
    .map(({ id }) => id));
  const details: BlockedComboDetail[] = [];
  const summaries: OpponentRangeRemovalSummary[] = [];
  let suppliedCount = 0;
  for (const [seatId, range] of Object.entries(input.publicRanges ?? {}) as [SeatId, WeightedRange | undefined][]) {
    if (range === undefined || !liveOpponentIds.has(seatId)) continue;
    suppliedCount += 1;
    const combos = positiveRange(range);
    const blockedByHero = combos.filter(({ cards }) => cards.some((card) => heroCards.includes(card)));
    const blockedByBoard = combos.filter(({ cards }) => cards.some((card) => board.includes(card)));
    const blockedByAny = combos.filter(({ cards }) => cards.some((card) => heroCards.includes(card) || board.includes(card)));
    for (const combo of blockedByAny) {
      const blockedBy = [...heroCards, ...board].filter((known) => combo.cards.includes(known));
      details.push({ seatId, comboId: combo.id, cards: combo.cards, weight: combo.weight, blockedBy });
    }
    summaries.push({
      seatId,
      suppliedComboCount: combos.length,
      suppliedWeightedMass: combos.reduce((sum, combo) => sum + combo.weight, 0),
      removedByHeroComboCount: blockedByHero.length,
      removedByHeroWeightedMass: blockedByHero.reduce((sum, combo) => sum + combo.weight, 0),
      removedByBoardComboCount: blockedByBoard.length,
      removedByBoardWeightedMass: blockedByBoard.reduce((sum, combo) => sum + combo.weight, 0),
      removedByAnyKnownCardComboCount: blockedByAny.length,
      removedByAnyKnownCardWeightedMass: blockedByAny.reduce((sum, combo) => sum + combo.weight, 0),
    });
  }
  details.sort((left, right) => left.seatId.localeCompare(right.seatId) || left.comboId.localeCompare(right.comboId));
  return { details, summaries, suppliedCount };
}

function buildBlockers(input: ExplanationInput, heroCards: readonly [Card, Card]): ExplanationModel["blockers"] {
  const board = input.state.board;
  const liveOpponentCount = input.state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded").length;
  const blocked = blockedDetails(input, heroCards, board);
  const opponentRangeCoverage = coverage(blocked.suppliedCount, liveOpponentCount);
  const heroCardDetails = heroCards.map((heroCard) => {
    const cardCombos = blocked.details.filter(({ cards }) => cards.includes(heroCard));
    const sameRankBoardCards = board.filter((boardCard) => boardCard[0] === heroCard[0]);
    const sameSuitBoardCards = board.filter((boardCard) => boardCard[1] === heroCard[1]);
    const displayedCard = formatCard(heroCard);
    const statements = [
      statement("EXACT_MATH" as const, `${displayedCard} is unavailable to every opponent; ${sameRankBoardCards.length} board card(s) share its rank and ${sameSuitBoardCards.length} share its suit.`),
      blocked.suppliedCount === 0
        ? statement("UNAVAILABLE" as const, `No opponent public range was supplied, so combinations containing ${displayedCard} cannot be enumerated.`)
        : statement("EXACT_MATH" as const, `${displayedCard} removes ${cardCombos.length} positive-weight supplied combo(s), totaling ${cardCombos.reduce((sum, combo) => sum + combo.weight, 0).toFixed(3)} weighted combos.`),
    ];
    const boardCompatible = cardCombos.filter(({ cards }) => cards.every((card) => !board.includes(card)));
    if (boardCompatible.length > 0 && board.length >= 3) {
      const groups = new Map<string, BlockedComboDetail[]>();
      for (const combo of boardCompatible) {
        const facts = describeHandFacts(combo.cards, board);
        for (const group of [facts.madeHand, ...facts.drawLabels.filter((label) => !label.startsWith("backdoor"))]) {
          const rows = groups.get(group) ?? [];
          rows.push(combo);
          groups.set(group, rows);
        }
      }
      const summary = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)
        .map(([group, rows]) => `${rows.length} ${group} combo(s), e.g. ${rows.slice(0, 2).map(({ cards }) => cards.map(formatCard).join("")).join(", ")}`).join("; ");
      statements.push(statement("EXACT_MATH", `Among combinations that were compatible with the board before Hero's cards were removed: ${summary}. Draw and made-hand groups can overlap.`));
    }
    return {
      card: heroCard,
      sameRankBoardCards,
      sameSuitBoardCards,
      blockedCombos: cardCombos,
      ...(blocked.suppliedCount === 0 ? {} : {
        blockedComboCount: cardCombos.length,
        blockedWeightedMass: cardCombos.reduce((sum, combo) => sum + combo.weight, 0),
      }),
      statements,
    };
  });
  return {
    provenance: blocked.suppliedCount === 0 ? "UNAVAILABLE" : "EXACT_MATH",
    knownCards: [...heroCards, ...board],
    heroCards: heroCardDetails,
    opponentRangeCoverage,
    blockedCombos: blocked.details,
    rangeRemoval: blocked.summaries,
    strategicNetEffect: [statement("UNAVAILABLE", "Card removal is exact, but whether the removed value, bluff, draw, or fold regions help this action requires a compatible conditional strategy or range model.")],
  };
}

function buildAlternatives(input: ExplanationInput): readonly AlternativeExplanation[] {
  const chosenSource = sourceActionFor(input.strategy.actions, input.chosenAction);
  return input.legalActions
    .filter((action) => actionKey(action) !== actionKey(input.chosenAction))
    .map((action) => {
      const sourceAction = sourceActionFor(input.strategy.actions, action);
      const economics = actionEconomics(input.state, action);
      const statements: ExplanationStatement[] = [];
      if (action.kind === "fold" || action.kind === "check") {
        statements.push(statement("EXACT_MATH", `${action.kind === "fold" ? "Folding" : "Checking"} adds ${formatBb(ZERO_BB)}.`));
      } else {
        statements.push(statement("EXACT_MATH", `${actionKey(action)} adds ${formatBb(economics.amountAddedBB)} and leaves Hero ${formatBb(economics.heroBehindBB)} behind.`));
      }
      if (sourceAction?.evBB !== undefined && chosenSource?.evBB !== undefined) {
        const delta = bbSub(sourceAction.evBB, chosenSource.evBB);
        statements.push(statement(input.strategy.provenance, `The source EV difference versus the chosen action is ${formatBb(delta)} (alternative minus chosen).`));
        if (input.strategy.provenance !== "HEURISTIC") {
          statements.push(statement(input.strategy.provenance, `${readableAction(action)} ${delta > 0 ? "earns more" : delta < 0 ? "earns less" : "has equal source EV"}${delta === 0 ? "" : ` than ${readableAction(input.chosenAction)}`}${input.state.potBB > 0 && delta !== 0 ? ` by ${(Math.abs(delta) / input.state.potBB * 100).toFixed(2)}% of this pot` : ""}. ${delta > 0 ? "This alternative is not worse on the supplied EV evidence." : "Frequency alone is not used to infer this EV difference."}`));
        }
      } else {
        statements.push(statement("UNAVAILABLE", "No comparable source EV proves that this alternative is better or worse than the chosen action."));
      }
      if (sourceAction?.frequency !== undefined) {
        statements.push(statement(input.strategy.provenance, `The source assigns this action ${(sourceAction.frequency * 100).toFixed(1)}%.`));
      } else {
        statements.push(statement(input.strategy.provenance === "HEURISTIC" && sourceAction !== undefined ? "HEURISTIC" : "UNAVAILABLE", "No equilibrium frequency is available for this action."));
      }
      return { action, ...(sourceAction === undefined ? {} : { sourceAction }), statements };
    });
}

function buildMultiway(input: ExplanationInput): ExplanationModel["multiway"] {
  const liveOpponentCount = input.state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded").length;
  if (liveOpponentCount <= 1) return { applies: false, liveOpponentCount, statements: [] };
  return {
    applies: true,
    liveOpponentCount,
    statements: [
      statement("HEURISTIC", "With several opposing ranges, collective strong-hand density rises and bluff/value thresholds cannot be copied from a heads-up range pair."),
      statement("HEURISTIC", "Thin value and low-equity bluffs generally need more caution because more players can continue and Hero's equity realization is lower."),
      statement("HEURISTIC", "Blockers can remove combinations from several ranges at once, but their strategic net effect depends on each range's conditional composition."),
      statement("UNAVAILABLE", "A heads-up MDF is intentionally withheld; it is not a correct multiway continue frequency."),
    ],
  };
}

interface BenchmarkWager {
  readonly betBB: BB;
  readonly potBeforeBetBB: BB;
  readonly appliesTo: "FACING_FIRST_BET" | "CHOSEN_FIRST_BET";
}

function latestFirstBet(history: readonly ActionRecord[], street: ExplanationInput["state"]["street"]): ActionRecord | undefined {
  return [...history].reverse().find((record) => record.street === street && record.action.kind === "bet");
}

function benchmarkWager(input: ExplanationInput): BenchmarkWager | undefined {
  const chosen = input.chosenAction;
  if ((chosen.kind === "bet" || chosen.kind === "jam") && input.state.currentBetBB === ZERO_BB) {
    return { betBB: chosen.to, potBeforeBetBB: input.state.potBB, appliesTo: "CHOSEN_FIRST_BET" };
  }
  if (input.state.currentBetBB > ZERO_BB) {
    const record = latestFirstBet(input.state.actionHistory, input.state.street);
    if (record?.action.kind === "bet" && record.potAfterBB === input.state.potBB) {
      const potBefore = bbSub(record.potAfterBB, record.action.to);
      if (potBefore > ZERO_BB) return { betBB: record.action.to, potBeforeBetBB: potBefore, appliesTo: "FACING_FIRST_BET" };
    }
  }
  return undefined;
}

function buildExactMath(input: ExplanationInput): readonly ExactMathPanel[] {
  const panels: ExactMathPanel[] = [];
  if (input.decisionMath.potOdds !== undefined) {
    panels.push({
      id: "POT_ODDS",
      provenance: "EXACT_MATH",
      label: "Raw pre-rake pot odds",
      value: input.decisionMath.potOdds,
      appliesTo: "HERO_DECISION",
      assumptions: input.decisionMath.potOddsCaveats,
    });
  }
  if (input.decisionMath.rakeAdjustedPotOdds !== undefined) {
    panels.push({
      id: "RAKE_ADJUSTED_POT_ODDS",
      provenance: "EXACT_MATH",
      label: "Rake-adjusted closing-call benchmark",
      value: input.decisionMath.rakeAdjustedPotOdds,
      appliesTo: "HERO_DECISION",
      assumptions: [
        "Heads-up only; the call closes the current betting round and no further wagering occurs.",
        "The current contestable pot has no excluded side-pot layer.",
        `Projected rake is ${bbToNumber(input.decisionMath.projectedRakeIfNoFurtherBettingBB ?? ZERO_BB).toFixed(3)} BB under the configured percentage, cap, and no-flop-no-drop rule.`,
        "This is not an equity-realization model or a recommendation to call.",
      ],
    });
  }
  if (input.decisionMath.currentSPR !== undefined) {
    panels.push({
      id: "CURRENT_SPR",
      provenance: "EXACT_MATH",
      label: `Current SPR (${input.decisionMath.effectiveStackBasis.toLowerCase().replaceAll("_", " ")})`,
      value: input.decisionMath.currentSPR,
      appliesTo: "HERO_DECISION",
      assumptions: ["SPR is a stack-to-current-pot ratio, not an action recommendation."],
    });
  }
  const wager = benchmarkWager(input);
  if (wager === undefined) return panels;
  const liveOpponentCount = input.state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded").length;
  panels.push({
    id: "BLUFF_BREAK_EVEN",
    provenance: "EXACT_MATH",
    label: "Pure-bluff break-even fold frequency",
    value: breakEvenBluffFrequency(wager.betBB, wager.potBeforeBetBB),
    appliesTo: wager.appliesTo,
    assumptions: [
      "The bettor has zero showdown equity when called.",
      "All opponents folding is treated as one aggregate outcome.",
      "Future-street value, rake, and differing opponent responses are excluded.",
    ],
  });
  if (liveOpponentCount === 1) {
    panels.push({
      id: "HEADS_UP_MDF",
      provenance: "EXACT_MATH",
      label: "Heads-up MDF benchmark",
      value: headsUpMdf(wager.betBB, wager.potBeforeBetBB),
      appliesTo: wager.appliesTo,
      assumptions: ["Heads-up toy-game benchmark only; it is not a solver-recommended continue frequency.", "Rake, range asymmetry, blockers, and future-street realization are excluded."],
    });
    if (input.state.street === "river") {
      const fraction = bbToNumber(wager.betBB) / bbToNumber(wager.potBeforeBetBB);
      panels.push({
        id: "RIVER_POLARIZED_BLUFF_FRACTION",
        provenance: "EXACT_MATH",
        label: "River polarized bluff fraction of betting range",
        value: riverPolarizedBluffFraction(fraction),
        appliesTo: wager.appliesTo,
        assumptions: ["Heads-up river toy game with a perfectly polarized value/bluff betting range.", "Value always wins when called and bluffs always lose; no rake or split pots."],
      });
      panels.push({
        id: "RIVER_BLUFF_TO_VALUE",
        provenance: "EXACT_MATH",
        label: "River polarized bluff-to-value ratio",
        value: bluffToValueRatio(fraction),
        appliesTo: wager.appliesTo,
        assumptions: ["Same heads-up polarized river toy-game assumptions; this is not a claim about the actual range."],
      });
    }
  }
  return panels;
}

function rankSet(cards: readonly Card[]): ReadonlySet<number> {
  return new Set(cards.map((card) => ranks[card[0] as Rank]));
}

function hasStraight(cards: readonly Card[]): boolean {
  const values = rankSet(cards);
  return straightWindows.some((window) => window.every((rank) => values.has(rank)));
}

function gutshotMissingRanks(cards: readonly Card[]): ReadonlySet<number> {
  const values = rankSet(cards);
  const missing = new Set<number>();
  for (const window of straightWindows) {
    const absent = window.filter((rank) => !values.has(rank));
    if (absent.length !== 1) continue;
    const index = window.indexOf(absent[0] ?? -1);
    if (index > 0 && index < window.length - 1) missing.add(absent[0] ?? -1);
  }
  return missing;
}

function hasOpenEndedDraw(cards: readonly Card[]): boolean {
  const values = rankSet(cards);
  for (let low = 2; low <= 10; low += 1) {
    const run = [low, low + 1, low + 2, low + 3];
    if (!run.every((rank) => values.has(rank))) continue;
    const lower = low === 2 ? 14 : low - 1;
    const upper = low + 4;
    if (lower >= 2 && lower <= 14 && upper <= 14 && !values.has(lower) && !values.has(upper)) return true;
  }
  return false;
}

function maxStraightWindowOccupancy(cards: readonly Card[]): number {
  const values = rankSet(cards);
  return Math.max(...straightWindows.map((window) => window.filter((rank) => values.has(rank)).length));
}

function suitCount(cards: readonly Card[], suit: Suit): number {
  return cards.filter((card) => card[1] === suit).length;
}

function analyzeFutureCard(heroCards: readonly [Card, Card], board: readonly Card[], future: Card): FutureCardDetail {
  const currentCards = [...heroCards, ...board];
  const afterCards = [...currentCards, future];
  const nextBoard = [...board, future];
  const tags = new Set<FutureCardTag>();
  const beforeEvaluation = currentCards.length >= 5 ? customSevenCardEvaluator.evaluate(currentCards) : undefined;
  const afterEvaluation = afterCards.length >= 5 ? customSevenCardEvaluator.evaluate(afterCards) : undefined;
  if (beforeEvaluation !== undefined && afterEvaluation !== undefined && afterEvaluation.score > beforeEvaluation.score) {
    tags.add("IMPROVES_HAND_SCORE");
    if (afterEvaluation.category !== beforeEvaluation.category) tags.add("IMPROVES_HAND_CATEGORY");
  }
  if (board.some((boardCard) => boardCard[0] === future[0])) tags.add("PAIRS_BOARD");
  const futureSuit = future[1] as Suit;
  const currentSuitCount = suitCount(currentCards, futureSuit);
  const nextSuitCount = currentSuitCount + 1;
  if (currentSuitCount < 5 && nextSuitCount >= 5) tags.add("COMPLETES_HERO_FLUSH");
  else if (currentSuitCount < 4 && nextSuitCount === 4) tags.add("ADDS_HERO_FLUSH_DRAW");
  const boardSuitBefore = suitCount(board, futureSuit);
  const boardSuitAfter = boardSuitBefore + 1;
  if ((boardSuitBefore < 3 && boardSuitAfter >= 3) || boardSuitAfter >= 4) tags.add("CHANGES_BOARD_FLUSH_STRUCTURE");

  if (!hasStraight(currentCards) && hasStraight(afterCards)) tags.add("COMPLETES_HERO_STRAIGHT");
  const gutshotsBefore = gutshotMissingRanks(currentCards);
  const gutshotsAfter = gutshotMissingRanks(afterCards);
  if (gutshotsAfter.size > 0 && [...gutshotsAfter].some((rank) => !gutshotsBefore.has(rank))) tags.add("ADDS_GUTSHOT");
  if (!hasOpenEndedDraw(currentCards) && hasOpenEndedDraw(afterCards)) tags.add("ADDS_OPEN_ENDED_STRAIGHT_DRAW");
  if (maxStraightWindowOccupancy(nextBoard) > maxStraightWindowOccupancy(board)) tags.add("CHANGES_BOARD_STRAIGHT_STRUCTURE");
  if (tags.size === 0) tags.add("NO_LISTED_CHANGE");
  return {
    card: future,
    tags: [...tags],
    ...(beforeEvaluation === undefined ? {} : { handCategoryBefore: beforeEvaluation.category }),
    ...(afterEvaluation === undefined ? {} : { handCategoryAfter: afterEvaluation.category }),
  };
}

const futureTags: readonly FutureCardTag[] = [
  "IMPROVES_HAND_SCORE",
  "IMPROVES_HAND_CATEGORY",
  "PAIRS_BOARD",
  "COMPLETES_HERO_FLUSH",
  "ADDS_HERO_FLUSH_DRAW",
  "CHANGES_BOARD_FLUSH_STRUCTURE",
  "COMPLETES_HERO_STRAIGHT",
  "ADDS_GUTSHOT",
  "ADDS_OPEN_ENDED_STRAIGHT_DRAW",
  "CHANGES_BOARD_STRAIGHT_STRUCTURE",
  "NO_LISTED_CHANGE",
];

function groupFutureCards(cards: readonly FutureCardDetail[]): Readonly<Record<FutureCardTag, readonly Card[]>> {
  const groups: Record<FutureCardTag, Card[]> = {
    IMPROVES_HAND_SCORE: [],
    IMPROVES_HAND_CATEGORY: [],
    PAIRS_BOARD: [],
    COMPLETES_HERO_FLUSH: [],
    ADDS_HERO_FLUSH_DRAW: [],
    CHANGES_BOARD_FLUSH_STRUCTURE: [],
    COMPLETES_HERO_STRAIGHT: [],
    ADDS_GUTSHOT: [],
    ADDS_OPEN_ENDED_STRAIGHT_DRAW: [],
    CHANGES_BOARD_STRAIGHT_STRUCTURE: [],
    NO_LISTED_CHANGE: [],
  };
  for (const detail of cards) {
    for (const tag of detail.tags) groups[tag].push(detail.card);
  }
  return groups;
}

function unavailableFuturePlan(cardsToCome: number, text: string): FutureStreetPlan {
  return {
    provenance: "UNAVAILABLE",
    cardsToCome,
    unseenCardCount: 0,
    cards: [],
    byTag: groupFutureCards([]),
    statements: [statement("UNAVAILABLE", text)],
  };
}

function buildFuturePlan(input: ExplanationInput, heroCards: readonly [Card, Card]): FutureStreetPlan {
  const cardsToCome = 5 - input.state.board.length;
  if (cardsToCome <= 0) return unavailableFuturePlan(0, "No future community card remains after the river.");
  if (input.state.board.length < 3) return unavailableFuturePlan(cardsToCome, "One-card future-street classification begins on the flop, when a five-card current hand can be compared exactly.");
  const known = [...heroCards, ...input.state.board, ...(input.deadCards ?? [])];
  assertUniqueCards(known);
  const knownSet = new Set(known);
  const cards = createDeck().filter((candidate) => !knownSet.has(candidate)).map((candidate) => analyzeFutureCard(heroCards, input.state.board, candidate));
  const byTag = groupFutureCards(cards);
  return {
    provenance: "EXACT_MATH",
    cardsToCome,
    unseenCardCount: cards.length,
    cards,
    byTag,
    statements: [
      statement("EXACT_MATH", `${cards.length} publicly unseen next cards were enumerated from the 52-card deck after removing Hero, board, and explicitly supplied dead cards.`),
      statement("HEURISTIC", "The tags describe card mechanics, not source frequencies or a solver-approved barrel/check plan."),
    ],
  };
}

function buildRule(input: ExplanationInput): RuleOfThumb {
  const liveOpponentCount = input.state.players.filter((player) => player.id !== input.heroSeatId && player.status !== "folded").length;
  if (liveOpponentCount > 1) {
    return {
      provenance: "HEURISTIC",
      rule: "Multiway, demand stronger evidence before thin value or low-equity bluffs because several ranges can continue.",
      exception: "A validated source may still support aggression when Hero retains a strong nut advantage or opponents are sharply capped.",
    };
  }
  const heroCards = playerById(input.state.players, input.heroSeatId).holeCards;
  if (heroCards !== undefined) {
    const facts = describeHandFacts(heroCards, input.state.board, input.deadCards);
    if (facts.madeHand.includes("pair") && facts.flushCompletingCards.length > 0) {
      return { provenance: "HEURISTIC", rule: "With a pair plus a flush draw, weigh the value of keeping weaker hands in against the pressure gained by raising.",
        exception: "A dominated draw, a paired board, shallow stacks, or the actual source strategy can change which route preserves more EV." };
    }
  }
  if (input.decisionMath.potOdds !== undefined) {
    return {
      provenance: "HEURISTIC",
      rule: "Use pot odds as a break-even price, then ask whether the exact hand realizes enough equity against the betting range.",
      exception: "Rake, action behind, future betting, and range asymmetry can move the practical threshold away from the raw showdown benchmark.",
    };
  }
  if (input.chosenAction.kind === "bet" || input.chosenAction.kind === "raise" || input.chosenAction.kind === "jam") {
    return {
      provenance: "HEURISTIC",
      rule: "Decide why the range bets before choosing how much; action and sizing answer different strategic questions.",
      exception: "A source can mix several sizes with near-identical EV, so one sizing story need not be exclusive.",
    };
  }
  return {
    provenance: "HEURISTIC",
    rule: "Treat a check as a range action, not automatically as surrender; it preserves future options without investing now.",
    exception: "When protection or thin value is source-supported, checking too much can surrender EV.",
  };
}

export function buildExplanation(input: ExplanationInput): ExplanationModel {
  if (input.state.actor !== input.heroSeatId) throw new RangeError("Explanation state actor must be Hero");
  const hero = playerById(input.state.players, input.heroSeatId);
  if (hero.holeCards === undefined) throw new RangeError("Exact explanation requires Hero's two concrete cards");
  assertUniqueCards([...hero.holeCards, ...input.state.board]);
  return {
    verdict: buildVerdict(input),
    actionRationale: buildActionRationale(input),
    sizingRationale: buildSizingRationale(input),
    blockers: buildBlockers(input, hero.holeCards),
    alternatives: buildAlternatives(input),
    multiway: buildMultiway(input),
    exactMath: buildExactMath(input),
    futureStreet: buildFuturePlan(input, hero.holeCards),
    ruleOfThumb: buildRule(input),
  };
}
