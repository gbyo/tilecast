#![allow(clippy::unwrap_used)]
use jiff::Timestamp;
use player_core::{NativeConfiguration, Source, evaluate_active_hours, overrides_activation_gate};
use serde_json::{Value, json};

/// The TypeScript Players (`packages/player-active-hours`) run this same file.
#[test]
fn active_hours_follow_the_shared_cross_player_cases() {
    let document: Value =
        serde_json::from_str(include_str!("../../../packages/settings-schema/active-hours-fixtures.json")).unwrap();
    let cases = document["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "the corpus must cover daylight saving changes");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let configuration =
            NativeConfiguration::parse(&json!({"schemaVersion": 1, "configRevision": 0, "power": case["power"]}))
                .unwrap();
        let now_ms = case["at"].as_str().unwrap().parse::<Timestamp>().unwrap().as_millisecond();
        let result = evaluate_active_hours(configuration.active_hours.as_ref(), now_ms);
        assert_eq!(result.active, case["expected"]["active"].as_bool().unwrap(), "{name}: active");
        assert_eq!(
            result.ms_until_transition,
            case["expected"]["msUntilTransition"].as_i64(),
            "{name}: msUntilTransition"
        );
    }
}

#[test]
fn only_operator_actions_outrank_rest() {
    let document: Value =
        serde_json::from_str(include_str!("../../../packages/settings-schema/active-hours-fixtures.json")).unwrap();
    for (name, source) in [
        ("takeover", Source::Takeover),
        ("quick_present", Source::QuickPresent),
        ("schedule", Source::Schedule),
        ("direct", Source::Direct),
        ("none", Source::None),
    ] {
        assert_eq!(overrides_activation_gate(source), document["overrides"][name].as_bool().unwrap(), "{name}");
    }
}
