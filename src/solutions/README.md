# Bundled solver packs

Files in this directory are imported through the same strict schema-v2 parser and legal replay path as user-supplied packs. A bundled file is not trusted merely because it ships with the application.

`acceptance-qsts-solved.pack.json` is generated from a real `b-inary/postflop-solver` CFR run. Its source, convergence, range adaptation, continuation tree, action EV convention, and deterministic hashes are embedded in the pack and shown in the trainer after a decision.

The current version, `2026-09-06.native-2.1.0`, was recomputed through native adapter 2.1.0 using all 411 original positive Hero combinations and the exact scenario-manifest tree. It converged in 290 iterations at 0.4189089% of the 5.5 BB street-start pot, below the 0.5% target. The native storage allocation was 962.24 MB. Prior data came from a separate exporter with jam-only continuation raises; it was replaced so the displayed action-tree manifest and native solve describe the same game.

Reproduce against a running adapter 2.1.0 with `node --import tsx scripts/refresh-acceptance-pack.ts OUTPUT_PACK_JSON`. The refresh preserves the existing custom ranges and manifest, validates the solver result and legally replays the output before writing. The original source range adaptation (QTs from zero to one to support the requested custom node) remains explicitly disclosed.
