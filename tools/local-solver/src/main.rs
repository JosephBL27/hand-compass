use chrono::Utc;
use postflop_solver::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
mod exact_cache;
use exact_cache::ExactCache;

const PROTOCOL_VERSION: &str = "1.1.0";
const SOURCE_ID: &str = "local-b-inary-postflop-solver";
const SOLVER_NAME: &str = "b-inary/postflop-solver";
const SOLVER_VERSION: &str = "0.1.0-pinned";
const SOLVER_COMMIT: &str = "9d1509fe5077d019825f833eed04b16d342dfda1";
const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
const ADAPTER_VERSION: &str = "2.1.0";

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WireAction {
    Fold,
    Check,
    Call { amount: i64 },
    Bet { to: i64 },
    Raise { to: i64 },
    Jam { to: i64 },
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum WireStreet {
    Preflop,
    Flop,
    Turn,
    River,
}

#[derive(Clone, Deserialize)]
struct WireCombo {
    cards: [String; 2],
    weight: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePlayer {
    id: String,
    #[serde(rename = "stackBB")]
    stack_bb: i64,
    #[serde(rename = "streetContributionBB")]
    street_contribution_bb: i64,
    #[serde(rename = "totalContributionBB")]
    total_contribution_bb: i64,
    status: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireActionRecord {
    seat_id: String,
    street: WireStreet,
    action: WireAction,
    #[serde(rename = "potAfterBB")]
    pot_after_bb: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePublicState {
    button_index: usize,
    #[serde(rename = "currentBetBB")]
    current_bet_bb: i64,
    #[serde(rename = "lastFullRaiseBB")]
    last_full_raise_bb: i64,
    players: Vec<WirePlayer>,
    action_history: Vec<WireActionRecord>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRake {
    enabled: bool,
    percentage: f64,
    #[serde(rename = "capBB")]
    cap_bb: i64,
    no_flop_no_drop: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireCandidateScope {
    Bet,
    Raise,
    Both,
}

impl Default for WireCandidateScope {
    fn default() -> Self { Self::Both }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum WireCandidate {
    PotFraction { fraction: f64, #[serde(default)] scope: WireCandidateScope, #[serde(default, rename = "rootOnly")] root_only: bool },
    RaiseMultiple { multiple: f64, #[serde(default)] scope: WireCandidateScope, #[serde(default, rename = "rootOnly")] root_only: bool },
    RaiseTo { #[serde(rename = "toBB")] to_bb: i64, #[serde(default)] scope: WireCandidateScope, #[serde(default, rename = "rootOnly")] root_only: bool },
    AllIn { #[serde(default)] scope: WireCandidateScope, #[serde(default, rename = "rootOnly")] root_only: bool },
}

#[derive(Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum WireSizingRule {
    Fixed { candidates: Vec<WireCandidate> },
    Dynamic {
        candidates: Vec<WireCandidate>,
        #[serde(default, rename = "retainedCandidateIndexes")]
        retained_candidate_indexes: Option<Vec<usize>>,
    },
    Geometric {
        #[serde(rename = "streetsRemaining")]
        streets_remaining: i32,
        #[serde(default, rename = "includeAllIn")]
        include_all_in: Option<bool>,
    },
}

#[derive(Clone, Deserialize)]
struct WirePreflopTree {
    unopened: WireSizingRule,
    #[serde(rename = "facingRaise")]
    facing_raise: WireSizingRule,
}

#[derive(Clone, Deserialize)]
struct WireActionTree {
    id: String,
    preflop: WirePreflopTree,
    flop: WireSizingRule,
    turn: WireSizingRule,
    river: WireSizingRule,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireQuery {
    node_hash: String,
    actor_seat_id: String,
    actor_position: String,
    hero_seat_id: String,
    game_config: Value,
    street: WireStreet,
    board: Vec<String>,
    action_history: Vec<WireAction>,
    public_state: Option<WirePublicState>,
    #[serde(rename = "potBB")]
    pot_bb: i64,
    #[serde(rename = "stacksBB")]
    stacks_bb: BTreeMap<String, i64>,
    hero_position: String,
    opponent_positions: Vec<String>,
    ranges: BTreeMap<String, Vec<WireCombo>>,
    legal_actions: Vec<WireAction>,
    action_tree: WireActionTree,
    rake: WireRake,
    dead_cards: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest {
    protocol_version: String,
    kind: String,
    identity: Value,
    query: WireQuery,
}

#[derive(Clone, Serialize)]
struct SolverSettings {
    max_iterations: u32,
    target_pct_pot: f32,
    max_memory_bytes: u64,
    compressed: bool,
    max_solve_seconds: u64,
    max_tree_nodes: usize,
    max_queued_requests: usize,
}

struct RuntimeState {
    phase: &'static str,
    started_at: Option<Instant>,
    queued_requests: usize,
    iterations: u32,
    completed_solves: u64,
    rejected_solves: u64,
    last_error: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self { phase: "idle", started_at: None, queued_requests: 0, iterations: 0,
            completed_solves: 0, rejected_solves: 0, last_error: None }
    }
}

struct SharedState {
    solve_lock: Mutex<()>,
    cache: Mutex<ExactCache>,
    activity: Mutex<RuntimeState>,
}

#[derive(Clone, Copy)]
struct SimState {
    street: BoardState,
    actor: usize,
    stack: [i32; 2],
    contribution: [i32; 2],
    pot_base: i32,
    current_bet: i32,
    previous_action: Action,
    terminal: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComboActionResult {
    action: WireAction,
    frequency: f64,
    #[serde(rename = "evBB")]
    ev_bb: i64,
}

#[derive(Serialize)]
struct ComboResult {
    cards: [String; 2],
    weight: f64,
    actions: Vec<ComboActionResult>,
}

fn setting<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

fn settings() -> SolverSettings {
    SolverSettings {
        max_iterations: setting("POKER_SOLVER_MAX_ITERATIONS", 2_000),
        target_pct_pot: setting("POKER_SOLVER_TARGET_PCT_POT", 0.5),
        max_memory_bytes: setting::<u64>("POKER_SOLVER_MAX_MEMORY_MB", 4_096) * 1024 * 1024,
        compressed: setting::<u8>("POKER_SOLVER_COMPRESSED", 1) != 0,
        max_solve_seconds: setting("POKER_SOLVER_MAX_SOLVE_SECONDS", 120),
        max_tree_nodes: setting("POKER_SOLVER_MAX_TREE_NODES", 200_000),
        max_queued_requests: setting("POKER_SOLVER_MAX_QUEUED_REQUESTS", 8),
    }
}

fn i32_units(value: i64, label: &str) -> Result<i32, String> {
    i32::try_from(value).map_err(|_| format!("{label} exceeds the solver's 32-bit fixed-unit limit"))
}

fn seat_index(id: &str) -> Result<usize, String> {
    id.strip_prefix("seat-")
        .ok_or_else(|| format!("Invalid seat id: {id}"))?
        .parse::<usize>()
        .map_err(|_| format!("Invalid seat id: {id}"))
}

fn board_state(street: WireStreet) -> Result<BoardState, String> {
    match street {
        WireStreet::Preflop => Err("The integrated open-source engine is heads-up postflop only; preflop is unsupported".to_string()),
        WireStreet::Flop => Ok(BoardState::Flop),
        WireStreet::Turn => Ok(BoardState::Turn),
        WireStreet::River => Ok(BoardState::River),
    }
}

fn next_street(street: BoardState) -> Option<BoardState> {
    match street {
        BoardState::Flop => Some(BoardState::Turn),
        BoardState::Turn => Some(BoardState::River),
        BoardState::River => None,
    }
}

fn rule_for(tree: &WireActionTree, street: BoardState) -> &WireSizingRule {
    match street {
        BoardState::Flop => &tree.flop,
        BoardState::Turn => &tree.turn,
        BoardState::River => &tree.river,
    }
}

fn selected_candidates(rule: &WireSizingRule) -> Vec<&WireCandidate> {
    match rule {
        WireSizingRule::Fixed { candidates } => candidates.iter().collect(),
        WireSizingRule::Dynamic { candidates, retained_candidate_indexes } => match retained_candidate_indexes {
            Some(indexes) => indexes.iter().filter_map(|index| candidates.get(*index)).collect(),
            None => candidates.iter().collect(),
        },
        WireSizingRule::Geometric { .. } => Vec::new(),
    }
}

fn rule_has_root_only(rule: &WireSizingRule) -> bool {
    selected_candidates(rule).iter().any(|candidate| candidate_root_only(candidate))
}

fn tree_has_root_only(tree: &WireActionTree) -> bool {
    rule_has_root_only(&tree.flop) || rule_has_root_only(&tree.turn) || rule_has_root_only(&tree.river)
}

fn candidate_scope(candidate: &WireCandidate) -> &WireCandidateScope {
    match candidate {
        WireCandidate::PotFraction { scope, .. }
        | WireCandidate::RaiseMultiple { scope, .. }
        | WireCandidate::RaiseTo { scope, .. }
        | WireCandidate::AllIn { scope, .. } => scope,
    }
}

fn candidate_root_only(candidate: &WireCandidate) -> bool {
    match candidate {
        WireCandidate::PotFraction { root_only, .. }
        | WireCandidate::RaiseMultiple { root_only, .. }
        | WireCandidate::RaiseTo { root_only, .. }
        | WireCandidate::AllIn { root_only, .. } => *root_only,
    }
}

fn candidate_applies(candidate: &WireCandidate, facing_wager: bool) -> bool {
    match candidate_scope(candidate) {
        WireCandidateScope::Both => true,
        WireCandidateScope::Bet => !facing_wager,
        WireCandidateScope::Raise => facing_wager,
    }
}

fn current_pot(_starting_pot: i32, state: SimState) -> i32 {
    state.pot_base + state.contribution[0] + state.contribution[1]
}

fn desired_aggression(tree: &WireActionTree, starting_pot: i32, state: SimState, at_public_node: bool) -> Result<Vec<Action>, String> {
    if state.terminal || matches!(state.previous_action, Action::AllIn(_)) || state.stack[state.actor] == 0 {
        return Ok(Vec::new());
    }
    let rule = rule_for(tree, state.street);
    let mut desired = Vec::new();
    match rule {
        WireSizingRule::Geometric { streets_remaining, include_all_in } => {
            if state.current_bet != 0 {
                return Err("Geometric mode does not define a raise tree while facing a wager".to_string());
            }
            if *streets_remaining <= 0 {
                return Err("Geometric streetsRemaining must be positive".to_string());
            }
            let pot = current_pot(starting_pot, state) as f64;
            let effective = state.stack[0].min(state.stack[1]) as f64;
            let fraction = ((1.0 + 2.0 * effective / pot).powf(1.0 / *streets_remaining as f64) - 1.0) / 2.0;
            let amount = state.contribution[state.actor] + (pot * fraction).round() as i32;
            let max_to = state.contribution[state.actor] + state.stack[state.actor];
            desired.push(if amount >= max_to { Action::AllIn(max_to) } else { Action::Bet(amount) });
            if include_all_in.unwrap_or(true) {
                desired.push(Action::AllIn(max_to));
            }
        }
        _ => {
            for candidate in selected_candidates(rule) {
                if candidate_root_only(candidate) && !at_public_node { continue; }
                if !candidate_applies(candidate, state.current_bet != 0) { continue; }
                let max_to = state.contribution[state.actor] + state.stack[state.actor];
                let target = match candidate {
                    WireCandidate::AllIn { .. } => {
                        desired.push(Action::AllIn(max_to));
                        continue;
                    }
                    WireCandidate::RaiseTo { to_bb, .. } => i32_units(*to_bb, "raise-to target")?,
                    WireCandidate::RaiseMultiple { multiple, .. } => {
                        if state.current_bet == 0 { continue; }
                        (state.current_bet as f64 * *multiple).round() as i32
                    }
                    WireCandidate::PotFraction { fraction, .. } => {
                        if !fraction.is_finite() || *fraction <= 0.0 {
                            return Err("Pot-fraction candidates must be finite and positive".to_string());
                        }
                        if state.current_bet == 0 {
                            state.contribution[state.actor]
                                + (current_pot(starting_pot, state) as f64 * *fraction).round() as i32
                        } else {
                            let call = state.current_bet - state.contribution[state.actor];
                            let pot_after_call = current_pot(starting_pot, state) + call;
                            state.contribution[state.actor] + call + (pot_after_call as f64 * *fraction).round() as i32
                        }
                    }
                };
                if target <= state.current_bet || target <= state.contribution[state.actor] { continue; }
                desired.push(if target >= max_to {
                    Action::AllIn(max_to)
                } else if state.current_bet == 0 {
                    Action::Bet(target)
                } else {
                    Action::Raise(target)
                });
            }
        }
    }
    desired.sort_unstable();
    desired.dedup();
    Ok(desired)
}

fn is_aggressive(action: Action) -> bool {
    matches!(action, Action::Bet(_) | Action::Raise(_) | Action::AllIn(_))
}

fn apply_sim(mut state: SimState, action: Action) -> Result<SimState, String> {
    let actor = state.actor;
    match action {
        Action::Fold => state.terminal = true,
        Action::Check => {
            if state.current_bet != state.contribution[actor] {
                return Err("Check encountered while facing a wager".to_string());
            }
            if actor == 0 {
                state.actor = 1;
                state.previous_action = Action::Check;
            } else if matches!(state.previous_action, Action::Check) {
                if let Some(street) = next_street(state.street) {
                    state.street = street;
                    state.actor = 0;
                    state.pot_base = current_pot(0, state);
                    state.contribution = [0, 0];
                    state.current_bet = 0;
                    state.previous_action = Action::Chance(0);
                } else {
                    state.terminal = true;
                }
            } else {
                return Err("IP check did not follow an OOP check".to_string());
            }
        }
        Action::Call => {
            let payment = state.current_bet - state.contribution[actor];
            if payment < 0 || payment > state.stack[actor] {
                return Err("Call exceeds simulated stack".to_string());
            }
            state.stack[actor] -= payment;
            state.contribution[actor] += payment;
            if state.stack[0] == 0 || state.stack[1] == 0 {
                state.terminal = true;
            } else if let Some(street) = next_street(state.street) {
                state.street = street;
                state.actor = 0;
                state.pot_base = current_pot(0, state);
                state.contribution = [0, 0];
                state.current_bet = 0;
                state.previous_action = Action::Chance(0);
            } else {
                state.terminal = true;
            }
        }
        Action::Bet(target) | Action::Raise(target) | Action::AllIn(target) => {
            let payment = target - state.contribution[actor];
            if payment <= 0 || payment > state.stack[actor] {
                return Err(format!("Aggressive target {target} exceeds simulated stack"));
            }
            state.stack[actor] -= payment;
            state.contribution[actor] = target;
            state.current_bet = target;
            state.actor ^= 1;
            state.previous_action = action;
        }
        Action::None | Action::Chance(_) => return Err("Unexpected simulated action".to_string()),
    }
    Ok(state)
}

fn materialize_tree(
    tree: &mut ActionTree,
    config: &WireActionTree,
    starting_pot: i32,
    state: SimState,
    forced_prefix: &[Action],
    depth: usize,
    public_decision_depth: usize,
    visited: &mut usize,
    max_nodes: usize,
) -> Result<(), String> {
    if state.terminal { return Ok(()); }
    *visited += 1;
    if *visited > max_nodes { return Err(format!("Configured action tree exceeds the {max_nodes}-node resource limit; no sizes were removed")); }
    if depth > 80 { return Err("Action tree exceeds the 80-decision safety bound".to_string()); }

    let existing = tree.available_actions().to_vec();
    if let Some(forced) = forced_prefix.first().copied() {
        if !existing.contains(&forced) && is_aggressive(forced) {
            tree.add_action(forced)?;
        }
        let available = tree.available_actions().to_vec();
        if !available.contains(&forced) {
            return Err(format!("Observed current-street action {forced:?} is absent from the reconstructed solver tree"));
        }
        for action in available {
            if action != forced { tree.remove_action(action)?; }
        }
    } else {
        let desired = desired_aggression(config, starting_pot, state, depth == public_decision_depth)?;
        for action in existing.iter().copied().filter(|action| is_aggressive(*action) && !desired.contains(action)) {
            tree.remove_action(action)?;
        }
        for action in desired {
            if !tree.available_actions().contains(&action) {
                if let Err(error) = tree.add_action(action) {
                    // The TypeScript rules engine filters fixed targets that
                    // are below the live minimum raise or above the stack.
                    if !error.contains("Invalid bet amount") { return Err(error); }
                }
            }
        }
    }

    let actions = tree.available_actions().to_vec();
    for action in actions {
        tree.play(action)?;
        let next = apply_sim(state, action)?;
        let next_prefix = if forced_prefix.first() == Some(&action) { &forced_prefix[1..] } else { &[] };
        materialize_tree(tree, config, starting_pot, next, next_prefix, depth + 1, public_decision_depth, visited, max_nodes)?;
        tree.undo()?;
    }
    Ok(())
}

fn wire_to_solver(action: &WireAction, effective_max: i32) -> Result<Action, String> {
    Ok(match action {
        WireAction::Fold => Action::Fold,
        WireAction::Check => Action::Check,
        WireAction::Call { .. } => Action::Call,
        WireAction::Bet { to } => {
            let target = i32_units(*to, "bet target")?;
            if target >= effective_max { Action::AllIn(effective_max) } else { Action::Bet(target) }
        }
        WireAction::Raise { to } => {
            let target = i32_units(*to, "raise target")?;
            if target >= effective_max { Action::AllIn(effective_max) } else { Action::Raise(target) }
        }
        WireAction::Jam { .. } => Action::AllIn(effective_max),
    })
}

fn action_matches_wire(solver: Action, wire: &WireAction) -> bool {
    match (solver, wire) {
        (Action::Fold, WireAction::Fold) | (Action::Check, WireAction::Check) | (Action::Call, WireAction::Call { .. }) => true,
        (Action::Bet(left), WireAction::Bet { to }) | (Action::Raise(left), WireAction::Raise { to }) => left as i64 == *to,
        (Action::AllIn(_), WireAction::Jam { .. }) => true,
        _ => false,
    }
}

fn range_string(combos: &[WireCombo], blocked: &HashSet<&str>) -> Result<String, String> {
    let mut entries = Vec::new();
    for combo in combos {
        if !combo.weight.is_finite() || combo.weight < 0.0 || combo.weight > 1.0 {
            return Err("Range combo weight must be in [0, 1]".to_string());
        }
        if combo.weight == 0.0 || blocked.contains(combo.cards[0].as_str()) || blocked.contains(combo.cards[1].as_str()) { continue; }
        if combo.cards[0] == combo.cards[1] { return Err("Range combo contains a duplicate card".to_string()); }
        let first = card_from_str(&combo.cards[0])?;
        let second = card_from_str(&combo.cards[1])?;
        let normalized = hole_to_string((first, second))?;
        entries.push(format!("{normalized}:{:.12}", combo.weight));
    }
    if entries.is_empty() { return Err("Range has no positive combos after board removal".to_string()); }
    Ok(entries.join(","))
}

fn build_card_config(query: &WireQuery, oop_range: Range, ip_range: Range) -> Result<CardConfig, String> {
    let state = board_state(query.street)?;
    let expected_cards = match state { BoardState::Flop => 3, BoardState::Turn => 4, BoardState::River => 5 };
    if query.board.len() != expected_cards { return Err(format!("Current street requires {expected_cards} public cards")); }
    let flop = flop_from_str(&query.board[..3].join(""))?;
    let turn = if query.board.len() >= 4 { card_from_str(&query.board[3])? } else { NOT_DEALT };
    let river = if query.board.len() >= 5 { card_from_str(&query.board[4])? } else { NOT_DEALT };
    Ok(CardConfig { range: [oop_range, ip_range], flop, turn, river })
}

fn response_action(wire: &WireAction, frequency: f64, ev: f64) -> Value {
    json!({ "action": wire, "frequency": frequency, "evBB": ev.round() as i64 })
}

fn solve_request(request: WireRequest, settings: &SolverSettings, activity: &Mutex<RuntimeState>) -> Result<Value, String> {
    let started = Instant::now();
    if request.protocol_version != PROTOCOL_VERSION || request.kind != "solve" {
        return Err(format!("Expected local solver protocol {PROTOCOL_VERSION} solve request"));
    }
    let query = request.query;
    if query.game_config.pointer("/tournament/icmEnabled").and_then(Value::as_bool) == Some(true)
        || query.game_config.pointer("/tournament/bountyType").and_then(Value::as_str) == Some("PKO") {
        return Err("ICM and PKO utility are unsupported by this chip-EV engine".to_string());
    }
    if !query.dead_cards.is_empty() {
        return Err("Known dead cards are not silently ignored by this engine; dead-card solves are unsupported".to_string());
    }
    let public = query.public_state.as_ref()
        .ok_or_else(|| "The live publicState ledger is required for arbitrary-node reconstruction".to_string())?;
    let live = public.players.iter().filter(|player| player.status != "folded").collect::<Vec<_>>();
    if live.len() != 2 {
        return Err(format!("The integrated engine supports exactly two players remaining postflop; received {}", live.len()));
    }
    if public.current_bet_bb < 0 || public.last_full_raise_bb < 0 {
        return Err("Public betting ledger cannot contain negative values".to_string());
    }
    let player_count = public.players.len();
    let mut ordered = live.clone();
    ordered.sort_by_key(|player| {
        let index = seat_index(&player.id).unwrap_or(usize::MAX);
        let distance = (index + player_count - public.button_index) % player_count;
        if distance == 0 { player_count } else { distance }
    });
    let oop = ordered[0];
    let ip = ordered[1];
    let actor_index = if query.actor_seat_id == oop.id {
        0
    } else if query.actor_seat_id == ip.id {
        1
    } else {
        return Err("Actor is not one of the two live postflop players".to_string());
    };

    let current_records = public.action_history.iter().filter(|record| record.street == query.street).collect::<Vec<_>>();
    if current_records.iter().any(|record| record.seat_id != oop.id && record.seat_id != ip.id) {
        return Err("Current-street multiway-to-heads-up transitions are not supported by this solver adapter".to_string());
    }
    let street_contributions = public.players.iter().map(|player| player.street_contribution_bb).sum::<i64>();
    let starting_pot = i32_units(query.pot_bb - street_contributions, "street-start pot")?;
    if starting_pot <= 0 { return Err("Street-start pot must be positive".to_string()); }
    let oop_start = i32_units(oop.stack_bb + oop.street_contribution_bb, "OOP street-start stack")?;
    let ip_start = i32_units(ip.stack_bb + ip.street_contribution_bb, "IP street-start stack")?;
    let effective_stack = oop_start.min(ip_start);
    if effective_stack <= 0 { return Err("Effective stack must be positive".to_string()); }

    let forced_path = current_records.iter()
        .map(|record| wire_to_solver(&record.action, effective_stack))
        .collect::<Result<Vec<_>, _>>()?;
    let empty_sizes = BetSizeOptions::default();
    let tree_config = TreeConfig {
        initial_state: board_state(query.street)?,
        starting_pot,
        effective_stack,
        rake_rate: if query.rake.enabled { query.rake.percentage } else { 0.0 },
        rake_cap: if query.rake.enabled { query.rake.cap_bb as f64 } else { 0.0 },
        flop_bet_sizes: [empty_sizes.clone(), empty_sizes.clone()],
        turn_bet_sizes: [empty_sizes.clone(), empty_sizes.clone()],
        river_bet_sizes: [empty_sizes.clone(), empty_sizes],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 0.0,
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };
    let mut action_tree = ActionTree::new(tree_config)?;
    let initial_sim = SimState {
        street: board_state(query.street)?,
        actor: 0,
        stack: [effective_stack, effective_stack],
        contribution: [0, 0],
        pot_base: starting_pot,
        current_bet: 0,
        previous_action: Action::None,
        terminal: false,
    };
    let mut visited_nodes = 0;
    materialize_tree(&mut action_tree, &query.action_tree, starting_pot, initial_sim, &forced_path, 0, forced_path.len(), &mut visited_nodes, settings.max_tree_nodes)?;

    action_tree.apply_history(&forced_path)?;
    let target_actions = action_tree.available_actions().to_vec();
    if target_actions.len() != query.legal_actions.len()
        || query.legal_actions.iter().any(|wire| !target_actions.iter().any(|solver| action_matches_wire(*solver, wire)))
    {
        return Err(format!("Reconstructed action tree does not match the live legal actions. Solver: {target_actions:?}"));
    }
    let mut target_sim = initial_sim;
    for action in &forced_path { target_sim = apply_sim(target_sim, *action)?; }
    if target_sim.actor != actor_index {
        return Err("Reconstructed current-street actor does not match the rules engine".to_string());
    }
    action_tree.back_to_root();

    let blocked = query.board.iter().map(String::as_str).collect::<HashSet<_>>();
    let oop_wire_range = query.ranges.get(&oop.id).ok_or_else(|| format!("Missing public range for {}", oop.id))?;
    let ip_wire_range = query.ranges.get(&ip.id).ok_or_else(|| format!("Missing public range for {}", ip.id))?;
    let oop_range = range_string(oop_wire_range, &blocked)?.parse::<Range>()?;
    let ip_range = range_string(ip_wire_range, &blocked)?.parse::<Range>()?;
    let card_config = build_card_config(&query, oop_range, ip_range)?;
    let mut game = PostFlopGame::with_config(card_config, action_tree)?;
    let (plain_memory, compressed_memory) = game.memory_usage();
    let selected_memory = if settings.compressed { compressed_memory } else { plain_memory };
    if selected_memory > settings.max_memory_bytes {
        return Err(format!(
            "Solve requires {:.2} GB, above the configured {:.2} GB limit",
            selected_memory as f64 / 1_073_741_824.0,
            settings.max_memory_bytes as f64 / 1_073_741_824.0
        ));
    }
    game.allocate_memory(settings.compressed);
    if let Ok(mut state) = activity.lock() { state.phase = "solving"; }
    let target_exploitability = starting_pot as f32 * (settings.target_pct_pot / 100.0);
    let mut iterations = 0u32;
    let mut exploitability = compute_exploitability(&game);
    while iterations < settings.max_iterations && exploitability > target_exploitability {
        if started.elapsed().as_secs() >= settings.max_solve_seconds {
            return Err(format!("Solve exceeded the {}-second resource limit after {iterations} iterations; no unconverged strategy was returned", settings.max_solve_seconds));
        }
        solve_step(&game, iterations);
        iterations += 1;
        if iterations % 10 == 0 {
            exploitability = compute_exploitability(&game);
            if let Ok(mut state) = activity.lock() { state.iterations = iterations; }
        }
    }
    if iterations % 10 != 0 { exploitability = compute_exploitability(&game); }
    if exploitability > target_exploitability {
        return Err(format!(
            "Solver did not converge within {} iterations: exploitability {:.6} units exceeds the {:.6}-unit target",
            settings.max_iterations, exploitability, target_exploitability
        ));
    }
    finalize(&mut game);
    for action in &forced_path {
        let index = game.available_actions().iter().position(|candidate| candidate == action)
            .ok_or_else(|| format!("Solved tree lost forced action {action:?}"))?;
        game.play(index);
    }
    game.cache_normalized_weights();
    let solver_actions = game.available_actions();
    let actor_cards = holes_to_strings(game.private_cards(actor_index))?;
    let strategy = game.strategy();
    let evs = game.expected_values_detail(actor_index);
    let hand_count = actor_cards.len();
    let actor_wire_range = if actor_index == 0 { oop_wire_range } else { ip_wire_range };
    let mut source_by_cards = HashMap::new();
    for combo in actor_wire_range {
        if combo.weight <= 0.0 || blocked.contains(combo.cards[0].as_str()) || blocked.contains(combo.cards[1].as_str()) { continue; }
        let first = card_from_str(&combo.cards[0])?;
        let second = card_from_str(&combo.cards[1])?;
        source_by_cards.insert(hole_to_string((first, second))?, combo);
    }

    let mut combo_policy = Vec::new();
    let mut aggregate_frequency = vec![0.0f64; solver_actions.len()];
    let mut aggregate_ev = vec![0.0f64; solver_actions.len()];
    let mut aggregate_weight = 0.0f64;
    for (hand_index, cards) in actor_cards.iter().enumerate() {
        let Some(source) = source_by_cards.get(cards) else { continue };
        let raw_frequencies = (0..solver_actions.len())
            .map(|action_index| strategy[hand_index + action_index * hand_count] as f64)
            .collect::<Vec<_>>();
        let frequency_sum = raw_frequencies.iter().sum::<f64>();
        if frequency_sum <= 0.0 { return Err(format!("Solver returned zero strategy mass for {cards}")); }
        let mut row_actions = Vec::new();
        for (action_index, solver_action) in solver_actions.iter().enumerate() {
            let wire = query.legal_actions.iter().find(|wire| action_matches_wire(*solver_action, wire))
                .ok_or_else(|| format!("Solved action {solver_action:?} is absent from the live action set"))?
                .clone();
            let frequency = raw_frequencies[action_index] / frequency_sum;
            let ev = evs[hand_index + action_index * hand_count] as f64;
            row_actions.push(ComboActionResult { action: wire, frequency, ev_bb: ev.round() as i64 });
            aggregate_frequency[action_index] += source.weight * frequency;
            aggregate_ev[action_index] += source.weight * ev;
        }
        aggregate_weight += source.weight;
        combo_policy.push(ComboResult { cards: source.cards.clone(), weight: source.weight, actions: row_actions });
    }
    if combo_policy.is_empty() || aggregate_weight <= 0.0 { return Err("Solver produced no positive actor combo rows".to_string()); }

    let aggregate_actions = solver_actions.iter().enumerate().map(|(index, solver_action)| {
        let wire = query.legal_actions.iter().find(|wire| action_matches_wire(*solver_action, wire)).unwrap();
        response_action(wire, aggregate_frequency[index] / aggregate_weight, aggregate_ev[index] / aggregate_weight)
    }).collect::<Vec<_>>();
    let exploitability_units = exploitability.max(0.0).round() as i64;
    let target_units = target_exploitability.max(0.0).round() as i64;
    let exploitability_pct = exploitability.max(0.0) as f64 / starting_pot as f64 * 100.0;
    let tree_id = query.action_tree.id.clone();
    let mut notes = vec![
        "Exact heads-up postflop subgame solve from current conditional ranges; observed current-street actions were forced before the decision to avoid double-conditioning.".to_string(),
        format!("Tree {tree_id} was materialized with the trainer's fixed, dynamic, or geometric sizing semantics at every remaining node."),
        format!("Engine commit {SOLVER_COMMIT}; {:.2} MB allocated; current-street pot starts at {:.4} BB.", selected_memory as f64 / 1_048_576.0, starting_pot as f64 / 10_000.0),
        format!("Raw computed exploitability was {:.6} fixed BB units; the public nonnegative value is clamped only when floating-point residual is below zero.", exploitability),
        "Scope: heads-up chip-EV postflop only. This source does not claim preflop, multiway postflop, ICM, PKO, or known-dead-card equilibrium coverage.".to_string(),
    ];
    if tree_has_root_only(&query.action_tree) {
        notes.push("This configured rolling subgame tree offers rootOnly actions (including jam) at the live decision but omits them from downstream branches to keep 100 BB solves bounded; later decisions are solved again from their new conditional state. This is not a claim of a single full-game equilibrium.".to_string());
    }

    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "strategy-result",
        "identity": request.identity,
        "source": {
            "sourceId": SOURCE_ID,
            "solver": SOLVER_NAME,
            "version": format!("{SOLVER_VERSION}/adapter-{ADAPTER_VERSION}"),
            "timestamp": Utc::now().to_rfc3339(),
            "commit": SOLVER_COMMIT,
            "sourceUrl": format!("https://github.com/b-inary/postflop-solver/tree/{SOLVER_COMMIT}"),
            "license": "AGPL-3.0-or-later",
        },
        "state": {
            "actorSeatId": query.actor_seat_id,
            "actorPosition": query.actor_position,
            "heroSeatId": query.hero_seat_id,
            "potBB": query.pot_bb,
            "stacksBB": query.stacks_bb,
            "rake": query.rake,
            "board": query.board,
            "legalActions": query.legal_actions,
        },
        "result": {
            "provenance": "SOLVED",
            "actions": aggregate_actions,
            "comboPolicy": combo_policy,
            "convergence": {
                "exploitability": exploitability_units,
                "exploitabilityBB": exploitability_units,
                "exploitabilityPctPot": exploitability_pct,
                "targetExploitabilityBB": target_units,
                "targetExploitabilityPctPot": settings.target_pct_pot,
                "iterations": iterations,
                "solver": SOLVER_NAME,
                "compression": if settings.compressed { "16-bit integer" } else { "32-bit float" },
            },
            "sourceNodeId": query.node_hash,
            "notes": notes,
        }
    }))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn allowed_origin(request: &Request) -> Option<String> {
    let origin = request.headers().iter().find(|item| item.field.equiv("Origin"))
        .map(|item| item.value.as_str().to_string());
    match origin {
        None => Some("*".to_string()),
        Some(value) if value.starts_with("http://127.0.0.1:")
            || value.starts_with("http://localhost:")
            || value.starts_with("http://[::1]:") => Some(value),
        _ => None,
    }
}

fn json_response(status: u16, body: Value, origin: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(&body).unwrap())
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Access-Control-Allow-Origin", origin))
        .with_header(header("Vary", "Origin"))
        .with_header(header("Cache-Control", "no-store"))
}

fn status_payload(shared: &SharedState, settings: &SolverSettings) -> Value {
    let activity = shared.activity.lock().unwrap();
    json!({
        "status": "ok", "protocolVersion": PROTOCOL_VERSION, "adapterVersion": ADAPTER_VERSION,
        "solver": SOLVER_NAME, "commit": SOLVER_COMMIT, "scope": "heads-up-postflop-chip-ev",
        "capabilities": {
            "streets": ["flop", "turn", "river"], "maxPlayersRemaining": 2,
            "weightedRanges": true, "unequalStacks": true, "rake": true,
            "sizingModes": ["fixed", "dynamic", "geometric"],
            "unsupported": ["Preflop equilibrium", "Multiway postflop equilibrium", "ICM and PKO utility",
                "Known dead cards", "Current-street multiway-to-heads-up transitions",
                "Legal actions that collapse to duplicate effective-stack all-ins",
                "Geometric raise trees while facing a wager", "Trees exceeding configured resource or convergence limits"]
        },
        "limits": { "maxIterations": settings.max_iterations, "targetExploitabilityPctPot": settings.target_pct_pot,
            "maxMemoryMB": settings.max_memory_bytes / 1024 / 1024, "maxSolveSeconds": settings.max_solve_seconds,
            "maxTreeNodes": settings.max_tree_nodes, "maxQueuedRequests": settings.max_queued_requests },
        "activity": { "phase": activity.phase, "queuedRequests": activity.queued_requests,
            "iterations": activity.iterations, "elapsedSeconds": activity.started_at.map(|time| time.elapsed().as_secs_f64()).unwrap_or(0.0),
            "completedSolves": activity.completed_solves, "rejectedSolves": activity.rejected_solves, "lastError": activity.last_error },
        "cache": shared.cache.lock().unwrap().status()
    })
}

fn failure_code(message: &str) -> &'static str {
    if message.contains("did not converge") { "CONVERGENCE_LIMIT" }
    else if message.contains("resource limit") || message.contains("GB limit") { "RESOURCE_LIMIT" }
    else if message.contains("unsupported") || message.contains("not supported") || message.contains("supports exactly") { "UNSUPPORTED_DOMAIN" }
    else { "INVALID_OR_UNMAPPED_STATE" }
}

fn handle(mut request: Request, shared: Arc<SharedState>, settings: SolverSettings) {
    let Some(origin) = allowed_origin(&request) else {
        let _ = request.respond(json_response(403, json!({ "error": { "code": "ORIGIN_REJECTED", "message": "Only loopback browser origins may call this sidecar" } }), "null"));
        return;
    };
    if request.method() == &Method::Options {
        let response = Response::empty(StatusCode(204))
            .with_header(header("Access-Control-Allow-Origin", &origin))
            .with_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "Content-Type, Accept"))
            .with_header(header("Access-Control-Max-Age", "600"))
            .with_header(header("Vary", "Origin"));
        let _ = request.respond(response);
        return;
    }
    if request.method() == &Method::Get && (request.url() == "/health" || request.url() == "/v1/status") {
        let _ = request.respond(json_response(200, status_payload(&shared, &settings), &origin));
        return;
    }
    if request.method() != &Method::Post || request.url() != "/v1/solve" {
        let _ = request.respond(json_response(404, json!({ "error": { "code": "NOT_FOUND", "message": "Use POST /v1/solve or GET /health" } }), &origin));
        return;
    }
    let mut bytes = Vec::new();
    if let Err(error) = request.as_reader().take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes) {
        let _ = request.respond(json_response(400, json!({ "error": { "code": "READ_FAILED", "message": error.to_string() } }), &origin));
        return;
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        let _ = request.respond(json_response(413, json!({ "error": { "code": "REQUEST_TOO_LARGE", "message": "Solver requests are limited to 16 MB" } }), &origin));
        return;
    }
    // serde_json's default map is ordered. This serializes object order
    // deterministically while preserving every query field, not only hashes.
    let raw: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            let _ = request.respond(json_response(400, json!({ "error": { "code": "INVALID_JSON", "message": error.to_string() } }), &origin));
            return;
        }
    };
    let exact_key = serde_json::to_string(&json!({ "adapterVersion": ADAPTER_VERSION, "solverCommit": SOLVER_COMMIT, "settings": settings, "request": raw })).unwrap();
    let parsed = match serde_json::from_value::<WireRequest>(raw) {
        Ok(value) => value,
        Err(error) => {
            let _ = request.respond(json_response(400, json!({ "error": { "code": "INVALID_REQUEST", "message": error.to_string() } }), &origin));
            return;
        }
    };
    if let Some(value) = shared.cache.lock().unwrap().get(&exact_key) {
        let _ = request.respond(json_response(200, value, &origin).with_header(header("X-Poker-Solver-Cache", "HIT")));
        return;
    }
    {
        let mut activity = shared.activity.lock().unwrap();
        if activity.queued_requests >= settings.max_queued_requests {
            let _ = request.respond(json_response(429, json!({ "error": { "code": "QUEUE_FULL", "message": "The bounded local solve queue is full; retry after the active solve completes" } }), &origin));
            return;
        }
        activity.queued_requests += 1;
    }
    let guard = match shared.solve_lock.lock() {
        Ok(value) => value,
        Err(_) => {
            let _ = request.respond(json_response(500, json!({ "error": { "code": "SOLVER_LOCK_POISONED", "message": "The solver worker must be restarted" } }), &origin));
            return;
        }
    };
    {
        let mut activity = shared.activity.lock().unwrap();
        activity.queued_requests -= 1;
    }
    // Another queued consumer may have completed this exact request meanwhile.
    if let Some(value) = shared.cache.lock().unwrap().get(&exact_key) {
        drop(guard);
        let _ = request.respond(json_response(200, value, &origin).with_header(header("X-Poker-Solver-Cache", "HIT")));
        return;
    }
    {
        let mut activity = shared.activity.lock().unwrap();
        activity.phase = "building";
        activity.started_at = Some(Instant::now());
        activity.iterations = 0;
        activity.last_error = None;
    }
    // A malformed or resource-heavy query must not poison every later hand.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| solve_request(parsed, &settings, &shared.activity)))
        .unwrap_or_else(|_| Err("Solver rejected the state during internal validation; no strategy was returned".to_string()));
    if let Ok(ref value) = result { shared.cache.lock().unwrap().set(exact_key, value.clone()); }
    {
        let mut activity = shared.activity.lock().unwrap();
        activity.phase = "idle";
        activity.started_at = None;
        if let Err(ref message) = result { activity.rejected_solves += 1; activity.last_error = Some(message.clone()); }
        else { activity.completed_solves += 1; }
    }
    drop(guard);
    match result {
        Ok(value) => { let _ = request.respond(json_response(200, value, &origin).with_header(header("X-Poker-Solver-Cache", "MISS"))); }
        Err(message) => { let _ = request.respond(json_response(422, json!({ "error": { "code": failure_code(&message), "message": message } }), &origin)); }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address = env::var("POKER_SOLVER_ADDR").unwrap_or_else(|_| "127.0.0.1:4317".to_string());
    let server = Server::http(&address)?;
    let settings = settings();
    if !settings.target_pct_pot.is_finite() || settings.target_pct_pot < 0.0 {
        return Err("POKER_SOLVER_TARGET_PCT_POT must be finite and nonnegative".into());
    }
    eprintln!(
        "poker solver sidecar listening on http://{address} ({} iterations, {:.3}% pot target, {} MB limit, compression={})",
        settings.max_iterations, settings.target_pct_pot, settings.max_memory_bytes / 1024 / 1024, settings.compressed
    );
    let cache_dir = env::var_os("POKER_SOLVER_CACHE_DIR").map(std::path::PathBuf::from).unwrap_or_else(exact_cache::default_directory);
    let shared = Arc::new(SharedState {
        solve_lock: Mutex::new(()), activity: Mutex::new(RuntimeState::default()),
        cache: Mutex::new(ExactCache::new(cache_dir, setting("POKER_SOLVER_CACHE_MAX_ENTRIES", 1024), setting::<u64>("POKER_SOLVER_CACHE_MAX_MB", 256) * 1024 * 1024)),
    });
    for request in server.incoming_requests() {
        let state = shared.clone();
        let solve_settings = settings.clone();
        thread::spawn(move || handle(request, state, solve_settings));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flop() -> SimState {
        SimState { street: BoardState::Flop, actor: 0, stack: [200_000, 200_000],
            contribution: [0, 0], pot_base: 55_000, current_bet: 0, previous_action: Action::None, terminal: false }
    }

    #[test]
    fn pot_carries_across_bet_call_and_check_check_streets() {
        let bet = apply_sim(flop(), Action::Bet(18_150)).unwrap();
        let turn = apply_sim(bet, Action::Call).unwrap();
        assert!(turn.street == BoardState::Turn);
        assert_eq!(turn.contribution, [0, 0]);
        assert_eq!(current_pot(55_000, turn), 91_300);
        let turn_bet = apply_sim(turn, Action::Bet(60_258)).unwrap();
        let river = apply_sim(turn_bet, Action::Call).unwrap();
        assert!(river.street == BoardState::River);
        assert_eq!(current_pot(55_000, river), 211_816);
        let checked_turn = apply_sim(apply_sim(turn, Action::Check).unwrap(), Action::Check).unwrap();
        assert_eq!(current_pot(55_000, checked_turn), 91_300);
    }

    #[test]
    fn descendants_size_from_their_actual_grown_pot() {
        let rule = |fraction| WireSizingRule::Fixed { candidates: vec![WireCandidate::PotFraction {
            fraction, scope: WireCandidateScope::Bet, root_only: false }] };
        let tree = WireActionTree { id: "pot-propagation".into(),
            preflop: WirePreflopTree { unopened: rule(0.33), facing_raise: rule(0.33) },
            flop: rule(0.33), turn: rule(0.66), river: rule(1.0) };
        let turn = apply_sim(apply_sim(flop(), Action::Bet(18_150)).unwrap(), Action::Call).unwrap();
        assert_eq!(desired_aggression(&tree, 55_000, turn, false).unwrap(), vec![Action::Bet(60_258)]);
    }
}
