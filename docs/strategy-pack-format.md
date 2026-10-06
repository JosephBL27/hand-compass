# Strategy pack format

The trainer accepts either schema-versioned JSON or combo-action CSV. Both
formats represent the same evidence: a solved node identity plus one row per
exact two-card combination and action. An aggregate 13x13 chart is not enough
to claim `SOLVED` because it loses suit-specific removal and action EV data.

## Money units

All monetary values are fixed-point big-blind units, where `10000` equals
`1 BB`. CSV columns use the `_units` suffix to make that explicit.

## JSON

Schema `2.0.0` is the first drillable format. The root object contains
`schemaVersion`, `packId`, `source`, `nodes`, and `scenarios`.
Every node supplies the five deterministic hashes, stacks, pot, rake, board,
the complete legal-action set, and a `comboPolicy`. Every combo row contains
`cards`, `weight`, and actions whose frequencies total 1. `evBB` is optional;
if one legal action lacks EV, exact EV-loss grading is withheld.

Every node must have exactly one scenario recipe with the same five-hash
identity. The recipe contains the complete `GameConfig`, Button and Hero seats,
action tree, public 1,326-combo range rows, fixed/dead/future cards, legal replay,
expected actor/board/pot/bet/stacks, and source-authored drill tags. Import
reconstructs the recipe through `PokerRulesEngine`, builds the live strategy
query, and rechecks all hashes, stacks, pot, rake, board, legal actions, and Hero
combo-policy coverage. Missing, duplicate, orphaned, or unreachable recipes
reject the whole pack. Schema `1.0.0` is rejected because it cannot prove how to
reach its nodes.

## CSV

CSV uses RFC-4180 quoting. Nested values are JSON inside their cells. The
header must contain every column below:

```text
schema_version,pack_id,source_name,source_version,source_timestamp,provenance,game_config_hash,range_hash,tree_hash,node_hash,board_canonical_hash,scenario_json,stack_units_json,pot_units,rake_json,board_json,legal_actions_json,combo_cards_json,combo_weight,action_json,frequency,ev_units
```

Each data row represents one action for one exact combo. Repeat node and combo
metadata and the identical `scenario_json` across their rows. Leave `ev_units` empty only when the source does
not provide that action EV. `provenance` must be `SOLVED`; the importer validates
cards, board collisions, action legality, combo weights, frequency totals,
hash compatibility, stacks, pot, and rake before registering the pack.

Importing a pack atomically registers every node as a selectable catalog drill.
The trainer never synthesizes a missing node. If a continuation reaches a child
node absent from the pack, the hand stops with an explicit provider block rather
than approximating the missing strategy.
