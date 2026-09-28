//! LAN discovery of Tilecast Servers through Avahi (M5).
//!
//! The server advertises `_tilecast._tcp` with TXT records `base-url`,
//! `installation-id`, `api-version` and the identity path
//! (docs/mdns-discovery.md). Each `discovery.list` runs one bounded browse
//! over Avahi's D-Bus API: browse until Avahi reports the cache is complete
//! or the deadline passes, resolve at most [`MAX_DISCOVERED_SERVERS`]
//! services, and keep only addresses that pass the player URL policy.
//!
//! Discovery is advisory. Choosing a result starts ordinary pairing, which
//! verifies installation identity before anything is sent. When the host
//! has no Avahi daemon or no system bus, the answer is `available: false`
//! and manual entry keeps working.

use std::collections::HashMap;
use std::time::Duration;

use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::method::{DiscoveredServer, DiscoveryListResult, MAX_DISCOVERED_SERVERS};
use edge_server::url_policy::normalize_server_url;
use futures_util::StreamExt as _;
use zbus::zvariant::OwnedObjectPath;

use crate::daemon::DaemonContext;

pub const SERVICE_TYPE: &str = "_tilecast._tcp";
const BROWSE_DEADLINE: Duration = Duration::from_secs(3);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_TXT_BYTES: usize = 1024;
/// Avahi's "unspecified" interface and protocol.
const UNSPEC: i32 = -1;

#[zbus::proxy(
    interface = "org.freedesktop.Avahi.Server",
    default_service = "org.freedesktop.Avahi",
    default_path = "/"
)]
trait AvahiServer {
    #[zbus(name = "ServiceBrowserPrepare")]
    fn service_browser_prepare(
        &self,
        interface: i32,
        protocol: i32,
        service_type: &str,
        domain: &str,
        flags: u32,
    ) -> zbus::Result<OwnedObjectPath>;

    #[allow(clippy::type_complexity, clippy::too_many_arguments)]
    #[zbus(name = "ResolveService")]
    fn resolve_service(
        &self,
        interface: i32,
        protocol: i32,
        name: &str,
        service_type: &str,
        domain: &str,
        aprotocol: i32,
        flags: u32,
    ) -> zbus::Result<(i32, i32, String, String, String, String, i32, String, u16, Vec<Vec<u8>>, u32)>;
}

#[zbus::proxy(interface = "org.freedesktop.Avahi.ServiceBrowser", default_service = "org.freedesktop.Avahi")]
trait ServiceBrowser {
    fn start(&self) -> zbus::Result<()>;
    fn free(&self) -> zbus::Result<()>;
    #[zbus(signal)]
    fn item_new(
        &self,
        interface: i32,
        protocol: i32,
        name: String,
        service_type: String,
        domain: String,
        flags: u32,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    fn all_for_now(&self) -> zbus::Result<()>;
}

/// TXT entries as `key=value` pairs, bounded.
pub fn parse_txt(records: &[Vec<u8>]) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let mut total = 0;
    for record in records.iter().take(32) {
        total += record.len();
        if total > MAX_TXT_BYTES {
            break;
        }
        let Ok(text) = std::str::from_utf8(record) else { continue };
        if let Some((key, value)) = text.split_once('=') {
            values.insert(key.to_ascii_lowercase(), value.to_owned());
        }
    }
    values
}

/// The address a resolved service offers, if the player URL policy allows
/// it. `base-url` wins; otherwise the resolved host and port.
pub fn server_url(txt: &HashMap<String, String>, host: &str, port: u16) -> Option<String> {
    if let Some(base) = txt.get("base-url") {
        return normalize_server_url(base).ok();
    }
    normalize_server_url(&format!("http://{host}:{port}")).ok()
}

async fn browse() -> zbus::Result<Vec<DiscoveredServer>> {
    let connection = zbus::Connection::system().await?;
    let server = AvahiServerProxy::new(&connection).await?;
    let path = server.service_browser_prepare(UNSPEC, UNSPEC, SERVICE_TYPE, "", 0).await?;
    let browser = ServiceBrowserProxy::builder(&connection).path(path)?.build().await?;
    let mut items = browser.receive_item_new().await?;
    let mut done = browser.receive_all_for_now().await?;
    browser.start().await?;
    let mut found: Vec<(i32, i32, String, String)> = Vec::new();
    let deadline = tokio::time::sleep(BROWSE_DEADLINE);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => break,
            _ = done.next() => break,
            item = items.next() => {
                let Some(item) = item else { break };
                if let Ok(args) = item.args()
                    && found.len() < MAX_DISCOVERED_SERVERS
                    && !found.iter().any(|(_, _, name, _)| *name == args.name)
                {
                    found.push((args.interface, args.protocol, args.name.clone(), args.domain.clone()));
                }
            }
        }
    }
    let _ = browser.free().await;
    let mut servers = Vec::new();
    for (interface, protocol, name, domain) in found {
        let resolved = tokio::time::timeout(
            RESOLVE_TIMEOUT,
            server.resolve_service(interface, protocol, &name, SERVICE_TYPE, &domain, UNSPEC, 0),
        )
        .await;
        let Ok(Ok((_, _, _, _, _, host, _, _, port, txt, _))) = resolved else { continue };
        let Some(url) = server_url(&parse_txt(&txt), &host, port) else { continue };
        if servers.iter().any(|known: &DiscoveredServer| known.server_url.as_str() == url) {
            continue;
        }
        servers.push(DiscoveredServer { name: SafeText::lossy(&name), server_url: SafeText::lossy(&url) });
    }
    Ok(servers)
}

pub async fn list(_context: &DaemonContext) -> DiscoveryListResult {
    match tokio::time::timeout(BROWSE_DEADLINE + RESOLVE_TIMEOUT * 4, browse()).await {
        Ok(Ok(servers)) => DiscoveryListResult { available: true, servers },
        Ok(Err(error)) => {
            tracing::info!(component = "discovery", event = "avahi_unavailable", error = %error);
            DiscoveryListResult { available: false, servers: Vec::new() }
        }
        Err(_) => DiscoveryListResult { available: true, servers: Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_base_url_must_pass_the_player_url_policy() {
        let txt = parse_txt(&[b"base-url=http://signs.local:8080/".to_vec(), b"api-version=v1".to_vec()]);
        assert_eq!(server_url(&txt, "ignored.local", 1), Some("http://signs.local:8080".to_owned()));
        // A public host over plain HTTP is refused, even from the LAN.
        let public = parse_txt(&[b"base-url=http://signs.example.org".to_vec()]);
        assert_eq!(server_url(&public, "signs.local", 8080), None);
        // Without base-url the resolved host is used, under the same policy.
        assert_eq!(server_url(&HashMap::new(), "signs.local", 8080), Some("http://signs.local:8080".to_owned()));
        assert_eq!(server_url(&HashMap::new(), "8.8.8.8", 80), None);
    }

    #[test]
    fn txt_parsing_is_bounded_and_ignores_binary_entries() {
        let mut records = vec![vec![0xff, 0xfe], b"flag".to_vec()];
        records.extend((0..64).map(|i| format!("k{i}={}", "v".repeat(40)).into_bytes()));
        let parsed = parse_txt(&records);
        assert!(parsed.len() < 30, "{}", parsed.len());
        assert!(!parsed.contains_key("flag"));
    }
}
