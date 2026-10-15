//! Manifest-level proof for the independent plugin-state channel.
use serde_json::Value;

/// Only these transport fields are regenerated when the Server compiles the
/// same presentation. All other fields, including unknown ones, remain part
/// of the equality proof. This does not prove projected presentation equality.
pub fn manifest_without_plugin_revision(document: &Value) -> Value {
    let mut document = document.clone();
    if let Some(object) = document.as_object_mut() {
        for field in ["plugins", "manifestVersion", "generatedAt", "serverTime"] {
            object.remove(field);
        }
    }
    document
}

pub fn is_plugin_only_revision(active: &Value, pending: &Value) -> bool {
    active.is_object()
        && pending.is_object()
        && active.get("plugins").is_some_and(Value::is_array)
        && pending.get("plugins").is_some_and(Value::is_array)
        && active.get("plugins") != pending.get("plugins")
        && manifest_without_plugin_revision(active) == manifest_without_plugin_revision(pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_plugins_and_named_transport_metadata_may_change() {
        let active = json!({"plugins": [], "manifestVersion": 1, "generatedAt": "old", "serverTime": "old",
            "playlist": {"id": "playlist", "items": []}, "layouts": [], "widgets": [], "dataSources": [],
            "syncGroup": {"playbackEpoch": "fixed"}, "futureOption": {"value": true}});
        let mut pending = active.clone();
        pending["plugins"] = json!([{"type": "countdown_bar", "version": 1}]);
        pending["manifestVersion"] = json!(2);
        pending["generatedAt"] = json!("new");
        pending["serverTime"] = json!("new");
        assert!(is_plugin_only_revision(&active, &pending));
        for field in [
            "playlist",
            "layouts",
            "widgets",
            "dataSources",
            "syncGroup",
            "futureOption",
            "schemaVersion",
            "screenId",
            "assets",
            "canvas",
            "viewport",
            "activationGraceSeconds",
            "schedules",
        ] {
            let mut changed = pending.clone();
            changed[field] = json!({"changed": true});
            assert!(!is_plugin_only_revision(&active, &changed), "{field}");
        }
        assert!(!is_plugin_only_revision(&active, &active));
        assert!(!is_plugin_only_revision(&Value::Null, &pending));
        pending["plugins"] = Value::Null;
        assert!(!is_plugin_only_revision(&active, &pending));
    }

    // Plugin API v2 state travels in the same plugins array, so a state-only
    // change is a plugin-only revision: no presentation is activated again.
    #[test]
    fn plugin_api_2_state_changes_are_plugin_only_revisions() {
        let state = |label: &str| {
            json!({"id": "beacon-1", "type": "plugin_state", "version": 1, "plugin": "sample_beacon",
                "definitionVersion": 1, "stateType": "sample_beacon", "stateVersion": 1,
                "state": {"label": label}, "media": []})
        };
        let active = json!({"schemaVersion": 21, "plugins": [state("Lobby")], "manifestVersion": 1,
            "playlist": {"id": "playlist", "items": []}, "syncGroup": {"playbackEpoch": "fixed"}});
        let mut pending = active.clone();
        pending["plugins"] = json!([state("Gym")]);
        pending["manifestVersion"] = json!(2);
        assert!(is_plugin_only_revision(&active, &pending));
        pending["plugins"] = json!([]);
        assert!(is_plugin_only_revision(&active, &pending));
    }
}
