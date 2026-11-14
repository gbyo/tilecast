//! Release qualification gates (docs/tilecast-edge-airplay.md section 12).
//!
//! A gate keeps a feature whose code is in the release, and whose probe and
//! diagnostics keep running, from being offered to the Server and Studio until
//! hardware qualification is recorded. Closing a gate changes what Edge
//! *reports as available*. It never changes what the feature does, so
//! qualification runs and automated tests exercise the same code.
//!
//! One decision per feature, in the release's source, never from the Server:
//!
//! * [`RELEASE_QUALIFIED`] lists the features this release has qualified. A
//!   feature is added by the change that records its hardware qualification,
//!   and the gate is removed with it.
//! * `[dev] airplay_qualified = true` in `/etc/tilecast-edge/config.toml`
//!   opens one gate on one screen. It exists for the qualification run
//!   itself and for CI, and it is inert unless set.

/// A feature behind a qualification gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    /// Single-screen AirPlay Present (`external_presentation.airplay`).
    Airplay,
}

/// Features whose hardware qualification this release records. Empty until
/// Stage 6 qualification passes on real hardware.
pub const RELEASE_QUALIFIED: &[Feature] = &[];

/// Whether `feature` may be offered: the release qualified it, or this screen's
/// development configuration opened its gate.
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
