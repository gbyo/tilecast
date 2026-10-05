//! LAN discovery: browse `_tilecast._tcp.local.` for advertised Tilecast
//! servers. A browse is a bounded one-shot scan behind `discovery.list`;
//! manual server entry always works when multicast does not.

use std::time::{Duration, Instant};

/// The service type the server advertises (docs/mdns-discovery.md).
pub const SERVICE_TYPE: &str = "_tilecast._tcp.local.";
/// How long one `discovery.list` call listens for answers.
pub const BROWSE_TIMEOUT: Duration = Duration::from_secs(3);
/// The Edge bound: at most this many servers per answer.
pub const MAX_SERVERS: usize = 32;
/// The Edge `SafeText` bounds, mirrored so Studio sees one shape.
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_URL_BYTES: usize = 512;
/// The TXT key carrying the server URL (server `internal/discovery`).
pub const BASE_URL_KEY: &str = "base-url";

/// One advertised server, in `DiscoveredServerV1` shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub name: String,
    pub server_url: String,
}

/// Builds a server from a resolved service instance. The `base-url` TXT
/// record must be an absolute lowercase HTTP(S) URL, as the server
/// advertises it; anything else (missing, relative, another scheme,
/// user information, overlong) is not an answer, and pairing
/// re-validates the URL against the full server-URL policy anyway.
pub fn parse_service(fullname: &str, base_url: Option<&str>) -> Option<DiscoveredServer> {
    let url = base_url?.trim();
    if url.is_empty() || url.len() > MAX_URL_BYTES || !crate::remote_web::valid_url(url) {
        return None;
    }
    let name = fullname.strip_suffix(SERVICE_TYPE).unwrap_or(fullname).trim_end_matches('.').trim().to_owned();
    let name = if name.is_empty() { "Tilecast".to_owned() } else { name };
    let name = name.chars().take(MAX_NAME_CHARS).collect::<String>();
    Some(DiscoveredServer { name, server_url: url.trim_end_matches('/').to_owned() })
}

/// Browses for advertised servers, returning what resolved before the
/// timeout. An unusable multicast stack is an empty answer, never an
/// error: the setup surface falls back to manual entry.
pub async fn browse() -> Vec<DiscoveredServer> {
    tokio::task::spawn_blocking(scan).await.unwrap_or_default()
}

fn scan() -> Vec<DiscoveredServer> {
    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(daemon) => daemon,
        Err(_) => return Vec::new(),
    };
    let receiver = match daemon.browse(SERVICE_TYPE) {
        Ok(receiver) => receiver,
        Err(_) => return Vec::new(),
    };
    let deadline = Instant::now() + BROWSE_TIMEOUT;
    let mut servers = Vec::new();
    while servers.len() < MAX_SERVERS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let event = match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(event) => event,
            Err(_) => continue,
        };
        if let mdns_sd::ServiceEvent::ServiceResolved(resolved) = event
            && let Some(server) = parse_service(resolved.get_fullname(), resolved.get_property_val_str(BASE_URL_KEY))
            && !servers.iter().any(|known: &DiscoveredServer| known.server_url == server.server_url)
        {
            servers.push(server);
        }
    }
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_advertisements_parse() {
        let server = parse_service("Tilecast - Library._tilecast._tcp.local.", Some("http://tilecast.local:8080/"))
            .expect("parses");
        assert_eq!(server.name, "Tilecast - Library");
        assert_eq!(server.server_url, "http://tilecast.local:8080");
    }

    #[test]
    fn unusable_advertisements_are_silently_dropped() {
        assert!(parse_service("Tilecast._tilecast._tcp.local.", None).is_none());
        assert!(parse_service("Tilecast._tilecast._tcp.local.", Some("")).is_none());
        assert!(parse_service("Tilecast._tilecast._tcp.local.", Some("gopher://x/")).is_none());
        assert!(parse_service("Tilecast._tilecast._tcp.local.", Some("/relative/path")).is_none());
        assert!(parse_service("Tilecast._tilecast._tcp.local.", Some("http://")).is_none());
        let long = format!("http://x/{}/", "y".repeat(MAX_URL_BYTES));
        assert!(parse_service("Tilecast._tilecast._tcp.local.", Some(&long)).is_none());
    }

    #[test]
    fn names_fall_back_and_truncate() {
        let server = parse_service("_tilecast._tcp.local.", Some("http://x/")).expect("parses");
        assert_eq!(server.name, "Tilecast");
        let wide = format!("{}.{}", "n".repeat(MAX_NAME_CHARS + 40), SERVICE_TYPE);
        let server = parse_service(&wide, Some("http://x/")).expect("parses");
        assert_eq!(server.name.chars().count(), MAX_NAME_CHARS);
    }
}
