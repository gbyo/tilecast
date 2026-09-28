//! Server URL normalization and security policy.
//!
//! A port of the Linux player's `core/server-url.ts` (which matches Android's
//! `ServerUrlPolicy`), so a screen validates identically on every player:
//!
//! * a bare host defaults to `https://`;
//! * only `http` and `https`; no credentials, path, query or fragment;
//! * `http` only for loopback and private IPv4, IPv4 link-local, `localhost`
//!   and `.local`/`.localhost` names (never IPv6 literals, never public
//!   names);
//! * the result is the canonical origin, explicit port preserved.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlPolicyError {
    #[error("Enter a server address")]
    Empty,
    #[error("That is not a valid address")]
    Invalid,
    #[error("Address must be http or https")]
    Scheme,
    #[error("Address must not contain a username or password")]
    Credentials,
    #[error("Enter only the server address, without a path")]
    Path,
    #[error("Public servers must use https:// to protect the device credential")]
    InsecurePublic,
}

/// Hosts that may use plain HTTP. IPv6 literals never qualify: the existing
/// players reject them over HTTP too (AGENTS.md: private IPv4, link-local,
/// localhost and `.local` only).
fn is_private_or_local(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h.contains(':') || h.contains('[') {
        return false;
    }
    if h == "localhost" || h.ends_with(".local") || h.ends_with(".localhost") {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 {
        let octets: Option<Vec<u8>> = parts.iter().map(|p| p.parse::<u8>().ok()).collect();
        if let Some(o) = octets {
            return o[0] == 10
                || o[0] == 127
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168);
        }
    }
    false
}

/// Returns the canonical origin (`scheme://host[:port]`) or why the address
/// is rejected.
pub fn normalize_server_url(input: &str) -> Result<String, UrlPolicyError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(UrlPolicyError::Empty);
    }
    let with_scheme = if has_scheme(trimmed) { trimmed.to_owned() } else { format!("https://{trimmed}") };
    let (scheme, rest) = with_scheme.split_once("://").ok_or(UrlPolicyError::Invalid)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(UrlPolicyError::Scheme);
    }
    let (authority, tail) = match rest.find(['/', '?', '#']) {
        Some(index) => rest.split_at(index),
        None => (rest, ""),
    };
    if !(tail.is_empty() || tail == "/") {
        return Err(UrlPolicyError::Path);
    }
    if authority.contains('@') {
        return Err(UrlPolicyError::Credentials);
    }
    let (host, port) = split_host_port(authority)?;
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')) {
        return Err(UrlPolicyError::Invalid);
    }
    let host = host.to_ascii_lowercase();
    if scheme == "http" && !is_private_or_local(&host) {
        return Err(UrlPolicyError::InsecurePublic);
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    let port_part = match port {
        Some(port) if port != default_port => format!(":{port}"),
        _ => String::new(),
    };
    Ok(format!("{scheme}://{host}{port_part}"))
}

fn has_scheme(value: &str) -> bool {
    match value.find("://") {
        Some(index) => index > 0 && value[..index].chars().all(|c| c.is_ascii_alphabetic()),
        None => false,
    }
}

fn split_host_port(authority: &str) -> Result<(&str, Option<u16>), UrlPolicyError> {
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']').ok_or(UrlPolicyError::Invalid)?;
        let host = &authority[..end + 2];
        let after = &rest[end + 1..];
        return match after.strip_prefix(':') {
            Some(port) => Ok((host, Some(port.parse().map_err(|_| UrlPolicyError::Invalid)?))),
            None if after.is_empty() => Ok((host, None)),
            None => Err(UrlPolicyError::Invalid),
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            Ok((host, Some(port.parse().map_err(|_| UrlPolicyError::Invalid)?)))
        }
        Some(_) => Err(UrlPolicyError::Invalid),
        None => Ok((authority, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_player_policy() {
        assert_eq!(normalize_server_url(" signage.example.org/ ").unwrap(), "https://signage.example.org");
        assert_eq!(
            normalize_server_url("https://Signage.Example.org:8443").unwrap(),
            "https://signage.example.org:8443"
        );
        assert_eq!(normalize_server_url("https://signage.example.org:443").unwrap(), "https://signage.example.org");
        assert_eq!(normalize_server_url("http://192.168.1.20:8080").unwrap(), "http://192.168.1.20:8080");
        assert_eq!(normalize_server_url("http://tilecast.local").unwrap(), "http://tilecast.local");
        assert_eq!(normalize_server_url("http://10.0.0.5").unwrap(), "http://10.0.0.5");
        assert_eq!(normalize_server_url("https://[fd00::5]:8080").unwrap(), "https://[fd00::5]:8080");
        assert_eq!(normalize_server_url("http://[fd00::5]:8080"), Err(UrlPolicyError::InsecurePublic));
        assert_eq!(normalize_server_url("http://[::1]"), Err(UrlPolicyError::InsecurePublic));
        assert_eq!(normalize_server_url("http://signage.example.org"), Err(UrlPolicyError::InsecurePublic));
        assert_eq!(normalize_server_url("http://8.8.8.8"), Err(UrlPolicyError::InsecurePublic));
        assert_eq!(normalize_server_url("http://fdroid.example.org"), Err(UrlPolicyError::InsecurePublic));
        assert_eq!(normalize_server_url("ftp://host"), Err(UrlPolicyError::Scheme));
        assert_eq!(normalize_server_url("https://user:pw@host"), Err(UrlPolicyError::Credentials));
        assert_eq!(normalize_server_url("https://host/api"), Err(UrlPolicyError::Path));
        assert_eq!(normalize_server_url("https://host?x=1"), Err(UrlPolicyError::Path));
        assert_eq!(normalize_server_url(""), Err(UrlPolicyError::Empty));
        assert_eq!(normalize_server_url("https://ho st"), Err(UrlPolicyError::Invalid));
    }
}
