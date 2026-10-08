//! Reference guest SDK for Tilecast Package API v3.
//!
//! Guests call versioned Tilecast services through the `tilecast.call_v1`
//! host import: one operation token, one JSON input, one JSON envelope
//! back. This crate owns the unsafe boundary (guest memory, host codes,
//! envelope parsing) and the typed shapes for the small, stable service
//! responses. Large domain documents (playlists, layouts, data sources,
//! schedules, groups) cross as `serde_json::Value`: guests read the
//! fields they need without the SDK shadowing every domain type.
//!
//! The crate builds for `wasm32-unknown-unknown` guests and runs its
//! pure logic under host unit tests. It uses only collections and
//! serde, so it links cleanly without WASI.

use std::fmt;
use std::string::String;
use std::vec::Vec;

use serde::{Deserialize, Serialize};

/// Maximum JSON input bytes for one service call.
pub const MAX_INPUT_BYTES: usize = 32 * 1024;
/// Maximum envelope bytes for one service answer.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[link(wasm_import_module = "tilecast")]
unsafe extern "C" {
    fn call_v1(op_ptr: u32, op_len: u32, in_ptr: u32, in_len: u32, out_ptr: u32, out_cap: u32) -> i32;
}

/// A transport-level refusal from the host. These never reach the
/// envelope: the import answers a stable negative code instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    /// Unknown operation token (-7).
    NoOperation,
    /// The active manifest does not grant the operation, the context
    /// forbids it, or the actor is invalid (-5).
    NoGrant,
    /// The input, output, or an address range exceeded its bound (-3).
    TooLarge,
    /// The host failed while answering (-2).
    HostFailure,
    /// An unrecognized negative code. Fail closed: treat it as denied.
    Unknown(i32),
}

/// Maps a negative import answer to its host error.
pub fn host_error_from_code(code: i32) -> HostError {
    match code {
        -7 => HostError::NoOperation,
        -5 => HostError::NoGrant,
        -3 => HostError::TooLarge,
        -2 => HostError::HostFailure,
        other => HostError::Unknown(other),
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostError::NoOperation => write!(f, "unknown service operation"),
            HostError::NoGrant => write!(f, "operation not granted in this context"),
            HostError::TooLarge => write!(f, "call or answer exceeded its bound"),
            HostError::HostFailure => write!(f, "host failed while answering"),
            HostError::Unknown(code) => write!(f, "host denied the call ({code})"),
        }
    }
}

/// A typed domain failure from inside the envelope.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DomainError {
    /// Machine-readable code: invalid_input, not_found, forbidden,
    /// conflict, too_large, unavailable.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Everything that can go wrong with one service call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// The host refused the call at the transport layer.
    Host(HostError),
    /// The operation ran and answered a typed domain failure.
    Domain(DomainError),
    /// The answer was not a well-formed envelope. Never trust a
    /// partial answer: the call failed.
    Envelope,
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CallError::Host(error) => write!(f, "{error}"),
            CallError::Domain(error) => write!(f, "{error}"),
            CallError::Envelope => write!(f, "malformed service envelope"),
        }
    }
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Envelope<T> {
    ok: bool,
    #[serde(default)]
    data: Option<T>,
    #[serde(default)]
    error: Option<DomainError>,
}

/// Parses one envelope into its payload. Pure: unit-tested on the host.
pub fn parse_envelope<T: for<'de> Deserialize<'de>>(raw: &[u8]) -> Result<T, CallError> {
    let envelope: Envelope<T> = serde_json::from_slice(raw).map_err(|_| CallError::Envelope)?;
    if envelope.ok {
        envelope.data.ok_or(CallError::Envelope)
    } else {
        Err(envelope.error.map(CallError::Domain).unwrap_or(CallError::Envelope))
    }
}

/// Guards the input bound before crossing into the host.
pub fn check_input_size(input: &[u8]) -> Result<(), CallError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(CallError::Host(HostError::TooLarge));
    }
    Ok(())
}

/// Crosses into the host once and answers the raw envelope bytes.
fn invoke(operation: &str, input: &[u8]) -> Result<Vec<u8>, CallError> {
    check_input_size(input)?;
    let mut out = Vec::with_capacity(MAX_OUTPUT_BYTES);
    // SAFETY: the host writes at most out_cap bytes into the spare
    // capacity and answers the exact count, or a negative code that
    // writes nothing. The buffers outlive the call.
    let written = unsafe {
        call_v1(
            operation.as_ptr() as u32,
            operation.len() as u32,
            input.as_ptr() as u32,
            input.len() as u32,
            out.as_mut_ptr() as u32,
            MAX_OUTPUT_BYTES as u32,
        )
    };
    if written < 0 {
        return Err(CallError::Host(host_error_from_code(written)));
    }
    let written = written as usize;
    if written > MAX_OUTPUT_BYTES {
        return Err(CallError::Envelope);
    }
    unsafe { out.set_len(written) };
    Ok(out)
}

/// Calls one operation with raw JSON input and answers the payload as a
/// JSON value. Prefer [`call_json`] for typed answers.
pub fn call_raw(operation: &str, input: &[u8]) -> Result<serde_json::Value, CallError> {
    let out = invoke(operation, input)?;
    parse_envelope(&out)
}

/// Calls one operation with a serializable input and parses the typed
/// answer. Operations that take no arguments pass `&Empty {}`.
pub fn call_json<Request: Serialize, Answer: for<'de> Deserialize<'de>>(
    operation: &str,
    input: &Request,
) -> Result<Answer, CallError> {
    let input = serde_json::to_vec(input).map_err(|_| CallError::Envelope)?;
    let out = invoke(operation, &input)?;
    parse_envelope(&out)
}

/// Empty input for operations that take no arguments.
#[derive(Serialize)]
pub struct Empty {}

/// One page of results.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// Paged list input shared by the list operations.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub search: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub page: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub page_size: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// By-ID input shared by the get operations.
#[derive(Debug, Clone, Serialize)]
pub struct ById {
    pub id: String,
}

// ---------------------------------------------------------------- org/instance

pub mod organization {
    //! `organization.read@1`: installation organization facts.
    use super::{CallError, Empty, call_json};
    use serde::Deserialize;
    use std::string::String;

    pub const GET: &str = "organization.read@1/get";

    #[derive(Debug, Clone, Deserialize)]
    pub struct Organization {
        pub id: String,
        pub name: String,
    }

    pub fn get() -> Result<Organization, CallError> {
        call_json(GET, &Empty {})
    }
}

pub mod instance {
    //! `instance.read@1`: installation facts.
    use super::{CallError, Empty, call_json};
    use serde::Deserialize;
    use std::string::String;

    pub const GET: &str = "instance.read@1/get";

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Instance {
        pub public_url: String,
        pub tilecast_version: String,
    }

    pub fn get() -> Result<Instance, CallError> {
        call_json(GET, &Empty {})
    }
}

// ---------------------------------------------------------------- screens

pub mod screens {
    //! `screens.read@1`: non-secret screen facts and reported player
    //! capabilities. Never credentials.
    use super::{ById, CallError, ListInput, Page, call_json};
    use serde::Deserialize;
    use std::collections::BTreeMap;
    use std::string::String;
    use std::vec::Vec;

    pub const LIST: &str = "screens.read@1/list";
    pub const GET: &str = "screens.read@1/get";

    #[derive(Debug, Clone, Default, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Capabilities {
        #[serde(default)]
        pub presentation_schema_versions: Vec<i64>,
        #[serde(default)]
        pub native: BTreeMap<String, i64>,
        #[serde(default)]
        pub web_runtime_version: i64,
        #[serde(default)]
        pub web_bundle_limit_bytes: i64,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Screen {
        pub id: String,
        pub name: String,
        pub enabled: bool,
        pub status: String,
        pub last_contact_at: Option<String>,
        pub platform: String,
        pub player_family: Option<String>,
        pub player_version: Option<String>,
        pub capabilities: Capabilities,
    }

    pub fn list(input: &ListInput) -> Result<Page<Screen>, CallError> {
        call_json(LIST, input)
    }

    pub fn get(id: &str) -> Result<Screen, CallError> {
        call_json(GET, &ById { id: id.into() })
    }
}

// ---------------------------------------------------------------- targets

pub mod targets {
    //! `targets.resolve@1`: validate and resolve display targets.
    use super::{CallError, call_json};
    use serde::{Deserialize, Serialize};
    use std::string::String;
    use std::vec::Vec;

    pub const RESOLVE: &str = "targets.resolve@1/resolve";

    #[derive(Debug, Clone, Default, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Targets {
        #[serde(default)]
        pub screen_ids: Vec<String>,
        #[serde(default)]
        pub group_ids: Vec<String>,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Resolved {
        pub screen_ids: Vec<String>,
    }

    pub fn resolve(targets: &Targets) -> Result<Resolved, CallError> {
        call_json(RESOLVE, targets)
    }
}

// ---------------------------------------------------------------- content

pub mod content {
    //! `content.read@1`: playlists, layouts, data sources, schedules, and
    //! screen groups. Answers cross as JSON values: guests read the
    //! fields they need without shadowing every domain type.
    use super::{ById, CallError, ListInput, call_json};
    use std::string::{String, ToString};

    pub const PLAYLISTS_LIST: &str = "content.read@1/playlists.list";
    pub const PLAYLISTS_GET: &str = "content.read@1/playlists.get";
    pub const LAYOUTS_LIST: &str = "content.read@1/layouts.list";
    pub const LAYOUTS_GET: &str = "content.read@1/layouts.get";
    pub const DATASOURCES_LIST: &str = "content.read@1/datasources.list";
    pub const DATASOURCES_GET: &str = "content.read@1/datasources.get";
    pub const SCHEDULES_LIST: &str = "content.read@1/schedules.list";
    pub const SCHEDULES_GET: &str = "content.read@1/schedules.get";
    pub const GROUPS_LIST: &str = "content.read@1/groups.list";
    pub const GROUPS_GET: &str = "content.read@1/groups.get";

    pub fn playlists_list(input: &ListInput) -> Result<serde_json::Value, CallError> {
        call_json(PLAYLISTS_LIST, input)
    }

    pub fn playlists_get(id: &str) -> Result<serde_json::Value, CallError> {
        call_json(PLAYLISTS_GET, &ById { id: id.to_string() })
    }

    pub fn layouts_list(input: &ListInput) -> Result<serde_json::Value, CallError> {
        call_json(LAYOUTS_LIST, input)
    }

    pub fn layouts_get(id: &str) -> Result<serde_json::Value, CallError> {
        call_json(LAYOUTS_GET, &ById { id: id.to_string() })
    }

    #[derive(Debug, Clone, Default, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DatasourceListInput {
        #[serde(flatten)]
        pub page: ListInput,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub provider: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub sort: String,
    }

    pub fn datasources_list(input: &DatasourceListInput) -> Result<serde_json::Value, CallError> {
        call_json(DATASOURCES_LIST, input)
    }

    pub fn datasources_get(id: &str) -> Result<serde_json::Value, CallError> {
        call_json(DATASOURCES_GET, &ById { id: id.to_string() })
    }

    // No Serialize derive on purpose: guests serialize through
    // to_value, which names the wire `type` field Rust cannot spell.
    #[derive(Debug, Clone, Default)]
    pub struct ScheduleListInput {
        pub page: ListInput,
        pub enabled: Option<bool>,
        pub schedule_type: String,
        pub presentation_type: String,
        pub sort: String,
    }

    /// Schedules list input. Note the wire field is `type`, which Rust
    /// cannot name: serialize through this struct, not a map.
    impl ScheduleListInput {
        pub fn to_value(&self) -> serde_json::Value {
            let mut map = serde_json::Map::new();
            if !self.page.search.is_empty() {
                map.insert("search".to_string(), serde_json::Value::String(self.page.search.clone()));
            }
            if self.page.page != 0 {
                map.insert("page".to_string(), serde_json::Value::from(self.page.page));
            }
            if self.page.page_size != 0 {
                map.insert("pageSize".to_string(), serde_json::Value::from(self.page.page_size));
            }
            if let Some(enabled) = self.enabled {
                map.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
            }
            if !self.schedule_type.is_empty() {
                map.insert("type".to_string(), serde_json::Value::String(self.schedule_type.clone()));
            }
            if !self.presentation_type.is_empty() {
                map.insert("presentationType".to_string(), serde_json::Value::String(self.presentation_type.clone()));
            }
            if !self.sort.is_empty() {
                map.insert("sort".to_string(), serde_json::Value::String(self.sort.clone()));
            }
            serde_json::Value::Object(map)
        }
    }

    pub fn schedules_list(input: &ScheduleListInput) -> Result<serde_json::Value, CallError> {
        call_json(SCHEDULES_LIST, &input.to_value())
    }

    pub fn schedules_get(id: &str) -> Result<serde_json::Value, CallError> {
        call_json(SCHEDULES_GET, &ById { id: id.to_string() })
    }

    pub fn groups_list(input: &ListInput) -> Result<serde_json::Value, CallError> {
        call_json(GROUPS_LIST, input)
    }

    pub fn groups_get(id: &str) -> Result<serde_json::Value, CallError> {
        call_json(GROUPS_GET, &ById { id: id.to_string() })
    }
}

// ---------------------------------------------------------------- managed

pub mod managed {
    //! `managed-presentations.manage@1`: the package's own managed data
    //! source, widget, and playlist. Guests never name other rows.
    use super::{CallError, Empty, call_json};
    use serde::{Deserialize, Serialize};
    use std::string::String;

    pub const ENSURE: &str = "managed-presentations.manage@1/ensure";
    pub const UPDATE_DATA: &str = "managed-presentations.manage@1/update-data";
    pub const GET: &str = "managed-presentations.manage@1/get";

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Managed {
        pub data_source_id: String,
        pub widget_id: String,
        pub playlist_id: String,
    }

    #[derive(Debug, Clone, Default, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct EnsureInput {
        pub name: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub description: String,
        pub data_source_provider: String,
        /// JSON document string.
        pub data_source_configuration: String,
        /// JSON document string.
        pub cached_payload: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub cache_category: String,
        /// RFC 3339 timestamp, or empty.
        #[serde(skip_serializing_if = "String::is_empty")]
        pub cache_expires_at: String,
        pub widget_provider: String,
        /// JSON object string. The host binds `dataSourceId` itself:
        /// guests name every other field, never the link.
        pub widget_configuration: String,
    }

    #[derive(Debug, Clone, Default, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateDataInput {
        /// JSON document string.
        pub configuration: String,
        /// JSON document string.
        pub cached_payload: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub cache_category: String,
        /// RFC 3339 timestamp, or empty.
        #[serde(skip_serializing_if = "String::is_empty")]
        pub cache_expires_at: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Updated {
        pub updated: bool,
    }

    pub fn ensure(input: &EnsureInput) -> Result<Managed, CallError> {
        call_json(ENSURE, input)
    }

    pub fn update_data(input: &UpdateDataInput) -> Result<Updated, CallError> {
        call_json(UPDATE_DATA, input)
    }

    pub fn get() -> Result<Managed, CallError> {
        call_json(GET, &Empty {})
    }
}

// ---------------------------------------------------------------- takeovers

pub mod takeovers {
    //! `takeovers.manage@1`: emergency takeovers under the canonical
    //! takeover rules.
    use super::{CallError, call_json};
    use crate::targets::Targets;
    use serde::{Deserialize, Serialize};
    use std::string::String;

    pub const ACTIVATE: &str = "takeovers.manage@1/activate";
    pub const CANCEL: &str = "takeovers.manage@1/cancel";

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ActivateInput {
        pub name: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub description: String,
        pub playlist_id: String,
        #[serde(flatten)]
        pub targets: Targets,
        /// RFC 3339 expiration within the maximum duration.
        pub expires_at: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Activated {
        pub id: String,
        pub status: String,
        pub affected_count: i64,
        pub expires_at: String,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CancelInput {
        pub id: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub reason: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Cancelled {
        pub id: String,
        pub status: String,
    }

    pub fn activate(input: &ActivateInput) -> Result<Activated, CallError> {
        call_json(ACTIVATE, input)
    }

    pub fn cancel(input: &CancelInput) -> Result<Cancelled, CallError> {
        call_json(CANCEL, input)
    }
}

// ---------------------------------------------------------------- users

pub mod users {
    //! `users.read-basic@1`: basic user directory facts. Identifiers,
    //! names, roles, and activity only.
    use super::{CallError, call_json};
    use serde::{Deserialize, Serialize};
    use std::string::String;
    use std::vec::Vec;

    pub const GET: &str = "users.read-basic@1/get";
    pub const SEARCH: &str = "users.read-basic@1/search";
    pub const LIST_BY_ROLE: &str = "users.read-basic@1/list-by-role";

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DirectoryUser {
        pub id: String,
        pub name: String,
        pub username: String,
        pub role: String,
        pub active: bool,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct GetInput {
        pub id: String,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct SearchInput {
        pub query: String,
        pub limit: i64,
    }

    #[derive(Debug, Clone, Serialize)]
    pub struct ByRoleInput {
        pub role: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Directory {
        pub items: Vec<DirectoryUser>,
    }

    pub fn get(id: &str) -> Result<DirectoryUser, CallError> {
        call_json(GET, &GetInput { id: id.into() })
    }

    pub fn search(query: &str, limit: i64) -> Result<Directory, CallError> {
        call_json(SEARCH, &SearchInput { query: query.into(), limit })
    }

    pub fn list_by_role(role: &str) -> Result<Directory, CallError> {
        call_json(LIST_BY_ROLE, &ByRoleInput { role: role.into() })
    }
}

// ---------------------------------------------------------------- audit

pub mod audit {
    //! `audit.write@1`: bounded package audit events. Actions must live
    //! under the `package.` namespace.
    use super::{CallError, call_json};
    use serde::{Deserialize, Serialize};
    use std::string::String;

    pub const WRITE: &str = "audit.write@1/write";

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WriteInput {
        pub action: String,
        pub resource_type: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub resource_id: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub resource_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub metadata: Option<serde_json::Value>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct Written {
        pub written: bool,
    }

    pub fn write(input: &WriteInput) -> Result<Written, CallError> {
        call_json(WRITE, input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_envelope_parses() {
        let answer: String = parse_envelope(br#"{"ok":true,"data":"Lobby"}"#).expect("parses");
        assert_eq!(answer, "Lobby");
    }

    #[test]
    fn failure_envelope_maps_to_domain_error() {
        let error = parse_envelope::<String>(br#"{"ok":false,"error":{"code":"not_found","message":"gone"}}"#)
            .expect_err("fails");
        assert_eq!(
            error,
            CallError::Domain(DomainError { code: "not_found".to_string(), message: "gone".to_string() })
        );
    }

    #[test]
    fn malformed_envelopes_fail_closed() {
        for raw in [&b""[..], &b"{"[..], br#"{"ok":true}"#, br#"{"ok":false}"#] {
            // A success envelope without data, or a failure envelope
            // without an error, is malformed either way.
            let parsed = parse_envelope::<String>(raw);
            assert!(parsed.is_err(), "{raw:?}");
        }
        // Success wins when both halves are present: the host never
        // sends this, but parsing must stay total.
        let both: String =
            parse_envelope(br#"{"ok":true,"data":"x","error":{"code":"c","message":"m"}}"#).expect("parses");
        assert_eq!(both, "x");
    }

    #[test]
    fn host_codes_map() {
        assert_eq!(host_error_from_code(-7), HostError::NoOperation);
        assert_eq!(host_error_from_code(-5), HostError::NoGrant);
        assert_eq!(host_error_from_code(-3), HostError::TooLarge);
        assert_eq!(host_error_from_code(-2), HostError::HostFailure);
        assert_eq!(host_error_from_code(-99), HostError::Unknown(-99));
    }

    #[test]
    fn oversize_input_is_refused() {
        assert!(check_input_size(&vec![0u8; MAX_INPUT_BYTES]).is_ok());
        assert_eq!(check_input_size(&vec![0u8; MAX_INPUT_BYTES + 1]), Err(CallError::Host(HostError::TooLarge)));
    }

    #[test]
    fn operation_tokens_are_stable() {
        // The registry owns these tokens; the SDK pins them so a rename
        // breaks the build here instead of failing at install review.
        for token in [
            organization::GET,
            instance::GET,
            screens::LIST,
            screens::GET,
            targets::RESOLVE,
            content::PLAYLISTS_LIST,
            content::PLAYLISTS_GET,
            content::LAYOUTS_LIST,
            content::LAYOUTS_GET,
            content::DATASOURCES_LIST,
            content::DATASOURCES_GET,
            content::SCHEDULES_LIST,
            content::SCHEDULES_GET,
            content::GROUPS_LIST,
            content::GROUPS_GET,
            managed::ENSURE,
            managed::UPDATE_DATA,
            managed::GET,
            takeovers::ACTIVATE,
            takeovers::CANCEL,
            users::GET,
            users::SEARCH,
            users::LIST_BY_ROLE,
            audit::WRITE,
        ] {
            let (capability, method) = token.split_once('/').expect("operation/method");
            let (id, version) = capability.split_once('@').expect("id@version");
            assert!(!id.is_empty() && !method.is_empty());
            assert_eq!(version, "1", "{token}");
        }
    }

    #[test]
    fn schedule_list_input_names_the_type_field() {
        let input = content::ScheduleListInput { schedule_type: "custom".to_string(), ..Default::default() };
        let value = input.to_value();
        assert_eq!(value["type"], "custom");
        assert!(value.get("schedule_type").is_none());
    }

    #[test]
    fn list_input_omits_zeros() {
        let raw = serde_json::to_string(&ListInput::default()).expect("serializes");
        assert_eq!(raw, "{}");
    }
}
