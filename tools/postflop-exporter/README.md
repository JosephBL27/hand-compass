# Acceptance-node solver exporter

This isolated tool reproduces the raw CFR evidence used by the bundled acceptance pack. It is not shipped in the browser bundle.

## Pinned sources

- Solver: `https://github.com/b-inary/postflop-solver`, commit `9d1509fe5077d019825f833eed04b16d342dfda1`, AGPL-3.0-or-later.
- Starting ranges: the range files bundled with TexasSolver v0.2.0. The CO-vs-BB call range gives QTs weight 0. The exporter asserts that fact and changes only QTs to weight 1 so the user's requested Q♠T♠ custom postflop node is present. The generated pack discloses this adaptation verbatim.

## Reproduce

1. Clone the pinned solver into an isolated directory and apply `rust-1.98.patch` if building with Rust 1.98 or newer.
2. Copy `acceptance_export.rs` into the solver clone's `examples/` directory.
3. Add these development dependencies to the clone's `Cargo.toml`:

   ```toml
   [dev-dependencies]
   serde = { version = "1", features = ["derive"] }
   serde_json = "1"
   ```

4. Run without the upstream bincode default feature:

   ```sh
   cargo run --release --no-default-features --features rayon --example acceptance_export -- BB_CALL_RANGE.txt CO_OPEN_RANGE.txt acceptance-solver-raw.json
   ```

5. Convert and revalidate the result through the application domain code:

   ```sh
   npm run solver:convert-acceptance -- acceptance-solver-raw.json src/solutions/acceptance-qsts-solved.pack.json
   ```

The recorded run used 16-bit compressed storage, stopped after 290 iterations at 0.023417664 BB exploitability (0.4257757% of the 5.5 BB starting pot), and beat its 0.5%-pot target. Its raw JSON SHA-256 is `6aa9096a14bf2ec9b637bfd94ec02a9bf4af592da4c3ba10d3321a8ef5bc4088`.
