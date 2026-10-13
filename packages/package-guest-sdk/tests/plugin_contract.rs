use serde_json::json;
use tilecast_package_guest::{runtime_state, targets_v2};

#[test]
fn configuration_preserves_explicit_all_and_optimistic_revision() {
    let input = runtime_state::Configure {
        contribution_id: "acme.presence.badge".into(),
        enabled: true,
        configuration: json!({"corner":"bottom-left"}),
        targets: targets_v2::Targets::all(),
        expected_configuration_revision: 8,
    };
    let wire = serde_json::to_value(input).unwrap();
    assert_eq!(wire["expectedConfigurationRevision"], 8);
    assert_eq!(wire["targets"], json!({"mode":"all","screenIds":[],"groupIds":[],"locationIds":[]}));
    assert!(wire.get("executionEpoch").is_none());
}

#[test]
fn private_configuration_and_public_state_decode_independently() {
    let view: runtime_state::View = serde_json::from_value(json!({
        "contributionId":"acme.presence.badge","enabled":true,"configuration":{"personalized":false},
        "configurationRevision":9,"targets":{"mode":"selected","locationIds":["location-1"]},
        "state":{"count":12},"validUntil":"2026-10-13T12:01:15Z","publishedAt":"2026-10-13T12:00:00Z"
    }))
    .unwrap();
    assert_eq!(view.configuration_revision, 9);
    assert_eq!(view.targets.unwrap().location_ids, vec!["location-1"]);
    assert_eq!(view.state, json!({"count":12}));
}

#[test]
fn state_and_target_capability_versions_are_independent() {
    assert_eq!(runtime_state::PUBLISH, "plugin-runtime.state@1/publish");
    assert_eq!(targets_v2::RESOLVE, "targets.resolve@2/resolve");
    assert_eq!(targets_v2::OPTIONS, "targets.resolve@2/options");
}
