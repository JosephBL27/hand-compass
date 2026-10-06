# Local solver coverage and operation

The native sidecar uses the pinned `b-inary/postflop-solver` engine at commit `9d1509fe5077d019825f833eed04b16d342dfda1`. Adapter **2.1.0** solves the exact supplied heads-up postflop chip-EV subgame and returns a strategy only after its configured exploitability target is met.

Run `npm run solver:build`, then `npm run solver:start`. The default endpoint is `http://127.0.0.1:4317/v1/solve`. Browser origins remain limited to loopback. The status API is read-only and contains no recommendations, frequencies, or EVs before the user's answer.

## Actual coverage

Supported inputs include flop, turn and river; weighted actual combinations; rake; unequal starting stacks when the legal action tree maps exactly to the effective-stack game; and configured fixed/dynamic sizing trees. Current-street actions are forced through the tree before solving the current conditional ranges, avoiding a second Bayesian update for the already observed line.

Geometric first bets can be materialized, but geometric raise trees are not defined. Preflop equilibrium, multiway equilibrium, ICM, PKO, known dead cards, and current-street transitions from multiway to heads-up are rejected explicitly. Actions that become duplicate effective-stack all-ins are also rejected rather than assigned invented frequencies. The caller may choose the visible educational fallback.

The default standard tree includes `rootOnly` jam choices. It is a sequence of explicitly configured rolling subgame solves, not one equilibrium strategy for every future decision. Named focused and broad practice ranges are custom laboratory inputs, not solved preflop charts. No solver request silently trims ranges or removes bet sizes.

## Persistent exact cache

Successful native results persist in `tools/local-solver/cache/exact-v1/`. The default bounds are 1,024 entries and 256 MB, with oldest unused entries evicted. A lookup requires the full canonical request, adapter version, pinned engine commit, and solver settings to match. The filename digest is only a locator; a hash collision cannot certify a different query. JSON floating-point round trips preserve the original strategy values. Failed and unconverged requests are never cached as solved.

The browser cache separately requires full query equality in addition to the five state hashes. It is bounded at 512 entries/64 MB in IndexedDB, or 256 entries/32 MB in memory. Adapter 2.1 cache keys invalidate previous results because 2.1 corrected descendant sizing to include prior streets' called bets in the pot.

`GET /v1/status` and `GET /health` return source identity, supported scope, resource limits, live phase/iterations, completed/rejected solve counts, and cache hits/misses/bytes. Frontend code uses `getLocalSolverStatus(endpoint, { signal })` from `src/domain/localSolverStatus.ts`.

## Resource controls

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `POKER_SOLVER_MAX_ITERATIONS` | 2000 | Reject when convergence is not reached within this count |
| `POKER_SOLVER_TARGET_PCT_POT` | 0.5 | Exploitability target as a percentage of the subgame's street-start pot |
| `POKER_SOLVER_MAX_MEMORY_MB` | 4096 | Reject a tree whose solver storage estimate exceeds this amount |
| `POKER_SOLVER_MAX_SOLVE_SECONDS` | 120 | Stop between solve iterations when the elapsed budget is reached |
| `POKER_SOLVER_MAX_TREE_NODES` | 200000 | Reject oversized action trees without pruning sizes |
| `POKER_SOLVER_MAX_QUEUED_REQUESTS` | 8 | Maximum waiting requests behind the one active solve |
| `POKER_SOLVER_CACHE_MAX_ENTRIES` | 1024 | Persistent cache entry bound |
| `POKER_SOLVER_CACHE_MAX_MB` | 256 | Persistent cache byte bound |
| `POKER_SOLVER_CACHE_DIR` | project cache directory | Optional exact-cache location |

The wall-clock budget is checked between native iterations; it cannot interrupt the middle of a large allocation or iteration. Larger ranges, deeper stacks and denser trees may be rejected. A rejected node has no action EV or equilibrium frequency result.

## Reproducible checks

`node --import tsx scripts/smoke-solver-curriculum.ts` starts its own isolated local sidecar, solves six generated nodes across flop/turn/river and 4/6-handed dealt tables with two players remaining, stops the process, restarts against the same cache, and requires all six exact responses to return without recomputation. The supplied focused ranges contain around 100 positive Hero combinations after board removal; they are never narrowed by the smoke test.

`node --import tsx scripts/refresh-acceptance-pack.ts OUTPUT_PACK_JSON` recomputes the existing acceptance pack's supplied ranges and exact action-tree manifest through adapter 2.1.0. It validates the complete pack and legal replay before writing its output.

Native regression tests cover pot propagation into future streets, cache restart, full-request collision rejection, float identity, and cache bounds. The TypeScript tests separately cover the HTTP protocol, status API, cache identity, cancellation, and byte/entry limits.
