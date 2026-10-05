//! Android player-configuration projection and installation.
//!
//! Core owns acceptance: [`player_core::NativeConfiguration`] validates the
//! envelope and native policy, and [`player_core::ConfigurationCoordinator`]
//! enforces strictly increasing revisions with the last accepted document
//! staying in force. This module owns the Android projections Core cannot:
//! the Runtime values the shared Player Runtime consumes through the
//! WebView bridge, and the platform values Kotlin applies (reliability,
//! power, managed kiosk, accessibility, updates, downloads).
//!
//! Structure is strict and values are lenient, the way the reference
//! player reads them: a section that is present but not an object refuses
//! the whole document, while a value of the wrong type falls back to that
//! setting's default. This intentionally differs from the legacy Kotlin
//! validator, which rejected the entire document over one field and could
//! darken a screen over a value an older or newer server sent.
//!
//! [`AndroidConfigHost::install_configuration`] persists the installed
//! projection to `installed-config.json` (atomic replace, no secrets: the
//! document carries no credentials), narrows the content-store policy, and
//! publishes the effective configuration for status, heartbeat, and the
//! future server-link driver.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use player_cas::{ContentStore, StorePolicy};
use player_core::{ConfigurationError as ConfigError, ConfigurationHost, NativeConfiguration};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::host::{CAS_LIMIT_BYTES, CAS_RESERVED_FREE_BYTES};

/// Sections the server may send. Matches the Edge host list: sections
/// Android does not project (`linuxKiosk`, `presentationNetwork`) are
/// still validated as objects and ignored.
const SECTIONS: &[&str] = &[
    "branding",
    "playback",
    "cache",
    "sync",
    "website",
    "reliability",
    "power",
    "managedKiosk",
    "linuxKiosk",
    "accessibility",
    "updates",
    "presentationNetwork",
];

pub const DEFAULT_BACKGROUND: &str = "#0E141B";
pub const DEFAULT_TEXT: &str = "#F5F7FA";
/// Where playback projection data for the runtime is bounded.
pub const MAX_PLAYBACK_CONTEXT_BYTES: usize = 16 * 1024;
/// Bound on the accessibility allow-list: entries, then characters each.
pub const MAX_ALLOWED_PACKAGES: usize = 64;
pub const MAX_PACKAGE_CHARS: usize = 256;

fn section<'a>(document: &'a Map<String, Value>, name: &str) -> Option<&'a Map<String, Value>> {
    document.get(name).and_then(Value::as_object)
}

fn text(values: Option<&Map<String, Value>>, key: &str, max_chars: usize) -> Option<String> {
    let value = values?.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.chars().filter(|c| !c.is_control()).take(max_chars).collect())
}

fn color(values: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    let value = values?.get(key)?.as_str()?;
    let bytes = value.as_bytes();
    (bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)).then(|| value.to_owned())
}

fn number(values: Option<&Map<String, Value>>, key: &str) -> Option<f64> {
    values?.get(key)?.as_f64().filter(|value| value.is_finite())
}

/// A boolean that defaults to true unless explicitly set to false.
fn flag_on(values: Option<&Map<String, Value>>, key: &str) -> bool {
    values.and_then(|values| values.get(key)).is_none_or(|value| value.as_bool() != Some(false))
}

/// A boolean that defaults to false unless explicitly set to true.
fn flag_off(values: Option<&Map<String, Value>>, key: &str) -> bool {
    values.and_then(|values| values.get(key)).and_then(Value::as_bool) == Some(true)
}

fn count(values: Option<&Map<String, Value>>, key: &str, min: f64, max: f64, default: u64) -> u64 {
    number(values, key).filter(|value| *value >= min && *value <= max).map_or(default, |value| value as u64)
}

fn token(values: Option<&Map<String, Value>>, key: &str, allowed: &[&str]) -> Option<String> {
    text(values, key, 32).filter(|value| allowed.contains(&value.as_str()))
}

fn bounded_list(values: Option<&Map<String, Value>>, key: &str) -> Vec<String> {
    values
        .and_then(|values| values.get(key))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = item.as_str()?.trim();
                    (!text.is_empty())
                        .then(|| text.chars().filter(|c| !c.is_control()).take(MAX_PACKAGE_CHARS).collect())
                })
                .take(MAX_ALLOWED_PACKAGES)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branding {
    pub organization_name: String,
    pub logo_asset_id: Option<String>,
    pub background_color: Option<String>,
    pub text_color: Option<String>,
    pub no_content_title: Option<String>,
    pub no_content_message: Option<String>,
    pub disabled_title: Option<String>,
    pub disabled_message: Option<String>,
    pub footer_text: Option<String>,
}

impl Default for Branding {
    fn default() -> Self {
        Self {
            organization_name: "Tilecast".to_owned(),
            logo_asset_id: None,
            background_color: None,
            text_color: None,
            no_content_title: None,
            no_content_message: None,
            disabled_title: None,
            disabled_message: None,
            footer_text: None,
        }
    }
}

impl Branding {
    pub fn background(&self) -> &str {
        self.background_color.as_deref().unwrap_or(DEFAULT_BACKGROUND)
    }

    pub fn text(&self) -> &str {
        self.text_color.as_deref().unwrap_or(DEFAULT_TEXT)
    }
}

/// Playback defaults (`resolvePlaybackItemSettings` in the shared runtime's
/// projection code).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub default_volume: f64,
    pub default_fit_mode: Option<String>,
    pub default_image_duration_ms: u64,
    pub default_transition: Option<String>,
    pub default_audio_enabled: bool,
    pub resume_after_restart: bool,
    pub identify_shows_location: bool,
    pub screen_location: String,
    /// The section as sent, for the runtime's layout and widget projection
    /// (regional formatting, layout playlist-zone defaults).
    pub context: Map<String, Value>,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            default_volume: 0.5,
            default_fit_mode: None,
            default_image_duration_ms: 10_000,
            default_transition: None,
            default_audio_enabled: true,
            resume_after_restart: true,
            identify_shows_location: true,
            screen_location: String::new(),
            context: Map::new(),
        }
    }
}

/// The `website` section: player-wide Website defaults and overrides, read
/// as the reference player reads them, plus the Android WebView bridge
/// values the legacy player applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Website {
    /// Overrides a Website's own load timeout.
    pub timeout_seconds: Option<u64>,
    /// Applies when a Website has no zoom of its own.
    pub default_zoom_percent: Option<u64>,
    /// Overrides a Website's own cookie policy.
    pub cookie_policy: Option<String>,
    /// Applies when a Website has no failure behavior of its own.
    pub default_failure_behavior: Option<String>,
    /// Clear remote website data when the player starts.
    pub clear_on_restart: bool,
    pub default_javascript: bool,
    pub default_dom_storage: bool,
    pub default_timeout_seconds: u64,
    pub default_cookie_policy: String,
    pub default_reload_policy: String,
    pub minimum_refresh_seconds: u64,
    pub default_fallback_image_id: String,
}

impl Default for Website {
    fn default() -> Self {
        Self {
            timeout_seconds: None,
            default_zoom_percent: None,
            cookie_policy: None,
            default_failure_behavior: None,
            clear_on_restart: false,
            default_javascript: true,
            default_dom_storage: true,
            default_timeout_seconds: 20,
            default_cookie_policy: "first_party".to_owned(),
            default_reload_policy: "on_each_activation".to_owned(),
            minimum_refresh_seconds: 30,
            default_fallback_image_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerDisplay {
    pub outside_display: String,
    pub outside_text: String,
}

/// Values used by the Runtime projection. Core does not interpret these fields.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProjection {
    pub branding: Branding,
    pub playback: Playback,
    pub power: PowerDisplay,
    pub website: Website,
}

impl Default for RuntimeProjection {
    fn default() -> Self {
        Self {
            branding: Branding::default(),
            playback: Playback::default(),
            power: PowerDisplay { outside_display: "black".to_owned(), outside_text: "Powered by Tilecast".to_owned() },
            website: Website::default(),
        }
    }
}

/// The Android-owned `reliability` values. Stall policy, the recovery
/// ladder, and safe mode are native and live in [`NativeConfiguration`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReliabilityAndroid {
    pub mode: String,
    pub launch_after_boot: bool,
    pub immersive_mode: bool,
    pub foreground_watchdog_enabled: bool,
    pub webview_stall_seconds: u64,
}

impl Default for ReliabilityAndroid {
    fn default() -> Self {
        Self {
            mode: "standard".to_owned(),
            launch_after_boot: true,
            immersive_mode: true,
            foreground_watchdog_enabled: true,
            webview_stall_seconds: 45,
        }
    }
}

/// The Android-owned `power` values. Active hours are native and live in
/// [`NativeConfiguration`]; the outside-hours display is Runtime-owned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerAndroid {
    pub keep_screen_on: bool,
    pub sleep_outside_active_hours: bool,
    pub startup_grace_seconds: u64,
    pub shutdown_prepare_seconds: u64,
}

impl Default for PowerAndroid {
    fn default() -> Self {
        Self {
            keep_screen_on: true,
            sleep_outside_active_hours: false,
            startup_grace_seconds: 30,
            shutdown_prepare_seconds: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedKiosk {
    pub lock_task_enabled: bool,
    pub block_overlays: bool,
    pub allow_settings_during_admin: bool,
    pub admin_session_minutes: u64,
}

impl Default for ManagedKiosk {
    fn default() -> Self {
        Self {
            lock_task_enabled: false,
            block_overlays: true,
            allow_settings_during_admin: true,
            admin_session_minutes: 15,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accessibility {
    pub control_assist_enabled: bool,
    pub return_delay_seconds: u64,
    pub allowed_packages: Vec<String>,
    pub pause_during_updates: bool,
    pub pause_during_admin_session: bool,
    pub report_foreground_package: bool,
    pub maximum_returns: u64,
    pub return_window_minutes: u64,
}

impl Default for Accessibility {
    fn default() -> Self {
        Self {
            control_assist_enabled: true,
            return_delay_seconds: 10,
            allowed_packages: Vec::new(),
            pause_during_updates: true,
            pause_during_admin_session: true,
            report_foreground_package: false,
            maximum_returns: 3,
            return_window_minutes: 10,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updates {
    pub channel: String,
}

impl Default for Updates {
    fn default() -> Self {
        Self { channel: "stable".to_owned() }
    }
}

/// The Android-owned `cache` values. Byte budgets are native and live in
/// [`NativeConfiguration`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloads {
    pub concurrent_downloads: u64,
    pub automatic_threshold_bytes: u64,
}

impl Default for Downloads {
    fn default() -> Self {
        Self { concurrent_downloads: 2, automatic_threshold_bytes: 256 * 1024 * 1024 }
    }
}

/// Configuration applied by the Android platform (Kotlin).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPlatform {
    pub reliability: ReliabilityAndroid,
    pub power: PowerAndroid,
    pub managed_kiosk: ManagedKiosk,
    pub accessibility: Accessibility,
    pub updates: Updates,
    pub downloads: Downloads,
}

/// Accepted configuration split by its behavioral owner.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AndroidPlayerConfig {
    pub native: NativeConfiguration,
    pub runtime: RuntimeProjection,
    pub platform: AndroidPlatform,
}

impl AndroidPlayerConfig {
    /// Validates a document from the server or from local state.
    pub fn parse(document: &Value) -> Result<Self, ConfigError> {
        let native = NativeConfiguration::parse(document)?;
        Self::project(document, native)
    }

    /// Projects Runtime and Android platform values after Core validates
    /// native policy. Unknown sections and fields pass through untouched:
    /// the playback context keeps them for the Runtime, so a newer server
    /// never breaks an older player over an unknown option.
    pub fn project(document: &Value, native: NativeConfiguration) -> Result<Self, ConfigError> {
        let object = document.as_object().ok_or(ConfigError::NotObject)?;
        for name in SECTIONS {
            if object.get(*name).is_some_and(|value| !value.is_object() && !value.is_null()) {
                return Err(ConfigError::InvalidSection);
            }
        }

        let branding_values = section(object, "branding");
        let branding_defaults = Branding::default();
        let branding = Branding {
            organization_name: text(branding_values, "organizationName", 120)
                .unwrap_or(branding_defaults.organization_name),
            logo_asset_id: text(branding_values, "logoAssetId", 64),
            background_color: color(branding_values, "backgroundColor"),
            text_color: color(branding_values, "textColor"),
            no_content_title: text(branding_values, "noContentTitle", 120),
            no_content_message: text(branding_values, "noContentMessage", 480),
            disabled_title: text(branding_values, "disabledTitle", 120),
            disabled_message: text(branding_values, "disabledMessage", 480),
            footer_text: text(branding_values, "footerText", 240),
        };

        let playback_values = section(object, "playback");
        let playback_defaults = Playback::default();
        let mut context = playback_values.cloned().unwrap_or_default();
        if serde_json::to_vec(&context).map_or(true, |encoded| encoded.len() > MAX_PLAYBACK_CONTEXT_BYTES) {
            context = Map::new();
        }
        let playback = Playback {
            default_volume: number(playback_values, "defaultVolume")
                .map_or(playback_defaults.default_volume, |volume| volume.clamp(0.0, 1.0)),
            default_fit_mode: text(playback_values, "defaultFitMode", 16),
            default_image_duration_ms: number(playback_values, "defaultImageDurationSeconds")
                .filter(|seconds| *seconds >= 0.0 && *seconds <= 86_400.0)
                .map_or(playback_defaults.default_image_duration_ms, |seconds| (seconds * 1_000.0) as u64),
            default_transition: text(playback_values, "defaultTransition", 16),
            default_audio_enabled: flag_on(playback_values, "defaultAudioEnabled"),
            resume_after_restart: flag_on(playback_values, "resumeAfterRestart"),
            identify_shows_location: flag_on(playback_values, "identifyShowsLocation"),
            screen_location: text(playback_values, "screenLocation", 240).unwrap_or_default(),
            context,
        };

        let power_values = section(object, "power");
        let outside_display = match text(power_values, "outsideActiveHoursDisplay", 32).as_deref() {
            Some(mode @ ("bouncing_logo" | "custom_text")) => mode.to_owned(),
            _ => "black".to_owned(),
        };
        let outside_text = text(power_values, "outsideActiveHoursText", 240)
            .or_else(|| branding.footer_text.clone())
            .unwrap_or_else(|| "Powered by Tilecast".to_owned());

        let website_values = section(object, "website");
        let website_defaults = Website::default();
        let website = Website {
            timeout_seconds: number(website_values, "timeoutSeconds")
                .filter(|seconds| *seconds >= 1.0 && *seconds <= 600.0)
                .map(|seconds| seconds as u64),
            default_zoom_percent: number(website_values, "defaultZoomPercent")
                .filter(|percent| *percent >= 25.0 && *percent <= 500.0)
                .map(|percent| percent as u64),
            cookie_policy: token(website_values, "cookiePolicy", &["disabled", "first_party", "first_and_third_party"]),
            default_failure_behavior: token(
                website_values,
                "defaultFailureBehavior",
                &["placeholder", "fallback_image", "skip", "last_success"],
            ),
            clear_on_restart: flag_off(website_values, "clearOnRestart"),
            default_javascript: flag_on(website_values, "defaultJavascript"),
            default_dom_storage: flag_on(website_values, "defaultDomStorage"),
            default_timeout_seconds: count(website_values, "defaultTimeoutSeconds", 1.0, 120.0, 20),
            default_cookie_policy: token(
                website_values,
                "defaultCookiePolicy",
                &["disabled", "first_party", "first_and_third_party"],
            )
            .unwrap_or(website_defaults.default_cookie_policy),
            default_reload_policy: token(
                website_values,
                "defaultReloadPolicy",
                &["load_once", "on_each_activation", "interval"],
            )
            .unwrap_or(website_defaults.default_reload_policy),
            minimum_refresh_seconds: count(website_values, "minimumRefreshSeconds", 30.0, 86_400.0, 30),
            default_fallback_image_id: text(website_values, "defaultFallbackImageId", 64).unwrap_or_default(),
        };

        let reliability_values = section(object, "reliability");
        let reliability_defaults = ReliabilityAndroid::default();
        let reliability = ReliabilityAndroid {
            mode: token(reliability_values, "mode", &["standard", "managed_kiosk"])
                .unwrap_or(reliability_defaults.mode),
            launch_after_boot: flag_on(reliability_values, "launchAfterBoot"),
            immersive_mode: flag_on(reliability_values, "immersiveMode"),
            foreground_watchdog_enabled: flag_on(reliability_values, "foregroundWatchdogEnabled"),
            webview_stall_seconds: count(reliability_values, "webviewStallSeconds", 15.0, 600.0, 45),
        };

        let power_defaults = PowerAndroid::default();
        let power = PowerAndroid {
            keep_screen_on: flag_on(power_values, "keepScreenOn"),
            sleep_outside_active_hours: flag_off(power_values, "sleepOutsideActiveHours"),
            startup_grace_seconds: count(
                power_values,
                "startupGraceSeconds",
                0.0,
                3_600.0,
                power_defaults.startup_grace_seconds,
            ),
            shutdown_prepare_seconds: count(
                power_values,
                "shutdownPrepareSeconds",
                0.0,
                3_600.0,
                power_defaults.shutdown_prepare_seconds,
            ),
        };

        let kiosk_values = section(object, "managedKiosk");
        let kiosk_defaults = ManagedKiosk::default();
        let managed_kiosk = ManagedKiosk {
            lock_task_enabled: flag_off(kiosk_values, "lockTaskEnabled"),
            block_overlays: flag_on(kiosk_values, "blockOverlays"),
            allow_settings_during_admin: flag_on(kiosk_values, "allowSettingsDuringAdmin"),
            admin_session_minutes: count(
                kiosk_values,
                "adminSessionMinutes",
                0.0,
                1_440.0,
                kiosk_defaults.admin_session_minutes,
            ),
        };

        let accessibility_values = section(object, "accessibility");
        let accessibility = Accessibility {
            control_assist_enabled: flag_on(accessibility_values, "controlAssistEnabled"),
            return_delay_seconds: count(accessibility_values, "returnDelaySeconds", 3.0, 300.0, 10),
            allowed_packages: bounded_list(accessibility_values, "allowedPackages"),
            pause_during_updates: flag_on(accessibility_values, "pauseDuringUpdates"),
            pause_during_admin_session: flag_on(accessibility_values, "pauseDuringAdminSession"),
            report_foreground_package: flag_off(accessibility_values, "reportForegroundPackage"),
            maximum_returns: count(accessibility_values, "maximumReturns", 1.0, 20.0, 3),
            return_window_minutes: count(accessibility_values, "returnWindowMinutes", 1.0, 120.0, 10),
        };

        let updates_values = section(object, "updates");
        let updates = Updates {
            channel: token(updates_values, "channel", &["stable", "beta"])
                .unwrap_or_else(|| Updates::default().channel),
        };

        let cache_values = section(object, "cache");
        let downloads_defaults = Downloads::default();
        let downloads = Downloads {
            concurrent_downloads: count(cache_values, "concurrentDownloads", 1.0, 8.0, 2),
            automatic_threshold_bytes: count(
                cache_values,
                "automaticThresholdBytes",
                0.0,
                9.0e18,
                downloads_defaults.automatic_threshold_bytes,
            ),
        };

        Ok(Self {
            native,
            runtime: RuntimeProjection {
                branding,
                playback,
                power: PowerDisplay { outside_display, outside_text },
                website,
            },
            platform: AndroidPlatform { reliability, power, managed_kiosk, accessibility, updates, downloads },
        })
    }

    /// The installed projection as Kotlin reads it: revision, Runtime
    /// values, platform values, and the native summary the heartbeat and
    /// drivers need. Carries no credentials.
    pub fn installed_json(&self) -> Value {
        serde_json::json!({
            "schemaVersion": self.native.schema_version,
            "configRevision": self.native.revision,
            "runtime": self.runtime,
            "platform": self.platform,
            "native": {
                "cache": {
                    "maximumBytes": self.native.cache.maximum_bytes,
                    "minimumFreeBytes": self.native.cache.minimum_free_bytes,
                },
                "sync": {
                    "statusReportSeconds": self.native.sync.status_report.as_secs(),
                    "manifestReconciliationSeconds": self.native.sync.manifest_reconciliation.as_secs(),
                },
            },
        })
    }
}

/// The installed projection file below the Core root. Kotlin reads it;
/// Core state stays the acceptance authority.
pub const INSTALLED_CONFIG_NAME: &str = "installed-config.json";

/// Android's [`ConfigurationHost`]: validates ownership projections and
/// installs them to the app-private file Kotlin applies.
#[derive(Debug)]
pub struct AndroidConfigHost {
    effective: RwLock<Option<Arc<AndroidPlayerConfig>>>,
    installed_path: PathBuf,
    cas: ContentStore,
}

impl AndroidConfigHost {
    pub fn new(installed_path: PathBuf, cas: ContentStore) -> Self {
        Self { effective: RwLock::new(None), installed_path, cas }
    }

    /// The configuration in force, if Core has installed one.
    pub fn effective(&self) -> Option<Arc<AndroidPlayerConfig>> {
        self.effective.read().ok().and_then(|guard| guard.clone())
    }

    /// The accepted revision, if any, for status and the heartbeat.
    pub fn accepted_revision(&self) -> Option<i64> {
        self.effective().map(|config| config.native.revision)
    }

    /// The shared verified store handle, cloned for sibling hosts.
    pub fn cas(&self) -> ContentStore {
        self.cas.clone()
    }

    /// The native policy in force, or the defaults before any install.
    /// The server-link driver reads this for reconciliation cadence.
    pub fn native_configuration(&self) -> NativeConfiguration {
        self.effective().map(|config| config.native.clone()).unwrap_or_default()
    }

    /// The operator's store policy narrowed by the server's: the smaller
    /// byte limit and the larger free-space floor. Operator policy is
    /// local and the server can tighten but never loosen it.
    fn store_policy(config: &AndroidPlayerConfig) -> StorePolicy {
        StorePolicy {
            limit_bytes: config.native.cache.maximum_bytes.map_or(CAS_LIMIT_BYTES, |max| max.min(CAS_LIMIT_BYTES)),
            reserved_free_bytes: config
                .native
                .cache
                .minimum_free_bytes
                .map_or(CAS_RESERVED_FREE_BYTES, |min| min.max(CAS_RESERVED_FREE_BYTES)),
        }
    }

    fn install(&self, config: Option<AndroidPlayerConfig>) {
        *self.effective.write().unwrap_or_else(|poison| poison.into_inner()) = config.clone().map(Arc::new);
        match config {
            Some(config) => {
                self.cas.set_policy(Self::store_policy(&config));
                let tmp = self.installed_path.with_extension("json.tmp");
                let written = serde_json::to_vec_pretty(&config.installed_json())
                    .map_err(|_| ())
                    .and_then(|bytes| std::fs::write(&tmp, &bytes).map_err(|_| ()))
                    .and_then(|()| std::fs::rename(&tmp, &self.installed_path).map_err(|_| ()));
                if written.is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
            }
            None => {
                self.cas.set_policy(StorePolicy {
                    limit_bytes: CAS_LIMIT_BYTES,
                    reserved_free_bytes: CAS_RESERVED_FREE_BYTES,
                });
                let _ = std::fs::remove_file(&self.installed_path);
            }
        }
    }
}

#[async_trait::async_trait]
impl ConfigurationHost for AndroidConfigHost {
    type Projection = AndroidPlayerConfig;

    fn prepare_configuration(
        &self,
        document: &Value,
        native: &NativeConfiguration,
    ) -> Result<Self::Projection, &'static str> {
        AndroidPlayerConfig::project(document, native.clone()).map_err(|error| error.reason_code())
    }

    async fn install_configuration(&self, projection: Option<Self::Projection>) {
        self.install(projection);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::LruByDomain;
    use player_state::{OpenOptions, StateDb};
    use serde_json::json;

    fn document(overrides: Value) -> Value {
        let mut value = json!({"schemaVersion": 1, "configRevision": 4, "generatedAt": "2026-09-24T00:00:00Z"});
        for (key, field) in overrides.as_object().expect("test object") {
            value[key] = field.clone();
        }
        value
    }

    #[test]
    fn structure_is_strict() {
        assert!(AndroidPlayerConfig::parse(&document(json!({}))).is_ok());
        assert_eq!(AndroidPlayerConfig::parse(&json!([1])), Err(ConfigError::NotObject));
        assert_eq!(
            AndroidPlayerConfig::parse(&document(json!({"schemaVersion": 2}))),
            Err(ConfigError::UnsupportedSchema)
        );
        assert_eq!(
            AndroidPlayerConfig::parse(&document(json!({"configRevision": -1}))),
            Err(ConfigError::InvalidRevision)
        );
        assert_eq!(AndroidPlayerConfig::parse(&document(json!({"power": "on"}))), Err(ConfigError::InvalidSection));
        assert_eq!(
            AndroidPlayerConfig::parse(&document(json!({"managedKiosk": []}))),
            Err(ConfigError::InvalidSection)
        );
        // Sections Android does not project still validate as objects.
        assert!(AndroidPlayerConfig::parse(&document(json!({"linuxKiosk": {"fullscreenEnabled": true}}))).is_ok());
        assert!(AndroidPlayerConfig::parse(&document(json!({"linuxKiosk": 7}))).is_err());
        let big = "x".repeat(player_client::player_api::MAX_CONFIG_BYTES);
        assert_eq!(
            AndroidPlayerConfig::parse(&document(json!({"branding": {"footerText": big}}))),
            Err(ConfigError::TooLarge)
        );
    }

    #[test]
    fn values_fall_back_like_the_reference_player() {
        let config = AndroidPlayerConfig::parse(&document(json!({
            "branding": {"backgroundColor": "red", "textColor": "#abcdef", "disabledTitle": "  Closed  "},
            "sync": {"statusReportSeconds": 5, "manifestReconciliationSeconds": 120},
            "reliability": {"playbackStallSeconds": 1, "maximumProcessRestarts": 0, "safeModeEnabled": false},
            "playback": {"defaultVolume": 4.0, "defaultImageDurationSeconds": -3},
        })))
        .expect("parse");
        assert_eq!(config.runtime.branding.background(), DEFAULT_BACKGROUND);
        assert_eq!(config.runtime.branding.text(), "#abcdef");
        assert_eq!(config.runtime.branding.disabled_title.as_deref(), Some("Closed"));
        assert_eq!(config.native.sync.status_report, std::time::Duration::from_secs(60), "below 15 s is ignored");
        assert_eq!(config.native.sync.manifest_reconciliation, std::time::Duration::from_secs(120));
        let reliability = config.native.reliability.expect("reliability section");
        assert_eq!(reliability.stall_threshold_ms, 10_000);
        assert_eq!(reliability.max_ladder_runs_before_safe_mode, 1);
        assert!(!reliability.safe_mode_enabled);
        assert_eq!(config.runtime.playback.default_volume, 1.0, "volume clamps");
        assert_eq!(config.runtime.playback.default_image_duration_ms, 10_000, "negative duration falls back");
    }

    #[test]
    fn android_platform_reads_with_legacy_defaults() {
        let config = AndroidPlayerConfig::parse(&document(json!({
            "reliability": {"mode": "managed_kiosk", "launchAfterBoot": false, "webviewStallSeconds": 120},
            "power": {"keepScreenOn": false, "sleepOutsideActiveHours": true, "startupGraceSeconds": 5},
            "managedKiosk": {"lockTaskEnabled": true, "blockOverlays": false, "adminSessionMinutes": 30},
            "accessibility": {"returnDelaySeconds": 20, "allowedPackages": ["com.example.a", " com.example.b "],
                "reportForegroundPackage": true, "maximumReturns": 9},
            "updates": {"channel": "beta"},
            "cache": {"concurrentDownloads": 4, "automaticThresholdBytes": 1024},
        })))
        .expect("parse");
        let platform = &config.platform;
        assert_eq!(platform.reliability.mode, "managed_kiosk");
        assert!(!platform.reliability.launch_after_boot);
        assert!(platform.reliability.immersive_mode);
        assert_eq!(platform.reliability.webview_stall_seconds, 120);
        assert!(!platform.power.keep_screen_on);
        assert!(platform.power.sleep_outside_active_hours);
        assert_eq!(platform.power.startup_grace_seconds, 5);
        assert_eq!(platform.power.shutdown_prepare_seconds, 60);
        assert!(platform.managed_kiosk.lock_task_enabled);
        assert!(!platform.managed_kiosk.block_overlays);
        assert!(platform.managed_kiosk.allow_settings_during_admin);
        assert_eq!(platform.managed_kiosk.admin_session_minutes, 30);
        assert_eq!(platform.accessibility.return_delay_seconds, 20);
        assert_eq!(platform.accessibility.allowed_packages, vec!["com.example.a", "com.example.b"]);
        assert!(platform.accessibility.report_foreground_package);
        assert_eq!(platform.accessibility.maximum_returns, 9);
        assert_eq!(platform.updates.channel, "beta");
        assert_eq!(platform.downloads.concurrent_downloads, 4);
        assert_eq!(platform.downloads.automatic_threshold_bytes, 1024);
    }

    #[test]
    fn android_platform_values_fall_back_on_wrong_types() {
        let config = AndroidPlayerConfig::parse(&document(json!({
            "reliability": {"mode": "kiosk", "webviewStallSeconds": 5},
            "managedKiosk": {"adminSessionMinutes": 99999},
            "accessibility": {"returnDelaySeconds": "soon", "allowedPackages": "com.example.a", "maximumReturns": 0},
            "updates": {"channel": "nightly"},
            "cache": {"concurrentDownloads": 99},
            "website": {"defaultReloadPolicy": "always", "defaultCookiePolicy": "everything"},
        })))
        .expect("parse");
        let platform = &config.platform;
        assert_eq!(platform.reliability.mode, "standard");
        assert_eq!(platform.reliability.webview_stall_seconds, 45);
        assert_eq!(platform.managed_kiosk.admin_session_minutes, 15);
        assert_eq!(platform.accessibility.return_delay_seconds, 10);
        assert!(platform.accessibility.allowed_packages.is_empty());
        assert_eq!(platform.accessibility.maximum_returns, 3);
        assert_eq!(platform.updates.channel, "stable");
        assert_eq!(platform.downloads.concurrent_downloads, 2);
        assert_eq!(config.runtime.website.default_reload_policy, "on_each_activation");
        assert_eq!(config.runtime.website.default_cookie_policy, "first_party");
    }

    #[test]
    fn runtime_options_survive_projection() {
        let document = document(json!({
            "playback": {"futureRuntimeOption": {"transition": "new", "values": [1, 2, 3]}},
            "cache": {"maximumBytes": 4096},
        }));
        let native = NativeConfiguration::parse(&document).expect("native");
        let projected = AndroidPlayerConfig::project(&document, native.clone()).expect("project");
        assert_eq!(projected.native, native);
        assert_eq!(
            projected.runtime.playback.context["futureRuntimeOption"],
            document["playback"]["futureRuntimeOption"]
        );
        assert_eq!(projected.native.cache.maximum_bytes, Some(4096));
    }

    async fn scratch_host(dir: &std::path::Path) -> AndroidConfigHost {
        std::fs::create_dir_all(dir).expect("scratch dir");
        let db = StateDb::open(dir.join("state.db"), OpenOptions::default()).expect("state");
        let clock = std::sync::Arc::new(crate::host::SystemClock);
        let store = ContentStore::open(
            dir.join("cas"),
            dir.join("partial"),
            db,
            clock,
            std::sync::Arc::new(crate::host::StatvfsProbe),
            std::sync::Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: CAS_LIMIT_BYTES, reserved_free_bytes: CAS_RESERVED_FREE_BYTES },
            std::sync::Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        AndroidConfigHost::new(dir.join(INSTALLED_CONFIG_NAME), store)
    }

    #[tokio::test]
    async fn install_round_trip_persists_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = scratch_host(dir.path()).await;
        assert_eq!(host.accepted_revision(), None);
        let config = AndroidPlayerConfig::parse(&document(json!({"configRevision": 7}))).expect("parse");
        host.install_configuration(Some(config)).await;
        assert_eq!(host.accepted_revision(), Some(7));
        let raw = std::fs::read_to_string(dir.path().join(INSTALLED_CONFIG_NAME)).expect("installed file");
        let installed: Value = serde_json::from_str(&raw).expect("installed json");
        assert_eq!(installed["configRevision"], 7);
        assert_eq!(installed["platform"]["updates"]["channel"], "stable");
        host.install_configuration(None).await;
        assert_eq!(host.accepted_revision(), None);
        assert!(!dir.path().join(INSTALLED_CONFIG_NAME).exists());
    }

    #[tokio::test]
    async fn store_policy_narrows_but_never_loosens() {
        let dir = tempfile::tempdir().expect("tempdir");
        let host = scratch_host(dir.path()).await;
        let tight = AndroidPlayerConfig::parse(&document(
            json!({"cache": {"maximumBytes": 1024, "minimumFreeBytes": CAS_RESERVED_FREE_BYTES + 1}}),
        ))
        .expect("parse");
        host.install_configuration(Some(tight)).await;
        assert_eq!(host.cas.policy().limit_bytes, 1024);
        assert_eq!(host.cas.policy().reserved_free_bytes, CAS_RESERVED_FREE_BYTES + 1);
        let loose = AndroidPlayerConfig::parse(&document(
            json!({"cache": {"maximumBytes": CAS_LIMIT_BYTES + 1, "minimumFreeBytes": 1}}),
        ))
        .expect("parse");
        host.install_configuration(Some(loose)).await;
        assert_eq!(host.cas.policy().limit_bytes, CAS_LIMIT_BYTES);
        assert_eq!(host.cas.policy().reserved_free_bytes, CAS_RESERVED_FREE_BYTES);
    }

    /// Scripted config endpoint: serves revisions in order, honors
    /// `If-None-Match` against the latest served validator.
    struct ConfigScript {
        revisions: std::collections::VecDeque<(i64, Value)>,
        etag: Option<String>,
        seen_validators: Vec<Option<String>>,
    }

    async fn canned_server(
        installation: player_types::InstallationId,
        script: Arc<std::sync::Mutex<ConfigScript>>,
    ) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://127.0.0.1:{}", listener.local_addr().expect("bound port").port());
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let script = script.clone();
                tokio::spawn(async move {
                    let mut request = vec![0u8; 8192];
                    let Ok(read) = stream.read(&mut request).await else { return };
                    let head = String::from_utf8_lossy(&request[..read]);
                    let mut lines = head.lines();
                    let target = lines.next().unwrap_or_default();
                    let mut if_none_match = None;
                    for line in lines {
                        if let Some(value) = line.strip_prefix("if-none-match:") {
                            if_none_match = Some(value.trim().to_owned());
                        }
                    }
                    let body = if target.contains("/api/v1/system/identity") {
                        format!(
                            r#"{{"data":{{"product":"Tilecast","installationId":"{installation}","organizationName":"Test","apiVersion":"v1","pairingEnabled":true}}}}"#
                        )
                    } else if target.contains("/api/v1/player/config") {
                        let response = {
                            let mut script = script.lock().expect("test lock");
                            script.seen_validators.push(if_none_match.clone());
                            match script.revisions.pop_front() {
                                // Nothing newer scripted: any validator earns a
                                // 304. Validator precision is asserted
                                // client-side on `seen_validators`.
                                None if if_none_match.is_some() => {
                                    b"HTTP/1.1 304 Not Modified\r\ncontent-length: 0\r\n\r\n".to_vec()
                                }
                                None => b"HTTP/1.1 500 Boom\r\ncontent-length: 0\r\n\r\n".to_vec(),
                                Some((revision, extra)) => {
                                    let mut document = json!({"schemaVersion": 1, "configRevision": revision});
                                    for (key, field) in extra.as_object().expect("test object") {
                                        document[key] = field.clone();
                                    }
                                    let etag = format!("\"config-{revision}\"");
                                    script.etag = Some(etag.clone());
                                    let payload = serde_json::json!({"data": document}).to_string();
                                    format!(
                                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\netag: {etag}\r\ncontent-length: {}\r\n\r\n{payload}",
                                        payload.len()
                                    )
                                    .into_bytes()
                                }
                            }
                        };
                        let _ = stream.write_all(&response).await;
                        return;
                    } else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Missing\r\ncontent-length: 0\r\n\r\n").await;
                        return;
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(body.as_bytes()).await;
                });
            }
        });
        url
    }

    fn credential() -> player_client::DeviceCredential {
        player_client::DeviceCredential::parse(&format!("tc_device_{}.{}", "a".repeat(26), "b".repeat(40)))
            .expect("credential")
    }

    #[tokio::test]
    async fn reconcile_accepts_revisits_and_refuses_stale() {
        let dir = tempfile::tempdir().expect("tempdir");
        let installation = player_types::InstallationId::from_uuid(uuid::Uuid::from_u128(0xC0FFEE));
        let script = Arc::new(std::sync::Mutex::new(ConfigScript {
            revisions: [
                (7, json!({"generatedAt": "first", "updates": {"channel": "beta"}})),
                (7, json!({"generatedAt": "second", "updates": {"channel": "beta"}})),
                (6, json!({"generatedAt": "stale"})),
            ]
            .into_iter()
            .collect(),
            etag: None,
            seen_validators: Vec::new(),
        }));
        let url = canned_server(installation, script.clone()).await;
        let client = player_client::ServerClient::new(&url, "test/1").expect("client");
        let server = client.verify_installation(installation, credential()).await.expect("verify");
        let state = StateDb::open(dir.path().join("host-state.db"), OpenOptions::default()).expect("state");
        let clock = std::sync::Arc::new(crate::host::SystemClock);
        let core = player_core::PlayerCore::new(player_core::Dependencies { state, clock });
        let binding = player_state::repo::manifests::Binding {
            installation_id: installation,
            screen_id: player_types::ScreenId::from_uuid(uuid::Uuid::from_u128(0x5C2EED)),
            server_url: url.clone(),
        };
        let host = scratch_host(&dir.path().join("config")).await;

        let outcome = core.configuration().reconcile(&server, &binding, &host).await.expect("reconcile");
        assert_eq!(outcome, player_core::ConfigurationOutcome::Accepted { revision: 7 });
        assert_eq!(host.accepted_revision(), Some(7));
        assert_eq!(host.effective().expect("installed").platform.updates.channel, "beta");

        // Same revision, same comparable document: a resend, not a refusal.
        let outcome = core.configuration().reconcile(&server, &binding, &host).await.expect("reconcile");
        assert_eq!(outcome, player_core::ConfigurationOutcome::Unchanged);

        // An older revision never replaces what is in force.
        let outcome = core.configuration().reconcile(&server, &binding, &host).await.expect("reconcile");
        assert_eq!(outcome, player_core::ConfigurationOutcome::Refused { reason: "config_revision_stale" });
        assert_eq!(host.accepted_revision(), Some(7));

        // Nothing new on the server: the validator earns a 304.
        let outcome = core.configuration().reconcile(&server, &binding, &host).await.expect("reconcile");
        assert_eq!(outcome, player_core::ConfigurationOutcome::Unchanged);

        // The second pass sent the accepted validator; the refusal kept it.
        let seen = script.lock().expect("test lock").seen_validators.clone();
        assert_eq!(seen.len(), 4);
        assert_eq!(seen[0], None);
        assert_eq!(seen[1].as_deref(), Some("\"config-7\""));
        assert_eq!(seen[3].as_deref(), Some("\"config-7\""));

        // A restart applies the accepted document before any network access.
        let host = scratch_host(&dir.path().join("config2")).await;
        core.configuration().load_cached(&binding, &host).await;
        assert_eq!(host.accepted_revision(), Some(7));
        assert_eq!(host.effective().expect("installed").platform.updates.channel, "beta");
    }

    #[test]
    fn installed_json_carries_no_secrets() {
        let config = AndroidPlayerConfig::parse(&document(json!({"configRevision": 9}))).expect("parse");
        let installed = config.installed_json();
        assert_eq!(installed["configRevision"], 9);
        assert_eq!(installed["platform"]["updates"]["channel"], "stable");
        assert_eq!(installed["runtime"]["power"]["outsideDisplay"], "black");
        let raw = serde_json::to_string(&installed).expect("installed json");
        assert!(!raw.contains("credential"));
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("token"));
    }
}
