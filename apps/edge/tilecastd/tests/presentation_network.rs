//! The Presentation Network client against the real root helper script
//! (`apps/server/internal/httpapi/install/tilecast-networkd`, the bytes a
//! player downloads), run unprivileged with `TILECAST_NETWORKD_ALLOW_
//! UNPRIVILEGED` and a fake `nmcli` whose state lives in a temporary file.
//! The helper's own unit tests (`apps/player-linux/helper/
//! test_tilecast_networkd.py`) use the same fake shape.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::Timestamp;
use edge_server::player_api::{NetworkProvisioning, network_provisioning};
use edge_state::{OpenOptions, StateDb};
use serde_json::{Value, json};
use tilecastd::presentation_network::{HelperClient, PresentationNetwork, Provisioner};

const NETWORK: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PSK: &str = "test-only-presentation-psk-2026";

fn helper_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server/internal/httpapi/install/tilecast-networkd")
}

/// A recorded nmcli: Ethernet up with an address, a Wi-Fi adapter with its
/// radio off, and connections that exist exactly when the helper wrote
/// their keyfile.
fn fake_nmcli(dir: &Path, keyfiles: &Path) -> (PathBuf, PathBuf) {
    let state = dir.join("nmcli-state.json");
    std::fs::write(&state, r#"{"radio": "disabled", "active": [], "calls": []}"#).unwrap();
    let script = dir.join("nmcli");
    std::fs::write(
        &script,
        format!(
            r#"#!/usr/bin/env python3
import json, os, sys
STATE = {state:?}
KEYFILES = {keyfiles:?}
args = sys.argv[1:]
with open(STATE) as handle:
    state = json.load(handle)
state["calls"].append(args)
joined = " ".join(args)
def names():
    return sorted(n[:-len(".nmconnection")] for n in os.listdir(KEYFILES) if n.endswith(".nmconnection"))
out = ""
if joined == "-t -f RUNNING general":
    out = "running\n"
elif joined == "-t radio wifi":
    out = state["radio"] + "\n"
elif joined == "radio wifi on":
    state["radio"] = "enabled"
elif joined == "radio wifi off":
    state["radio"] = "disabled"
elif joined == "-t -f DEVICE,TYPE,STATE device status":
    out = "eth0:ethernet:connected\nwlan0:wifi:disconnected\n"
elif args[:4] == ["-t", "-f", "IP4.ADDRESS", "device"]:
    device = args[-1]
    if device == "eth0":
        out = "IP4.ADDRESS[1]:10.10.2.15/24\n"
    elif device == "wlan0" and state["active"]:
        out = "IP4.ADDRESS[1]:10.40.5.71/24\n"
elif joined == "-t -f NAME connection show":
    out = "".join(n + "\n" for n in names())
elif joined == "-t -f NAME connection show --active":
    out = "".join(n + "\n" for n in state["active"])
elif args[:3] == ["connection", "up", "id"]:
    state["active"].append(args[3])
elif args[:3] == ["connection", "down", "id"]:
    state["active"] = [n for n in state["active"] if n != args[3]]
with open(STATE, "w") as handle:
    json.dump(state, handle)
sys.stdout.write(out)
"#,
            state = state.to_str().unwrap(),
            keyfiles = keyfiles.to_str().unwrap(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, state)
}

struct Helper {
    child: std::process::Child,
    socket: PathBuf,
    keyfiles: PathBuf,
    nmcli_state: PathBuf,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn start_helper(dir: &Path) -> Helper {
    let keyfiles = dir.join("system-connections");
    std::fs::create_dir_all(&keyfiles).unwrap();
    let (nmcli, nmcli_state) = fake_nmcli(dir, &keyfiles);
    let socket = dir.join("run/networkd.sock");
    let child = std::process::Command::new("python3")
        .arg(helper_source())
        .env("TILECAST_NETWORKD_ALLOW_UNPRIVILEGED", "1")
        .env("TILECAST_NETWORKD_SOCKET", &socket)
        .env("TILECAST_NETWORKD_STATE", dir.join("helper-state"))
        .env("TILECAST_NETWORKD_KEYFILE_DIR", &keyfiles)
        .env("TILECAST_NETWORKD_NMCLI", &nmcli)
        .env("TILECAST_NETWORKD_GROUP", "tilecast-test-group-that-does-not-exist")
        .spawn()
        .expect("python3 runs the shipped helper; this test needs python3");
    let helper = Helper { child, socket, keyfiles, nmcli_state };
    for _ in 0..100 {
        if helper.socket.exists() {
            return helper;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the helper never created {}", helper.socket.display());
}

#[derive(Default)]
struct FakeServer {
    calls: AtomicUsize,
    revision: std::sync::Mutex<i64>,
}

#[async_trait]
impl Provisioner for FakeServer {
    async fn provisioning(&self) -> Result<NetworkProvisioning, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let revision = *self.revision.lock().unwrap();
        network_provisioning(&json!({
            "presentationNetworkId": NETWORK, "name": "Library AV", "ssid": "Library-AV", "hidden": false,
            "security": "wpa_psk", "configRevision": revision,
            "profileName": format!("tilecast-presentation-{NETWORK}"),
            "auth": {"identity": "", "anonymousIdentity": "", "domainSuffixMatch": "", "caCertificatePem": ""},
            "secret": PSK,
        }))
        .ok_or_else(|| "invalid".to_owned())
    }
}

fn assigned(revision: i64) -> Value {
    json!({"assigned": true, "presentationNetworkId": NETWORK, "name": "Library AV", "ssid": "Library-AV",
        "hidden": false, "security": "wpa_psk", "configRevision": revision, "credentialAvailable": true})
}

fn now() -> Timestamp {
    Timestamp::parse("2026-09-25T12:00:00Z").unwrap()
}

fn nmcli_state(helper: &Helper) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&helper.nmcli_state).unwrap()).unwrap()
}

fn keyfile(helper: &Helper) -> PathBuf {
    helper.keyfiles.join(format!("tilecast-presentation-{NETWORK}.nmconnection"))
}

#[tokio::test]
async fn profiles_follow_the_assignment_through_the_real_helper_and_the_secret_is_never_kept() {
    let dir = tempfile::tempdir().unwrap();
    let helper = start_helper(dir.path()).await;
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let network = PresentationNetwork::new(HelperClient::new(&helper.socket), Some(db.clone()));
    let server = FakeServer::default();
    *server.revision.lock().unwrap() = 3;

    let capability = network.probe().await;
    assert!(capability.supported && capability.wifi_adapter && capability.wired_interface_available, "{capability:?}");
    assert_eq!(capability.wired_ipv4, "10.10.2.15");

    // Assigned: the credential is fetched once and the helper writes the profile.
    network.apply_configuration(Some(&assigned(3)), &server, now()).await;
    let (_, status) = network.status();
    assert_eq!(status.state, "provisioned", "{status:?}");
    assert_eq!(status.installed_revision, Some(3));
    let written = std::fs::read_to_string(keyfile(&helper)).unwrap();
    assert!(written.contains(PSK), "the helper writes the credential into NetworkManager's keyfile");
    assert_eq!(std::fs::metadata(keyfile(&helper)).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);

    // A current profile costs one status call and no credential fetch.
    network.apply_configuration(Some(&assigned(3)), &server, now()).await;
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    // A rotated credential (new revision) replaces it.
    *server.revision.lock().unwrap() = 4;
    network.apply_configuration(Some(&assigned(4)), &server, now()).await;
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
    assert_eq!(network.status().1.installed_revision, Some(4));

    // The connection test joins, checks the sidecar, then leaves and turns
    // off the radio that Tilecast turned on.
    let payload = json!({"presentationNetworkId": NETWORK, "timeoutSeconds": 30});
    let result = network.test_command(payload.as_object().unwrap(), &server, now).await;
    assert_eq!((result.success, result.code.as_str()), (true, "presentation_network_test_passed"), "{result:?}");
    let state = nmcli_state(&helper);
    assert_eq!(state["radio"], "disabled", "the radio is restored to off");
    assert_eq!(state["active"], json!([]), "the Tilecast connection is down again");
    let calls: Vec<String> = state["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| call.as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect::<Vec<_>>().join(" "))
        .collect();
    assert!(calls.iter().all(|call| !call.contains(PSK)), "the credential is never an nmcli argument");
    let persisted = db.run(|c| edge_state::repo::presentation_network::get(c)).await.unwrap();
    assert_eq!(persisted, Default::default(), "nothing is active and the safe default holds");

    // Unassigned is an instruction: the profile goes.
    network.apply_configuration(Some(&json!({"assigned": false})), &server, now()).await;
    assert_eq!(network.status().1.state, "unassigned");
    assert!(!keyfile(&helper).exists());

    // A test for a network this player was not assigned changes nothing.
    let result = network.test_command(payload.as_object().unwrap(), &server, now).await;
    assert_eq!(result.code, "presentation_network_not_assigned");

    // Local state never held the credential.
    db.checkpoint().unwrap();
    drop(db);
    for name in ["state.db", "state.db-wal"] {
        if let Ok(bytes) = std::fs::read(dir.path().join(name)) {
            assert!(!bytes.windows(PSK.len()).any(|window| window == PSK.as_bytes()), "{name} holds the credential");
        }
    }
}

#[tokio::test]
async fn a_connection_left_by_a_crash_is_taken_down_at_start() {
    let dir = tempfile::tempdir().unwrap();
    let helper = start_helper(dir.path()).await;
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let server = FakeServer::default();
    *server.revision.lock().unwrap() = 1;
    let network = PresentationNetwork::new(HelperClient::new(&helper.socket), Some(db.clone()));
    network.apply_configuration(Some(&assigned(1)), &server, now()).await;
    // A crash after activation: the connection is up and the record says
    // Tilecast turned the radio on.
    let mut state = nmcli_state(&helper);
    state["active"] = json!([format!("tilecast-presentation-{NETWORK}")]);
    state["radio"] = json!("enabled");
    std::fs::write(&helper.nmcli_state, state.to_string()).unwrap();
    let record = edge_state::repo::presentation_network::NetworkState {
        active_network_id: Some(NETWORK.into()),
        radio_was_enabled: false,
    };
    db.run(move |c| edge_state::repo::presentation_network::put(c, &record, now())).await.unwrap();

    let restarted = PresentationNetwork::new(HelperClient::new(&helper.socket), Some(db));
    restarted.cleanup_orphaned(now()).await;
    let state = nmcli_state(&helper);
    assert_eq!(state["active"], json!([]));
    assert_eq!(state["radio"], "disabled");
}
