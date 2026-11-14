"""Invariants of the packaged systemd units that real hardware broke.

Release 0.2.0 failed on a Debian 13 screen in three ways that these tests keep
out of every later release (docs/tilecast-edge-sandbox-review.md): the
renderer's home directory was the state directory its own unit hides, WebKit's
bubblewrap sandbox could not mount /proc under the unit's sandbox, and the
self-test host's runtime was fixed by moving it out of /run.
"""
from pathlib import Path
import re
import unittest

UNITS = Path(__file__).resolve().parents[1] / "packaging" / "systemd"
WPE_UNITS = (
    "tilecast-renderer.service",
    "tilecast-renderer-selftest.service",
    "tilecast-web-renderer.service",
    "tilecast-renderer-probe.service",
)
STATE = "/var/lib/tilecast-edge"


def parse(name):
    """{key: [values]} of a unit's [Service] section, repeated keys kept."""
    values = {}
    section = None
    for raw in (UNITS / name).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line
            continue
        if section == "[Service]" and "=" in line:
            key, value = line.split("=", 1)
            values.setdefault(key, []).append(value)
    return values


def environment(service):
    result = {}
    for value in service.get("Environment", []):
        for item in re.findall(r'(\w+)=("[^"]*"|\S+)', value):
            result[item[0]] = item[1].strip('"')
    return result


def cache_directories(service):
    return ["/var/cache/" + entry for value in service.get("CacheDirectory", []) for entry in value.split()]


class SandboxTests(unittest.TestCase):
    def test_no_unit_disables_the_webkit_sandbox(self):
        for path in UNITS.glob("*.service"):
            directives = [l for l in path.read_text().splitlines() if not l.lstrip().startswith("#")]
            self.assertNotIn("WEBKIT_DISABLE_SANDBOX", "\n".join(directives), path.name)

    def test_wpe_units_do_not_mount_over_proc(self):
        # ProtectKernelTunables= and ProtectKernelLogs= bind-mount over files
        # in /proc; the kernel then refuses the fresh /proc that WebKit's
        # bubblewrap mounts in a user namespace ("bwrap: Can't mount proc").
        # RestrictSUIDSGID= makes openat2() fail with ENOSYS, which bubblewrap
        # 0.12 and later does not survive.
        for name in WPE_UNITS:
            service = parse(name)
            for key in ("ProtectKernelTunables", "ProtectKernelLogs", "RestrictSUIDSGID", "ProtectProc", "ProcSubset"):
                self.assertNotIn(key, service, f"{name} sets {key}=, which breaks WebKit's own sandbox")

    def test_wpe_units_keep_every_isolation_that_does_not_break_the_sandbox(self):
        for name in WPE_UNITS:
            service = parse(name)
            for key, value in {
                "ProtectSystem": "strict",
                "ProtectHome": "yes",
                "PrivateTmp": "yes",
                "NoNewPrivileges": "yes",
                "ProtectKernelModules": "yes" if name != "tilecast-renderer-probe.service" else None,
            }.items():
                if value is not None:
                    self.assertEqual(service.get(key), [value], f"{name}: {key}")
            self.assertEqual(service.get("CapabilityBoundingSet"), [""], f"{name}: no capabilities")
            self.assertIn(f"-{STATE}", service.get("InaccessiblePaths", []), f"{name}: the daemon state is hidden")
            self.assertIn("User", service)
            self.assertNotIn("PrivateUsers", service)
            self.assertNotIn("RestrictNamespaces", service, f"{name}: WebKit creates namespaces")
            self.assertNotIn("SystemCallFilter", service, f"{name}: a filter breaks WebKit's helpers")
        # The two units that draw keep the address-family limit and the VT/GPU
        # access they had.
        self.assertIn("AF_UNIX", parse("tilecast-renderer.service")["RestrictAddressFamilies"][0])


class HomeTests(unittest.TestCase):
    def test_renderer_homes_never_resolve_into_the_hidden_state_directory(self):
        for name in ("tilecast-renderer.service", "tilecast-renderer-selftest.service"):
            service = parse(name)
            env = environment(service)
            roots = cache_directories(service)
            self.assertTrue(roots, f"{name} has a CacheDirectory=")
            for variable in ("HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"):
                self.assertIn(variable, env, f"{name} sets {variable}")
                path = env[variable]
                self.assertTrue(path.startswith("/var/cache/"), f"{name}: {variable}={path}")
                self.assertFalse((path + "/").startswith(STATE + "/"), f"{name}: {variable} resolves into {STATE}")
                self.assertIn(path, roots, f"{name}: systemd creates {variable}={path} (CacheDirectory=)")
            self.assertEqual(len({env[v] for v in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME")}), 3)

    def test_the_web_helper_home_is_its_own_state_directory(self):
        service = parse("tilecast-web-renderer.service")
        self.assertEqual(service["User"], ["tilecast-web"])
        self.assertIn("tilecast-web", service["StateDirectory"])
        sysusers = (UNITS.parent / "sysusers.d" / "tilecast-edge.conf").read_text()
        self.assertRegex(sysusers, r"(?m)^u tilecast-web - \"[^\"]*\" /var/lib/tilecast-web ")


class PresentationNetworkHelperTests(unittest.TestCase):
    """The release carries the existing root helper (docs/tilecast-edge-airplay.md
    section 8); it must stay narrow, optional and out of the renderer's reach."""

    def test_the_helper_runs_from_the_root_owned_release_tree(self):
        service = parse("tilecast-networkd.service")
        self.assertEqual(service["User"], ["root"])
        self.assertEqual(service["ExecStart"],
                         ["/usr/bin/python3 /opt/tilecast-edge/current/bin/tilecast-networkd"])
        self.assertEqual(service["NoNewPrivileges"], ["yes"])
        self.assertEqual(service["RestrictAddressFamilies"], ["AF_UNIX AF_NETLINK AF_INET AF_INET6"])

    def test_the_helper_never_installs_or_requires_network_manager(self):
        text = (UNITS / "tilecast-networkd.service").read_text()
        directives = [l for l in text.splitlines() if l and not l.lstrip().startswith("#")]
        self.assertIn("Wants=NetworkManager.service", directives)
        for line in directives:
            self.assertFalse(line.startswith(("Requires=", "BindsTo=", "Requisite=")), line)
        self.assertNotRegex("\n".join(directives), r"apt-get|dpkg|systemctl enable")

    def test_the_daemon_wants_the_helper_without_requiring_it(self):
        daemon = (UNITS / "tilecast-edge.service").read_text()
        directives = [l for l in daemon.splitlines() if not l.lstrip().startswith("#")]
        self.assertIn("Wants=tilecast-networkd.service", directives)
        for line in directives:
            if line.startswith(("Requires=", "BindsTo=", "Requisite=")):
                self.assertNotIn("tilecast-networkd", line)
        self.assertIn("tilecast-network", parse("tilecast-edge.service")["SupplementaryGroups"][0].split())

    def test_only_the_daemon_joins_the_helper_group(self):
        for path in UNITS.glob("*.service"):
            groups = [g for v in parse(path.name).get("SupplementaryGroups", []) for g in v.split()]
            if path.name != "tilecast-edge.service":
                self.assertNotIn("tilecast-network", groups, path.name)
        sysusers = (UNITS.parent / "sysusers.d" / "tilecast-edge.conf").read_text()
        self.assertRegex(sysusers, r"(?m)^g tilecast-network -")
        self.assertNotRegex(sysusers, r"(?m)^m \S+ tilecast-network")
        # The renderer inherits the account's groups, so the helper's socket
        # directory stays hidden from it.
        self.assertTrue(any(v.startswith("/run/tilecast:") for v in parse("tilecast-renderer.service")["TemporaryFileSystem"]))

    def test_the_release_stages_the_servers_helper_bytes(self):
        stage = (Path(__file__).with_name("stage-release.py")).read_text()
        self.assertIn('"bin/tilecast-networkd"', stage)
        source = Path(__file__).resolve().parents[2] / "server" / "internal" / "httpapi" / "install" / "tilecast-networkd"
        self.assertTrue(source.is_file())
        self.assertTrue(source.read_text().startswith("#!/usr/bin/env python3"))
        self.assertIn('"tilecast-networkd.service"', stage)


class SelfTestRuntimeTests(unittest.TestCase):
    def test_the_self_test_host_keeps_its_ephemeral_runtime_directory(self):
        service = parse("tilecast-edge-selftest.service")
        self.assertEqual(service["RuntimeDirectory"], ["tilecast-edge-selftest"])
        command = service["ExecStart"][0]
        self.assertNotIn("/var/cache", command)
        self.assertNotIn("--config", command)
        self.assertNotIn("--runtime-dir", command, "the runtime directory is the unit's RuntimeDirectory=")
        for key in ("StateDirectory", "CacheDirectory", "ReadWritePaths"):
            self.assertNotIn(key, service, "the self-test writes only to /run")
        renderer = parse("tilecast-renderer-selftest.service")
        self.assertIn("--socket=/run/tilecast-edge-selftest/edge.sock", renderer["ExecStart"][0])

    def test_failing_units_leave_their_own_account_for_the_migrator(self):
        for name, target in {
            "tilecast-renderer-probe.service": "drm-probe.err",
            "tilecast-edge-selftest.service": "selftest.err",
            "tilecast-renderer-selftest.service": "selftest-renderer.err",
        }.items():
            self.assertEqual(parse(name)["StandardError"], [f"truncate:/run/tilecast-edge-migrate/{target}"], name)


if __name__ == "__main__":
    unittest.main()
