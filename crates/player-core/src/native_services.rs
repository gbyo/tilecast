//! Typed native services for Plugin API v2 native contributions.
//!
//! A native service is a Rust trait that a platform implements and a native
//! contribution consumes. Each service has a marker type that names it and
//! its version and fixes the trait object a contribution receives. There is
//! no string-keyed invocation: a contribution asks for one marker type and
//! gets exactly that trait, or `None`.
//!
//! Adding a service such as `player.display-control@1` is a new marker and a
//! new trait beside this file's reference service. `NativeServices`,
//! `NativeServiceSet`, `NativePluginHost`, and every other service stay as
//! they are, because none of them interprets a service beyond its name and
//! version.
use std::any::Any;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Names one native service, its version, and the trait object that a
/// contribution receives. A Player that provides version N provides every
/// version from 1 to N.
pub trait NativeServiceKind: 'static {
    const NAME: &'static str;
    const VERSION: u32;
    type Api: ?Sized + Send + Sync + 'static;
}

type Handle = Arc<dyn Any + Send + Sync>;

fn handle<K: NativeServiceKind>(api: Arc<K::Api>) -> Handle {
    Arc::new(api)
}

/// The native services one Player build provides. A platform builds it once
/// and gives it to `NativePluginHost::new`. What it contains is exactly what
/// the Player reports as native service capabilities.
#[derive(Clone, Default)]
pub struct NativeServices {
    entries: BTreeMap<&'static str, (u32, Handle)>,
}

impl std::fmt::Debug for NativeServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.capabilities()).finish()
    }
}

impl NativeServices {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer one service. A second provider of the same name replaces the
    /// first.
    #[must_use]
    pub fn provide<K: NativeServiceKind>(mut self, api: Arc<K::Api>) -> Self {
        self.entries.insert(K::NAME, (K::VERSION, handle::<K>(api)));
        self
    }

    /// `(name, highest version)` for each service, in name order. This is
    /// what the Player adds to its heartbeat capabilities.
    pub fn capabilities(&self) -> Vec<(String, u32)> {
        self.entries.iter().map(|(name, (version, _))| ((*name).to_owned(), *version)).collect()
    }

    /// The services a contribution asked for and this Player can satisfy.
    /// Nothing else is visible to it.
    pub(crate) fn grant(&self, references: &[crate::ServiceRef]) -> NativeServiceSet {
        let entries = references
            .iter()
            .filter_map(|wanted| {
                let (version, handle) = self.entries.get(wanted.name.as_str())?;
                (*version >= wanted.version).then(|| (wanted.name.clone(), (*version, Arc::clone(handle))))
            })
            .collect();
        NativeServiceSet { entries }
    }

    pub(crate) fn has(&self, reference: &str) -> bool {
        crate::ServiceRef::parse(reference)
            .is_some_and(|wanted| self.entries.get(wanted.name.as_str()).is_some_and(|(v, _)| *v >= wanted.version))
    }
}

/// The services one contribution may use: the ones its descriptor names and
/// the Player provides.
#[derive(Clone, Default)]
pub struct NativeServiceSet {
    entries: BTreeMap<String, (u32, Handle)>,
}

impl std::fmt::Debug for NativeServiceSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.entries.iter().map(|(name, (version, _))| format!("{name}@{version}"))).finish()
    }
}

impl NativeServiceSet {
    /// Whether `name@version` is provided, for example `player.clock@1`.
    pub fn has(&self, reference: &str) -> bool {
        crate::ServiceRef::parse(reference)
            .is_some_and(|wanted| self.entries.get(&wanted.name).is_some_and(|(v, _)| *v >= wanted.version))
    }

    /// The typed service, or `None` when the contribution did not request it
    /// or the Player does not provide it.
    pub fn get<K: NativeServiceKind>(&self) -> Option<Arc<K::Api>> {
        let (version, handle) = self.entries.get(K::NAME)?;
        if *version < K::VERSION {
            return None;
        }
        handle.downcast_ref::<Arc<K::Api>>().cloned()
    }
}

// --------------------------------------------------------- reference service

/// A counter the platform owns, read as one number. It exists to qualify the
/// native service model end to end, and no product Player provides it.
pub trait ReferenceSignal: Send + Sync {
    fn read(&self) -> u64;
}

/// `player.reference.signal@1`.
#[derive(Debug, Clone, Copy)]
pub struct ReferenceSignalService;

impl NativeServiceKind for ReferenceSignalService {
    const NAME: &'static str = "player.reference.signal";
    const VERSION: u32 = 1;
    type Api = dyn ReferenceSignal;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServiceRef;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Counter(AtomicU64);
    impl ReferenceSignal for Counter {
        fn read(&self) -> u64 {
            self.0.fetch_add(1, Ordering::SeqCst)
        }
    }

    /// A second service proves that adding one changes no existing type.
    trait Another: Send + Sync {
        fn label(&self) -> &'static str;
    }
    struct AnotherService;
    impl NativeServiceKind for AnotherService {
        const NAME: &'static str = "player.another";
        const VERSION: u32 = 2;
        type Api = dyn Another;
    }
    struct Fixed;
    impl Another for Fixed {
        fn label(&self) -> &'static str {
            "fixed"
        }
    }

    fn refs(values: &[&str]) -> Vec<ServiceRef> {
        values.iter().map(|value| ServiceRef::parse(value).unwrap()).collect()
    }

    #[test]
    fn a_contribution_sees_only_what_it_requested_and_the_player_provides() {
        let services = NativeServices::new()
            .provide::<ReferenceSignalService>(Arc::new(Counter(AtomicU64::new(7))))
            .provide::<AnotherService>(Arc::new(Fixed));
        assert_eq!(
            services.capabilities(),
            vec![("player.another".to_owned(), 2), ("player.reference.signal".to_owned(), 1)]
        );

        let granted = services.grant(&refs(&["player.reference.signal@1", "player.absent@1"]));
        assert!(granted.has("player.reference.signal@1"));
        assert!(!granted.has("player.another@1"), "not requested, so not visible");
        assert_eq!(granted.get::<ReferenceSignalService>().expect("requested").read(), 7);
        assert!(granted.get::<AnotherService>().is_none());

        // A request for a higher version than the Player offers is not granted.
        assert!(services.grant(&refs(&["player.another@3"])).get::<AnotherService>().is_none());
        // A lower request is satisfied by a higher provided version.
        assert_eq!(services.grant(&refs(&["player.another@1"])).get::<AnotherService>().unwrap().label(), "fixed");
    }

    #[test]
    fn the_reference_marker_matches_the_canonical_vocabulary() {
        let canonical: Value =
            serde_json::from_str(include_str!("../../../packages/plugin-sdk/player-services.json")).unwrap();
        let entry = canonical["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|service| service["name"] == ReferenceSignalService::NAME)
            .expect("vocabulary entry");
        assert_eq!(entry["version"], ReferenceSignalService::VERSION);
        assert_eq!(entry["execution"], "native");
    }
}
