//! Android pairing surfaces for Player Core.
//!
//! Core decides pairing policy; Kotlin owns device facts and the setup UI.
//! Facts cross as one JSON document, validated and sanitized by
//! [`DeviceMetadata::new`]. Status crosses back as one JSON document the
//! Kotlin host projects into Compose state. Both crossings run on the
//! blocking pool so driver workers never stall on JNI.

use std::sync::Arc;

use async_trait::async_trait;
use player_client::pairing::DeviceMetadata;
use player_core::{PairingHost as CorePairingHost, PairingMetadataProvider, PairingStatus};
use player_types::PlayerId;
use serde::Deserialize;

use crate::jvm::{Jvm, method};

/// Facts Kotlin reports for this device. Every field is optional on the
/// wire: missing facts fall back to the contract defaults in
/// [`DeviceMetadata::new`], never to an error.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Facts {
    // Server-visible platform tag. Kotlin sends the same values the legacy
    // Player reports ("android-tv", or "fire-tv" on Amazon hardware), so
    // the cutover changes no server behavior.
    #[serde(default = "default_platform")]
    platform: String,
    #[serde(default)]
    manufacturer: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    os_release: String,
    #[serde(default)]
    player_version: String,
    #[serde(default)]
    screen_width: u32,
    #[serde(default)]
    screen_height: u32,
    #[serde(default)]
    locale: String,
    #[serde(default)]
    timezone: String,
}

fn default_platform() -> String {
    "android-tv".to_owned()
}

impl Facts {
    fn parse(json: &str) -> Self {
        serde_json::from_str(json).unwrap_or(Self {
            platform: default_platform(),
            manufacturer: String::new(),
            model: String::new(),
            os_release: String::new(),
            player_version: String::new(),
            screen_width: 0,
            screen_height: 0,
            locale: String::new(),
            timezone: String::new(),
        })
    }

    fn metadata(&self, player: PlayerId) -> DeviceMetadata {
        DeviceMetadata::new(
            *player.as_uuid(),
            &self.platform,
            &self.manufacturer,
            &self.model,
            &self.os_release,
            &self.player_version,
            (self.screen_width, self.screen_height),
            &self.locale,
            &self.timezone,
        )
    }
}

/// The two pairing crossings. Production calls Kotlin; tests substitute
/// [`MemMetadataSource`].
pub trait MetadataSource: Send + Sync + std::fmt::Debug {
    fn device_metadata_json(&self) -> Result<String, MetadataError>;
    fn pairing_status(&self, json: &str);
    /// Device uptime in whole seconds since boot. The app sandbox
    /// cannot read the kernel uptime file, so this stays a live
    /// Android measurement rather than a collected fact.
    fn device_uptime_seconds(&self) -> Option<i64>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MetadataError {
    #[error("device facts are unavailable")]
    Unavailable,
}

#[derive(Debug)]
pub struct JvmMetadataSource {
    jvm: Arc<Jvm>,
}

impl JvmMetadataSource {
    pub fn new(jvm: Arc<Jvm>) -> Self {
        Self { jvm }
    }
}

impl MetadataSource for JvmMetadataSource {
    fn device_metadata_json(&self) -> Result<String, MetadataError> {
        self.jvm
            .call_string(method::device_metadata(), None)
            .map_err(|_| MetadataError::Unavailable)?
            .ok_or(MetadataError::Unavailable)
    }

    fn pairing_status(&self, json: &str) {
        let _ = self.jvm.call_void(method::pairing_status(), json);
    }

    fn device_uptime_seconds(&self) -> Option<i64> {
        self.jvm.call_long(method::device_uptime_seconds()).ok().filter(|up| *up >= 0)
    }
}

/// In-memory facts and a status sink for host tests.
#[derive(Debug, Default)]
pub struct MemMetadataSource {
    facts: std::sync::Mutex<String>,
    statuses: std::sync::Mutex<Vec<String>>,
    fail: std::sync::Mutex<bool>,
    uptime: std::sync::Mutex<Option<i64>>,
}

impl MemMetadataSource {
    pub fn with_facts(facts: &str) -> Self {
        Self {
            facts: std::sync::Mutex::new(facts.to_owned()),
            statuses: std::sync::Mutex::new(Vec::new()),
            fail: std::sync::Mutex::new(false),
            uptime: std::sync::Mutex::new(None),
        }
    }

    pub fn with_uptime(self, uptime: i64) -> Self {
        *self.uptime.lock().unwrap_or_else(|error| error.into_inner()) = Some(uptime);
        self
    }

    pub fn statuses(&self) -> Vec<String> {
        self.statuses.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub fn fail_next(&self, fail: bool) {
        *self.fail.lock().unwrap_or_else(|error| error.into_inner()) = fail;
    }
}

impl MetadataSource for MemMetadataSource {
    fn device_metadata_json(&self) -> Result<String, MetadataError> {
        if *self.fail.lock().unwrap_or_else(|error| error.into_inner()) {
            return Err(MetadataError::Unavailable);
        }
        Ok(self.facts.lock().unwrap_or_else(|error| error.into_inner()).clone())
    }

    fn pairing_status(&self, json: &str) {
        self.statuses.lock().unwrap_or_else(|error| error.into_inner()).push(json.to_owned());
    }

    fn device_uptime_seconds(&self) -> Option<i64> {
        if *self.fail.lock().unwrap_or_else(|error| error.into_inner()) {
            return None;
        }
        *self.uptime.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Serializes [`PairingStatus`] for the Kotlin surface (bridge contract).
pub fn status_json(status: &PairingStatus) -> String {
    let value = match status {
        PairingStatus::Paired => serde_json::json!({"state": "paired"}),
        PairingStatus::Enrolled => serde_json::json!({"state": "enrolled"}),
        PairingStatus::Setup => serde_json::json!({"state": "setup"}),
        PairingStatus::AddressRejected => serde_json::json!({"state": "addressRejected"}),
        PairingStatus::Reset => serde_json::json!({"state": "reset"}),
        PairingStatus::Waiting { code, approval_url, organization_name, expires_at, server_time } => {
            serde_json::json!({
                "state": "waiting",
                "code": code,
                "approvalUrl": approval_url,
                "organizationName": organization_name,
                "expiresAt": expires_at.to_string(),
                "serverTime": server_time,
            })
        }
        PairingStatus::Renewing { reason } => serde_json::json!({"state": "renewing", "reason": reason}),
    };
    value.to_string()
}

#[derive(Debug, Clone)]
pub struct AndroidPairingHost {
    meta: Arc<dyn MetadataSource>,
    wake: Arc<tokio::sync::Notify>,
    server_wake: Arc<tokio::sync::Notify>,
    manifest_wake: Arc<tokio::sync::Notify>,
}

impl AndroidPairingHost {
    pub fn new(
        meta: Arc<dyn MetadataSource>,
        wake: Arc<tokio::sync::Notify>,
        server_wake: Arc<tokio::sync::Notify>,
        manifest_wake: Arc<tokio::sync::Notify>,
    ) -> Self {
        Self { meta, wake, server_wake, manifest_wake }
    }
}

#[async_trait]
impl PairingMetadataProvider for AndroidPairingHost {
    fn new_player_id(&self) -> PlayerId {
        PlayerId::from_uuid(uuid::Uuid::new_v4())
    }

    async fn metadata(&self, player: PlayerId) -> DeviceMetadata {
        let meta = self.meta.clone();
        let json = tokio::task::spawn_blocking(move || meta.device_metadata_json())
            .await
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or_default();
        Facts::parse(&json).metadata(player)
    }
}

#[async_trait]
impl CorePairingHost for AndroidPairingHost {
    async fn show_pairing(&self, status: PairingStatus) {
        let meta = self.meta.clone();
        let json = status_json(&status);
        let _ = tokio::task::spawn_blocking(move || meta.pairing_status(&json)).await;
        // Enrollment lands the credential and binding, but Core's next pass
        // is an hour out. Wake the loop so it projects Paired immediately,
        // and wake the server link so it verifies and reports at once
        // instead of sleeping through its idle interval.
        if matches!(status, PairingStatus::Enrolled) {
            self.wake.notify_one();
            self.server_wake.notify_one();
            self.manifest_wake.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player() -> PlayerId {
        PlayerId::from_uuid(uuid::Uuid::from_u128(0x1234))
    }

    #[test]
    fn facts_default_safely() {
        let meta = Facts::parse("not json");
        let facts = meta.metadata(player());
        assert_eq!(facts.platform, "android-tv");
        assert_eq!(facts.manufacturer, "unknown");
        assert_eq!(facts.screen_width, 1);
        let meta = Facts::parse(
            r#"{"manufacturer":"  ","model":"TV","osRelease":"14","playerVersion":"0.25.0","screenWidth":3840,"screenHeight":2160,"locale":"de-DE","timezone":"Europe/Berlin"}"#,
        )
        .metadata(player());
        assert_eq!(meta.manufacturer, "unknown");
        assert_eq!(meta.model, "TV");
        assert_eq!(meta.android_version, "14");
        assert_eq!(meta.screen_width, 3840);
        assert_eq!(meta.timezone, "Europe/Berlin");
        assert_eq!(meta.player_installation_id, player().as_uuid().to_string());
    }

    #[test]
    fn status_shapes_are_stable() {
        let waiting = status_json(&PairingStatus::Waiting {
            code: "ABC123".to_owned(),
            approval_url: "https://signs.example/s".to_owned(),
            organization_name: None,
            expires_at: player_types::Timestamp::from_unix_millis(1_786_000_000_000).expect("expiry"),
            server_time: Some("2026-08-06T06:56:40Z".to_owned()),
        });
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&waiting).expect("json"),
            serde_json::json!({"state": "waiting", "code": "ABC123", "approvalUrl": "https://signs.example/s", "organizationName": null, "expiresAt": "2026-08-06T07:06:40Z", "serverTime": "2026-08-06T06:56:40Z"}),
        );
        assert!(status_json(&PairingStatus::Paired).contains("paired"));
        assert!(status_json(&PairingStatus::Renewing { reason: "expired".to_owned() }).contains("expired"));
    }

    #[tokio::test]
    async fn host_serves_facts_and_records_status() {
        let meta = Arc::new(MemMetadataSource::with_facts(r#"{"model":"Stick"}"#));
        let wake = Arc::new(tokio::sync::Notify::new());
        let link = Arc::new(tokio::sync::Notify::new());
        let host = AndroidPairingHost::new(meta.clone(), wake, link.clone(), link);
        let facts = host.metadata(player()).await;
        assert_eq!(facts.model, "Stick");
        host.show_pairing(PairingStatus::Setup).await;
        assert_eq!(meta.statuses(), vec![status_json(&PairingStatus::Setup)]);
        meta.fail_next(true);
        let fallback = host.metadata(player()).await;
        assert_eq!(fallback.model, "unknown");
    }

    #[tokio::test]
    async fn enrollment_wakes_the_driver_loop() {
        let meta = Arc::new(MemMetadataSource::with_facts("{}"));
        let wake = Arc::new(tokio::sync::Notify::new());
        let server_wake = Arc::new(tokio::sync::Notify::new());
        let manifest_wake = Arc::new(tokio::sync::Notify::new());
        let host = AndroidPairingHost::new(meta, wake.clone(), server_wake.clone(), manifest_wake.clone());
        let notified = wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let server = server_wake.notified();
        tokio::pin!(server);
        server.as_mut().enable();
        let manifest = manifest_wake.notified();
        tokio::pin!(manifest);
        manifest.as_mut().enable();
        host.show_pairing(PairingStatus::Setup).await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut notified).await.is_err(),
            "setup must not wake the loop"
        );
        host.show_pairing(PairingStatus::Enrolled).await;
        tokio::time::timeout(std::time::Duration::from_secs(1), notified).await.expect("enrollment wakes the loop");
        tokio::time::timeout(std::time::Duration::from_secs(1), server)
            .await
            .expect("enrollment wakes the server link");
        tokio::time::timeout(std::time::Duration::from_secs(1), manifest)
            .await
            .expect("enrollment wakes manifest preparation");
    }
}
