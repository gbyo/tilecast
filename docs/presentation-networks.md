# Presentation Networks

Presentation Networks let a supported Linux Player join a managed Wi-Fi
network temporarily for AirPlay Present and other local presentation features.
Ethernet remains the player's normal and default path. Tilecast does not turn a
second interface into a route for the server connection, WebSocket, heartbeats,
commands, downloads, or group RTP.

For a group AirPlay session, exactly one display is selected as the gateway. The
gateway joins Wi-Fi so an AirPlay sender can discover it; the gateway then fans
out compressed H.264 RTP over Ethernet to the followers. Followers do not join
Wi-Fi and never receive the Presentation Network credential.

```text
AirPlay sender
      |
    Wi-Fi
      |
Tilecast gateway
 Wi-Fi + Ethernet
      |
      | compressed H.264 RTP over Ethernet
      +--------> follower
      +--------> follower
      +--------> follower
```

Tilecast does not bridge VLANs, route traffic between VLANs, enable NAT or IP
forwarding, provide an mDNS reflector, or bypass access-point client isolation.
A successful Wi-Fi association therefore does not guarantee that an AirPlay
sender can discover the gateway: the sender must be able to reach the gateway's
Wi-Fi address, and the Wi-Fi network must permit peer-to-peer traffic.

## Supported authentication

Studio supports WPA2/WPA3 Personal PSK and WPA2-Enterprise PEAP/MSCHAPv2. An
Enterprise network may also specify an identity, anonymous identity, public CA
certificate, and domain-suffix match. Tilecast validates these fields before
they reach the player; arbitrary NetworkManager properties and website-style
credentials are not supported.

The Wi-Fi password or PSK is write-only in Studio. Editing a network with a
blank secret retains the saved credential; entering a new secret rotates it and
increments the configuration revision. List and detail APIs expose only whether
a credential is saved.

## Server encryption key

Set the following deployment environment variable on the Tilecast Server:

```text
TILECAST_PRESENTATION_NETWORK_KEY=
```

The value must decode to exactly 32 bytes. Tilecast accepts a 64-character hex
value or standard/raw, URL-safe standard/raw Base64 encoding of 32 bytes. For
example, an operator can generate a hex key with:

```sh
openssl rand -hex 32
```

The variable is optional for installations that do not use Presentation
Networks. If it is missing, Tilecast remains available, but creating or
provisioning a network credential fails closed and Studio reports that the key
is unavailable. If the value is present but malformed, the server refuses to
start with a configuration error rather than silently disabling encryption.

Credentials are sealed with AES-256-GCM. The PostgreSQL database and Tilecast
database backups contain ciphertext, not the key. Back up the key separately in
the deployment's secret store. Restoring a database without the same key makes
the stored credentials unreadable; the operator must re-enter them in Studio.
Restoring the key without the database does not recreate network definitions.
Tilecast does not put this key in database backups, settings exports, logs, or
the Studio API. There is no automatic key rotation workflow: to rotate it,
retain the old key long enough to read the existing credentials, re-enter or
rotate each network under the new key, then remove the old key and restart.
Plan this as an administrative migration and verify every assigned player.

## Linux player requirements

Presentation Networks are Linux-only. The player must have:

- NetworkManager and `nmcli` installed and running;
- a usable Wi-Fi adapter; and
- the root-owned `tilecast-networkd` helper installed and healthy.

The installer is available at `/install-presentation-network.sh` and installs
the helper at `/usr/local/lib/tilecast/tilecast-networkd`, its system unit at
`/etc/systemd/system/tilecast-networkd.service`, and the local socket at
`/run/tilecast/networkd.sock`. It does not install NetworkManager, change the
existing Ethernet profile, grant the kiosk account sudo, or add a general
NetworkManager/polkit privilege. The Electron kiosk process remains
unprivileged and communicates with the narrow root helper over the Unix socket.

The helper owns only Tilecast profiles named
`tilecast-presentation-<network-id>`. Profiles are installed in
NetworkManager's protected system connection store. A credential is held in
memory only while a profile is being installed; it is never written to the
player state file, `airplay-session.json`, a player command, process arguments,
or a log line. The helper deletes stale Tilecast profiles when assignment or
revision changes, and it removes the temporary active connection after AirPlay
stops or fails.

The sidecar Wi-Fi profile is configured with a higher route metric so Ethernet
stays the default route. If Ethernet stops being the default route, the player
disconnects the temporary Wi-Fi connection and reports
`ethernet_default_route_lost`.

## Studio and AirPlay behavior

Create networks under Settings → Presentation Networks, then assign one to a
Linux screen. Studio reports the server-derived readiness state, including
NetworkManager/helper availability, Wi-Fi adapter availability, installed
revision, connection state, failure code, and the last usable wired IPv4. The
assignment is durable configuration, so an offline player converges on it after
the next configuration sync; deleting or unassigning a network also reaches the
player and removes the old Tilecast profile.

When an operator starts AirPlay Present, the gateway is selected automatically.
If the target requires a Presentation Network, a gateway must be online,
Linux, AirPlay-capable, assigned to a network, able to manage Wi-Fi, and have a
usable wired IPv4 for group fan-out. A preferred gateway is used only when it
meets those requirements; otherwise an eligible member is selected. If no
member qualifies, Studio reports the most useful limitation instead of
starting an AirPlay session that cannot be discovered.

The AirPlay dialog uses the player's reported state for copy such as joining,
connected, authentication failure, SSID not found, DHCP failure, and loss of
the Ethernet default route. It does not expose raw NetworkManager output or
pretend to know progress the player has not reported.

## Troubleshooting

### No Wi-Fi adapter

Studio shows **Wi-Fi adapter unavailable**. Check that the adapter is visible
to the host and to NetworkManager (`nmcli device status`). Presentation
Networks do not make a USB or built-in adapter appear. AirPlay continues to use
the ordinary Ethernet path when the sender can already reach the player.

### NetworkManager is unavailable

Studio shows **NetworkManager unavailable** when `nmcli` is missing or the
service is not running. The installer deliberately does not install or enable
NetworkManager because doing so can migrate an existing Ethernet configuration.
If NetworkManager is the intended host network manager, enable it and restart
the helper:

```sh
sudo systemctl enable --now NetworkManager
sudo systemctl restart tilecast-networkd
```

### Helper missing or unhealthy

Check the system unit and socket:

```sh
sudo systemctl status tilecast-networkd
sudo journalctl -u tilecast-networkd --since today
stat /run/tilecast/networkd.sock
```

Re-run the server-published Presentation Network installer as root. The
installer verifies the embedded helper checksum before replacing it. Do not
grant the kiosk user sudo or replace the helper with an arbitrary script.

### Authentication failure

Studio shows **Presentation Network authentication failed**. Confirm the
network's security type, saved PSK/password, Enterprise identity, and CA/domain
configuration. Rotate the secret in Settings if the network administrator
changed it. The credential is intentionally not displayed for recovery.

### SSID not found or DHCP failure

For **SSID not found**, check radio coverage, the hidden-SSID setting, and that
the adapter can see the network with `nmcli device wifi list`. For
**DHCP/IP acquisition failure**, check the Wi-Fi VLAN's DHCP scope, address
pool, and policy for the player MAC address. A connected radio without an IPv4
address is not considered Presentation Network ready.

### Ethernet is no longer the default route

Check `ip route` and the NetworkManager connection metrics. Tilecast must not
modify the existing Ethernet profile. The temporary Tilecast Wi-Fi profile
must remain a sidecar; if it becomes the default route, the player tears it down
and reports `ethernet_default_route_lost`. Correct the host's NetworkManager
policy and retry the AirPlay preparation.

### No usable wired IPv4

Group AirPlay requires an explicit non-loopback wired IPv4 for every member so
the gateway never sends RTP to a temporary Wi-Fi address. Confirm that the
Ethernet interface has a lease and that the player heartbeat reports it. An
IPv6-only, loopback, multicast, link-local, or Wi-Fi address is not accepted as
the group RTP destination.

### Wi-Fi association succeeds but AirPlay does not appear

Check that the AirPlay sender and the gateway can reach each other on the Wi-Fi
network, that UDP 5353/mDNS is permitted, and that access-point client
isolation is disabled or otherwise compatible with the deployment. Tilecast
does not provide an mDNS reflector, bridge VLANs, NAT, or a client-isolation
bypass. A successful Presentation Network readiness state only proves that the
player joined the Wi-Fi network and preserved Ethernet; it does not prove
sender discovery.

### Stale Presentation Network configuration

If a network was renamed, reassigned, deleted, or rotated while a player was
offline, wait for the next configuration sync or use the screen's **Sync now**
operation. The desired assignment and revision are durable, and the player
removes obsolete `tilecast-presentation-*` profiles before installing the
current one. Do not delete unrelated NetworkManager profiles.

On Linux Edge, a provisioning failure that can pass by itself is retried without
a new configuration. These failures are an unreachable server credential
endpoint, a helper that refused the profile install, and a helper that was not
running. Edge retries after 30 seconds, then after twice as long each time, up
to five minutes, until the profile installs. A failed connection test is not retried, so its status stays visible.
