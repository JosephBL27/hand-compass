import { deterministicHash } from "../domain/hash";
import type { ScenarioCatalog } from "./catalog";
import { selectScenarioForReview, type ScenarioReviewSelectionOptions } from "./reviewSelection";
import type { ScenarioCatalogMatch, ScenarioFilter } from "./types";

export interface PracticeQueueOptions {
  readonly seed: number;
}

export interface PracticeQueueStats {
  readonly served: number;
  readonly uniqueServed: number;
  readonly cycle: number;
  readonly remaining: number;
  readonly matching: number;
  readonly lastScenarioId?: string;
}

/** Filtered sampling without replacement; review weights affect order, never legality. */
export class PracticeQueue {
  readonly #catalog: ScenarioCatalog;
  readonly #seed: number;
  readonly #seenThisCycle = new Set<string>();
  readonly #seenEver = new Set<string>();
  #served = 0;
  #cycle = 1;
  #lastId: string | undefined;

  constructor(catalog: ScenarioCatalog, options: PracticeQueueOptions) {
    if (!Number.isSafeInteger(options.seed)) throw new RangeError("Practice queue seed must be a safe integer");
    this.#catalog = catalog;
    this.#seed = options.seed;
  }

  next(filter: ScenarioFilter = {}, review: Omit<ScenarioReviewSelectionOptions, "seed"> = { currentDecision: 0 }): ScenarioCatalogMatch | undefined {
    const matching = this.#catalog.filter(filter);
    if (matching.length === 0) return undefined;
    let remaining: readonly ScenarioCatalogMatch[] = matching.filter(({ definition }) => !this.#seenThisCycle.has(definition.id));
    if (remaining.length === 0) {
      for (const match of matching) this.#seenThisCycle.delete(match.definition.id);
      this.#cycle += 1;
      remaining = matching;
    }
    const withoutImmediateRepeat = remaining.filter(({ definition }) => definition.id !== this.#lastId);
    const candidates = withoutImmediateRepeat.length > 0 ? withoutImmediateRepeat : remaining;
    const seed = Number.parseInt(deterministicHash({ queue: "practice-v1", seed: this.#seed, cursor: this.#served }), 16);
    const chosen = selectScenarioForReview(candidates, { ...review, seed });
    if (chosen === undefined) return undefined;
    this.#seenThisCycle.add(chosen.definition.id);
    this.#seenEver.add(chosen.definition.id);
    this.#lastId = chosen.definition.id;
    this.#served += 1;
    return chosen;
  }

  stats(filter: ScenarioFilter = {}): PracticeQueueStats {
    const matching = this.#catalog.filter(filter);
    return {
      served: this.#served, uniqueServed: this.#seenEver.size, cycle: this.#cycle,
      matching: matching.length,
      remaining: matching.filter(({ definition }) => !this.#seenThisCycle.has(definition.id)).length,
      ...(this.#lastId === undefined ? {} : { lastScenarioId: this.#lastId }),
    };
  }

  reset(): void {
    this.#seenThisCycle.clear();
    this.#seenEver.clear();
    this.#served = 0;
    this.#cycle = 1;
    this.#lastId = undefined;
  }
}

export function createPracticeQueue(catalog: ScenarioCatalog, options: PracticeQueueOptions): PracticeQueue {
  return new PracticeQueue(catalog, options);
}
