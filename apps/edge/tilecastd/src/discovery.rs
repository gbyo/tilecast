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
use futures_util::{Stream, StreamExt as _};
use zbus::zvariant::{ObjectPath, OwnedObjectPath};
use zbus::{MatchRule, Message, MessageStream, message::Type};

use crate::daemon::DaemonContext;

pub const SERVICE_TYPE: &str = "_tilecast._tcp";
const AVAHI: &str = "org.freedesktop.Avahi";
const BROWSER_INTERFACE: &str = "org.freedesktop.Avahi.ServiceBrowser";
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
    #[zbus(name = "ServiceBrowserNew")]
    fn service_browser_new(
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
    fn free(&self) -> zbus::Result<()>;
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
    // The classic Server API works on Avahi before and after 0.8. Subscribe
    // before New can send cached results, and read ItemNew and AllForNow in
    // their original order.
    let owner = zbus::fdo::DBusProxy::new(&connection).await?.get_name_owner(AVAHI.try_into()?).await?;
    let rule = MatchRule::builder().msg_type(Type::Signal).sender(owner)?.interface(BROWSER_INTERFACE)?.build();
    let signals = MessageStream::for_match_rule(rule, &connection, Some(128)).await?;
    let path = server.service_browser_new(UNSPEC, UNSPEC, SERVICE_TYPE, "", 0).await?;
    let browser = ServiceBrowserProxy::builder(&connection).path(path.clone())?.build().await?;
    let found = collect_services(signals, &path).await;
    let _ = browser.free().await;
    let mut servers = Vec::new();
    for (interface, protocol, name, domain) in found? {
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

async fn collect_services(
    mut signals: impl Stream<Item = zbus::Result<Message>> + Unpin,
    path: &ObjectPath<'_>,
) -> zbus::Result<Vec<(i32, i32, String, String)>> {
    let mut found: Vec<(i32, i32, String, String)> = Vec::new();
    let deadline = tokio::time::sleep(BROWSE_DEADLINE);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => break,
            signal = signals.next() => {
                let signal = signal.ok_or_else(|| zbus::Error::Failure("Avahi browser signal stream ended".into()))??;
                let header = signal.header();
                if header.path() != Some(path) {
                    continue;
                }
                let member = header.member().map(|member| member.as_str());
                if member == Some("AllForNow") {
                    break;
                }
                if member == Some("ItemNew")
                    && found.len() < MAX_DISCOVERED_SERVERS
                    && let Ok((interface, protocol, name, _, domain, _)) =
                        signal.body().deserialize::<(i32, i32, String, String, String, u32)>()
                    && !found.iter().any(|(_, _, known, _)| *known == name)
                {
                    found.push((interface, protocol, name, domain));
                }
            }
        }
    }
    Ok(found)
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

    #[tokio::test]
    async fn a_browse_must_not_succeed_when_its_signal_stream_stops_early() {
        let path = ObjectPath::try_from("/browser").expect("valid object path");
        let item = Message::signal(&path, BROWSER_INTERFACE, "ItemNew")
            .expect("valid signal header")
            .build(&(0i32, 0i32, "Tilecast", SERVICE_TYPE, "local", 0u32))
            .expect("valid signal body");
        let ended = futures_util::stream::iter([Ok(item.clone())]);
        assert!(matches!(collect_services(ended, &path).await, Err(zbus::Error::Failure(_))));

        let failed = futures_util::stream::iter([Ok(item), Err(zbus::Error::InvalidReply)]);
        assert_eq!(collect_services(failed, &path).await, Err(zbus::Error::InvalidReply));
    }

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
