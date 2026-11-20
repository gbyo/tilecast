"""Tests for the developer diagnostics tools (no screen, no root, no WPE).

    python3 -m unittest discover -s apps/edge/renderer-wpe/diagnostics
"""
import contextlib
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pack_wpe_overlay  # noqa: E402
import sanitize_log  # noqa: E402
import tilecast_wpe_debug as tool  # noqa: E402
import visual_trace_report as report  # noqa: E402
import wpe_build_flags  # noqa: E402

C_FORMAT = HERE.parent / "src" / "visual-trace-format.c"
BUILD_WPE = HERE.parents[1] / "release" / "build-wpe.sh"


def tar_bytes(entries):
    """entries: [(name, bytes | None for a dir, kind)]"""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = data
                archive.addfile(info)
            else:
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def overlay_manifest(files, arch="x86_64", label="wpe-2.54.3"):
    return {
        "schema": "tilecast-wpe-overlay-v1",
        "label": label,
        "arch": arch,
        "webkitVersion": "2.54.3",
        "source": {"kind": "tarball", "version": "2.54.3"},
        "files": {path: {"sha256": hashlib.sha256(data).hexdigest()} for path, data in files.items()},
    }


def overlay_tar(files, manifest=None, extra=()):
    manifest = manifest or overlay_manifest(files)
    entries = [("wpe", None, "dir")]
    entries += [(f"wpe/{path}", data, "file") for path, data in files.items()]
    entries.append((f"wpe/{tool.OVERLAY_MANIFEST}", json.dumps(manifest).encode(), "file"))
    entries += list(extra)
    return tar_bytes(entries)


WEBKIT_FILES = {
    "lib/libWPEWebKit-2.0.so.1": b"webkit",
    "libexec/wpe-webkit-2.0/WPEWebProcess": b"web process",
}


class BuildFlags(unittest.TestCase):
    def test_reads_the_release_configuration(self):
        config = wpe_build_flags.read(BUILD_WPE)
        self.assertRegex(config["version"], r"^\d+\.\d+\.\d+$")
        self.assertRegex(config["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(config["prefix"], "/opt/tilecast-edge/current/lib/wpe")
        for flag in ("-DPORT=WPE", "-DENABLE_BUBBLEWRAP_SANDBOX=ON", "-DCMAKE_BUILD_TYPE=Release",
                     f"-DCMAKE_INSTALL_PREFIX={config['prefix']}", f"-DCMAKE_INSTALL_RPATH={config['prefix']}/lib"):
            self.assertIn(flag, config["flags"])
        self.assertFalse(any("$" in flag for flag in config["flags"]))

    def test_a_changed_script_shape_is_an_error(self):
        with tempfile.TemporaryDirectory() as work:
            script = Path(work) / "build-wpe.sh"
            script.write_text("WPE_VERSION=2.54.0\nWPE_SHA256=00\nPREFIX=/p\ncmake -S a -B b \\\n  -DPORT=WPE\n")
            with self.assertRaises(ValueError):
                wpe_build_flags.read(script)
            script.write_text("WPE_VERSION=2.54.0\nWPE_SHA256=00\nPREFIX=/p\n")
            with self.assertRaises(ValueError):
                wpe_build_flags.read(script)


class EnvironmentAllowlist(unittest.TestCase):
    def test_python_and_c_lists_agree(self):
        source = C_FORMAT.read_text()
        block = source[source.index("tc_trace_env_allowlist[] = {"):]
        block = block[:block.index("NULL")]
        self.assertEqual(tuple(re.findall(r'"([A-Z0-9_]+)"', block)), tool.ENV_ALLOWLIST)

    def test_matrix_uses_only_allowlisted_variables_one_at_a_time(self):
        matrix = json.loads((HERE / "compositor-matrix.json").read_text())
        baseline = {c["name"]: c["env"] for c in matrix["presets"]["baseline"]}
        self.assertEqual(baseline, {
            "skia": {},
            "texturemapper": {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"},
            "skia-cpu": {"WEBKIT_SKIA_ENABLE_CPU_RENDERING": "1"},
            "skia-show-damage": {"WEBKIT_SHOW_DAMAGE": "1"},
            "skia-show-fps": {"WEBKIT_SHOW_FPS": "1"},
        })
        for preset in matrix["presets"].values():
            for config in preset:
                tool.parse_env(f"{k}={v}" for k, v in config["env"].items())
                # One variable from the default, or one from a named sibling.
                self.assertTrue(len(config["env"]) <= 1 or "note" in config, config["name"])

    def test_parse_env_refuses_other_variables_and_values(self):
        self.assertEqual(tool.parse_env(["WEBKIT_USE_SKIA_FOR_COMPOSITION=0"]),
                         {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"})
        for bad in ["LD_PRELOAD=/tmp/x.so", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1", "WEBKIT_SHOW_FPS",
                    "WEBKIT_SHOW_FPS=1 2", "WEBKIT_DEBUG=$(id)", "WPE_BUFFER_FORMAT=" + "x" * 65]:
            with self.assertRaises(tool.Refused, msg=bad):
                tool.parse_env([bad])


SHOW = ("{ path=/opt/tilecast-edge/current/bin/tilecast-renderer-wpe ; argv[]=/opt/tilecast-edge/current/bin/"
        "tilecast-renderer-wpe --platform=drm --socket=/run/tilecast-edge/edge.sock "
        "--media-socket=/run/tilecast-edge/media.sock "
        "--runtime-dir=/opt/tilecast-edge/current/share/tilecast/renderer-web "
        "--gst-plugin-dir=/opt/tilecast-edge/current/lib/gstreamer-1.0 ; ignore_errors=no ; start_time=[n/a] }")


class TraceDropin(unittest.TestCase):
    def test_adds_only_the_trace_flags_and_allowlisted_environment(self):
        argv = tool.parse_exec_start(SHOW)
        self.assertEqual(argv[0], tool.RENDERER_BINARY)
        text = tool.trace_dropin(argv, 90, True, {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"})
        self.assertIn("ExecStart=\n", text)
        exec_line = next(line for line in text.splitlines() if line.startswith("ExecStart=/"))
        self.assertEqual(exec_line.split()[1:-3], argv[1:])
        self.assertTrue(exec_line.endswith("--visual-trace --visual-trace-seconds=90 --visual-trace-deep"))
        self.assertIn("Environment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0", text)
        self.assertNotIn("SANDBOX", text)

    def test_refuses_unknown_commands_and_bad_windows(self):
        with self.assertRaises(tool.Refused):
            tool.parse_exec_start(SHOW.replace("argv[]=/opt/tilecast-edge/current/bin/tilecast-renderer-wpe",
                                               "argv[]=/bin/sh"))
        with self.assertRaises(tool.Refused):
            tool.parse_exec_start(SHOW.replace("--platform=drm", "--platform=drm --visual-trace"))
        with self.assertRaises(tool.Refused):
            tool.parse_exec_start(SHOW.replace("--platform=drm", "--platform=$(id)"))
        with self.assertRaises(tool.Refused):
            tool.parse_exec_start("nothing")
        with self.assertRaises(tool.Refused):
            tool.trace_dropin(["x"], 3, False, {})


class Overlay(unittest.TestCase):
    def test_a_valid_overlay(self):
        manifest, files = tool.read_overlay_tar(overlay_tar(WEBKIT_FILES), "x86_64")
        self.assertEqual(manifest["label"], "wpe-2.54.3")
        self.assertEqual(files["lib/libWPEWebKit-2.0.so.1"], b"webkit")
        self.assertIn(tool.OVERLAY_MANIFEST, files)

    def test_refusals(self):
        tampered = dict(WEBKIT_FILES, **{"lib/libWPEWebKit-2.0.so.1": b"other"})
        cases = {
            "hash": overlay_tar(tampered, overlay_manifest(WEBKIT_FILES)),
            "extra file": overlay_tar(WEBKIT_FILES, extra=[("wpe/lib/evil.so", b"x", "file")]),
            "traversal": overlay_tar(WEBKIT_FILES, extra=[("wpe/../etc/passwd", b"x", "file")]),
            "absolute": overlay_tar(WEBKIT_FILES, extra=[("/wpe/x", b"x", "file")]),
            "outside": overlay_tar(WEBKIT_FILES, extra=[("other/x", b"x", "file")]),
            "symlink": overlay_tar(WEBKIT_FILES, extra=[("wpe/lib/link.so", "/etc/shadow", "symlink")]),
            "arch": overlay_tar(WEBKIT_FILES, overlay_manifest(WEBKIT_FILES, arch="aarch64")),
            "label": overlay_tar(WEBKIT_FILES, overlay_manifest(WEBKIT_FILES, label="../x")),
            "no webkit": overlay_tar({"lib/x.so": b"x"}),
        }
        for name, data in cases.items():
            with self.assertRaises(tool.Refused, msg=name):
                tool.read_overlay_tar(data, "x86_64")
        with self.assertRaises(tool.Refused):
            tool.read_overlay_tar(tar_bytes([("wpe/lib/libWPEWebKit-2.0.so.1", b"x", "file")]), "x86_64")

    def test_dropin_binds_read_only_over_the_fixed_prefix(self):
        text = tool.overlay_dropin(Path("/var/lib/tilecast-wpe-debug/overlays/a/wpe"),
                                   "/opt/tilecast-edge/current/lib/wpe", "a")
        self.assertIn("BindReadOnlyPaths=/var/lib/tilecast-wpe-debug/overlays/a/wpe:"
                      "/opt/tilecast-edge/current/lib/wpe\n", text)
        self.assertNotIn("ExecStart", text)

    def test_pack_round_trip(self):
        with tempfile.TemporaryDirectory() as work:
            prefix = Path(work) / "prefix"
            (prefix / "lib" / "pkgconfig").mkdir(parents=True)
            (prefix / "libexec" / "wpe-webkit-2.0").mkdir(parents=True)
            (prefix / "include" / "wpe-webkit-2.0" / "wpe").mkdir(parents=True)
            (prefix / "lib" / "libWPEWebKit-2.0.so.1.5.3").write_bytes(b"webkit")
            os.symlink("libWPEWebKit-2.0.so.1.5.3", prefix / "lib" / "libWPEWebKit-2.0.so.1")
            os.symlink("libWPEWebKit-2.0.so.1", prefix / "lib" / "libWPEWebKit-2.0.so")
            (prefix / "lib" / "pkgconfig" / "wpe-webkit-2.0.pc").write_text("x")
            process = prefix / "libexec" / "wpe-webkit-2.0" / "WPEWebProcess"
            process.write_bytes(b"process")
            process.chmod(0o755)
            (prefix / "include" / "wpe-webkit-2.0" / "wpe" / "WebKitVersion.h").write_text(
                "#define WEBKIT_MAJOR_VERSION (2)\n#define WEBKIT_MINOR_VERSION (54)\n#define WEBKIT_MICRO_VERSION (3)\n")
            target, version = pack_wpe_overlay.pack(prefix, "wpe-2.54.3", "x86_64",
                                                    {"kind": "tarball", "version": "2.54.3"}, Path(work) / "out")
            self.assertEqual(version, "2.54.3")
            data = target.read_bytes()
            manifest, files = tool.read_overlay_tar(data, "x86_64")
            # One file per library under its SONAME; no headers, pkg-config or links.
            self.assertEqual(sorted(manifest["files"]),
                             ["lib/libWPEWebKit-2.0.so.1", "libexec/wpe-webkit-2.0/WPEWebProcess"])
            self.assertEqual(files["lib/libWPEWebKit-2.0.so.1"], b"webkit")
            digest = (Path(work) / "out" / f"{target.name}.sha256").read_text().split()[0]
            self.assertEqual(digest, hashlib.sha256(data).hexdigest())
            with self.assertRaises(ValueError):
                pack_wpe_overlay.pack(prefix, "Bad Label", "x86_64", {}, Path(work) / "out")


class Lab(unittest.TestCase):
    def test_lab_bundle(self):
        good = tar_bytes([("lab/bin/tilecast-wpe-compositor-lab", b"elf", "file"),
                          ("lab/share/tilecast-wpe-lab/scenes/lab.js", b"js", "file")])
        self.assertIn("bin/tilecast-wpe-compositor-lab", tool.read_lab_tar(good))
        for bad in (tar_bytes([("lab/share/x", b"x", "file")]),
                    tar_bytes([("lab/bin/tilecast-wpe-compositor-lab", b"e", "file"), ("etc/x", b"x", "file")]),
                    tar_bytes([("lab/bin/tilecast-wpe-compositor-lab", "/bin/sh", "symlink")])):
            with self.assertRaises(tool.Refused):
                tool.read_lab_tar(bad)

    def test_lab_unit_keeps_webkit_sandbox_possible_and_mounts_the_overlay(self):
        paths = tool.Paths(root=Path("/tmp/none"))
        props = tool.lab_unit_properties(paths, Path("/r/run"), {"WEBKIT_SHOW_FPS": "1"}, Path("/o/wpe"))
        self.assertIn("User=tilecast", props)
        self.assertIn("Environment=WEBKIT_SHOW_FPS=1", props)
        self.assertIn("BindReadOnlyPaths=/o/wpe:/opt/tilecast-edge/current/lib/wpe", props)
        # These stop bubblewrap (docs/tilecast-edge-sandbox-review.md section 4).
        for forbidden in ("RestrictSUIDSGID", "ProtectKernelTunables", "ProtectKernelLogs", "RestrictNamespaces",
                          "SystemCallFilter", "WEBKIT_DISABLE_SANDBOX"):
            self.assertFalse(any(forbidden in prop for prop in props), forbidden)
        command = tool.lab_command(paths, "crossfade", "busy-end:no-pin", 5, "transitions", Path("/r/run"))
        self.assertIn("--scene=crossfade", command)
        self.assertIn("--variant=busy-end:no-pin", command)
        with self.assertRaises(tool.Refused):
            tool.lab_command(paths, "../x", None, 5, "off", Path("/r"))

    def test_version_matrix_plan(self):
        matrix = json.loads((HERE / "compositor-matrix.json").read_text())
        plan = tool.matrix_plan(matrix, "versions", ["release", "wpe-2.54.3"], ["crossfade"])
        self.assertEqual([(wpe, config["name"]) for wpe, config, _ in plan], [
            ("release", "skia"), ("release", "texturemapper"), ("release", "skia-cpu"),
            ("wpe-2.54.3", "skia"), ("wpe-2.54.3", "texturemapper"), ("wpe-2.54.3", "skia-cpu")])
        table = tool.matrix_table([tool.row({"scene": "crossfade", "result": "pass", "pacing": {"fps": 60},
                                             "anomalies": {"total": 0}, "_run": {"wpe": "release"}})])
        self.assertIn("| release |", table)


class Sanitizer(unittest.TestCase):
    SAMPLE = (
        "renderer: Authorization: Bearer tc_device_0f3c2a.SECRETSECRET\n"
        "pairing poll Authorization: Pairing pollsecret123\n"
        "server https://signage.example.org:8443/api/v1 unreachable\n"
        "media tcmedia://cap/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 failed\n"
        "activation 0b9f2c1e-8a4d-4f2b-9d3e-1a2b3c4d5e6f generation 4\n"
        "peer 192.168.40.12:443 and fe80::1:2:3:4 admin@example.org\n"
        "lobby-tv.school.lan says hello\n"
        "view: loaded libWPEWebKit-2.0.so.1 and runtime.js from tilecast-bridge.js\n"
    )

    def test_removes_everything_private_and_keeps_file_names(self):
        cleaned = sanitize_log.sanitize(self.SAMPLE)
        for secret in ("SECRETSECRET", "pollsecret123", "signage.example.org", "9f86d081", "0b9f2c1e",
                       "192.168.40.12", "fe80::1", "admin@", "lobby-tv"):
            self.assertNotIn(secret, cleaned)
        self.assertIn("libWPEWebKit-2.0.so.1", cleaned)
        self.assertIn("runtime.js", cleaned)
        self.assertEqual(sanitize_log.find_private(cleaned), [])

    def test_verification_catches_what_is_left_and_known_values(self):
        self.assertIn("url", sanitize_log.find_private("see https://x.example"))
        self.assertIn("credential", sanitize_log.find_private("tc_device_abc.def"))
        self.assertIn("known-private-value", sanitize_log.find_private("screen KIOSK-7 ready", ["kiosk-7"]))
        self.assertEqual(sanitize_log.find_private("tc_device_<redacted> Bearer <redacted>"), [])


class Bundle(unittest.TestCase):
    def test_drm_facts_read_ids_and_modes_only(self):
        with tempfile.TemporaryDirectory() as work:
            drm = Path(work) / "sys" / "class" / "drm"
            device = Path(work) / "devices" / "pci0" / "card0"
            (device / "drivers").mkdir(parents=True)
            (device / "drivers" / "i915").mkdir()
            for name, value in {"vendor": "0x8086", "device": "0x46a6", "subsystem_vendor": "0x1028",
                                "subsystem_device": "0x0b19"}.items():
                (device / name).write_text(value + "\n")
            os.symlink(device / "drivers" / "i915", device / "driver")
            (drm / "card0").mkdir(parents=True)
            os.symlink(device, drm / "card0" / "device")
            connector = drm / "card0-HDMI-A-1"
            connector.mkdir()
            (connector / "status").write_text("connected\n")
            (connector / "modes").write_text("1920x1080\n1280x720\n")
            (connector / "edid").write_bytes(b"\x00\xff serial number")
            facts = tool.drm_facts(tool.Paths(root=Path(work)))
            self.assertEqual(facts["cards"], [{"card": "card0", "driver": "i915", "vendor": "0x8086",
                                               "device": "0x46a6", "subsystemVendor": "0x1028",
                                               "subsystemDevice": "0x0b19"}])
            self.assertEqual(facts["connectors"][0]["name"], "HDMI-A-1")
            self.assertEqual(facts["connectors"][0]["modes"], ["1920x1080", "1280x720"])
            self.assertNotIn("serial", json.dumps(facts))

    def test_compositor_dropins(self):
        with tempfile.TemporaryDirectory() as work:
            paths = tool.Paths(root=Path(work))
            tool.write_dropin(paths, tool.RENDERER_UNIT, tool.TRACE_DROPIN,
                              tool.trace_dropin(["/x"], 60, False, {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"}))
            tool.write_dropin(paths, tool.RENDERER_UNIT, tool.OVERLAY_DROPIN,
                              tool.overlay_dropin(paths.overlays / "wpe-2.54.3" / "wpe", "/opt/x", "wpe-2.54.3"))
            self.assertEqual(tool.compositor_dropins(paths), {tool.RENDERER_UNIT: {
                "env": {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"}, "unset": [], "wpeOverlay": "wpe-2.54.3",
                "runtimeOverlay": None}})
            self.assertTrue(tool.remove_dropin(paths, tool.RENDERER_UNIT, tool.TRACE_DROPIN))
            self.assertFalse(tool.remove_dropin(paths, tool.RENDERER_UNIT, tool.TRACE_DROPIN))


def trace_lines():
    """A small trace: one stage crossfade whose fade ends on the compositor at
    t = 1000 + 300 ms and is cleaned up 40 ms later, with frames every 16.7 ms."""
    offset = 5_000_000  # mono = offset + t * 1000
    lines = [{"type": "header", "schema": "tilecast-visual-v1", "webkit": "2.54.0", "platform": "drm",
              "screen": {"refreshMilliHz": 60000}, "env": {}},
             {"type": "clock", "t0": offset + 500_000 - 100, "t1": offset + 500_000 + 100, "js": 500.0}]

    def runtime(t, ev, **fields):
        lines.append({"type": "runtime", "recv": offset + int(t * 1000) + 2000, "batch": 1, "sentAt": t,
                      "rec": {"t": t, "scope": "stage", "ev": ev, "tx": 1, **fields}})

    runtime(989, "stage.swap", kind="video", incoming="b")
    runtime(990, "swap.stack")
    runtime(990.1, "fade.pin")
    runtime(990.2, "anim.create", anim=1, label="fade-in")
    runtime(1001, "anim.ready", anim=1, label="fade-in", startTime=1000.0, currentTime=1.0, playState="running")
    runtime(1340, "anim.finish", anim=1, label="fade-in", currentTime=300.0, playState="finished")
    runtime(1340.2, "fade.unpin")
    runtime(1340.4, "swap.settle")
    for i in range(30):
        mono = offset + 1_000_000 + int(i * 16_667)
        lines.append({"type": "frame", "ev": "rendered", "mono": mono, "seq": i + 1, "buf": 1 + i % 3})
    lines.sort(key=lambda line: line.get("mono", line.get("recv", 0)))
    return lines


class TraceReport(unittest.TestCase):
    def test_correlates_runtime_events_with_presented_frames(self):
        result = report.analyze(trace_lines())
        self.assertEqual(result["nominalIntervalMs"], 16.667)
        (transition,) = result["transitions"]
        self.assertEqual((transition["scope"], transition["tx"]), ("stage", 1))
        (window,) = transition["endWindows"]
        self.assertEqual(window["label"], "fade-in")
        self.assertAlmostEqual(window["ms"], 40.2, places=1)
        flagged = [item["seq"] for item in transition["flagged"] if "end-window" in item["flags"]]
        # Frames at 1300 to 1340.2 ms on the page clock: 18 (1283.3) is before.
        self.assertEqual(flagged, [19, 20, 21])
        events = [item["ev"] for item in transition["timeline"] if item["entry"] == "event"]
        self.assertEqual(events[0], "stage.swap")
        # A record's own `kind` (the item kind) never hides what it is.
        self.assertEqual(transition["timeline"][0]["kind"], "video")
        self.assertEqual(events[-1], "swap.settle")

    def test_text_output(self):
        out = io.StringIO()
        report.render_text(report.analyze(trace_lines()), out)
        text = out.getvalue()
        self.assertIn("WebKit 2.54.0 on drm", text)
        self.assertIn("<-- end-window", text)

    def test_documents_split_on_reload(self):
        lines = trace_lines()
        lines.append({"type": "runtime", "recv": 9_000_000, "batch": 1, "sentAt": 1,
                      "rec": {"t": 1, "scope": "trace", "ev": "start"}})
        self.assertEqual(len(report.documents(lines)), 2)


if __name__ == "__main__":
    unittest.main()
