//! Plugin API v2 in Player Core.
//!
//! Core owns two generic things here. It recognizes `plugin_state` entries
//! and validates them as bounded Runtime data. And it owns the capability
//! vocabulary a Player reports for the Shared Runtime's Player Plugin Host.
//! The native contribution boundary is in `native_host.rs`.
use serde_json::Value;

/// The capability a Player reports when it hosts Plugin API v2.
pub const PLAYER_PLUGIN_HOST_CAPABILITY: &str = "plugin.host";
pub const PLAYER_PLUGIN_HOST_VERSION: u32 = 2;

/// Services the Shared Player Runtime implements on every host that
/// forwards plugin state. Mirrors `packages/plugin-sdk/player-services.json`
/// (entries with execution `runtime` and no `hostCapability`); a test
/// replays the file. A runtime service that needs host help, such as
/// `player.events`, is reported only by a host that provides that help.
pub const SHARED_RUNTIME_PLAYER_SERVICES: &[(&str, u32)] = &[
    ("player.clock", 1),
    ("player.media", 1),
    ("player.presentation.observe", 1),
    ("player.presentation.provide", 1),
    ("player.surface", 1),
];

/// What a Player whose renderer hosts the Shared Runtime with the v2 plugin
/// host reports, before any native services are added.
pub fn shared_runtime_plugin_capabilities() -> impl Iterator<Item = (&'static str, u32)> {
    std::iter::once((PLAYER_PLUGIN_HOST_CAPABILITY, PLAYER_PLUGIN_HOST_VERSION))
        .chain(SHARED_RUNTIME_PLAYER_SERVICES.iter().copied())
}

pub const PLUGIN_STATE_TYPE: &str = "plugin_state";
const MAX_STATE_BYTES: usize = 16 * 1024;
const MAX_STATE_MEDIA: usize = 16;
/// The `plugins` array limit; state entries never exceed it.
pub(crate) const MAX_STATE_ENTRIES: usize = 64;

/// A Plugin API v2 entry. Like an external entry it is Runtime data: it is
/// never resolved through a renderer feature list.
pub fn is_plugin_state_entry(plugin: &Value) -> bool {
    plugin.get("type").and_then(Value::as_str) == Some(PLUGIN_STATE_TYPE)
        && plugin.get("version").and_then(Value::as_u64) == Some(1)
}

/// Entries a native host passes to the Runtime unchanged, rather than
/// checking them against its renderer feature list. Any `plugin_state`
/// version is routed here; manifest validation refuses versions Core does
/// not know, so they never reach a renderer.
pub fn is_runtime_plugin_data(plugin: &Value) -> bool {
    crate::is_external_runtime_plugin(plugin) || plugin.get("type").and_then(Value::as_str) == Some(PLUGIN_STATE_TYPE)
}

/// The media variants a validated state entry declares. A host grants each
/// one to the Runtime exactly as it grants plugin media today.
pub fn plugin_state_media(plugin: &Value) -> Vec<(uuid::Uuid, uuid::Uuid)> {
    validate_plugin_state(plugin).unwrap_or_default()
}

fn valid_type(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        !text.is_empty()
            && text.len() <= 80
            && text.as_bytes()[0].is_ascii_lowercase()
            && text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn positive(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64).is_some_and(|number| (1..=1_000_000).contains(&number))
}

/// Structural validation of one `plugin_state` entry. Returns its declared
/// media, or `Err` when the entry is malformed. The bounds equal the Server's
/// (`plugin.EncodePlayerState`), so a Server-accepted entry is never refused.
pub(crate) fn validate_plugin_state(plugin: &Value) -> Result<Vec<(uuid::Uuid, uuid::Uuid)>, ()> {
    let object = plugin.as_object().ok_or(())?;
    if !is_plugin_state_entry(plugin)
        || !object.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.len() <= 64)
        || !valid_type(object.get("plugin"))
        || !valid_type(object.get("stateType"))
        || !positive(object.get("definitionVersion"))
        || !positive(object.get("stateVersion"))
    {
        return Err(());
    }
    let state = object.get("state").filter(|state| state.is_object()).ok_or(())?;
    let mut nodes = 0;
    if serde_json::to_vec(state).map_err(|_| ())?.len() > MAX_STATE_BYTES
        || !crate::manifest_resources::bounded_plugin_state(state, 0, &mut nodes)
    {
        return Err(());
    }
    if let Some(deadline) = object.get("validUntil").filter(|value| !value.is_null()) {
        let deadline = deadline.as_str().ok_or(())?;
        if deadline.len() > 64 || player_types::Timestamp::parse(deadline).is_err() {
            return Err(());
        }
    }
    let mut media = Vec::new();
    match object.get("media") {
        None | Some(Value::Null) => {}
        Some(Value::Array(references)) if references.len() <= MAX_STATE_MEDIA => {
            for reference in references {
                let id = |key| {
                    reference
                        .get(key)
                        .and_then(Value::as_str)
                        .and_then(|text| text.parse::<uuid::Uuid>().ok())
                        .ok_or(())
                };
                media.push((id("assetId")?, id("variantId")?));
            }
        }
        Some(_) => return Err(()),
    }
    Ok(media)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CANONICAL: &str = include_str!("../../../packages/plugin-sdk/player-services.json");

    #[test]
    fn mirrors_the_canonical_service_vocabulary() {
        let canonical: Value = serde_json::from_str(CANONICAL).unwrap();
        assert_eq!(canonical["host"]["capability"], PLAYER_PLUGIN_HOST_CAPABILITY);
        assert_eq!(canonical["host"]["version"], PLAYER_PLUGIN_HOST_VERSION);
        let runtime: Vec<(String, u32)> = canonical["services"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|service| service["execution"] == "runtime" && service.get("hostCapability").is_none())
            .map(|service| (service["name"].as_str().unwrap().to_owned(), service["version"].as_u64().unwrap() as u32))
            .collect();
        let mirrored: Vec<(String, u32)> =
            SHARED_RUNTIME_PLAYER_SERVICES.iter().map(|(name, version)| ((*name).to_owned(), *version)).collect();
        assert_eq!(runtime, mirrored);
    }

    fn entry(plugin: &str, state_type: &str, version: u32, state: Value) -> Value {
        json!({"id": format!("{plugin}-{state_type}-{version}"), "type": "plugin_state", "version": 1,
            "plugin": plugin, "definitionVersion": 1, "stateType": state_type, "stateVersion": version,
            "state": state, "media": []})
    }

    #[test]
    fn validates_state_entries_as_bounded_runtime_data() {
        let good = entry("beacon", "beacon", 1, json!({"label": "Lobby"}));
        assert!(is_plugin_state_entry(&good) && is_runtime_plugin_data(&good));
        assert_eq!(validate_plugin_state(&good), Ok(vec![]));
        let asset = uuid::Uuid::new_v4();
        let variant = uuid::Uuid::new_v4();
        let mut with_media = good.clone();
        with_media["media"] = json!([{"assetId": asset, "variantId": variant}]);
        assert_eq!(plugin_state_media(&with_media), vec![(asset, variant)]);

        let mut deep = json!(1);
        for _ in 0..20 {
            deep = json!({ "n": deep });
        }
        for (field, value) in [
            ("state", json!([1])),
            ("state", deep),
            ("state", json!({"x": "a".repeat(MAX_STATE_BYTES)})),
            ("plugin", json!("Bad-Plugin")),
            ("stateVersion", json!(0)),
            ("media", json!([{"assetId": "nope", "variantId": "nope"}])),
            ("validUntil", json!("tomorrow")),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(validate_plugin_state(&bad).is_err(), "{field}");
        }
        // A v1 entry or an unknown future entry version is not v2 state.
        assert!(!is_plugin_state_entry(&json!({"type": "countdown_bar", "version": 1})));
        assert!(!is_plugin_state_entry(&json!({"type": "plugin_state", "version": 2})));
    }

    #[test]
    fn accepts_the_shared_cross_player_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../packages/manifest-schema/plugin-state-entry-fixture.json"))
                .unwrap();
        assert!(is_plugin_state_entry(&fixture) && is_runtime_plugin_data(&fixture));
        assert_eq!(validate_plugin_state(&fixture), Ok(vec![]));
    }
}
