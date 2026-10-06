import { StrategyUnavailableError, type StrategyProvider, type StrategyProvenance } from "./strategy";

export type StrategyProviderKind = "SOLVED_PACK" | "LOCAL_SOLVER" | "INTERPOLATED" | "HEURISTIC";
export type ProviderAvailabilityState = "AVAILABLE" | "UNAVAILABLE" | "CHECKING" | "ERROR";

export interface ProviderAvailability {
  readonly state: ProviderAvailabilityState;
  readonly reason?: string;
  readonly checkedAt?: string;
}

export interface StrategyProviderMetadata {
  readonly label: string;
  readonly kind: StrategyProviderKind;
  readonly description?: string;
  readonly possibleProvenance: readonly StrategyProvenance[];
  readonly source?: string;
}

export interface RegisteredStrategyProvider {
  readonly provider: StrategyProvider;
  readonly metadata: StrategyProviderMetadata;
  readonly availability: ProviderAvailability;
}

function validateAvailability(availability: ProviderAvailability): ProviderAvailability {
  if (availability.state !== "AVAILABLE" && !availability.reason?.trim()) {
    throw new RangeError(`${availability.state} provider availability requires a reason`);
  }
  if (availability.checkedAt !== undefined && !Number.isFinite(Date.parse(availability.checkedAt))) {
    throw new RangeError("Provider checkedAt must be an ISO-compatible timestamp");
  }
  return availability;
}

/** Registry selection is explicit: it never substitutes a heuristic provider. */
export class StrategyProviderRegistry {
  readonly #entries = new Map<string, RegisteredStrategyProvider>();

  register(entry: RegisteredStrategyProvider): void {
    const id = entry.provider.id.trim();
    if (!id) throw new RangeError("Strategy provider id is required");
    if (!entry.metadata.label.trim()) throw new RangeError("Strategy provider label is required");
    if (entry.metadata.possibleProvenance.length === 0) throw new RangeError("Strategy provider provenance capabilities are required");
    if (this.#entries.has(id)) throw new RangeError(`Duplicate strategy provider id: ${id}`);
    this.#entries.set(id, { ...entry, availability: validateAvailability(entry.availability) });
  }

  unregister(id: string): boolean {
    return this.#entries.delete(id);
  }

  setAvailability(id: string, availability: ProviderAvailability): void {
    const current = this.#entries.get(id);
    if (current === undefined) throw new RangeError(`Unknown strategy provider: ${id}`);
    this.#entries.set(id, { ...current, availability: validateAvailability(availability) });
  }

  get(id: string): RegisteredStrategyProvider | undefined {
    return this.#entries.get(id);
  }

  list(): readonly RegisteredStrategyProvider[] {
    return [...this.#entries.values()].sort((left, right) => left.metadata.label.localeCompare(right.metadata.label));
  }

  requireAvailable(id: string): StrategyProvider {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new StrategyUnavailableError("Provider is not registered.", id);
    if (entry.availability.state !== "AVAILABLE") {
      throw new StrategyUnavailableError(entry.availability.reason ?? `Provider state is ${entry.availability.state}.`, id);
    }
    return entry.provider;
  }
}

