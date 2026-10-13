//! Canonical screen, group, location and explicit all-screen targets.
use crate::{CallError, ListInput, call_json};
use serde::{Deserialize, Serialize};

pub const RESOLVE: &str = "targets.resolve@2/resolve";
pub const OPTIONS: &str = "targets.resolve@2/options";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    All,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Targets {
    pub mode: Mode,
    #[serde(default)]
    pub screen_ids: Vec<String>,
    #[serde(default)]
    pub group_ids: Vec<String>,
    #[serde(default)]
    pub location_ids: Vec<String>,
}
impl Targets {
    pub fn all() -> Self {
        Self { mode: Mode::All, screen_ids: vec![], group_ids: vec![], location_ids: vec![] }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Screen,
    Group,
    Location,
}
#[derive(Serialize)]
pub struct OptionsInput {
    pub kind: Kind,
    #[serde(flatten)]
    pub page: ListInput,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionItem {
    pub id: String,
    pub name: String,
    pub kind: Kind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionsPage {
    pub items: Vec<OptionItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub can_select_all: bool,
}

pub fn resolve(targets: &Targets) -> Result<crate::targets::Resolved, CallError> {
    call_json(RESOLVE, targets)
}
pub fn options(input: &OptionsInput) -> Result<OptionsPage, CallError> {
    call_json(OPTIONS, input)
}
