//! Which interface the Edge fabric uses (RFC §13.4).
//!
//! * With `mesh.interfaces` set, the first listed interface that has an IPv4
//!   address is used, exactly as configured (loopback and wireless included:
//!   an explicit operator choice).
//! * Otherwise the interface carrying the IPv4 default route is used, and
//!   only if it is not wireless and its address is private or link-local.
//!   Wireless is refused by default because the Presentation Network runs
//!   on the Wi-Fi adapter (AirPlay sidecar) while the default route stays on
//!   Ethernet; serving or advertising the fabric there is forbidden.
//! * No routes are installed and nothing is bridged. Without a permitted
//!   interface the node is a standalone player with mesh `unavailable`.

use std::net::Ipv4Addr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub name: String,
    pub address: Ipv4Addr,
}

/// Why no interface was selected (a capability reason code).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NoDefaultRoute,
    NoAddress,
    Wireless,
    NotPrivate,
    ConfiguredMissing,
}

impl Refusal {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::NoDefaultRoute => "mesh_no_default_route",
            Self::NoAddress => "mesh_interface_no_ipv4",
            Self::Wireless => "mesh_interface_wireless",
            Self::NotPrivate => "mesh_interface_not_private",
            Self::ConfiguredMissing => "mesh_configured_interface_missing",
        }
    }
}

/// The legacy player's rule (`isWirelessInterfaceName`).
pub fn is_wireless(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["wl", "wlan", "wlp", "ath", "ra"].iter().any(|prefix| lower.starts_with(prefix))
}

fn is_private(address: Ipv4Addr) -> bool {
    address.is_private() || address.is_link_local()
}

/// Parses `/proc/net/route` for the IPv4 default route with the lowest
/// metric.
pub fn default_route_interface(route_table: &str) -> Option<String> {
    const RTF_UP: u32 = 0x1;
    route_table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (name, destination, flags, metric, mask) =
                (fields.first()?, fields.get(1)?, fields.get(3)?, fields.get(6)?, fields.get(7)?);
            let flags = u32::from_str_radix(flags, 16).ok()?;
            let default = *destination == "00000000" && *mask == "00000000" && flags & RTF_UP != 0;
            default.then(|| (metric.parse::<u32>().unwrap_or(u32::MAX), (*name).to_owned()))
        })
        .min()
        .map(|(_, name)| name)
}

fn ipv4_of(name: &str) -> Option<Ipv4Addr> {
    let addresses = nix::ifaddrs::getifaddrs().ok()?;
    for entry in addresses {
        if entry.interface_name == name
            && let Some(address) = entry.address.as_ref().and_then(|a| a.as_sockaddr_in())
        {
            return Some(address.ip());
        }
    }
    None
}

pub fn select(configured: &[String]) -> Result<Selected, Refusal> {
    if !configured.is_empty() {
        return configured
            .iter()
            .find_map(|name| ipv4_of(name).map(|address| Selected { name: name.clone(), address }))
            .ok_or(Refusal::ConfiguredMissing);
    }
    let table = std::fs::read_to_string("/proc/net/route").map_err(|_| Refusal::NoDefaultRoute)?;
    let name = default_route_interface(&table).ok_or(Refusal::NoDefaultRoute)?;
    if is_wireless(&name) {
        return Err(Refusal::Wireless);
    }
    let address = ipv4_of(&name).ok_or(Refusal::NoAddress)?;
    if !is_private(address) {
        return Err(Refusal::NotPrivate);
    }
    Ok(Selected { name, address })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTES: &str = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0
enp3s0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0
enp3s0\t0000000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
";

    #[test]
    fn picks_the_lowest_metric_default_route() {
        assert_eq!(default_route_interface(ROUTES).as_deref(), Some("enp3s0"));
        assert_eq!(default_route_interface("Iface\tDestination\n"), None);
    }

    #[test]
    fn wireless_names_follow_the_legacy_rule() {
        for name in ["wlp2s0", "wlan0", "ath0", "ra0", "WLAN1"] {
            assert!(is_wireless(name), "{name}");
        }
        for name in ["enp3s0", "eth0", "eno1", "lo"] {
            assert!(!is_wireless(name), "{name}");
        }
    }
}
