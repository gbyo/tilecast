//! Capability registry.
//!
//! Every machine integration contributes capabilities through one
//! [`CapabilityProvider`]. The registry probes providers independently, with
//! a timeout each, and assembles the node's complete capability list. A
//! provider that errors or times out keeps its last known capabilities,
//! marked `degraded` with reason `provider_probe_failed`, instead of silently
//! disappearing or taking another provider down with it.
//!
//! Persisting the snapshot (and bumping its revision only on material
//! change) is `edge_state::repo::capabilities`; reporting it is the daemon's
//! status reporter. Providers only observe.
//!
//! Adding a provider (for example PipeWire, udev, CEC/DDC):
//!
//! 1. implement [`CapabilityProvider`] in `edge-platform::providers` (or in
//!    the crate that owns the subsystem);
//! 2. return only capability IDs under categories in
//!    `edge_protocol::capability::CATEGORIES`, using the constants in
//!    `edge_protocol::capability::ids` where one exists;
//! 3. register it in `tilecastd`'s capability task.
//!
//! Never branch on an OS or platform name elsewhere to decide what a node
//! can do; add or consult a capability instead.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::Timestamp;
use edge_protocol::bounded::ShortToken;
use edge_protocol::capability::{Capability, CapabilityState};

/// Default time a single provider probe may take.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[async_trait]
pub trait CapabilityProvider: Send + Sync + std::fmt::Debug {
    /// Stable provider name (for logs and the `provider` field default).
    fn name(&self) -> &'static str;
    /// Current capabilities. Must be bounded in time and output, must not
    /// block the runtime (use `spawn_blocking` for filesystem-heavy work),
    /// and must never return capabilities owned by another provider.
    async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("capability probe failed: {reason}")]
pub struct ProbeError {
    pub reason: &'static str,
}

#[derive(Debug, Default)]
pub struct CapabilityRegistry {
    providers: Vec<Arc<dyn CapabilityProvider>>,
    last_known: BTreeMap<&'static str, Vec<Capability>>,
    probe_timeout: Option<Duration>,
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = Some(timeout);
        self
    }

    pub fn register(&mut self, provider: Arc<dyn CapabilityProvider>) {
        self.providers.push(provider);
    }

    /// Probes every provider concurrently and returns the combined list,
    /// sorted by capability ID with duplicates from misbehaving providers
    /// dropped (first provider wins).
    pub async fn probe_all(&mut self, now: Timestamp) -> Vec<Capability> {
        let timeout = self.probe_timeout.unwrap_or(PROBE_TIMEOUT);
        let mut tasks = tokio::task::JoinSet::new();
        for provider in &self.providers {
            let provider = Arc::clone(provider);
            tasks.spawn(async move {
                let name = provider.name();
                let result = tokio::time::timeout(timeout, provider.probe(now)).await;
                (name, result)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            let Ok((name, result)) = joined else {
                continue;
            };
            match result {
                Ok(Ok(capabilities)) => {
                    self.last_known.insert(name, capabilities);
                }
                Ok(Err(error)) => {
                    tracing::warn!(component = "capabilities", event = "probe_failed", provider = name, reason = error.reason);
                    self.degrade(name, now);
                }
                Err(_) => {
                    tracing::warn!(component = "capabilities", event = "probe_timeout", provider = name);
                    self.degrade(name, now);
                }
            }
        }
        let mut combined: BTreeMap<String, Capability> = BTreeMap::new();
        for provider in &self.providers {
            for capability in self.last_known.get(provider.name()).into_iter().flatten() {
                combined.entry(capability.id.as_str().to_owned()).or_insert_with(|| capability.clone());
            }
        }
        combined.into_values().collect()
    }

    fn degrade(&mut self, name: &'static str, now: Timestamp) {
        if let Some(previous) = self.last_known.get_mut(name) {
            for capability in previous.iter_mut() {
                if capability.state.is_usable() {
                    capability.state = CapabilityState::Degraded;
                }
                capability.reason_code = ShortToken::new("provider_probe_failed").ok();
                capability.observed_at = now;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use edge_protocol::capability::CapabilityId;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Debug)]
    struct Fixed(&'static str, &'static str, CapabilityState);

    #[async_trait]
    impl CapabilityProvider for Fixed {
        fn name(&self) -> &'static str {
            self.0
        }
        async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError> {
            Ok(vec![Capability::new(CapabilityId::new(self.1).expect("id"), self.2, now)])
        }
    }

    #[derive(Debug)]
    struct Flaky(AtomicBool);

    #[async_trait]
    impl CapabilityProvider for Flaky {
        fn name(&self) -> &'static str {
            "flaky"
        }
        async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError> {
            if self.0.swap(true, Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            Ok(vec![Capability::new(CapabilityId::new("audio.pipewire").expect("id"), CapabilityState::Available, now)])
        }
    }

    #[tokio::test]
    async fn providers_are_isolated_and_failures_degrade() {
        let now = Timestamp::from_unix_seconds(1_000).expect("time");
        let mut registry = CapabilityRegistry::new().with_probe_timeout(Duration::from_millis(100));
        registry.register(Arc::new(Fixed("mesh", "mesh.zenoh", CapabilityState::Available)));
        registry.register(Arc::new(Flaky(AtomicBool::new(false))));
        let first = registry.probe_all(now).await;
        assert_eq!(first.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["audio.pipewire", "mesh.zenoh"]);
        let second = registry.probe_all(now).await;
        let audio = second.iter().find(|c| c.id.as_str() == "audio.pipewire").expect("kept");
        assert_eq!(audio.state, CapabilityState::Degraded);
        assert_eq!(audio.reason_code.as_ref().map(|r| r.as_str()), Some("provider_probe_failed"));
        let mesh = second.iter().find(|c| c.id.as_str() == "mesh.zenoh").expect("unaffected");
        assert_eq!(mesh.state, CapabilityState::Available);
    }
}
