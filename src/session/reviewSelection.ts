import { deterministicHash } from "../domain/hash";
import { ReplayRng } from "./rng";
import type { ScenarioCatalogMatch } from "./types";

/** Minimal structural view of one analytics concept-review entry. */
export interface ScenarioConceptReviewWeight {
  readonly tag: string;
  readonly samplingWeight: number;
  readonly nextDueDecision: number;
}

export interface ScenarioReviewSelectionOptions {
  readonly seed: number;
  /** Number of decisions already recorded; a concept is due at or below this cursor. */
  readonly currentDecision: number;
  readonly conceptReviews?: readonly ScenarioConceptReviewWeight[];
  /** Defaults to the catalog's source-authored strategic classes. */
  readonly conceptTagsForMatch?: (match: ScenarioCatalogMatch) => readonly string[];
}

function validateOptions(options: ScenarioReviewSelectionOptions): void {
  if (!Number.isSafeInteger(options.seed)) throw new RangeError("Scenario review seed must be a safe integer");
  if (!Number.isSafeInteger(options.currentDecision) || options.currentDecision < 0) {
    throw new RangeError("Scenario review decision cursor must be a non-negative safe integer");
  }
  for (const review of options.conceptReviews ?? []) {
    if (!review.tag.trim()) throw new RangeError("Scenario review concept tags cannot be blank");
    if (!Number.isFinite(review.samplingWeight) || review.samplingWeight <= 0) {
      throw new RangeError(`Scenario review weight for ${review.tag} must be positive and finite`);
    }
    if (!Number.isSafeInteger(review.nextDueDecision) || review.nextDueDecision < 0) {
      throw new RangeError(`Scenario review due cursor for ${review.tag} must be a non-negative safe integer`);
    }
  }
}

function dueWeights(options: ScenarioReviewSelectionOptions): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  for (const review of options.conceptReviews ?? []) {
    if (review.nextDueDecision > options.currentDecision) continue;
    const weight = Math.max(1, review.samplingWeight);
    weights.set(review.tag, Math.max(weights.get(review.tag) ?? 1, weight));
  }
  return weights;
}

/**
 * Selects one of the exact catalog matches supplied by the caller. The input is
 * sorted by validated scenario id before sampling, so equivalent match sets are
 * stable even when their array order differs. No scenario is constructed here.
 */
export function selectScenarioForReview(
  matches: readonly ScenarioCatalogMatch[],
  options: ScenarioReviewSelectionOptions,
): ScenarioCatalogMatch | undefined {
  validateOptions(options);
  if (matches.length === 0) return undefined;

  const ordered = [...matches].sort((left, right) => left.definition.id.localeCompare(right.definition.id));
  const weightsByTag = dueWeights(options);
  const tagsForMatch = options.conceptTagsForMatch ?? ((match: ScenarioCatalogMatch) => match.facts.strategicClasses);
  const weighted = ordered.map((match) => {
    const tags = new Set(tagsForMatch(match));
    // The strongest matching due concept sets the multiplier. This prevents a
    // multiply-tagged scenario from receiving an accidental exponential boost.
    const weight = [...tags].reduce((maximum, tag) => Math.max(maximum, weightsByTag.get(tag) ?? 1), 1);
    return { match, weight };
  });
  const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  const mixedSeed = Number.parseInt(deterministicHash({
    selector: "scenario-review-v1",
    seed: options.seed,
    scenarioIds: ordered.map(({ definition }) => definition.id),
  }), 16);
  let remaining = new ReplayRng(mixedSeed).nextUnit() * totalWeight;
  for (const candidate of weighted) {
    remaining -= candidate.weight;
    if (remaining < 0) return candidate.match;
  }
  return weighted.at(-1)?.match;
}
