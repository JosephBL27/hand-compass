use postflop_solver::*;
use serde::Serialize;
use std::env;
use std::fs;

#[derive(Serialize)]
struct ActionRow {
    action: String,
    amount: Option<i32>,
    frequency: f32,
    ev: f32,
}

#[derive(Serialize)]
struct ComboRow {
    cards: String,
    weight: f32,
    actions: Vec<ActionRow>,
}

#[derive(Serialize)]
struct RangeRow {
    cards: String,
    weight: f32,
}

#[derive(Serialize)]
struct Export<'a> {
    solver: &'a str,
    solver_commit: &'a str,
    compression: &'a str,
    source_units_per_bb: i32,
    target_exploitability: f32,
    exploitability: f32,
    iterations: u32,
    starting_pot: i32,
    effective_stack: i32,
    board: &'a str,
    range_note: &'a str,
    target_path: Vec<&'a str>,
    legal_actions: Vec<String>,
    hero_policy: Vec<ComboRow>,
    villain_range: Vec<RangeRow>,
}

fn describe(action: Action) -> (String, Option<i32>) {
    match action {
        Action::Fold => ("fold".to_string(), None),
        Action::Check => ("check".to_string(), None),
        Action::Call => ("call".to_string(), None),
        Action::Bet(amount) => ("bet".to_string(), Some(amount)),
        Action::Raise(amount) => ("raise".to_string(), Some(amount)),
        Action::AllIn(amount) => ("all-in".to_string(), Some(amount)),
        other => (format!("{other:?}"), None),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    assert!(args.len() == 4, "usage: acceptance_export BB_RANGE CO_RANGE OUTPUT_JSON");
    let mut oop_source = fs::read_to_string(&args[1]).unwrap();
    assert!(oop_source.contains("QTs:0.0"), "expected source QTs weight to be zero");
    oop_source = oop_source.replace("QTs:0.0", "QTs:1.0");
    let ip_source = fs::read_to_string(&args[2]).unwrap();

    let card_config = CardConfig {
        range: [oop_source.parse().unwrap(), ip_source.parse().unwrap()],
        flop: flop_from_str("Qh8s4s").unwrap(),
        turn: NOT_DEALT,
        river: NOT_DEALT,
    };
    let oop_flop = BetSizeOptions::try_from(("", "37c,54c,72c,a")).unwrap();
    let ip_flop = BetSizeOptions::try_from(("18c", "a")).unwrap();
    let later = BetSizeOptions::try_from(("66%,a", "a")).unwrap();
    let river = BetSizeOptions::try_from(("100%,a", "a")).unwrap();
    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: 55,
        effective_stack: 975,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [oop_flop, ip_flop],
        turn_bet_sizes: [later.clone(), later.clone()],
        river_bet_sizes: [river.clone(), river],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 0.0,
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };

    let tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, tree).unwrap();
    let (_full, compressed) = game.memory_usage();
    eprintln!("allocating {compressed} bytes compressed");
    game.allocate_memory(true);

    let max_iterations = 2_000;
    let target_exploitability = 55.0 * 0.005;
    let mut iterations = 0;
    let mut exploitability = compute_exploitability(&game);
    while iterations < max_iterations && exploitability > target_exploitability {
        solve_step(&game, iterations);
        iterations += 1;
        if iterations % 10 == 0 {
            exploitability = compute_exploitability(&game);
            eprintln!("iteration {iterations}: exploitability {exploitability:.6}");
        }
    }
    if iterations % 10 != 0 {
        exploitability = compute_exploitability(&game);
    }
    finalize(&mut game);

    game.play(0); // OOP check-only root
    let bet_index = game.available_actions().iter().position(|action| *action == Action::Bet(18)).unwrap();
    game.play(bet_index);
    game.cache_normalized_weights();
    let actions = game.available_actions();
    assert_eq!(actions, &[Action::Fold, Action::Call, Action::Raise(55), Action::Raise(72), Action::Raise(90), Action::AllIn(975)]);
    let hero_cards = holes_to_strings(game.private_cards(0)).unwrap();
    let villain_cards = holes_to_strings(game.private_cards(1)).unwrap();
    let hero_weights = game.normalized_weights(0);
    let villain_weights = game.normalized_weights(1);
    let strategy = game.strategy();
    let evs = game.expected_values_detail(0);
    let hand_count = hero_cards.len();

    let hero_policy = hero_cards.iter().enumerate().filter_map(|(hand, cards)| {
        let weight = hero_weights[hand];
        if weight <= 0.0 { return None; }
        let row_actions = actions.iter().enumerate().map(|(action_index, action)| {
            let index = hand + action_index * hand_count;
            let (name, amount) = describe(*action);
            ActionRow { action: name, amount, frequency: strategy[index], ev: evs[index] }
        }).collect();
        Some(ComboRow { cards: cards.clone(), weight, actions: row_actions })
    }).collect::<Vec<_>>();
    assert!(hero_policy.iter().any(|row| row.cards == "QsTs" && row.weight > 0.0), "QsTs has zero reach at target");
    let villain_range = villain_cards.iter().enumerate().filter_map(|(hand, cards)| {
        let weight = villain_weights[hand];
        (weight > 0.0).then(|| RangeRow { cards: cards.clone(), weight })
    }).collect::<Vec<_>>();
    let legal_actions = actions.iter().map(|action| {
        let (name, amount) = describe(*action);
        match amount { Some(value) => format!("{name}:{value}"), None => name }
    }).collect();

    let export = Export {
        solver: "b-inary/postflop-solver",
        solver_commit: "9d1509fe5077d019825f833eed04b16d342dfda1",
        compression: "16-bit integer",
        source_units_per_bb: 10,
        target_exploitability,
        exploitability,
        iterations,
        starting_pot: 55,
        effective_stack: 975,
        board: "Qh8s4s",
        range_note: "TexasSolver v0.2.0 bundled CO-vs-BB ranges; QTs was changed from 0 to 1 in the BB call range solely to support the requested custom postflop node.",
        target_path: vec!["OOP Check", "IP Bet 18"],
        legal_actions,
        hero_policy,
        villain_range,
    };
    fs::write(&args[3], serde_json::to_vec(&export).unwrap()).unwrap();
    eprintln!("wrote {} hero rows and {} villain rows to {}", export.hero_policy.len(), export.villain_range.len(), &args[3]);
}

