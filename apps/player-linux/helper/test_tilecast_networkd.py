#!/usr/bin/env python3
"""Unit tests for the root-owned Presentation Network helper.

The helper is loaded from the server's embedded copy — the exact bytes a signage
box downloads and runs as root — so these tests cannot drift from what ships.

Everything privileged is faked: `nmcli` is a recorded call list, and the keyfile
and state directories are temporary. Nothing here requires a Wi-Fi adapter, a
NetworkManager daemon, or root, so CI needs none of them.

Run with:  python3 -m unittest discover -s apps/player-linux/helper
"""

from __future__ import annotations

import ast
import importlib.machinery
import importlib.util
import json
import os
import stat
import tempfile
import unittest
import uuid
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
HELPER_SOURCE = REPOSITORY_ROOT / "apps/server/internal/httpapi/install/tilecast-networkd"

NETWORK_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
OTHER_NETWORK_ID = "8f14e45f-ceea-467a-9575-6a1a0a1a0a1a"
PSK = "test-only-presentation-psk-2026"
ENTERPRISE_PASSWORD = "test-only-radius-secret-1"


def load_helper(environment: dict[str, str]):
    """Import the shipped helper with its paths pointed at a temporary tree."""
    for key, value in environment.items():
        os.environ[key] = value
    # The shipped helper has no .py suffix, so the loader is named explicitly
    # rather than inferred. Loading the exact bytes the server serves is the
    # point: a copy would let the tests and the artifact drift apart.
    loader = importlib.machinery.SourceFileLoader("tilecast_networkd", str(HELPER_SOURCE))
    specification = importlib.util.spec_from_loader(loader.name, loader)
    assert specification is not None
    module = importlib.util.module_from_spec(specification)
    loader.exec_module(module)
    return module


class FakeNmcli:
    """A recorded nmcli. Every call is captured so tests can assert on argv."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.connections: list[str] = []
        self.running = True
        self.radio = "enabled"
        self.devices = [("eth0", "ethernet", "connected"), ("wlan0", "wifi", "disconnected")]
        self.wifi_ipv4 = "10.40.5.71"
        self.wired_ipv4 = "10.10.2.15"
        self.active: list[str] = []
        self.up_result = (0, "", "")
        self.reload_result = (0, "", "")

    def __call__(self, arguments: list[str], timeout: int = 20):
        self.calls.append(list(arguments))
        joined = " ".join(arguments)
        if joined == "-t -f RUNNING general":
            return (0, "running\n" if self.running else "stopped\n", "")
        if joined == "-t radio wifi":
            return (0, self.radio + "\n", "")
        if joined == "radio wifi on":
            self.radio = "enabled"
            return (0, "", "")
        if joined == "radio wifi off":
            self.radio = "disabled"
            return (0, "", "")
        if joined == "-t -f DEVICE,TYPE,STATE device status":
            return (0, "".join(f"{d}:{k}:{s}\n" for d, k, s in self.devices), "")
        if arguments[:4] == ["-t", "-f", "IP4.ADDRESS", "device"]:
            device = arguments[-1]
            address = self.wifi_ipv4 if device == "wlan0" else self.wired_ipv4
            return (0, f"IP4.ADDRESS[1]:{address}/24\n" if address else "", "")
        if joined == "-t -f NAME connection show":
            return (0, "".join(name + "\n" for name in self.connections), "")
        if joined == "-t -f NAME connection show --active":
            return (0, "".join(name + "\n" for name in self.active), "")
        if joined == "connection reload":
            return self.reload_result
        if arguments[:3] == ["connection", "up", "id"]:
            if self.up_result[0] == 0:
                self.active.append(arguments[3])
            return self.up_result
        if arguments[:3] == ["connection", "down", "id"]:
            self.active = [name for name in self.active if name != arguments[3]]
            return (0, "", "")
        if arguments[:3] == ["connection", "delete", "id"]:
            self.connections = [name for name in self.connections if name != arguments[3]]
            return (0, "", "")
        return (0, "", "")


class HelperTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.keyfiles = root / "system-connections"
        self.state = root / "state"
        self.keyfiles.mkdir()
        self.state.mkdir()
        self.helper = load_helper({
            "TILECAST_NETWORKD_KEYFILE_DIR": str(self.keyfiles),
            "TILECAST_NETWORKD_STATE": str(self.state),
            "TILECAST_NETWORKD_SOCKET": str(root / "networkd.sock"),
        })
        self.nmcli = FakeNmcli()
        self.helper.run_nmcli = self.nmcli
        self.addCleanup(self.directory.cleanup)

    def request(self, payload: dict) -> dict:
        return self.helper.handle_request(json.dumps(payload).encode())

    def install(self, **overrides) -> dict:
        payload = {
            "op": "install",
            "networkId": NETWORK_ID,
            "revision": 3,
            "ssid": "District-Staff",
            "hidden": False,
            "security": "wpa_psk",
            "secret": PSK,
        }
        payload.update(overrides)
        # NetworkManager "accepting" the profile is modelled by the connection
        # appearing after reload, which is exactly what the helper verifies.
        name = self.helper.profile_name(payload.get("networkId", NETWORK_ID))
        original = self.nmcli.__call__

        def call(arguments, timeout=20):
            result = original(arguments, timeout)
            if arguments == ["connection", "reload"] and result[0] == 0:
                if name not in self.nmcli.connections:
                    self.nmcli.connections.append(name)
            return result

        self.helper.run_nmcli = call
        try:
            return self.request(payload)
        finally:
            self.helper.run_nmcli = original

    def keyfile(self, network_id: str = NETWORK_ID) -> str:
        return (self.keyfiles / f"tilecast-presentation-{network_id}.nmconnection").read_text()


class TestCapabilityProbe(HelperTestCase):
    def test_status_reports_facts_without_guessing(self) -> None:
        self.nmcli.connections = [self.helper.profile_name(NETWORK_ID)]
        self.helper.write_state(NETWORK_ID, 3, "wpa_psk")
        result = self.request({"op": "status"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["networkManagerAvailable"])
        self.assertTrue(result["wifiAdapter"])
        self.assertTrue(result["wiredInterfaceAvailable"])
        self.assertEqual(result["wiredIpv4"], "10.10.2.15")
        self.assertEqual(result["profiles"], [{"networkId": NETWORK_ID, "revision": 3}])
        self.assertNotIn("limitation", result)

    def test_network_manager_unavailable_is_reported_not_inferred(self) -> None:
        self.nmcli.running = False
        result = self.request({"op": "status"})
        self.assertTrue(result["ok"])
        self.assertFalse(result["networkManagerAvailable"])
        self.assertFalse(result["wifiAdapter"])
        self.assertIn("NetworkManager", result["limitation"])

    def test_missing_wifi_adapter_is_reported_with_a_reason(self) -> None:
        self.nmcli.devices = [("eth0", "ethernet", "connected")]
        result = self.request({"op": "status"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["networkManagerAvailable"])
        self.assertFalse(result["wifiAdapter"])
        self.assertIn("Wi-Fi adapter", result["limitation"])

    def test_a_profile_with_no_metadata_is_reported_as_stale(self) -> None:
        # A profile left by a previous install whose state file is gone must read
        # as revision 0 so the player replaces it rather than trusting it.
        self.nmcli.connections = [self.helper.profile_name(NETWORK_ID)]
        result = self.request({"op": "status"})
        self.assertEqual(result["profiles"], [{"networkId": NETWORK_ID, "revision": 0}])

    def test_unmanaged_wifi_device_is_not_usable(self) -> None:
        self.nmcli.devices = [("eth0", "ethernet", "connected"), ("wlan0", "wifi", "unmanaged")]
        result = self.request({"op": "status"})
        self.assertFalse(result["wifiAdapter"])


class TestProfileInstall(HelperTestCase):
    def test_psk_profile_is_a_sidecar_and_never_the_default_route(self) -> None:
        self.assertTrue(self.install()["ok"])
        contents = self.keyfile()
        self.assertIn("autoconnect=false", contents)
        self.assertIn("ssid=District-Staff", contents)
        self.assertIn("key-mgmt=wpa-psk", contents)
        # The three properties that keep Ethernet in charge.
        self.assertEqual(contents.count("never-default=true"), 2)
        self.assertEqual(contents.count("ignore-auto-dns=true"), 2)
        self.assertNotIn("gateway=", contents)
        # Nothing here reconfigures the machine's own interfaces.
        self.assertNotIn("interface-name=", contents)
        self.assertNotIn("[ethernet]", contents)

    def test_credential_is_written_only_to_a_root_only_keyfile(self) -> None:
        self.assertTrue(self.install()["ok"])
        path = self.keyfiles / f"tilecast-presentation-{NETWORK_ID}.nmconnection"
        mode = stat.S_IMODE(path.stat().st_mode)
        self.assertEqual(mode, 0o600, f"keyfile mode {oct(mode)} must be 0600")
        self.assertIn(PSK, path.read_text())
        # The credential must not reach the response, the state file, or argv.
        self.assertNotIn(PSK, json.dumps(self.install()))
        self.assertNotIn(PSK, (self.state / f"{NETWORK_ID}.json").read_text())
        for call in self.nmcli.calls:
            self.assertNotIn(PSK, " ".join(call), "a credential must never appear in a process argument")

    def test_state_file_records_the_revision_and_no_secret(self) -> None:
        self.assertTrue(self.install(revision=7)["ok"])
        state = json.loads((self.state / f"{NETWORK_ID}.json").read_text())
        self.assertEqual(state, {"networkId": NETWORK_ID, "revision": 7, "security": "wpa_psk"})
        mode = stat.S_IMODE((self.state / f"{NETWORK_ID}.json").stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_enterprise_profile_writes_peap_mschapv2(self) -> None:
        result = self.install(
            security="wpa_eap_peap_mschapv2",
            secret=ENTERPRISE_PASSWORD,
            identity="svc-signage@district.example.org",
            anonymousIdentity="anonymous@district.example.org",
        )
        self.assertTrue(result["ok"], result)
        contents = self.keyfile()
        self.assertIn("key-mgmt=wpa-eap", contents)
        self.assertIn("eap=peap", contents)
        self.assertIn("phase2-auth=mschapv2", contents)
        self.assertIn("identity=svc-signage@district.example.org", contents)
        self.assertIn("anonymous-identity=anonymous@district.example.org", contents)
        self.assertIn(f"password={ENTERPRISE_PASSWORD}", contents)

    def test_enterprise_ca_certificate_is_written_and_referenced(self) -> None:
        certificate = "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----"
        result = self.install(
            security="wpa_eap_peap_mschapv2",
            secret=ENTERPRISE_PASSWORD,
            identity="svc-signage",
            caCertificatePem=certificate,
            domainSuffixMatch="radius.district.example.org",
        )
        self.assertTrue(result["ok"], result)
        contents = self.keyfile()
        ca_path = self.state / f"{NETWORK_ID}-ca.pem"
        self.assertIn(f"ca-cert={ca_path}", contents)
        self.assertIn("domain-suffix-match=radius.district.example.org", contents)
        # A public certificate, not a secret.
        self.assertEqual(stat.S_IMODE(ca_path.stat().st_mode), 0o644)

    def test_profile_name_is_always_namespaced(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.assertEqual(
            self.helper.profile_name(NETWORK_ID),
            f"tilecast-presentation-{NETWORK_ID}",
        )
        self.assertIn(f"id=tilecast-presentation-{NETWORK_ID}", self.keyfile())

    def test_connection_uuid_is_stable_so_reinstall_replaces(self) -> None:
        first = self.helper.connection_uuid(NETWORK_ID)
        second = self.helper.connection_uuid(NETWORK_ID)
        self.assertEqual(first, second)
        self.assertNotEqual(first, self.helper.connection_uuid(OTHER_NETWORK_ID))
        uuid.UUID(first)

    def test_connection_uuid_equals_the_standard_version_5_uuid(self) -> None:
        # The helper computes it with hashlib because python3-minimal has no
        # uuid module. Existing profiles keep the identifiers they already have.
        for network_id in (NETWORK_ID, OTHER_NETWORK_ID, "ünï"):
            expected = uuid.uuid5(uuid.NAMESPACE_URL, "tilecast-presentation-network:" + network_id)
            self.assertEqual(self.helper.connection_uuid(network_id), str(expected))

    def test_the_helper_imports_only_modules_that_python3_minimal_has(self) -> None:
        # The Edge release runs the helper on python3-minimal. tempfile, uuid
        # and shutil are not in it, and the release sandbox check failed on that.
        allowed = {"__future__", "errno", "grp", "hashlib", "json", "os", "re", "socket", "subprocess", "sys"}
        imported = set()
        for node in ast.walk(ast.parse(HELPER_SOURCE.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertEqual(imported - allowed, set())

    def test_a_rejected_profile_leaves_no_credential_behind(self) -> None:
        self.nmcli.reload_result = (1, "", "Error: reload failed.")
        result = self.request({
            "op": "install", "networkId": NETWORK_ID, "revision": 1,
            "ssid": "District-Staff", "security": "wpa_psk", "secret": PSK,
        })
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "profile_reload_failed")
        self.assertFalse((self.keyfiles / f"tilecast-presentation-{NETWORK_ID}.nmconnection").exists())

    def test_keyfile_escaping_survives_backslash_and_trailing_space(self) -> None:
        self.assertEqual(self.helper.keyfile_escape("DISTRICT\\svc"), "DISTRICT\\\\svc")
        self.assertEqual(self.helper.keyfile_escape(" leading"), "\\sleading")
        self.assertEqual(self.helper.keyfile_escape("trailing "), "trailing\\s")
        self.assertEqual(self.helper.keyfile_escape("plain"), "plain")


class TestValidation(HelperTestCase):
    def test_unsupported_operation_is_refused(self) -> None:
        for payload in ({"op": "exec"}, {"op": "shell"}, {"op": ""}, {}):
            result = self.request(payload)
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "unsupported_operation")

    def test_only_the_five_tilecast_operations_exist(self) -> None:
        self.assertEqual(
            sorted(self.helper.OPERATIONS),
            ["activate", "deactivate", "delete", "install", "status"],
        )

    def test_network_id_must_be_a_uuid(self) -> None:
        for candidate in ("../../etc/passwd", "wlan0", "", "not-a-uuid", "*"):
            result = self.request({"op": "delete", "networkId": candidate})
            self.assertFalse(result["ok"], candidate)
            self.assertEqual(result["code"], "invalid_request")

    def test_ssid_bounds_and_charset(self) -> None:
        self.assertEqual(self.install(ssid="")["code"], "invalid_ssid")
        self.assertEqual(self.install(ssid="x" * 33)["code"], "invalid_ssid")
        self.assertEqual(self.install(ssid="net\nname")["code"], "invalid_ssid")
        self.assertEqual(self.install(ssid="Café-WiFi")["code"], "invalid_ssid")

    def test_security_type_must_be_validated(self) -> None:
        self.assertEqual(self.install(security="wep")["code"], "invalid_security")
        self.assertEqual(self.install(security="wpa_eap_tls")["code"], "invalid_security")

    def test_secret_bounds_and_charset(self) -> None:
        self.assertEqual(self.install(secret="")["code"], "invalid_secret")
        self.assertEqual(self.install(secret="x" * 129)["code"], "invalid_secret")
        self.assertEqual(self.install(secret="pass\nword")["code"], "invalid_secret")

    def test_rejection_messages_never_quote_the_credential(self) -> None:
        result = self.install(secret="secret\nvalue")
        self.assertNotIn("secret", result["message"].replace("credential", ""))
        self.assertNotIn("value", result["message"])

    def test_identity_charset_is_restricted(self) -> None:
        for identity in ("bad identity", "id\nentity", "id;entity", "a" * 254):
            result = self.install(
                security="wpa_eap_peap_mschapv2", secret=ENTERPRISE_PASSWORD, identity=identity)
            self.assertEqual(result["code"], "invalid_identity", identity)

    def test_certificate_must_be_certificates_only(self) -> None:
        for candidate in (
            "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----",
            "-----BEGIN CERTIFICATE-----\n<script>\n-----END CERTIFICATE-----",
            "not a certificate",
            "-----BEGIN CERTIFICATE-----\nQUJD",
        ):
            result = self.install(
                security="wpa_eap_peap_mschapv2", secret=ENTERPRISE_PASSWORD,
                identity="svc", caCertificatePem=candidate)
            self.assertEqual(result["code"], "invalid_certificate", candidate[:32])

    def test_domain_suffix_match_requires_a_ca(self) -> None:
        result = self.install(
            security="wpa_eap_peap_mschapv2", secret=ENTERPRISE_PASSWORD,
            identity="svc", domainSuffixMatch="radius.example.org")
        self.assertEqual(result["code"], "invalid_domain")

    def test_malformed_request_is_a_typed_response_not_a_crash(self) -> None:
        for raw in (b"not json", b"[]", b'"string"', b"", b"\xff\xfe"):
            result = self.helper.handle_request(raw)
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "invalid_request")

    def test_revision_must_be_a_positive_integer(self) -> None:
        for revision in (0, -1, "3", 1.5, True, None):
            self.assertEqual(self.install(revision=revision)["code"], "invalid_request", revision)


class TestActivation(HelperTestCase):
    def test_activation_reports_the_address_and_the_default_route(self) -> None:
        self.assertTrue(self.install()["ok"])
        result = self.request({"op": "activate", "networkId": NETWORK_ID, "timeoutSeconds": 60})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["ipv4"], "10.40.5.71")
        self.assertEqual(result["wiredIpv4"], "10.10.2.15")
        # The caller checks this: Ethernet has to remain the default route.
        self.assertIn("defaultRouteInterface", result)

    def test_activation_requires_an_installed_profile(self) -> None:
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "profile_missing")

    def test_activation_requires_a_wifi_adapter(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.devices = [("eth0", "ethernet", "connected")]
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertEqual(result["code"], "wifi_adapter_unavailable")

    def test_radio_prior_state_is_reported_so_it_can_be_restored(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.radio = "disabled"
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertTrue(result["ok"], result)
        # Tilecast enabled the radio, so the caller is told it may turn it back off.
        self.assertFalse(result["radioWasEnabled"])
        self.assertIn(["radio", "wifi", "on"], self.nmcli.calls)

    def test_an_already_enabled_radio_is_not_touched(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.radio = "enabled"
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertTrue(result["radioWasEnabled"])
        self.assertNotIn(["radio", "wifi", "on"], self.nmcli.calls)

    def test_authentication_failure_maps_to_a_stable_code(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.up_result = (4, "", "Error: Connection activation failed: Secrets were required, but not provided.")
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertEqual(result["code"], "authentication_failed")

    def test_missing_ssid_maps_to_a_stable_code(self) -> None:
        # NetworkManager words SSID_NOT_FOUND differently across releases, and an
        # operator has to be told "the network was not in range" for all of them.
        for message in (
            "Error: Connection activation failed: The Wi-Fi network could not be found.",
            "Error: Connection activation failed: No suitable network with SSID found.",
            "Error: Activation failed: SSID not found",
        ):
            self.assertTrue(self.install()["ok"])
            self.nmcli.up_result = (4, "", message)
            result = self.request({"op": "activate", "networkId": NETWORK_ID})
            self.assertEqual(result["code"], "ssid_not_found", message)

    def test_no_address_is_a_dhcp_timeout_and_tears_the_connection_down(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.wifi_ipv4 = ""
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertEqual(result["code"], "dhcp_timeout")
        self.assertIn(
            ["connection", "down", "id", self.helper.profile_name(NETWORK_ID)],
            self.nmcli.calls,
        )

    def test_a_failed_activation_restores_a_radio_tilecast_enabled(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.radio = "disabled"
        self.nmcli.up_result = (4, "", "Error: activation failed.")
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertFalse(result["ok"])
        self.assertIn(["radio", "wifi", "off"], self.nmcli.calls)

    def test_radio_that_cannot_be_enabled_is_a_stable_code(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.radio = "disabled"
        original = self.nmcli.__call__

        def call(arguments, timeout=20):
            if arguments == ["radio", "wifi", "on"]:
                self.nmcli.calls.append(list(arguments))
                return (1, "", "Error: failed to enable Wi-Fi.")
            return original(arguments, timeout)

        self.helper.run_nmcli = call
        result = self.request({"op": "activate", "networkId": NETWORK_ID})
        self.assertEqual(result["code"], "radio_unavailable")

    def test_timeout_bounds_are_enforced(self) -> None:
        self.assertTrue(self.install()["ok"])
        for timeout in (1, 0, 300, "60", None, True):
            result = self.request({"op": "activate", "networkId": NETWORK_ID, "timeoutSeconds": timeout})
            self.assertFalse(result["ok"], timeout)
            self.assertEqual(result["code"], "invalid_request")


class TestDeactivationAndCleanup(HelperTestCase):
    def test_deactivate_only_touches_the_tilecast_connection(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.nmcli.connections.append("Staff Laptop Wi-Fi")
        self.nmcli.active = [self.helper.profile_name(NETWORK_ID), "Staff Laptop Wi-Fi"]
        result = self.request({"op": "deactivate", "networkId": NETWORK_ID})
        self.assertTrue(result["ok"])
        down_calls = [call for call in self.nmcli.calls if call[:3] == ["connection", "down", "id"]]
        self.assertEqual(down_calls, [["connection", "down", "id", self.helper.profile_name(NETWORK_ID)]])
        self.assertIn("Staff Laptop Wi-Fi", self.nmcli.connections)

    def test_radio_is_left_enabled_unless_tilecast_enabled_it(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.request({"op": "deactivate", "networkId": NETWORK_ID})
        self.assertNotIn(["radio", "wifi", "off"], self.nmcli.calls)
        self.assertEqual(self.nmcli.radio, "enabled")

    def test_radio_is_restored_when_tilecast_enabled_it(self) -> None:
        self.assertTrue(self.install()["ok"])
        result = self.request({
            "op": "deactivate", "networkId": NETWORK_ID, "restoreRadioDisabled": True})
        self.assertTrue(result["radioRestored"])
        self.assertEqual(self.nmcli.radio, "disabled")

    def test_deactivate_keeps_the_saved_profile_for_the_next_session(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.request({"op": "deactivate", "networkId": NETWORK_ID, "restoreRadioDisabled": True})
        self.assertIn(self.helper.profile_name(NETWORK_ID), self.nmcli.connections)
        self.assertTrue((self.keyfiles / f"tilecast-presentation-{NETWORK_ID}.nmconnection").exists())

    def test_delete_removes_the_profile_and_all_local_material(self) -> None:
        certificate = "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----"
        self.assertTrue(self.install(
            security="wpa_eap_peap_mschapv2", secret=ENTERPRISE_PASSWORD,
            identity="svc", caCertificatePem=certificate)["ok"])
        result = self.request({"op": "delete", "networkId": NETWORK_ID})
        self.assertTrue(result["ok"])
        self.assertNotIn(self.helper.profile_name(NETWORK_ID), self.nmcli.connections)
        self.assertFalse((self.keyfiles / f"tilecast-presentation-{NETWORK_ID}.nmconnection").exists())
        self.assertFalse((self.state / f"{NETWORK_ID}.json").exists())
        self.assertFalse((self.state / f"{NETWORK_ID}-ca.pem").exists())

    def test_cleanup_is_idempotent(self) -> None:
        for _ in range(3):
            self.assertTrue(self.request({"op": "delete", "networkId": NETWORK_ID})["ok"])
            self.assertTrue(self.request({"op": "deactivate", "networkId": NETWORK_ID})["ok"])

    def test_cleanup_works_without_network_manager(self) -> None:
        self.nmcli.running = False
        self.assertTrue(self.request({"op": "delete", "networkId": NETWORK_ID})["ok"])
        self.assertTrue(self.request({"op": "deactivate", "networkId": NETWORK_ID})["ok"])

    def test_tilecast_never_lists_a_connection_outside_its_namespace(self) -> None:
        self.nmcli.connections = [
            "Wired connection 1", "Staff Laptop Wi-Fi", "tilecast-presentationXbad",
            "tilecast-presentation-not-a-uuid", self.helper.profile_name(NETWORK_ID),
        ]
        self.assertEqual(list(self.helper.tilecast_connections()), [NETWORK_ID])


class TestNoShellAnywhere(HelperTestCase):
    def test_the_helper_never_invokes_a_shell(self) -> None:
        source = HELPER_SOURCE.read_text()
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)
        self.assertNotIn("os.popen", source)
        self.assertNotIn("subprocess.getoutput", source)
        self.assertNotIn("eval(", source)
        self.assertNotIn("exec(", source)

    def test_every_nmcli_call_uses_a_fixed_argument_list(self) -> None:
        self.assertTrue(self.install()["ok"])
        self.request({"op": "activate", "networkId": NETWORK_ID})
        self.request({"op": "deactivate", "networkId": NETWORK_ID})
        self.request({"op": "delete", "networkId": NETWORK_ID})
        for call in self.nmcli.calls:
            self.assertIsInstance(call, list)
            for argument in call:
                self.assertIsInstance(argument, str)
                for character in ";|&$`\n<>":
                    self.assertNotIn(character, argument, f"{argument!r} in {call}")


class TestTerseParsing(HelperTestCase):
    def test_escaped_colons_do_not_shift_fields(self) -> None:
        # nmcli -t escapes a literal colon. Splitting naively would turn a MAC
        # address or a name containing a colon into extra fields.
        self.helper.run_nmcli = lambda arguments, timeout=20: (0, "a\\:b:wifi:connected\n", "")
        self.assertEqual(self.helper.nmcli_records(["x"]), [["a:b", "wifi", "connected"]])


if __name__ == "__main__":
    unittest.main()
