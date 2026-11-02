//! Package-owned plugin configuration and privacy-minimized Player state.
use crate::{CallError, call_json, targets_v2::Targets};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GET: &str = "plugin-runtime.state@1/get";
pub const CONFIGURE: &str = "plugin-runtime.state@1/configure";
pub const PUBLISH: &str = "plugin-runtime.state@1/publish";
pub const CLEAR: &str = "plugin-runtime.state@1/clear";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub contribution_id: String,
    pub enabled: bool,
    pub configuration: Value,
    pub targets: Option<Targets>,
    pub configuration_revision: i64,
    pub state: Value,
    pub valid_until: Option<String>,
    pub published_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    pub contribution_id: String,
    pub enabled: bool,
    pub configuration: Value,
    pub targets: Targets,
    pub expected_configuration_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publish {
    pub contribution_id: String,
    pub configuration_revision: i64,
    pub state: Value,
    pub valid_until: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ByContribution<'a> {
    contribution_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Clear<'a> {
    contribution_id: &'a str,
    configuration_revision: i64,
}

pub fn get(contribution_id: &str) -> Result<View, CallError> {
    call_json(GET, &ByContribution { contribution_id })
}
pub fn configure(input: &Configure) -> Result<View, CallError> {
    call_json(CONFIGURE, input)
}
pub fn publish(input: &Publish) -> Result<View, CallError> {
    call_json(PUBLISH, input)
}
pub fn clear(contribution_id: &str, configuration_revision: i64) -> Result<View, CallError> {
    call_json(CLEAR, &Clear { contribution_id, configuration_revision })
}
