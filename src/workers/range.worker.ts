import type { PokerAction } from "../domain/actions";
import type { Card } from "../domain/cards";
import {
  conditionRangeByAction,
  sampleComboThenAction,
  type ComboActionSample,
  type ComboPolicy,
  type ConditionedRangeResult,
} from "../domain/comboPolicy";
import { allCombos, projectRangeMatrix, removeCards, weightedComboCount, type WeightedRange } from "../domain/ranges";

export interface EnumerateRangeWorkerRequest {
  readonly id: string;
  readonly type: "enumerate";
  readonly deadCards: readonly Card[];
}

export interface ConditionRangeWorkerRequest {
  readonly id: string;
  readonly type: "condition";
  readonly prior: WeightedRange;
  readonly comboPolicy?: ComboPolicy;
  readonly observedAction: PokerAction;
  readonly blockedCards: readonly Card[];
}

export interface SampleRangeWorkerRequest {
  readonly id: string;
  readonly type: "sample";
  readonly comboPolicy?: ComboPolicy;
  readonly seed: number;
  readonly heroCards?: readonly [Card, Card];
  readonly board?: readonly Card[];
  readonly deadCards?: readonly Card[];
}

export type RangeWorkerRequest = EnumerateRangeWorkerRequest | ConditionRangeWorkerRequest | SampleRangeWorkerRequest;

export interface EnumerateRangeWorkerResponse {
  readonly id: string;
  readonly type: "enumerate";
  readonly weightedCombos: number;
  readonly matrix: ReturnType<typeof projectRangeMatrix>;
}

export interface ConditionRangeWorkerResponse {
  readonly id: string;
  readonly type: "condition";
  readonly result: ConditionedRangeResult;
}

export interface SampleRangeWorkerResponse {
  readonly id: string;
  readonly type: "sample";
  readonly result: ComboActionSample;
}

export type RangeWorkerResponse = EnumerateRangeWorkerResponse | ConditionRangeWorkerResponse | SampleRangeWorkerResponse;

export function handleRangeWorkerRequest(request: EnumerateRangeWorkerRequest): EnumerateRangeWorkerResponse;
export function handleRangeWorkerRequest(request: ConditionRangeWorkerRequest): ConditionRangeWorkerResponse;
export function handleRangeWorkerRequest(request: SampleRangeWorkerRequest): SampleRangeWorkerResponse;
export function handleRangeWorkerRequest(request: RangeWorkerRequest): RangeWorkerResponse {
  switch (request.type) {
    case "enumerate": {
      const range = removeCards(allCombos(), request.deadCards);
      return { id: request.id, type: "enumerate", weightedCombos: weightedComboCount(range), matrix: projectRangeMatrix(range) };
    }
    case "condition":
      return {
        id: request.id,
        type: "condition",
        result: conditionRangeByAction(request.prior, request.comboPolicy, request.observedAction, request.blockedCards),
      };
    case "sample":
      return {
        id: request.id,
        type: "sample",
        result: sampleComboThenAction(request.comboPolicy, {
          seed: request.seed,
          ...(request.heroCards === undefined ? {} : { heroCards: request.heroCards }),
          ...(request.board === undefined ? {} : { board: request.board }),
          ...(request.deadCards === undefined ? {} : { deadCards: request.deadCards }),
        }),
      };
  }
}

const workerScope = globalThis as typeof globalThis & {
  postMessage?: (value: RangeWorkerResponse) => void;
  onmessage?: ((event: MessageEvent<RangeWorkerRequest>) => void) | null;
};

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  workerScope.onmessage = (event) => workerScope.postMessage?.(handleRangeWorkerRequest(event.data));
}
