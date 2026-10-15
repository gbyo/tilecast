//! Plugin API v2 in Player Core.
//!
//! Core owns three generic things here. It recognizes `plugin_state`
//! entries and validates them as bounded Runtime data. It owns the
//! capability vocabulary a Player reports for the Shared Runtime's Player
//! Plugin Host. And it owns the boundary for first-party native plugin
//! contributions: registration, service negotiation, state routing, and
//! lifecycle.
//!
//! Nothing here names a plugin. A native contribution identifies itself
//! through its descriptor; Core routes state to it by the plugin and state
//! types it declares. There is no generic invocation channel: a native
//! service is a typed trait owned by the contribution that consumes it.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The capability a Player reports when it hosts Plugin API v2.
pub const PLAYER_PLUGIN_HOST_CAPABILITY: &str = "plugin.host";
pub const PLAYER_PLUGIN_HOST_VERSION: u32 = 2;

/// Services the Shared Player Runtime implements. Mirrors
/// `packages/plugin-sdk/player-services.json` (entries with execution
/// `runtime`); a test replays the file.
pub const SHARED_RUNTIME_PLAYER_SERVICES: &[(&str, u32)] =
    &[("player.clock", 1), ("player.media", 1), ("player.presentation.observe", 1), ("player.surface", 1)];

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

// ------------------------------------------------------------ native boundary

/// A `name@version` service reference.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ServiceRef {
    pub name: String,
    pub version: u32,
}

impl ServiceRef {
    pub fn parse(value: &str) -> Option<Self> {
        let (name, version) = value.rsplit_once('@')?;
        let version: u32 = version.parse().ok().filter(|version| *version >= 1)?;
        let segments: Vec<&str> = name.split('.').collect();
        let valid = segments.len() >= 2
            && segments.iter().all(|segment| {
                segment.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                    && segment.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            });
        valid.then(|| Self { name: name.to_owned(), version })
    }
}

/// What a first-party native contribution declares. It must equal the
/// plugin manifest's `player.native` entry; the plugin's tests check that.
#[derive(Debug, Clone)]
pub struct NativeContributionDescriptor {
    pub plugin: &'static str,
    pub contribution: &'static str,
    /// Accepted `(stateType, stateVersion)` pairs.
    pub state: &'static [(&'static str, u32)],
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
}

/// One current state entry, filtered to the contribution's declarations.
#[derive(Debug, Clone, PartialEq)]
pub struct NativePluginState {
    pub id: String,
    pub state_type: String,
    pub state_version: u32,
    pub state: Value,
    pub media: Vec<(uuid::Uuid, uuid::Uuid)>,
}

/// A contribution refused an event. Core disposes it and keeps it failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct NativePluginError(pub String);

/// Which optional services this Player offers right now.
#[derive(Debug, Clone, Default)]
pub struct NativeServiceSet(BTreeMap<String, u32>);

impl NativeServiceSet {
    pub fn has(&self, reference: &str) -> bool {
        ServiceRef::parse(reference)
            .is_some_and(|wanted| self.0.get(&wanted.name).is_some_and(|v| *v >= wanted.version))
    }
}

/// A first-party native Player contribution compiled into a Player build.
/// Every hook except `descriptor` is optional. Hooks return errors instead of
/// panicking: release builds abort on panic.
pub trait NativePluginContribution: Send {
    fn descriptor(&self) -> &NativeContributionDescriptor;
    fn activate(&mut self, _services: &NativeServiceSet) -> Result<(), NativePluginError> {
        Ok(())
    }
    fn state_changed(&mut self, _entries: &[NativePluginState]) -> Result<(), NativePluginError> {
        Ok(())
    }
    fn awake_changed(&mut self, _awake: bool) -> Result<(), NativePluginError> {
        Ok(())
    }
    fn dispose(&mut self) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePluginStatus {
    Inactive,
    Unsupported,
    Active,
    Failed,
}

struct Hosted {
    contribution: Box<dyn NativePluginContribution>,
    status: NativePluginStatus,
    delivered: Vec<NativePluginState>,
}

/// Registration refused at construction: a build defect, reported loudly.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NativeRegistrationError {
    #[error("native contribution {0} is registered twice")]
    Duplicate(String),
    #[error("native contribution {0} has an invalid descriptor")]
    Descriptor(String),
}

/// Hosts the native contributions one Player build registers. A platform
/// constructs it with the native services it implements and the
/// contributions it compiles in, then forwards each plugins snapshot.
pub struct NativePluginHost {
    services: NativeServiceSet,
    hosted: Vec<Hosted>,
    awake: bool,
    failures: Vec<String>,
}

impl std::fmt::Debug for NativePluginHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativePluginHost").field("contributions", &self.hosted.len()).finish_non_exhaustive()
    }
}

impl NativePluginHost {
    pub fn new(
        services: impl IntoIterator<Item = (String, u32)>,
        contributions: Vec<Box<dyn NativePluginContribution>>,
    ) -> Result<Self, NativeRegistrationError> {
        let mut seen = BTreeSet::new();
        let mut hosted = Vec::with_capacity(contributions.len());
        for contribution in contributions {
            let descriptor = contribution.descriptor();
            let key = format!("{}/{}", descriptor.plugin, descriptor.contribution);
            if !valid_type(Some(&Value::from(descriptor.plugin)))
                || descriptor.state.is_empty()
                || descriptor
                    .state
                    .iter()
                    .any(|(kind, version)| !valid_type(Some(&Value::from(*kind))) || *version == 0)
                || descriptor
                    .required
                    .iter()
                    .chain(descriptor.optional)
                    .any(|service| ServiceRef::parse(service).is_none())
            {
                return Err(NativeRegistrationError::Descriptor(key));
            }
            if !seen.insert(key.clone()) {
                return Err(NativeRegistrationError::Duplicate(key));
            }
            hosted.push(Hosted { contribution, status: NativePluginStatus::Inactive, delivered: Vec::new() });
        }
        Ok(Self {
            services: NativeServiceSet(services.into_iter().collect()),
            hosted,
            awake: true,
            failures: Vec::new(),
        })
    }

    /// Native services this Player reports beside the plugin host. Contributions
    /// are not reported by name: the Server never needs a plugin identity
    /// from a Player to decide what to send.
    pub fn capabilities(&self) -> Vec<(String, u32)> {
        self.services.0.iter().map(|(name, version)| (name.clone(), *version)).collect()
    }

    /// Route one complete plugins snapshot. Non-state entries are ignored.
    /// `now` is corrected server time; expired entries are not delivered.
    pub fn route(&mut self, plugins: &[Value], now: player_types::Timestamp) {
        let states: Vec<(String, NativePluginState)> = plugins
            .iter()
            .filter(|plugin| is_plugin_state_entry(plugin))
            .take(MAX_STATE_ENTRIES)
            .filter_map(|plugin| {
                let media = validate_plugin_state(plugin).ok()?;
                let expired = plugin
                    .get("validUntil")
                    .and_then(Value::as_str)
                    .and_then(|deadline| player_types::Timestamp::parse(deadline).ok())
                    .is_some_and(|deadline| deadline <= now);
                if expired {
                    return None;
                }
                Some((
                    plugin.get("plugin")?.as_str()?.to_owned(),
                    NativePluginState {
                        id: plugin.get("id")?.as_str()?.to_owned(),
                        state_type: plugin.get("stateType")?.as_str()?.to_owned(),
                        state_version: u32::try_from(plugin.get("stateVersion")?.as_u64()?).ok()?,
                        state: plugin.get("state")?.clone(),
                        media,
                    },
                ))
            })
            .collect();
        for index in 0..self.hosted.len() {
            let descriptor = self.hosted[index].contribution.descriptor().clone();
            let entries: Vec<NativePluginState> = states
                .iter()
                .filter(|(plugin, state)| {
                    plugin == descriptor.plugin
                        && descriptor
                            .state
                            .iter()
                            .any(|(kind, version)| *kind == state.state_type && *version == state.state_version)
                })
                .map(|(_, state)| state.clone())
                .collect();
            self.reconcile(index, &descriptor, entries);
        }
    }

    fn reconcile(&mut self, index: usize, descriptor: &NativeContributionDescriptor, entries: Vec<NativePluginState>) {
        let supported = descriptor.required.iter().all(|service| self.services.has(service));
        let services = self.services.clone();
        let hosted = &mut self.hosted[index];
        if hosted.status == NativePluginStatus::Failed {
            return;
        }
        if entries.is_empty() || !supported {
            if hosted.status == NativePluginStatus::Active {
                hosted.contribution.dispose();
            }
            hosted.delivered.clear();
            hosted.status =
                if entries.is_empty() { NativePluginStatus::Inactive } else { NativePluginStatus::Unsupported };
            return;
        }
        let mut result = Ok(());
        if hosted.status != NativePluginStatus::Active {
            result = hosted.contribution.activate(&services);
            if result.is_ok() {
                hosted.status = NativePluginStatus::Active;
                if !self.awake {
                    result = hosted.contribution.awake_changed(false);
                }
            }
        }
        if result.is_ok() && hosted.delivered != entries {
            result = hosted.contribution.state_changed(&entries);
            hosted.delivered = entries;
        }
        if let Err(error) = result {
            self.fail(index, &error);
        }
    }

    pub fn set_awake(&mut self, awake: bool) {
        if awake == self.awake {
            return;
        }
        self.awake = awake;
        for index in 0..self.hosted.len() {
            if self.hosted[index].status != NativePluginStatus::Active {
                continue;
            }
            if let Err(error) = self.hosted[index].contribution.awake_changed(awake) {
                self.fail(index, &error);
            }
        }
    }

    fn fail(&mut self, index: usize, error: &NativePluginError) {
        let hosted = &mut self.hosted[index];
        let descriptor = hosted.contribution.descriptor();
        let line = format!("{}/{}: {error}", descriptor.plugin, descriptor.contribution);
        tracing::warn!(component = "plugins", event = "native_contribution_failed", contribution = %line);
        hosted.contribution.dispose();
        hosted.delivered.clear();
        hosted.status = NativePluginStatus::Failed;
        self.failures.push(line);
    }

    /// `(plugin/contribution, status)` for diagnostics.
    pub fn statuses(&self) -> Vec<(String, NativePluginStatus)> {
        self.hosted
            .iter()
            .map(|hosted| {
                let descriptor = hosted.contribution.descriptor();
                (format!("{}/{}", descriptor.plugin, descriptor.contribution), hosted.status)
            })
            .collect()
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    /// Dispose every active contribution.
    pub fn shutdown(&mut self) {
        for hosted in &mut self.hosted {
            if hosted.status == NativePluginStatus::Active {
                hosted.contribution.dispose();
                hosted.status = NativePluginStatus::Inactive;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

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
            .filter(|service| service["execution"] == "runtime")
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

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<String>>>);
    impl Log {
        fn push(&self, line: impl Into<String>) {
            self.0.lock().unwrap().push(line.into());
        }
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut self.0.lock().unwrap())
        }
    }

    struct Fixture {
        descriptor: NativeContributionDescriptor,
        log: Log,
        fail_on_state: bool,
    }

    impl NativePluginContribution for Fixture {
        fn descriptor(&self) -> &NativeContributionDescriptor {
            &self.descriptor
        }
        fn activate(&mut self, services: &NativeServiceSet) -> Result<(), NativePluginError> {
            self.log.push(format!(
                "{} activate optional={}",
                self.descriptor.contribution,
                services.has("test.echo@1")
            ));
            Ok(())
        }
        fn state_changed(&mut self, entries: &[NativePluginState]) -> Result<(), NativePluginError> {
            self.log.push(format!("{} state {}", self.descriptor.contribution, entries.len()));
            if self.fail_on_state { Err(NativePluginError("refused".into())) } else { Ok(()) }
        }
        fn awake_changed(&mut self, awake: bool) -> Result<(), NativePluginError> {
            self.log.push(format!("{} awake {awake}", self.descriptor.contribution));
            Ok(())
        }
        fn dispose(&mut self) {
            self.log.push(format!("{} dispose", self.descriptor.contribution));
        }
    }

    fn fixture(
        contribution: &'static str,
        required: &'static [&'static str],
        log: &Log,
        fail_on_state: bool,
    ) -> Box<dyn NativePluginContribution> {
        Box::new(Fixture {
            descriptor: NativeContributionDescriptor {
                plugin: "cast_receiver",
                contribution,
                state: &[("cast_receiver", 1)],
                required,
                optional: &["test.echo@1"],
            },
            log: log.clone(),
            fail_on_state,
        })
    }

    fn now() -> player_types::Timestamp {
        player_types::Timestamp::parse("2026-10-15T12:00:00Z").unwrap()
    }

    // Registration, negotiation, and routing are generic: the host compares
    // descriptors with entries and services, never a plugin identity.
    #[test]
    fn routes_state_to_registered_contributions_by_declaration() {
        let log = Log::default();
        let mut host = NativePluginHost::new(
            [("test.receiver".to_owned(), 1)],
            vec![
                fixture("receiver", &["test.receiver@1"], &log, false),
                fixture("needs-missing", &["test.absent@1"], &log, false),
                fixture("broken", &[], &log, true),
            ],
        )
        .unwrap();
        assert_eq!(host.capabilities(), vec![("test.receiver".to_owned(), 1)]);

        host.route(&[json!({"type": "countdown_bar", "version": 1})], now());
        assert!(log.take().is_empty());

        let state = entry("cast_receiver", "cast_receiver", 1, json!({"name": "Lobby"}));
        let other = entry("other_plugin", "cast_receiver", 1, json!({}));
        let undeclared = entry("cast_receiver", "cast_receiver", 2, json!({}));
        host.route(&[state.clone(), other, undeclared], now());
        assert_eq!(
            log.take(),
            vec![
                "receiver activate optional=false",
                "receiver state 1",
                "broken activate optional=false",
                "broken state 1",
                "broken dispose",
            ]
        );
        assert_eq!(
            host.statuses(),
            vec![
                ("cast_receiver/receiver".to_owned(), NativePluginStatus::Active),
                ("cast_receiver/needs-missing".to_owned(), NativePluginStatus::Unsupported),
                ("cast_receiver/broken".to_owned(), NativePluginStatus::Failed),
            ]
        );

        // The same snapshot again is not a change; sleep reaches active ones.
        host.route(std::slice::from_ref(&state), now());
        host.set_awake(false);
        assert_eq!(log.take(), vec!["receiver awake false"]);

        // Expired state deactivates; a failed contribution stays failed.
        let mut expired = state.clone();
        expired["validUntil"] = json!("2026-10-15T11:00:00Z");
        host.route(&[expired], now());
        assert_eq!(log.take(), vec!["receiver dispose"]);
        host.route(&[state], now());
        assert_eq!(log.take(), vec!["receiver activate optional=false", "receiver awake false", "receiver state 1"]);
        assert_eq!(host.failures().len(), 1);
    }

    #[test]
    fn refuses_duplicate_or_malformed_registrations() {
        let log = Log::default();
        assert_eq!(
            NativePluginHost::new([], vec![fixture("a", &[], &log, false), fixture("a", &[], &log, false)])
                .unwrap_err(),
            NativeRegistrationError::Duplicate("cast_receiver/a".into())
        );
        assert!(matches!(
            NativePluginHost::new([], vec![fixture("a", &["not a reference"], &log, false)]),
            Err(NativeRegistrationError::Descriptor(_))
        ));
    }

    #[test]
    fn parses_service_references() {
        assert_eq!(
            ServiceRef::parse("player.presentation.observe@1"),
            Some(ServiceRef { name: "player.presentation.observe".into(), version: 1 })
        );
        for bad in ["player.clock", "clock@1", "player.clock@0", "Player.Clock@1"] {
            assert_eq!(ServiceRef::parse(bad), None, "{bad}");
        }
    }
}
