//! Separate installed-release and live-session support; no transport or host names.
use std::collections::{BTreeMap, BTreeSet};

use player_types::bounded::ShortToken;

const MAX_ENTRIES: usize = 256;

/// Existing capability namespaces remain separate even when identifiers overlap.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RendererSupport {
    features: BTreeSet<ShortToken>,
    presentation_schemas: BTreeSet<u32>,
    declarative: BTreeMap<ShortToken, u32>,
    widget_components: BTreeMap<ShortToken, u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RendererProfileError {
    #[error("renderer profile exceeds its bound")]
    TooLarge,
    #[error("renderer profile has a zero version")]
    ZeroVersion,
}

impl RendererSupport {
    /// Construct a checked profile from host-provided facts. An absent namespace
    /// is empty, not inherited from the installed release.
    pub fn new(
        features: BTreeSet<ShortToken>,
        presentation_schemas: BTreeSet<u32>,
        declarative: BTreeMap<ShortToken, u32>,
        widget_components: BTreeMap<ShortToken, u32>,
    ) -> Result<Self, RendererProfileError> {
        if features.len() > MAX_ENTRIES
            || presentation_schemas.len() > MAX_ENTRIES
            || declarative.len() > MAX_ENTRIES
            || widget_components.len() > MAX_ENTRIES
        {
            return Err(RendererProfileError::TooLarge);
        }
        if presentation_schemas.contains(&0)
            || declarative.values().chain(widget_components.values()).any(|version| *version == 0)
        {
            return Err(RendererProfileError::ZeroVersion);
        }
        Ok(Self { features, presentation_schemas, declarative, widget_components })
    }

    pub fn supports_feature(&self, feature: &str) -> bool {
        self.features.iter().any(|entry| entry.as_str() == feature)
    }

    fn supports(&self, requirement: &RendererRequirement) -> bool {
        match requirement {
            RendererRequirement::Feature(name) => self.features.contains(name),
            RendererRequirement::PresentationSchema(version) => self.presentation_schemas.contains(version),
            RendererRequirement::Declarative { name, version } => {
                *version > 0 && self.declarative.get(name).is_some_and(|offered| offered >= version)
            }
            RendererRequirement::WidgetComponent { name, version } => {
                *version > 0 && self.widget_components.get(name).is_some_and(|offered| offered >= version)
            }
        }
    }
}

/// Requirements belong to their existing contract namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererRequirement {
    Feature(ShortToken),
    PresentationSchema(u32),
    Declarative { name: ShortToken, version: u32 },
    WidgetComponent { name: ShortToken, version: u32 },
}

/// Support declared by the installed release, used before preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagedRendererProfile(pub RendererSupport);

/// Support actually advertised by the current connection, used before activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectedRendererProfile(pub RendererSupport);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererProfileMismatch {
    Packaged,
    Connected,
}

impl PackagedRendererProfile {
    pub fn check(&self, requirement: &RendererRequirement) -> Result<(), RendererProfileMismatch> {
        self.0.supports(requirement).then_some(()).ok_or(RendererProfileMismatch::Packaged)
    }

    /// Both checks are required; a live process cannot extend release support,
    /// and release metadata cannot substitute for an actual advertisement.
    pub fn check_connected(
        &self,
        connected: &ConnectedRendererProfile,
        requirement: &RendererRequirement,
    ) -> Result<(), RendererProfileMismatch> {
        self.check(requirement)?;
        connected.check(requirement)
    }
}

impl ConnectedRendererProfile {
    pub fn check(&self, requirement: &RendererRequirement) -> Result<(), RendererProfileMismatch> {
        self.0.supports(requirement).then_some(()).ok_or(RendererProfileMismatch::Connected)
    }

    /// The advertised presentation schemas, ascending. Hosts report
    /// these so the server negotiates only what the live renderer
    /// proved it can show.
    pub fn presentation_schemas(&self) -> Vec<u32> {
        self.0.presentation_schemas.iter().copied().collect()
    }

    /// The advertised declarative capabilities, by name. Hosts merge
    /// these with [`Self::widget_components`] for the heartbeat's
    /// single capability table.
    pub fn declarative_capabilities(&self) -> Vec<(String, u32)> {
        self.0.declarative.iter().map(|(name, version)| (name.as_str().to_owned(), *version)).collect()
    }

    /// The advertised Widget component capabilities, by name.
    pub fn widget_components(&self) -> Vec<(String, u32)> {
        self.0.widget_components.iter().map(|(name, version)| (name.as_str().to_owned(), *version)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name() -> ShortToken {
        ShortToken::new("widget.tilecast.clock").unwrap()
    }

    fn support(version: u32) -> RendererSupport {
        RendererSupport::new(
            BTreeSet::from([ShortToken::new("render-tree-v1").unwrap()]),
            BTreeSet::from([2]),
            BTreeMap::new(),
            BTreeMap::from([(name(), version)]),
        )
        .unwrap()
    }

    #[test]
    fn release_and_session_are_checked_independently() {
        let requirement = RendererRequirement::WidgetComponent { name: name(), version: 2 };
        let packaged = PackagedRendererProfile(support(2));
        let old = ConnectedRendererProfile(support(1));
        assert_eq!(packaged.check_connected(&old, &requirement), Err(RendererProfileMismatch::Connected));
        let current = ConnectedRendererProfile(support(2));
        assert_eq!(packaged.check_connected(&current, &requirement), Ok(()));
        assert_eq!(
            PackagedRendererProfile(support(1)).check_connected(&current, &requirement),
            Err(RendererProfileMismatch::Packaged)
        );
        assert_eq!(
            packaged.check_connected(&ConnectedRendererProfile(RendererSupport::default()), &requirement),
            Err(RendererProfileMismatch::Connected)
        );
    }

    #[test]
    fn namespaces_and_schema_versions_are_not_interchangeable() {
        let packaged = PackagedRendererProfile(support(2));
        assert!(packaged.check(&RendererRequirement::Declarative { name: name(), version: 1 }).is_err());
        assert!(packaged.check(&RendererRequirement::PresentationSchema(1)).is_err());
        assert!(packaged.check(&RendererRequirement::PresentationSchema(2)).is_ok());
        assert!(packaged.check(&RendererRequirement::WidgetComponent { name: name(), version: 0 }).is_err());
    }

    #[test]
    fn bounds_and_zero_versions_are_checked_at_construction() {
        assert_eq!(
            RendererSupport::new(BTreeSet::new(), BTreeSet::from([0]), BTreeMap::new(), BTreeMap::new()),
            Err(RendererProfileError::ZeroVersion)
        );
        assert_eq!(
            RendererSupport::new(BTreeSet::new(), (1..=257).collect(), BTreeMap::new(), BTreeMap::new()),
            Err(RendererProfileError::TooLarge)
        );
    }
}
