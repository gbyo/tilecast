//! The native contribution boundary of Plugin API v2.
//!
//! A first-party native contribution is a Rust type compiled into a Player
//! build. Core owns its registration, service negotiation, state routing,
//! bounded events, lifecycle, and failure isolation. Nothing here names a
//! plugin or a platform: a contribution identifies itself through its
//! descriptor, and Core routes by the plugin, state types, services, and
//! events that descriptor declares.
//!
//! There is no generic invocation channel. A native service is a typed trait
//! (see `native_services.rs`). An event is a declared, versioned, bounded
//! fact (see `plugin_events.rs`). Neither lets one side call a method of the
//! other by name.
use crate::native_services::{NativeServiceSet, NativeServices};
use crate::plugin_events::{
    EventSource, MAX_PENDING_EVENTS, MAX_PENDING_EVENTS_PER_PLUGIN, PluginEvent, PluginEventError, valid_event_name,
};
use crate::plugin_host::{MAX_STATE_ENTRIES, is_plugin_state_entry, validate_plugin_state};
use serde_json::Value;
use std::collections::{BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

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

fn valid_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// One event a contribution takes part in. `source` names the side that
/// raises it: a contribution emits `Native` events and receives `Runtime`
/// events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeEventDeclaration {
    pub name: &'static str,
    pub version: u32,
    pub source: EventSource,
}

/// What a first-party native contribution declares. It must equal the
/// plugin manifest's `player.native` entry and the events of its
/// `player.events`; the plugin's tests check that.
#[derive(Debug, Clone)]
pub struct NativeContributionDescriptor {
    pub plugin: &'static str,
    pub contribution: &'static str,
    /// Accepted `(stateType, stateVersion)` pairs.
    pub state: &'static [(&'static str, u32)],
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
    pub events: &'static [NativeEventDeclaration],
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

/// A contribution refused a call. Core disposes it and keeps it failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct NativePluginError(pub String);

// ------------------------------------------------------------------ events

#[derive(Debug, Default)]
struct EventQueue {
    /// `(contribution key, event)`, oldest first.
    pending: VecDeque<(String, PluginEvent)>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The way a contribution raises events. It is valid only while the
/// contribution is active: after disposal or failure every call is refused
/// and nothing it queued is delivered. It is cheap to clone, so a
/// contribution can give it to a thread that reads a sensor.
#[derive(Debug, Clone)]
pub struct NativeEvents {
    owner: String,
    plugin: &'static str,
    emits: Arc<Vec<(&'static str, u32)>>,
    live: Arc<AtomicBool>,
    queue: Arc<Mutex<EventQueue>>,
}

impl NativeEvents {
    /// Raise a declared `Native` event for the plugin's Shared Runtime part.
    /// The event is queued, never delivered inline, so a slow consumer
    /// cannot block the contribution. A full queue refuses the event; it
    /// never drops an older one.
    pub fn emit(&self, name: &str, version: u32, payload: Value) -> Result<(), PluginEventError> {
        if !self.live.load(Ordering::Acquire) {
            return Err(PluginEventError::Inactive);
        }
        if !self.emits.iter().any(|(declared, declared_version)| *declared == name && *declared_version == version) {
            return Err(PluginEventError::Undeclared);
        }
        let event = PluginEvent::new(self.plugin, name, version, payload)?;
        let mut queue = lock(&self.queue);
        let ours = queue.pending.iter().filter(|(_, queued)| queued.plugin == self.plugin).count();
        if ours >= MAX_PENDING_EVENTS_PER_PLUGIN || queue.pending.len() >= MAX_PENDING_EVENTS {
            return Err(PluginEventError::Full);
        }
        queue.pending.push_back((self.owner.clone(), event));
        Ok(())
    }
}

/// What a contribution receives when it activates: its granted services and
/// its event handle.
#[derive(Debug, Clone)]
pub struct NativeContext {
    services: NativeServiceSet,
    events: NativeEvents,
}

impl NativeContext {
    pub fn services(&self) -> &NativeServiceSet {
        &self.services
    }

    pub fn events(&self) -> &NativeEvents {
        &self.events
    }
}

// ------------------------------------------------------------- contribution

/// A first-party native Player contribution compiled into a Player build.
/// Every hook except `descriptor` is optional. Hooks return errors instead of
/// panicking: release builds abort on panic.
pub trait NativePluginContribution: Send {
    fn descriptor(&self) -> &NativeContributionDescriptor;
    fn activate(&mut self, _context: &NativeContext) -> Result<(), NativePluginError> {
        Ok(())
    }
    fn state_changed(&mut self, _entries: &[NativePluginState]) -> Result<(), NativePluginError> {
        Ok(())
    }
    fn awake_changed(&mut self, _awake: bool) -> Result<(), NativePluginError> {
        Ok(())
    }
    /// An event the plugin's Shared Runtime part raised and this
    /// contribution's descriptor declares.
    fn event(&mut self, _event: &PluginEvent) -> Result<(), NativePluginError> {
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
    context: NativeContext,
    key: String,
    required: Vec<ServiceRef>,
    live: Arc<AtomicBool>,
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
/// contributions its build includes, then forwards each plugins snapshot.
pub struct NativePluginHost {
    services: NativeServices,
    hosted: Vec<Hosted>,
    queue: Arc<Mutex<EventQueue>>,
    awake: bool,
    failures: Vec<String>,
}

impl std::fmt::Debug for NativePluginHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativePluginHost").field("contributions", &self.hosted.len()).finish_non_exhaustive()
    }
}

fn descriptor_valid(descriptor: &NativeContributionDescriptor) -> bool {
    let mut events = BTreeSet::new();
    valid_type(descriptor.plugin)
        && !descriptor.contribution.is_empty()
        && !descriptor.state.is_empty()
        && descriptor.state.iter().all(|(kind, version)| valid_type(kind) && *version > 0)
        && descriptor.required.iter().chain(descriptor.optional).all(|service| ServiceRef::parse(service).is_some())
        && descriptor.events.len() <= 16
        && descriptor.events.iter().all(|event| {
            valid_event_name(event.name)
                && (1..=1000).contains(&event.version)
                && events.insert((event.name, event.version, event.source))
        })
}

impl NativePluginHost {
    pub fn new(
        services: NativeServices,
        contributions: Vec<Box<dyn NativePluginContribution>>,
    ) -> Result<Self, NativeRegistrationError> {
        let queue = Arc::new(Mutex::new(EventQueue::default()));
        let mut seen = BTreeSet::new();
        let mut hosted = Vec::with_capacity(contributions.len());
        for contribution in contributions {
            let descriptor = contribution.descriptor();
            let key = format!("{}/{}", descriptor.plugin, descriptor.contribution);
            if !descriptor_valid(descriptor) {
                return Err(NativeRegistrationError::Descriptor(key));
            }
            if !seen.insert(key.clone()) {
                return Err(NativeRegistrationError::Duplicate(key));
            }
            let requested: Vec<ServiceRef> = descriptor
                .required
                .iter()
                .chain(descriptor.optional)
                .filter_map(|value| ServiceRef::parse(value))
                .collect();
            let required = descriptor.required.iter().filter_map(|value| ServiceRef::parse(value)).collect();
            let live = Arc::new(AtomicBool::new(false));
            let events = NativeEvents {
                owner: key.clone(),
                plugin: descriptor.plugin,
                emits: Arc::new(
                    descriptor
                        .events
                        .iter()
                        .filter(|event| event.source == EventSource::Native)
                        .map(|event| (event.name, event.version))
                        .collect(),
                ),
                live: Arc::clone(&live),
                queue: Arc::clone(&queue),
            };
            let context = NativeContext { services: services.grant(&requested), events };
            hosted.push(Hosted {
                contribution,
                context,
                key,
                required,
                live,
                status: NativePluginStatus::Inactive,
                delivered: Vec::new(),
            });
        }
        Ok(Self { services, hosted, queue, awake: true, failures: Vec::new() })
    }

    /// A host with no contributions and no services.
    pub fn empty() -> Self {
        Self {
            services: NativeServices::new(),
            hosted: Vec::new(),
            queue: Arc::new(Mutex::new(EventQueue::default())),
            awake: true,
            failures: Vec::new(),
        }
    }

    /// Native services this Player reports beside the plugin host. Contributions
    /// are not reported by name: the Server never needs a plugin identity
    /// from a Player to decide what to send.
    pub fn capabilities(&self) -> Vec<(String, u32)> {
        self.services.capabilities()
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
            self.reconcile(index, entries);
        }
    }

    fn reconcile(&mut self, index: usize, entries: Vec<NativePluginState>) {
        let supported = self.hosted[index]
            .required
            .iter()
            .all(|wanted| self.services.has(&format!("{}@{}", wanted.name, wanted.version)));
        let hosted = &mut self.hosted[index];
        if hosted.status == NativePluginStatus::Failed {
            return;
        }
        if entries.is_empty() || !supported {
            if hosted.status == NativePluginStatus::Active {
                Self::retire(&self.queue, hosted);
            }
            hosted.delivered.clear();
            hosted.status =
                if entries.is_empty() { NativePluginStatus::Inactive } else { NativePluginStatus::Unsupported };
            return;
        }
        let mut result = Ok(());
        if hosted.status != NativePluginStatus::Active {
            // Live before activation, so a contribution may start a sensor
            // thread inside `activate`. A failed activation clears it again.
            hosted.live.store(true, Ordering::Release);
            let context = hosted.context.clone();
            result = hosted.contribution.activate(&context);
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

    /// End a contribution's life: refuse its events, drop what it queued,
    /// and let it release what it holds.
    fn retire(queue: &Mutex<EventQueue>, hosted: &mut Hosted) {
        hosted.live.store(false, Ordering::Release);
        lock(queue).pending.retain(|(owner, _)| *owner != hosted.key);
        hosted.contribution.dispose();
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

    /// Deliver an event the plugin's Shared Runtime part raised. Only active
    /// contributions that declare it receive it. Returns how many did.
    /// A contribution that refuses it fails; the others still receive it.
    pub fn deliver_event(&mut self, event: &PluginEvent) -> Result<usize, PluginEventError> {
        let mut declared = false;
        let mut delivered = 0;
        for index in 0..self.hosted.len() {
            let accepts = {
                let descriptor = self.hosted[index].contribution.descriptor();
                descriptor.plugin == event.plugin
                    && descriptor.events.iter().any(|candidate| {
                        candidate.name == event.name
                            && candidate.version == event.version
                            && candidate.source == EventSource::Runtime
                    })
            };
            if !accepts {
                continue;
            }
            declared = true;
            if self.hosted[index].status != NativePluginStatus::Active {
                continue;
            }
            match self.hosted[index].contribution.event(event) {
                Ok(()) => delivered += 1,
                Err(error) => self.fail(index, &error),
            }
        }
        if !declared {
            return Err(PluginEventError::Undeclared);
        }
        if delivered == 0 {
            return Err(PluginEventError::Inactive);
        }
        Ok(delivered)
    }

    /// Events native contributions raised since the last call, oldest
    /// first. A platform forwards each to the Shared Runtime.
    pub fn take_events(&mut self) -> Vec<PluginEvent> {
        lock(&self.queue).pending.drain(..).map(|(_, event)| event).collect()
    }

    fn fail(&mut self, index: usize, error: &NativePluginError) {
        let hosted = &mut self.hosted[index];
        let line = format!("{}: {error}", hosted.key);
        tracing::warn!(component = "plugins", event = "native_contribution_failed", contribution = %line);
        Self::retire(&self.queue, hosted);
        hosted.delivered.clear();
        hosted.status = NativePluginStatus::Failed;
        self.failures.push(line);
    }

    /// `(plugin/contribution, status)` for diagnostics.
    pub fn statuses(&self) -> Vec<(String, NativePluginStatus)> {
        self.hosted.iter().map(|hosted| (hosted.key.clone(), hosted.status)).collect()
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    /// Dispose every active contribution.
    pub fn shutdown(&mut self) {
        for index in 0..self.hosted.len() {
            if self.hosted[index].status == NativePluginStatus::Active {
                Self::retire(&self.queue, &mut self.hosted[index]);
                self.hosted[index].status = NativePluginStatus::Inactive;
                self.hosted[index].delivered.clear();
            }
        }
    }
}

// -------------------------------------------------------------------- feed

/// The thread-safe handle a platform keeps beside its renderer port. It
/// reads what the port already receives (the presentation document and the
/// runtime context) and routes it to the native host, so a platform adds a
/// few calls and no plugin logic.
#[derive(Debug)]
pub struct NativePluginFeed {
    host: Mutex<NativePluginHost>,
}

impl NativePluginFeed {
    pub fn new(host: NativePluginHost) -> Self {
        Self { host: Mutex::new(host) }
    }

    /// A feed with no contributions: a Player build that registers none.
    pub fn empty() -> Self {
        Self::new(NativePluginHost::empty())
    }

    /// The feed for a build's registered contributions. A registration the
    /// host refuses is a build defect: it is logged loudly and the Player
    /// runs without native contributions rather than not at all.
    pub fn registered(services: NativeServices, contributions: Vec<Box<dyn NativePluginContribution>>) -> Self {
        match NativePluginHost::new(services, contributions) {
            Ok(host) => Self::new(host),
            Err(error) => {
                tracing::error!(component = "plugins", event = "native_registration_refused", error = %error);
                Self::empty()
            }
        }
    }

    /// A presentation or status surface was delivered to the renderer.
    /// `document` is the presentation document, `context` its runtime
    /// context. A document in the `sleep` state puts the Player to sleep.
    pub fn activated(&self, document: &Value, context: Option<&Value>, corrected_now_ms: i64) {
        let mut host = lock(&self.host);
        host.set_awake(document.get("state").and_then(Value::as_str) != Some("sleep"));
        Self::route(&mut host, context, corrected_now_ms);
    }

    /// A plugin-only revision reached the renderer; the presentation did not
    /// change.
    pub fn plugins_updated(&self, context: &Value, corrected_now_ms: i64) {
        Self::route(&mut lock(&self.host), Some(context), corrected_now_ms);
    }

    /// The renderer was cleared: no presentation, so no plugin state.
    pub fn cleared(&self) {
        lock(&self.host).route(&[], unix_epoch());
    }

    fn route(host: &mut NativePluginHost, context: Option<&Value>, corrected_now_ms: i64) {
        let plugins: &[Value] =
            context.and_then(|context| context.get("plugins")).and_then(Value::as_array).map_or(&[], Vec::as_slice);
        let now = player_types::Timestamp::from_unix_millis(corrected_now_ms).unwrap_or_else(unix_epoch);
        host.route(plugins, now);
    }

    pub fn capabilities(&self) -> Vec<(String, u32)> {
        lock(&self.host).capabilities()
    }

    pub fn deliver_event(&self, event: &PluginEvent) -> Result<usize, PluginEventError> {
        lock(&self.host).deliver_event(event)
    }

    pub fn take_events(&self) -> Vec<PluginEvent> {
        lock(&self.host).take_events()
    }

    pub fn statuses(&self) -> Vec<(String, NativePluginStatus)> {
        lock(&self.host).statuses()
    }

    pub fn shutdown(&self) {
        lock(&self.host).shutdown();
    }
}

fn unix_epoch() -> player_types::Timestamp {
    player_types::Timestamp::from_unix_seconds(0).expect("the Unix epoch is representable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_services::{ReferenceSignal, ReferenceSignalService};
    use serde_json::json;
    use std::sync::atomic::AtomicU64;

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<String>>>);
    impl Log {
        fn push(&self, line: impl Into<String>) {
            lock(&self.0).push(line.into());
        }
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut lock(&self.0))
        }
    }

    struct Counter(AtomicU64);
    impl ReferenceSignal for Counter {
        fn read(&self) -> u64 {
            self.0.fetch_add(1, Ordering::SeqCst)
        }
    }

    const EVENTS: &[NativeEventDeclaration] = &[
        NativeEventDeclaration { name: "button_pressed", version: 1, source: EventSource::Native },
        NativeEventDeclaration { name: "ring_chime", version: 1, source: EventSource::Runtime },
    ];

    struct Fixture {
        descriptor: NativeContributionDescriptor,
        log: Log,
        fail_on_state: bool,
        fail_on_event: bool,
    }

    impl NativePluginContribution for Fixture {
        fn descriptor(&self) -> &NativeContributionDescriptor {
            &self.descriptor
        }
        fn activate(&mut self, context: &NativeContext) -> Result<(), NativePluginError> {
            let signal = context.services().get::<ReferenceSignalService>().map(|signal| signal.read());
            self.log.push(format!("{} activate signal={signal:?}", self.descriptor.contribution));
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
        fn event(&mut self, event: &PluginEvent) -> Result<(), NativePluginError> {
            self.log.push(format!("{} event {}@{}", self.descriptor.contribution, event.name, event.version));
            if self.fail_on_event { Err(NativePluginError("event refused".into())) } else { Ok(()) }
        }
        fn dispose(&mut self) {
            self.log.push(format!("{} dispose", self.descriptor.contribution));
        }
    }

    fn fixture_for(
        plugin: &'static str,
        contribution: &'static str,
        required: &'static [&'static str],
        log: &Log,
    ) -> Fixture {
        Fixture {
            descriptor: NativeContributionDescriptor {
                plugin,
                contribution,
                state: &[("cast_receiver", 1)],
                required,
                optional: &["player.reference.signal@1"],
                events: EVENTS,
            },
            log: log.clone(),
            fail_on_state: false,
            fail_on_event: false,
        }
    }

    fn fixture(
        contribution: &'static str,
        required: &'static [&'static str],
        log: &Log,
    ) -> Box<dyn NativePluginContribution> {
        Box::new(fixture_for("cast_receiver", contribution, required, log))
    }

    fn entry(plugin: &str, state_type: &str, version: u32, state: Value) -> Value {
        json!({"id": format!("{plugin}-{state_type}-{version}"), "type": "plugin_state", "version": 1,
            "plugin": plugin, "definitionVersion": 1, "stateType": state_type, "stateVersion": version,
            "state": state, "media": []})
    }

    fn now() -> player_types::Timestamp {
        player_types::Timestamp::parse("2026-10-15T12:00:00Z").unwrap()
    }

    fn signal_services() -> NativeServices {
        NativeServices::new().provide::<ReferenceSignalService>(Arc::new(Counter(AtomicU64::new(40))))
    }

    fn state() -> Value {
        entry("cast_receiver", "cast_receiver", 1, json!({}))
    }

    // Registration, negotiation, and routing are generic: the host compares
    // descriptors with entries and services, never a plugin identity.
    #[test]
    fn routes_state_to_registered_contributions_by_declaration() {
        let log = Log::default();
        let mut broken = fixture_for("cast_receiver", "broken", &[], &log);
        broken.fail_on_state = true;
        let mut host = NativePluginHost::new(
            signal_services(),
            vec![
                fixture("receiver", &[], &log),
                fixture("needs-missing", &["player.absent@1"], &log),
                Box::new(broken),
            ],
        )
        .unwrap();
        assert_eq!(host.capabilities(), vec![("player.reference.signal".to_owned(), 1)]);

        host.route(&[json!({"type": "countdown_bar", "version": 1})], now());
        assert!(log.take().is_empty());

        let state = entry("cast_receiver", "cast_receiver", 1, json!({"name": "Lobby"}));
        let other = entry("other_plugin", "cast_receiver", 1, json!({}));
        let undeclared = entry("cast_receiver", "cast_receiver", 2, json!({}));
        host.route(&[state.clone(), other, undeclared], now());
        assert_eq!(
            log.take(),
            vec![
                "receiver activate signal=Some(40)",
                "receiver state 1",
                "broken activate signal=Some(41)",
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
        assert_eq!(log.take(), vec!["receiver activate signal=Some(42)", "receiver awake false", "receiver state 1"]);
        assert_eq!(host.failures().len(), 1);
    }

    #[test]
    fn negotiates_required_and_optional_native_services() {
        let log = Log::default();

        // Required and provided: activates and reads the typed service.
        let mut host =
            NativePluginHost::new(signal_services(), vec![fixture("a", &["player.reference.signal@1"], &log)]).unwrap();
        host.route(&[state()], now());
        assert_eq!(log.take(), vec!["a activate signal=Some(40)", "a state 1"]);

        // Required and not provided: unsupported, never activated.
        let mut host =
            NativePluginHost::new(NativeServices::new(), vec![fixture("a", &["player.reference.signal@1"], &log)])
                .unwrap();
        host.route(&[state()], now());
        assert!(log.take().is_empty());
        assert_eq!(host.statuses()[0].1, NativePluginStatus::Unsupported);
        assert!(host.capabilities().is_empty(), "a Player reports only services it provides");

        // Optional and not provided: activates with the service absent.
        let mut host = NativePluginHost::new(NativeServices::new(), vec![fixture("a", &[], &log)]).unwrap();
        host.route(&[state()], now());
        assert_eq!(log.take(), vec!["a activate signal=None", "a state 1"]);

        // A version newer than the Player provides is unsupported.
        let mut host =
            NativePluginHost::new(signal_services(), vec![fixture("a", &["player.reference.signal@2"], &log)]).unwrap();
        host.route(&[state()], now());
        assert_eq!(host.statuses()[0].1, NativePluginStatus::Unsupported);
    }

    #[test]
    fn events_flow_both_ways_within_declared_bounds() {
        let log = Log::default();
        let mut host = NativePluginHost::new(signal_services(), vec![fixture("input", &[], &log)]).unwrap();
        let runtime_event =
            |name: &str, version| PluginEvent::new("cast_receiver", name, version, json!({"n": 1})).unwrap();

        // Nothing is active: a runtime event has nowhere to go.
        assert_eq!(host.deliver_event(&runtime_event("ring_chime", 1)), Err(PluginEventError::Inactive));
        host.route(&[state()], now());
        log.take();

        // A declared runtime event reaches the active contribution.
        assert_eq!(host.deliver_event(&runtime_event("ring_chime", 1)), Ok(1));
        assert_eq!(log.take(), vec!["input event ring_chime@1"]);
        // Undeclared name, version, source, or plugin: refused, not delivered.
        for event in [
            runtime_event("ring_chime", 2),
            runtime_event("unknown", 1),
            runtime_event("button_pressed", 1), // declared, but a native-sourced event
            PluginEvent::new("other_plugin", "ring_chime", 1, json!({})).unwrap(),
        ] {
            assert_eq!(host.deliver_event(&event), Err(PluginEventError::Undeclared), "{event:?}");
        }
        assert!(log.take().is_empty());

        // The contribution raises a declared native event; the platform takes it.
        let events = host.hosted[0].context.events().clone();
        assert_eq!(events.emit("button_pressed", 1, json!({"pin": 4})), Ok(()));
        assert_eq!(events.emit("button_pressed", 2, json!({})), Err(PluginEventError::Undeclared));
        assert_eq!(events.emit("ring_chime", 1, json!({})), Err(PluginEventError::Undeclared), "wrong source");
        assert_eq!(events.emit("button_pressed", 1, json!([1])), Err(PluginEventError::Payload));
        assert_eq!(
            events.emit("button_pressed", 1, json!({"x": "a".repeat(crate::MAX_EVENT_PAYLOAD_BYTES)})),
            Err(PluginEventError::Payload)
        );
        let taken = host.take_events();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].plugin, "cast_receiver");
        assert_eq!(taken[0].to_message()["type"], "plugin-event");
        assert!(host.take_events().is_empty());

        // The queue is bounded: events past the cap are refused, never evicting older ones.
        for _ in 0..crate::MAX_PENDING_EVENTS_PER_PLUGIN {
            assert_eq!(events.emit("button_pressed", 1, json!({})), Ok(()));
        }
        assert_eq!(events.emit("button_pressed", 1, json!({})), Err(PluginEventError::Full));
        assert_eq!(host.take_events().len(), crate::MAX_PENDING_EVENTS_PER_PLUGIN);
    }

    #[test]
    fn events_end_with_the_contribution() {
        let log = Log::default();
        let mut host = NativePluginHost::new(signal_services(), vec![fixture("input", &[], &log)]).unwrap();
        host.route(&[state()], now());
        let events = host.hosted[0].context.events().clone();
        assert_eq!(events.emit("button_pressed", 1, json!({})), Ok(()));

        // Losing state disposes the contribution: its queued event is dropped
        // and a handle kept by a sensor thread is refused from then on.
        host.route(&[], now());
        assert!(host.take_events().is_empty());
        assert_eq!(events.emit("button_pressed", 1, json!({})), Err(PluginEventError::Inactive));

        // Reactivation makes the same handle live again, as a new life.
        host.route(&[state()], now());
        assert_eq!(events.emit("button_pressed", 1, json!({})), Ok(()));
        host.shutdown();
        assert!(host.take_events().is_empty());
        assert_eq!(events.emit("button_pressed", 1, json!({})), Err(PluginEventError::Inactive));
    }

    #[test]
    fn a_failing_contribution_cannot_affect_another_or_the_queue() {
        let log = Log::default();
        let mut bad = fixture_for("cast_receiver", "bad", &[], &log);
        bad.fail_on_event = true;
        let mut host = NativePluginHost::new(
            signal_services(),
            vec![Box::new(bad), fixture("good", &[], &log), Box::new(fixture_for("second_plugin", "alone", &[], &log))],
        )
        .unwrap();
        host.route(&[state()], now());
        log.take();
        let bad_events = host.hosted[0].context.events().clone();
        assert_eq!(bad_events.emit("button_pressed", 1, json!({})), Ok(()));

        let event = PluginEvent::new("cast_receiver", "ring_chime", 1, json!({})).unwrap();
        assert_eq!(host.deliver_event(&event), Ok(1), "the healthy contribution still receives it");
        assert_eq!(log.take(), vec!["bad event ring_chime@1", "bad dispose", "good event ring_chime@1"]);
        assert_eq!(host.statuses()[0].1, NativePluginStatus::Failed);
        assert_eq!(host.statuses()[1].1, NativePluginStatus::Active);
        assert_eq!(host.statuses()[2].1, NativePluginStatus::Inactive, "another plugin is untouched");
        assert!(host.take_events().is_empty(), "a failed contribution's queued events are dropped");
        assert_eq!(bad_events.emit("button_pressed", 1, json!({})), Err(PluginEventError::Inactive));
        assert_eq!(host.failures(), ["cast_receiver/bad: event refused"]);
    }

    #[test]
    fn refuses_duplicate_or_malformed_registrations() {
        let log = Log::default();
        assert_eq!(
            NativePluginHost::new(NativeServices::new(), vec![fixture("a", &[], &log), fixture("a", &[], &log)])
                .unwrap_err(),
            NativeRegistrationError::Duplicate("cast_receiver/a".into())
        );
        assert!(matches!(
            NativePluginHost::new(NativeServices::new(), vec![fixture("a", &["not a reference"], &log)]),
            Err(NativeRegistrationError::Descriptor(_))
        ));
        const DUPLICATE_EVENTS: &[NativeEventDeclaration] = &[EVENTS[0], EVENTS[0]];
        let mut duplicated = fixture_for("cast_receiver", "a", &[], &log);
        duplicated.descriptor.events = DUPLICATE_EVENTS;
        assert!(matches!(
            NativePluginHost::new(NativeServices::new(), vec![Box::new(duplicated)]),
            Err(NativeRegistrationError::Descriptor(_))
        ));
        const BAD_NAME: &[NativeEventDeclaration] =
            &[NativeEventDeclaration { name: "call.method", version: 1, source: EventSource::Native }];
        let mut method_style = fixture_for("cast_receiver", "b", &[], &log);
        method_style.descriptor.events = BAD_NAME;
        assert!(matches!(
            NativePluginHost::new(NativeServices::new(), vec![Box::new(method_style)]),
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

    #[test]
    fn the_feed_reads_what_a_renderer_port_already_receives() {
        let log = Log::default();
        let feed = NativePluginFeed::new(
            NativePluginHost::new(signal_services(), vec![fixture("receiver", &[], &log)]).unwrap(),
        );
        let context = json!({"plugins": [state()], "clockOffsetMs": 0});
        let now_ms = now().unix_millis();

        feed.activated(&json!({"state": "playing", "items": []}), Some(&context), now_ms);
        assert_eq!(log.take(), vec!["receiver activate signal=Some(40)", "receiver state 1"]);
        // A plugin-only update with the same state is not a change.
        feed.plugins_updated(&context, now_ms);
        assert!(log.take().is_empty());
        // A sleep document puts the Player to sleep without ending the state.
        feed.activated(&json!({"state": "sleep"}), Some(&context), now_ms);
        assert_eq!(log.take(), vec!["receiver awake false"]);
        feed.activated(&json!({"state": "playing"}), Some(&context), now_ms);
        assert_eq!(log.take(), vec!["receiver awake true"]);
        // A status surface carries no context, and a clear carries no state.
        feed.activated(&json!({"state": "pairing"}), None, now_ms);
        assert_eq!(log.take(), vec!["receiver dispose"]);
        feed.activated(&json!({"state": "playing"}), Some(&context), now_ms);
        log.take();
        feed.cleared();
        assert_eq!(log.take(), vec!["receiver dispose"]);
        assert_eq!(feed.capabilities(), vec![("player.reference.signal".to_owned(), 1)]);
        assert!(NativePluginFeed::empty().capabilities().is_empty());
    }

    /// No shared native behavior names a plugin or a platform. The files
    /// that own the boundary are scanned without their test modules.
    #[test]
    fn shared_native_code_names_no_plugin_and_no_platform() {
        let sources = [
            include_str!("native_host.rs"),
            include_str!("native_services.rs"),
            include_str!("plugin_events.rs"),
            include_str!("plugin_host.rs"),
        ];
        let plugins = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../plugins"))
            .expect("plugins directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("tilecast.plugin.json").is_file())
            .map(|entry| entry.file_name().to_string_lossy().replace('-', "_"))
            .collect::<Vec<_>>();
        assert!(!plugins.is_empty());
        let platforms = ["edge", "windows", "android", "electron", "wpe", "webview", "browser", "linux", "macos"];
        for source in sources {
            let code = source.split("#[cfg(test)]").next().unwrap_or(source).to_lowercase();
            for name in plugins.iter().map(String::as_str).chain(platforms) {
                assert!(!code.contains(name), "shared native code names {name}");
            }
        }
    }
}
