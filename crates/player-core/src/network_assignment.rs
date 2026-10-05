//! Optional Presentation Network assignment and provisioning policy.
use player_client::player_api::{is_uuid, network_security};
use serde_json::{Map, Value};

/// The non-secret assignment from the configuration's `presentationNetwork`
/// section. `assigned: false` is an instruction to remove every Tilecast
/// profile, not an absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub network_id: String,
    pub name: String,
    pub ssid: String,
    pub hidden: bool,
    pub security: &'static str,
    pub config_revision: i64,
    pub credential_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisioningDecision {
    Current,
    CredentialUnavailable,
    Install,
}

impl Assignment {
    pub fn provisioning_decision(&self, installed: &[(String, i64)]) -> ProvisioningDecision {
        if installed.iter().any(|(id, revision)| *id == self.network_id && *revision == self.config_revision) {
            ProvisioningDecision::Current
        } else if !self.credential_available {
            ProvisioningDecision::CredentialUnavailable
        } else {
            ProvisioningDecision::Install
        }
    }
}

/// An explicit unassignment removes all managed profiles. An absent section
/// is handled by the host and must not be converted to an unassignment.
pub fn obsolete_profiles(assignment: Option<&Assignment>, installed: &[(String, i64)]) -> Vec<String> {
    installed
        .iter()
        .filter(|(id, _)| !assignment.is_some_and(|assignment| assignment.network_id == *id))
        .map(|(id, _)| id.clone())
        .collect()
}

fn optional_text(section: &Map<String, Value>, key: &str, max_chars: usize) -> Result<String, &'static str> {
    match section.get(key) {
        Some(Value::String(text)) if text.chars().count() > max_chars => {
            Err("a Presentation Network field is too long")
        }
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Ok(String::new()),
    }
}

/// The reference player's `parsePresentationNetworkAssignment`: `Ok(None)`
/// for "not assigned", an error for anything half-understood.
pub fn parse_assignment(section: &Value) -> Result<Option<Assignment>, &'static str> {
    let Some(section) = section.as_object() else { return Ok(None) };
    if section.get("assigned") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let network_id = section
        .get("presentationNetworkId")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .ok_or("Presentation Network ID is invalid")?
        .to_ascii_lowercase();
    let ssid = section
        .get("ssid")
        .and_then(Value::as_str)
        .filter(|ssid| !ssid.is_empty() && ssid.chars().count() <= 32)
        .ok_or("Presentation Network SSID is invalid")?
        .to_owned();
    let security = section
        .get("security")
        .and_then(Value::as_str)
        .and_then(network_security)
        .ok_or("Presentation Network authentication type is unsupported")?;
    let config_revision = section
        .get("configRevision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 1)
        .ok_or("Presentation Network configuration revision is invalid")?;
    for (key, limit) in [("identity", 253), ("anonymousIdentity", 253), ("domainSuffixMatch", 253)] {
        optional_text(section, key, limit)?;
    }
    Ok(Some(Assignment {
        network_id,
        name: optional_text(section, "name", 120)?,
        ssid,
        hidden: section.get("hidden") == Some(&Value::Bool(true)),
        security,
        config_revision,
        credential_available: section.get("credentialAvailable") == Some(&Value::Bool(true)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn revisions_and_credentials_select_provisioning_without_host_mechanics() {
        let section = json!({"assigned":true,"presentationNetworkId":"6F0C2B1E-9D2A-4B7E-8F3A-2C1D0E9F8A7B",
            "ssid":"Library-AV","security":"wpa_psk","configRevision":2,"credentialAvailable":true});
        let mut assignment = parse_assignment(&section).unwrap().unwrap();
        assert_eq!(assignment.network_id, "6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b");
        let stale = vec![(assignment.network_id.clone(), 1), ("other-network".into(), 8)];
        assert_eq!(assignment.provisioning_decision(&stale), ProvisioningDecision::Install);
        assert_eq!(obsolete_profiles(Some(&assignment), &stale), vec!["other-network"]);
        assignment.credential_available = false;
        assert_eq!(assignment.provisioning_decision(&stale), ProvisioningDecision::CredentialUnavailable);
        let current = vec![(assignment.network_id.clone(), 2)];
        assert_eq!(
            assignment.provisioning_decision(&current),
            ProvisioningDecision::Current,
            "installed revision needs no credential fetch"
        );
        let unassigned = parse_assignment(&json!({"assigned":false})).unwrap();
        assert_eq!(
            obsolete_profiles(unassigned.as_ref(), &stale),
            stale.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()
        );
        for (key, invalid) in [
            ("presentationNetworkId", json!("invalid")),
            ("ssid", json!("")),
            ("security", json!("wep")),
            ("configRevision", json!(0)),
            ("identity", json!("x".repeat(254))),
        ] {
            let mut malformed = section.clone();
            malformed[key] = invalid;
            assert!(parse_assignment(&malformed).is_err(), "{key}");
        }
    }
}
