//! Release qualification gates (docs/tilecast-edge-airplay.md section 12).
//!
//! A gate keeps a feature whose code is in the release, and whose probe and
//! diagnostics keep running, from being offered to the Server and Studio until
//! hardware qualification is recorded. Closing a gate changes what Edge
//! *reports as available*. It never changes what the feature does, so
//! qualification runs and automated tests exercise the same code.
//!
//! Release qualification decides when a feature can be offered by default.
//! A feature may still expose an explicit per-screen beta opt-in while its
//! hardware qualification is open.
//!
//! * [`RELEASE_QUALIFIED`] lists features that no longer need a beta opt-in.
//! * `[dev] airplay_qualified = true` in `/etc/tilecast-edge/config.toml`
//!   remains a local qualification/CI override; operators use Studio's beta
//!   switch instead.

/// A feature behind a qualification gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    /// Single-screen AirPlay Present (`external_presentation.airplay`).
    Airplay,
}

/// Features whose hardware qualification this release records. Empty until
/// Stage 6 qualification passes on real hardware.
pub const RELEASE_QUALIFIED: &[Feature] = &[];

/// Whether `feature` is release-qualified, or a local development override
/// opens the release gate. Product beta opt-ins are applied separately.
pub fn is_qualified(feature: Feature, configured: Option<bool>) -> bool {
    configured.unwrap_or(false) || RELEASE_QUALIFIED.contains(&feature)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feature_is_closed_unless_the_release_or_the_screen_opens_it() {
        assert!(!is_qualified(Feature::Airplay, None));
        assert!(!is_qualified(Feature::Airplay, Some(false)));
        assert!(is_qualified(Feature::Airplay, Some(true)));
    }

    #[test]
    fn this_release_has_qualified_nothing_that_hardware_has_not_proven() {
        // Stage 6 qualification adds `Feature::Airplay` here, in the same
        // change that records the hardware evidence.
        assert!(RELEASE_QUALIFIED.is_empty());
    }
}
