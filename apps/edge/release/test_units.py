"""Invariants of the packaged systemd units that real hardware broke.

Release 0.2.0 failed on a Debian 13 screen in three ways that these tests keep
out of every later release (docs/records/edge/0.2.1-sandbox-review.md): the
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
