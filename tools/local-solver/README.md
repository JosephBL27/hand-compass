# Local solver sidecar

This loopback-only service connects the trainer's normalized strategy-provider
protocol to `b-inary/postflop-solver` at the exact pinned commit recorded in
`Cargo.toml` and `Cargo.lock`. The locked upstream engine and every Cargo crate
are vendored under `vendor/`; normal builds run offline and do not depend on
GitHub or crates.io remaining available.

It is an on-demand, full-combo heads-up postflop solver. It reconstructs the
public current-street ledger, forces the already-observed action prefix so the
supplied conditional ranges are not conditioned a second time, materializes the
trainer's remaining sizing tree, solves it, and returns every positive actor
combo with every legal action's frequency and EV.

Supported scope:

- heads-up flop, turn, and river chip-EV subgames;
- unequal real stacks through the effective-stack cap;
- fixed, dynamic, and geometric remaining action trees;
- configured postflop rake;
- exact combo frequencies, action EVs, and measured convergence.

Explicitly unsupported (HTTP 422, never a fake `SOLVED` response):

- preflop;
- three-or-more-player postflop equilibria;
- ICM, PKO, and payout utility;
- known dead cards outside the board;
- a current-street line that became heads-up only after a player folded;
- a geometric raise tree while already facing a wager.

Runtime controls:

```text
POKER_SOLVER_ADDR=127.0.0.1:4317
POKER_SOLVER_MAX_ITERATIONS=2000
POKER_SOLVER_TARGET_PCT_POT=0.5
POKER_SOLVER_MAX_MEMORY_MB=4096
POKER_SOLVER_COMPRESSED=1
```

Run `npm run solver:start`, then verify the provider from the trainer's Strategy
workspace. The browser activates it only after the exact acceptance query
returns a hash-, state-, legal-action-, combo-frequency-, and EV-complete result.

`npm run solver:smoke-breadth` is the bounded 100 BB range-level proof. It
solves a different flop with hundreds of positive combo rows and refuses to call
the result SOLVED unless the configured exploitability target is reached.

## License

The engine and this network wrapper are AGPL-3.0-or-later. The complete wrapper
source is this directory. The pinned upstream source is available at:

https://github.com/b-inary/postflop-solver/tree/9d1509fe5077d019825f833eed04b16d342dfda1
