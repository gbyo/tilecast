"""Tests for environment integrity and the diagnostic Tilecast overlay.

A FakeScreen stands in for systemd and /proc: it applies drop-ins in file name
order, honours Environment=, UnsetEnvironment= and BindReadOnlyPaths= the way
systemd does, and writes the /proc files of the process it "starts", so the
tool's real code reads what a real screen would show.

    python3 -m unittest discover -s apps/edge/renderer-wpe/diagnostics
"""
import contextlib
import hashlib
import io
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import environment as env_lib  # noqa: E402
import runtime_overlay  # noqa: E402
import tilecast_wpe_debug as tool  # noqa: E402
from test_diagnostics import SHOW  # noqa: E402

COMMIT = "c" * 40
RELEASE_BINARY = b"ELF tilecast-renderer-wpe 1.4.0 (no trace)"


def renderer_binary(identity):
    """A stand-in renderer with the trace option and the delimited build identity of src/visual-trace.c."""
    return b"ELF tilecast-renderer-wpe with visual-trace-seconds\0tilecast-build-id:" + identity.encode() + b"\0rest"


OVERLAY_BINARY = renderer_binary(COMMIT)
TEXTUREMAPPER = {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def runtime_files(traceable, tag):
    files = {
        "index.html": b"<html>" + tag.encode(),
        "runtime.js": b"var runtime=1;" + (b"globalThis.__tilecastVisualTrace;" if traceable else b""),
        "fonts/a.woff2": b"font",
        "tilecast-bridge.js": b"bridge",
        "tilecast-native-relay.js": b"relay",
    }
    if traceable:
        files["tilecast-visual-trace.js"] = b"sink"
    listed = [{"path": name, "sha256": sha(files[name])} for name in ("index.html", "runtime.js", "fonts/a.woff2")]
    files["runtime-manifest.json"] = json.dumps({"name": "runtime", "version": "1", "contractVersion": 1,
                                                 "files": listed}).encode()
    return files


def write_tree(directory, files):
    for name, data in files.items():
        path = Path(directory) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def parse_assignments(text, key):
    values = []
    for line in text.splitlines():
        if line.startswith(key + "="):
            values.append(line.split("=", 1)[1])
    return values


class FakeScreen:
    """A Tilecast Edge 1.4.0 screen: systemd, /proc and the release tree."""

    def __init__(self, work, release_traceable=False, unit_env=None, manager_env=None, etc_dropins=None,
                 ignore_unset=False, ignore_binds=False, web_extra_env=None):
        self.root = Path(work) / "root"
        self.paths = tool.Paths(root=self.root)
        self.unit_env = dict(unit_env or {})
        self.manager_env = dict(manager_env or {})
        self.ignore_unset, self.ignore_binds = ignore_unset, ignore_binds
        self.web_extra_env = dict(web_extra_env or {})
        self.restarts = 0
        self.pid = 4000
        self.running = False
        self.calls = []
        release = self.paths.release_link
        self.release_web_files = runtime_files(release_traceable, "release")
        self.release_binary = OVERLAY_BINARY if release_traceable else RELEASE_BINARY
        (release / "bin").mkdir(parents=True)
        (release / "bin" / "tilecast-renderer-wpe").write_bytes(self.release_binary)
        write_tree(release / "share/tilecast/renderer-web", self.release_web_files)
        files = [{"path": "bin/tilecast-renderer-wpe", "sha256": sha(self.release_binary)}]
        files += [{"path": f"share/tilecast/renderer-web/{n}", "sha256": sha(d)}
                  for n, d in self.release_web_files.items()]
        (release / "tilecast-edge-release.json").write_text(json.dumps(
            {"versionName": "1.4.0", "wpeWebkitVersion": "2.54.0", "files": files}))
        for name, text in (etc_dropins or {}).items():
            directory = self.paths.etc_units / f"{tool.RENDERER_UNIT}.d"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / name).write_text(text)

    # -- systemd --------------------------------------------------------------

    def dropin_files(self):
        found = []
        for base in (self.paths.etc_units, self.paths.run_units):
            directory = base / f"{tool.RENDERER_UNIT}.d"
            if directory.is_dir():
                found += list(directory.glob("*.conf"))
        return sorted(found, key=lambda path: path.name)

    def effective(self):
        env = {"HOME": "/var/cache/tilecast-renderer/home", **self.unit_env}
        for path in self.dropin_files():
            for line in parse_assignments(path.read_text(), "Environment"):
                env.update(env_lib.parse_environment_property(line))
        return env

    def unsets(self):
        entries = set()
        for path in self.dropin_files():
            for line in parse_assignments(path.read_text(), "UnsetEnvironment"):
                entries |= env_lib.parse_unset(line)
        return entries

    def binds(self):
        found = {}
        for path in self.dropin_files():
            for line in parse_assignments(path.read_text(), "BindReadOnlyPaths"):
                source, _, target = line.partition(":")
                found[target] = Path(source)
        return found

    def process_env(self):
        env = {**self.manager_env, **self.effective()}
        if not self.ignore_unset:
            entries = self.unsets()
            env = {name: value for name, value in env.items() if not env_lib.is_unset(name, value, entries)}
        return env

    def start(self):
        self.restarts += 1
        old = self.paths.proc / str(self.pid)
        shutil.rmtree(old, ignore_errors=True)
        shutil.rmtree(self.paths.proc / str(self.pid + 1), ignore_errors=True)
        self.pid += 10
        self.running = True
        binds = {} if self.ignore_binds else self.binds()
        binary = binds.get(tool.RENDERER_BINARY)
        web = binds.get(tool.RELEASE_WEB_TARGET)
        proc = self.paths.proc / str(self.pid)
        proc.mkdir(parents=True)
        environ = self.process_env()
        (proc / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in environ.items()) + b"\0")
        (proc / "comm").write_text("tilecast-render\n")
        (proc / "stat").write_text(f"{self.pid} (tilecast-render) S 1 1 1 0\n")
        (proc / "exe").write_bytes(binary.read_bytes() if binary else self.release_binary)
        target = proc / "root" / tool.RELEASE_WEB_TARGET.lstrip("/")
        if web:
            shutil.copytree(web, target)
        else:
            write_tree(target, self.release_web_files)
        child = self.paths.proc / str(self.pid + 1)
        child.mkdir(parents=True)
        (child / "environ").write_bytes(
            b"\0".join(f"{k}={v}".encode() for k, v in {**environ, **self.web_extra_env}.items()) + b"\0")
        (child / "comm").write_text("WPEWebProcess\n")
        (child / "stat").write_text(f"{self.pid + 1} (WPEWebProcess) S {self.pid} 1 1 0\n")

    def systemctl(self, *args, check=True):
        self.calls.append(args)
        command = args[0]
        if command == "show-environment":
            return "".join(f"{k}={v}\n" for k, v in self.manager_env.items())
        if command == "show":
            unit = args[-1]
            values = {
                "Environment": " ".join(f"{k}={v}" for k, v in self.effective().items()),
                "EnvironmentFiles": "",
                "DropInPaths": " ".join(str(path) for path in self.dropin_files()),
                "FragmentPath": "/usr/lib/systemd/system/tilecast-renderer.service",
                "UnsetEnvironment": " ".join(sorted(name if value is None else f"{name}={value}"
                                                    for name, value in self.unsets())),
                "ExecStart": SHOW,
                "MainPID": str(self.pid) if self.running and unit == tool.RENDERER_UNIT else "0",
                "ActiveState": "active" if self.running and unit == tool.RENDERER_UNIT else "inactive",
                "NRestarts": "0",
            }
            return "".join(f"{name[2:]}={values.get(name[2:], '')}\n" for name in args if name.startswith("-p"))
        if command == "is-active":
            return "active\n" if self.running and args[1] == tool.RENDERER_UNIT else "inactive\n"
        if command == "restart" and args[1] == tool.RENDERER_UNIT:
            self.start()
        return ""

    def restart_count(self):
        return sum(1 for call in self.calls if call[:2] == ("restart", tool.RENDERER_UNIT))

    def trace_dropin_exists(self):
        return (self.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.TRACE_DROPIN).exists()

    def release_tree(self):
        return tool.tree_hashes(self.paths.release_link)

    @contextlib.contextmanager
    def patched(self):
        with mock.patch.object(tool, "systemctl", self.systemctl), \
                mock.patch.object(tool, "require_root", lambda: None), \
                mock.patch.object(tool, "SETTLE_SECONDS", 0), \
                mock.patch.object(env_lib.time, "sleep", lambda _: None):
            yield self

    def args(self, **values):
        defaults = {"env": None, "seconds": 60, "deep": False, "clear_inherited": False, "tar": None,
                    "sha256": None, "json": False}
        return type("Args", (), {**defaults, **values})()

    def run(self, handler, **values):
        output = io.StringIO()
        with self.patched(), contextlib.redirect_stdout(output):
            result = handler(self.paths, self.args(**values))
        return output.getvalue(), result


def make_overlay(work, commit=COMMIT, modified=0, traceable=True, binary=OVERLAY_BINARY, label="diag-a"):
    renderer = Path(work) / "renderer-bin"
    renderer.write_bytes(binary)
    runtime = Path(work) / "runtime-dir"
    shutil.rmtree(runtime, ignore_errors=True)
    write_tree(runtime, runtime_files(traceable, "overlay"))
    out = Path(work) / "out"
    target, manifest = runtime_overlay.pack(renderer, runtime, label, platform.machine(), commit, modified,
                                            "d" * 64 if modified else None, "2.54.0", out)
    return target, manifest


class Parsing(unittest.TestCase):
    def test_systemd_environment_values(self):
        self.assertEqual(env_lib.parse_environment_property(
            'HOME=/x WEBKIT_DEBUG="Layers,Painting" "A=b c"'),
            {"HOME": "/x", "WEBKIT_DEBUG": "Layers,Painting", "A": "b c"})
        self.assertEqual(env_lib.parse_show_environment("PATH=/usr/bin\nWEBKIT_SHOW_FPS=1\n"),
                         {"PATH": "/usr/bin", "WEBKIT_SHOW_FPS": "1"})
        self.assertEqual(env_lib.parse_environment_file("# c\nexport WEBKIT_SHOW_FPS='1'\nbad line\nX=y\n"),
                         {"WEBKIT_SHOW_FPS": "1", "X": "y"})
        self.assertEqual(env_lib.parse_environ(b"A=1\0WEBKIT_SHOW_FPS=\0noequals\0"), {"A": "1", "WEBKIT_SHOW_FPS": ""})

    def test_what_webkit_makes_of_the_variables(self):
        # DrawingAreaCoordinatedGraphicsGLib.cpp: only exactly "0"; WebProcessGLib.cpp: anything but "0".
        self.assertEqual(env_lib.classify_compositor({}), "skia")
        self.assertEqual(env_lib.classify_compositor(TEXTUREMAPPER), "texturemapper")
        self.assertEqual(env_lib.classify_compositor({"WEBKIT_USE_SKIA_FOR_COMPOSITION": "1"}), "skia")
        self.assertEqual(env_lib.classify_compositor({"WEBKIT_SKIA_ENABLE_CPU_RENDERING": "1"}), "skia-cpu")
        self.assertEqual(env_lib.classify_compositor({"WEBKIT_SKIA_ENABLE_CPU_RENDERING": "0"}), "skia")

    def test_the_profile_is_the_whole_truth(self):
        self.assertEqual(env_lib.compare_environment({}, {}), [])
        self.assertEqual(env_lib.compare_environment({}, TEXTUREMAPPER),
                         ["WEBKIT_USE_SKIA_FOR_COMPOSITION=0 is set but the profile does not set it"])
        self.assertEqual(env_lib.compare_environment(TEXTUREMAPPER, {}),
                         ["WEBKIT_USE_SKIA_FOR_COMPOSITION should be '0' but is not set"])
        self.assertEqual(len(env_lib.compare_environment({"WEBKIT_SHOW_FPS": "1"}, {"WEBKIT_SHOW_FPS": "2"})), 1)


class Inherited(unittest.TestCase):
    def read(self, files):
        return lambda path: files.get(path)

    def test_every_source_is_found_and_attributed(self):
        show = {"Environment": "HOME=/h WEBKIT_SHOW_FPS=1 WEBKIT_DEBUG=Layers",
                "FragmentPath": "/usr/lib/systemd/system/r.service",
                "DropInPaths": "/etc/systemd/system/r.service.d/99-debug.conf /run/systemd/system/r.service.d/"
                               + tool.TRACE_DROPIN,
                "EnvironmentFiles": "/etc/default/r (ignore_errors=yes)", "UnsetEnvironment": ""}
        files = {
            "/etc/systemd/system/r.service.d/99-debug.conf": "[Service]\nEnvironment=WEBKIT_SHOW_FPS=1\n",
            "/run/systemd/system/r.service.d/" + tool.TRACE_DROPIN:
                "[Service]\nEnvironment=WEBKIT_DEBUG=Layers\nUnsetEnvironment=WPE_BUFFER_FORMAT\n",
            "/etc/default/r": "WPE_DRM_DISABLE_ATOMIC=1\n",
        }
        found = env_lib.inherited_environment(show, {"WEBKIT_USE_SKIA_FOR_COMPOSITION": "0", "PATH": "/bin"},
                                              self.read(files), tool.TOOL_DROPINS)
        by_name = {item["name"]: item for item in found}
        # WEBKIT_DEBUG comes only from this tool's own drop-in: that is the request, not inherited.
        self.assertEqual(sorted(by_name), ["WEBKIT_SHOW_FPS", "WEBKIT_USE_SKIA_FOR_COMPOSITION",
                                           "WPE_DRM_DISABLE_ATOMIC"])
        self.assertIn("99-debug.conf", by_name["WEBKIT_SHOW_FPS"]["source"])
        self.assertIn("EnvironmentFile /etc/default/r", by_name["WPE_DRM_DISABLE_ATOMIC"]["source"])
        self.assertIn("service manager", by_name["WEBKIT_USE_SKIA_FOR_COMPOSITION"]["source"])

    def test_this_tools_unset_does_not_hide_an_inherited_variable(self):
        show = {"Environment": "WEBKIT_SHOW_FPS=1", "DropInPaths": "/etc/a.conf /run/" + tool.TRACE_DROPIN,
                "UnsetEnvironment": "WEBKIT_SHOW_FPS"}
        files = {"/etc/a.conf": "Environment=WEBKIT_SHOW_FPS=1\n",
                 "/run/" + tool.TRACE_DROPIN: "UnsetEnvironment=WEBKIT_SHOW_FPS\n"}
        found = env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS)
        self.assertEqual([item["name"] for item in found], ["WEBKIT_SHOW_FPS"])
        # The unit's own UnsetEnvironment= does remove it.
        files["/etc/a.conf"] += "UnsetEnvironment=WEBKIT_SHOW_FPS\n"
        self.assertEqual(env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS), [])


class InheritedTextureMapper(unittest.TestCase):
    """A TextureMapper environment that was already on the screen must never be reported as Skia."""

    ETC = {"99-debug.conf": "[Service]\nEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0\n"}

    def test_trace_enable_refuses_a_preexisting_etc_override(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, etc_dropins=self.ETC)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable)
            message = str(refused.exception)
            self.assertIn("WEBKIT_USE_SKIA_FOR_COMPOSITION=0", message)
            self.assertIn("99-debug.conf", message)
            self.assertIn("texturemapper", message)
            self.assertIn("--clear-inherited", message)
            # Nothing was started or written, and no session says "skia".
            self.assertEqual(screen.restart_count(), 0)
            self.assertFalse(screen.trace_dropin_exists())
            self.assertFalse(screen.paths.session.exists())

    def test_the_service_managers_environment_counts_too(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, manager_env=TEXTUREMAPPER)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable)
            self.assertIn("service manager", str(refused.exception))

    def test_a_different_variable_is_refused_for_a_profile_that_does_not_set_it(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, unit_env={"WEBKIT_SHOW_FPS": "1"})
            with self.assertRaises(tool.Refused):
                screen.run(tool.trace_enable)

    def test_doctor_names_the_override_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, etc_dropins=self.ETC)
            screen.start()
            output, status = screen.run(tool.doctor)
            self.assertEqual(status, 1)
            self.assertRegex(output, r"BLOCK WEBKIT_USE_SKIA_FOR_COMPOSITION=0 is already set by .*99-debug\.conf")
            self.assertIn("texturemapper", output)
            self.assertIn("compositor: texturemapper", output)  # what the live process really runs

    def test_clear_inherited_unsets_it_and_the_processes_are_checked(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, etc_dropins=self.ETC)
            output, _ = screen.run(tool.trace_enable, clear_inherited=True)
            text = (screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.TRACE_DROPIN).read_text()
            self.assertIn("UnsetEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION", text)
            self.assertIn("compositor as the processes see it: skia", output)
            session = json.loads(screen.paths.session.read_text())["current"]["profile"]
            self.assertEqual(session["requestedEnv"], {})
            self.assertEqual(session["unsetInherited"], ["WEBKIT_USE_SKIA_FOR_COMPOSITION"])
            self.assertEqual(session["observedCompositor"], "skia")
            self.assertTrue(session["verified"])
            self.assertEqual(session["observed"]["renderer"], {})
            self.assertEqual(session["observed"]["webProcess"], {})

    def test_a_clear_that_does_not_work_is_caught_from_the_process_and_rolled_back(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, etc_dropins=self.ETC, ignore_unset=True)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable, clear_inherited=True)
            self.assertIn("renderer process: WEBKIT_USE_SKIA_FOR_COMPOSITION=0 is set", str(refused.exception))
            self.assertIn("no trace was kept", str(refused.exception))
            self.assertFalse(screen.trace_dropin_exists())
            # The attempt started the renderer with the trace, so its record says it was refused.
            current = json.loads(screen.paths.session.read_text())["current"]
            self.assertTrue(current["refused"])
            self.assertFalse(current["profile"]["verified"])
            self.assertIn("WEBKIT_USE_SKIA_FOR_COMPOSITION=0 is set", current["problems"][0])
            self.assertEqual(screen.restart_count(), 2)  # the trace start and the rollback

    def test_the_web_process_is_checked_as_well_as_the_renderer(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, web_extra_env=TEXTUREMAPPER)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable)
            self.assertIn("web process: WEBKIT_USE_SKIA_FOR_COMPOSITION=0 is set", str(refused.exception))

    def test_a_requested_variable_is_recorded_as_requested_and_observed(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.run(tool.trace_enable, env=["WEBKIT_USE_SKIA_FOR_COMPOSITION=0"])
            profile = json.loads(screen.paths.session.read_text())["current"]["profile"]
            self.assertEqual(profile["requestedEnv"], TEXTUREMAPPER)
            self.assertEqual(profile["requestedCompositor"], "texturemapper")
            self.assertEqual(profile["observed"]["renderer"], TEXTUREMAPPER)
            self.assertEqual(profile["observed"]["webProcess"], TEXTUREMAPPER)
            self.assertEqual(profile["observedCompositor"], "texturemapper")

    def test_a_web_process_that_never_appears_is_unverified_not_assumed_good(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.start()
            shutil.rmtree(screen.paths.proc / str(screen.pid + 1))
            with mock.patch.object(env_lib.time, "monotonic", side_effect=[0, 0, 100, 100]):
                result = env_lib.verify_process_environment(screen.paths.proc, screen.pid, {}, wait_seconds=1,
                                                            sleep=lambda _: None)
            self.assertFalse(result["ok"])
            self.assertIn("web process was not found", result["problems"][0])


class LabEnvironment(unittest.TestCase):
    def test_the_lab_unit_unsets_everything_but_the_profile(self):
        props = tool.lab_unit_properties(tool.Paths(root=Path("/tmp/none")), Path("/r/run"), TEXTUREMAPPER, None)
        unset = {p.split("=", 1)[1] for p in props if p.startswith("UnsetEnvironment=")}
        self.assertEqual(unset, set(tool.ENV_ALLOWLIST) - set(TEXTUREMAPPER))
        self.assertIn("Environment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0", props)

    def run_watch(self, lab_env, expected):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work)
            proc = screen.paths.proc / "900"
            proc.mkdir(parents=True)
            (proc / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in lab_env.items()) + b"\0")
            (proc / "comm").write_text("tilecast-wpe-co\n")
            (proc / "stat").write_text("900 (tilecast-wpe-co) S 1 1 1 0\n")
            child = screen.paths.proc / "901"
            child.mkdir()
            (child / "environ").write_bytes(b"\0".join(f"{k}={v}".encode() for k, v in lab_env.items()) + b"\0")
            (child / "comm").write_text("WPEWebProcess\n")
            (child / "stat").write_text("901 (WPEWebProcess) S 900 1 1 0\n")
            stopped = []

            class Process:
                def poll(self):
                    return 0 if stopped else None

            def fake(*args, check=True):
                if args[0] == "show":
                    return "MainPID=900\n"
                if args[0] == "stop":
                    stopped.append(args)
                return ""

            with mock.patch.object(tool, "systemctl", fake):
                result = tool.watch_lab_environment(screen.paths, Process(), expected)
            return result, stopped

    def test_a_matching_lab_environment_is_verified(self):
        result, stopped = self.run_watch(TEXTUREMAPPER, TEXTUREMAPPER)
        self.assertTrue(result["ok"] and result["complete"])
        self.assertEqual(result["compositor"], "texturemapper")
        self.assertEqual(stopped, [])

    def test_a_lab_that_got_another_environment_is_stopped_and_not_labelled(self):
        result, stopped = self.run_watch(TEXTUREMAPPER, {})
        self.assertFalse(result["ok"])
        self.assertEqual(result["compositor"], "texturemapper")
        self.assertEqual(stopped, [("stop", tool.LAB_UNIT)])


class RealRuntimeTracing(unittest.TestCase):
    def test_trace_refuses_without_the_instrumented_renderer_and_names_the_fix(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable)
            message = str(refused.exception)
            self.assertIn("1.4.0", message)
            self.assertIn("--visual-trace", message)
            self.assertIn("runtime-overlay install", message)
            self.assertEqual(screen.restart_count(), 0)
            self.assertFalse(screen.trace_dropin_exists())

    def test_a_renderer_with_the_flag_but_a_runtime_without_the_sink_is_refused_too(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            screen.release_binary = OVERLAY_BINARY
            (screen.paths.release_binary()).write_bytes(OVERLAY_BINARY)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.trace_enable)
            self.assertIn("trace sink", str(refused.exception))

    def test_the_overlay_makes_it_possible_and_the_session_names_the_commit(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, manifest = make_overlay(work)
            output, _ = screen.run(tool.runtime_overlay_install, tar=str(archive))
            self.assertIn(COMMIT, output)
            output, _ = screen.run(tool.trace_enable)
            self.assertIn("verified runtime overlay diag-a, commit " + COMMIT[:12], output)
            tilecast = json.loads(screen.paths.session.read_text())["current"]["tilecast"]
            self.assertEqual(tilecast["source"], "overlay")
            self.assertEqual(tilecast["commit"], COMMIT)
            self.assertEqual(tilecast["overlay"], "diag-a")
            self.assertEqual(tilecast["rendererSha256"], sha(OVERLAY_BINARY))
            self.assertEqual(tilecast["runtimeManifestSha256"], manifest["runtime"]["manifestSha256"])
            self.assertEqual(tilecast["edgeVersion"], "1.4.0")
            # collect carries the record with the trace
            (screen.paths.trace_dir).mkdir(parents=True)
            (screen.paths.trace_dir / "visual-trace.jsonl").write_text("{}\n")
            out = Path(work) / "collected"
            with contextlib.redirect_stdout(io.StringIO()):
                tool.trace_collect(screen.paths, type("A", (), {"out": str(out)})())
            self.assertEqual(json.loads((out / "trace-meta.json").read_text())["current"]["tilecast"]["commit"], COMMIT)

    def test_a_release_that_already_has_the_trace_needs_no_overlay(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            output, _ = screen.run(tool.trace_enable)
            self.assertIn("the signed release manifest", output)
            self.assertIsNone(json.loads(screen.paths.session.read_text())["current"]["tilecast"]["commit"])

    def test_the_standalone_lab_still_needs_no_overlay(self):
        # The lab never reads the Tilecast overlay: its run touches the WPE overlay and nothing else.
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            self.assertIsNone(tool.resolve_wpe(screen.paths, "release"))
            props = tool.lab_unit_properties(screen.paths, Path("/r"), {}, None)
            self.assertFalse(any("renderer-web" in prop or "tilecast-renderer-wpe" in prop for prop in props))


class RuntimeOverlay(unittest.TestCase):
    def test_install_status_restore_leave_the_release_untouched(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            before = screen.release_tree()
            archive, manifest = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            dropin = (screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.RUNTIME_DROPIN).read_text()
            self.assertEqual(len(parse_assignments(dropin, "BindReadOnlyPaths")), 2)
            self.assertNotIn("ExecStart", dropin)
            self.assertFalse((screen.paths.run_units / f"{tool.WEB_UNIT}.d").exists())
            # The running renderer is the overlay's, read from the process.
            self.assertEqual(sha((screen.paths.proc / str(screen.pid) / "exe").read_bytes()), sha(OVERLAY_BINARY))
            output, _ = screen.run(tool.runtime_overlay_status)
            self.assertIn(COMMIT, output)
            self.assertIn("matches runtime overlay diag-a", output)
            self.assertEqual(screen.release_tree(), before)  # never written
            output, _ = screen.run(tool.runtime_overlay_restore)
            self.assertIn("verified against the signed release manifest", output)
            self.assertEqual(sha((screen.paths.proc / str(screen.pid) / "exe").read_bytes()), sha(RELEASE_BINARY))
            self.assertEqual(screen.release_tree(), before)
            output, _ = screen.run(tool.runtime_overlay_restore)
            self.assertIn("none installed", output)

    def test_a_reboot_restores_the_release_because_run_is_cleared(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            self.assertEqual(sha((screen.paths.proc / str(screen.pid) / "exe").read_bytes()), sha(OVERLAY_BINARY))
            shutil.rmtree(screen.paths.root / "run")  # /run is a tmpfs
            self.assertIsNone(tool.active_runtime_overlay(screen.paths))
            with screen.patched():
                screen.start()  # the unit starts again after boot
            self.assertEqual(sha((screen.paths.proc / str(screen.pid) / "exe").read_bytes()), sha(RELEASE_BINARY))
            # The overlay's files stay on /var, inactive, and the release is what the tool expects again.
            self.assertTrue((screen.paths.runtime_overlays / "diag-a" / "bin" / "tilecast-renderer-wpe").is_file())
            self.assertEqual(tool.expected_artifacts(screen.paths)["source"], "release")
            self.assertFalse(tool.trace_support(screen.paths)[0])

    def test_an_overlay_that_does_not_reach_the_process_is_removed_again(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False, ignore_binds=True)
            archive, _ = make_overlay(work)
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.runtime_overlay_install, tar=str(archive))
            self.assertIn("running renderer binary has SHA-256", str(refused.exception))
            self.assertIn("removed again", str(refused.exception))
            self.assertFalse((screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.RUNTIME_DROPIN).exists())

    def test_a_tampered_runtime_file_in_the_process_is_caught(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, manifest = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            web = screen.paths.proc / str(screen.pid) / "root" / tool.RELEASE_WEB_TARGET.lstrip("/")
            (web / "runtime.js").write_bytes(b"other")
            (web / "extra.js").write_bytes(b"x")
            problems = tool.verify_artifacts(tool.expected_artifacts(screen.paths),
                                             tool.running_artifacts(screen.paths, screen.pid))
            self.assertEqual(len(problems), 2)
            self.assertIn("extra.js", problems[0] + problems[1])
            self.assertIn("runtime.js", problems[0] + problems[1])

    def test_install_refuses_while_an_update_is_provisional(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work)
            guard = screen.paths.etc_units / "tilecast-edge-update-guard.timer"
            guard.parent.mkdir(parents=True, exist_ok=True)
            guard.write_text("")
            archive, _ = make_overlay(work)
            with self.assertRaises(tool.Refused):
                screen.run(tool.runtime_overlay_install, tar=str(archive))

    def test_the_overlay_does_not_start_a_settling_renderer_that_keeps_exiting(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work)
            archive, _ = make_overlay(work)
            original = screen.systemctl

            def dying(*args, check=True):
                text = original(*args, check=check)
                if args[0] == "show" and "-pActiveState" in args and screen.restart_count() == 1:
                    return text.replace("ActiveState=active", "ActiveState=activating")
                return text

            screen.systemctl = dying
            with self.assertRaises(tool.Refused) as refused:
                screen.run(tool.runtime_overlay_install, tar=str(archive))
            self.assertIn("did not stay up", str(refused.exception))
            self.assertFalse((screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.RUNTIME_DROPIN).exists())

    def test_archive_refusals(self):
        with tempfile.TemporaryDirectory() as work:
            archive, manifest = make_overlay(work)
            good = archive.read_bytes()
            arch = platform.machine()
            parsed, files = runtime_overlay.read_tar(good, arch)
            self.assertEqual(parsed["source"]["commit"], COMMIT)
            self.assertEqual(files["bin/tilecast-renderer-wpe"], OVERLAY_BINARY)
            with self.assertRaises(runtime_overlay.Invalid):
                runtime_overlay.read_tar(good, "other-arch")

            def entries(replace=None, extra=(), drop=None, manifest_edit=None):
                import tarfile
                buffer = io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(good)) as source, tarfile.open(fileobj=buffer, mode="w") as out:
                    for member in source.getmembers():
                        data = source.extractfile(member).read()
                        if member.name == drop:
                            continue
                        if replace and member.name in replace:
                            data = replace[member.name]
                        if manifest_edit and member.name.endswith(runtime_overlay.MANIFEST):
                            document = json.loads(data)
                            manifest_edit(document)
                            data = json.dumps(document).encode()
                        info = tarfile.TarInfo(member.name)
                        info.size = len(data)
                        out.addfile(info, io.BytesIO(data))
                    for name, data, kind in extra:
                        info = tarfile.TarInfo(name)
                        if kind == "symlink":
                            info.type, info.linkname = tarfile.SYMTYPE, data
                            out.addfile(info)
                        else:
                            info.size = len(data)
                            out.addfile(info, io.BytesIO(data))
                return buffer.getvalue()

            cases = {
                "changed binary": entries({"runtime/bin/tilecast-renderer-wpe": OVERLAY_BINARY + b"x"}),
                "changed runtime file": entries({"runtime/renderer-web/index.html": b"<other>"}),
                "extra file": entries(extra=[("runtime/renderer-web/evil.js", b"x", "file")]),
                "traversal": entries(extra=[("runtime/../etc/x", b"x", "file")]),
                "absolute": entries(extra=[("/runtime/x", b"x", "file")]),
                "outside": entries(extra=[("other/x", b"x", "file")]),
                "symlink": entries(extra=[("runtime/renderer-web/l", "/etc/shadow", "symlink")]),
                "no manifest": entries(drop="runtime/" + runtime_overlay.MANIFEST),
                "bad label": entries(manifest_edit=lambda d: d.update(label="../x")),
                "bad commit": entries(manifest_edit=lambda d: d["source"].update(commit="abc")),
            }
            for name, data in cases.items():
                with self.assertRaises(runtime_overlay.Invalid, msg=name):
                    runtime_overlay.read_tar(data, arch)

    def test_pack_refuses_what_cannot_trace(self):
        with tempfile.TemporaryDirectory() as work:
            with self.assertRaisesRegex(ValueError, "no --visual-trace"):
                make_overlay(work, binary=RELEASE_BINARY)
            with self.assertRaisesRegex(ValueError, "not built with TILECAST_BUILD_COMMIT"):
                make_overlay(work, commit="e" * 40)
            with self.assertRaisesRegex(ValueError, "trace sink|tilecast-visual-trace"):
                make_overlay(work, traceable=False)
            # A dirty tree needs its diff hash and its own build identity.
            with self.assertRaisesRegex(ValueError, "not built with"):
                make_overlay(work, modified=3)
            dirty_binary = renderer_binary(COMMIT + "-dirty")
            # A dirty renderer never passes for the clean commit it contains.
            with self.assertRaisesRegex(ValueError, "not built with"):
                make_overlay(work, binary=dirty_binary)
            _, manifest = make_overlay(work, modified=3, binary=dirty_binary)
            self.assertEqual(manifest["source"]["modifiedFiles"], 3)
            self.assertEqual(manifest["source"]["diffSha256"], "d" * 64)


class DoctorOutput(unittest.TestCase):
    def test_a_clean_1_4_0_screen_is_ready_for_the_lab_and_says_trace_needs_the_overlay(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            screen.start()
            output, status = screen.run(tool.doctor)
            self.assertEqual(status, 0)
            self.assertIn("Tilecast Edge 1.4.0", output)
            self.assertIn("no compositor variable is set", output)
            self.assertRegex(output, r"WARN +`trace enable` would refuse: .*runtime-overlay install")
            self.assertIn("the lab runs on the release as installed", output)

    def test_with_the_overlay_active_it_reports_the_commit(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            output, status = screen.run(tool.doctor)
            self.assertEqual(status, 0)
            self.assertIn(f"diagnostic Tilecast overlay diag-a is active (commit {COMMIT[:12]}", output)
            self.assertIn("ok    real-Runtime tracing is possible", output)

    def test_a_process_started_before_a_config_change_is_flagged(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.start()
            override = screen.paths.etc_units / f"{tool.RENDERER_UNIT}.d"
            override.mkdir(parents=True)
            (override / "50-new.conf").write_text("[Service]\nEnvironment=WEBKIT_SHOW_FPS=1\n")
            output, _ = screen.run(tool.doctor)
            self.assertIn("started before a configuration change", output)

    def test_json_output_has_the_state(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, etc_dropins={
                "99-debug.conf": "[Service]\nEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0\n"})
            screen.start()
            output, _ = screen.run(tool.doctor, json=True)
            data = json.loads(output)
            self.assertEqual(data["state"]["inheritedCompositorEnvironment"][0]["name"],
                             "WEBKIT_USE_SKIA_FOR_COMPOSITION")
            self.assertTrue(any(f["level"] == "block" for f in data["findings"]))


class TraceEnableTwice(unittest.TestCase):
    def test_a_second_enable_replaces_the_first(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.run(tool.trace_enable)
            screen.run(tool.trace_enable, env=["WEBKIT_USE_SKIA_FOR_COMPOSITION=0"])
            text = (screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.TRACE_DROPIN).read_text()
            self.assertEqual(text.count("--visual-trace "), 1)
            self.assertIn("Environment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0", text)
            session = json.loads(screen.paths.session.read_text())
            self.assertEqual(session["current"]["profile"]["observedCompositor"], "texturemapper")
            self.assertEqual(session["previous"]["profile"]["observedCompositor"], "skia")

    def test_the_tool_drop_ins_sort_after_everything_an_operator_would_name(self):
        for name in tool.TOOL_DROPINS:
            self.assertGreater(name, "99-debug.conf")
            self.assertGreater(name, "override.conf")


class BundleFacts(unittest.TestCase):
    def test_the_bundle_carries_the_commit_and_the_observed_environment(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            screen.run(tool.trace_enable, env=["WEBKIT_USE_SKIA_FOR_COMPOSITION=0"])
            screen.paths.trace_dir.mkdir(parents=True)
            (screen.paths.trace_dir / "visual-trace.jsonl").write_text("{}\n")
            out = Path(work) / "bundle.tar.gz"
            args = type("A", (), {"out": str(out), "trace": True, "results": None, "renderer_log": False})()
            with screen.patched(), contextlib.redirect_stdout(io.StringIO()), \
                    mock.patch.object(tool, "package_versions", lambda _: {}), \
                    mock.patch.object(tool, "run", lambda *a, **k: ""), \
                    mock.patch.object(tool, "RENDERER_BINARY", str(work) + "/missing"):
                tool.bundle(screen.paths, args)
            import tarfile
            with tarfile.open(out) as archive_file:
                names = archive_file.getnames()
                facts = json.load(archive_file.extractfile("tilecast-graphics-bundle/facts.json"))
                meta = json.load(archive_file.extractfile("tilecast-graphics-bundle/trace/trace-meta.json"))
            self.assertIn("tilecast-graphics-bundle/trace/trace-meta.json", names)
            self.assertEqual(facts["tilecastCommit"]["commit"], COMMIT)
            self.assertEqual(facts["runtimeOverlays"][0]["commit"], COMMIT)
            self.assertEqual(facts["doctor"]["live"]["compositor"], "texturemapper")
            self.assertEqual(meta["current"]["profile"]["observed"]["webProcess"], TEXTUREMAPPER)


class EnvironmentPrecedence(unittest.TestCase):
    def read(self, files):
        return lambda path: files.get(path)

    def test_a_value_qualified_unset_removes_only_that_value(self):
        show = {"Environment": "WEBKIT_USE_SKIA_FOR_COMPOSITION=0", "DropInPaths": "/etc/a.conf /etc/b.conf"}
        files = {"/etc/a.conf": "Environment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0\n",
                 "/etc/b.conf": "UnsetEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION=1\n"}
        found = env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS)
        self.assertEqual([(i["name"], i["value"]) for i in found], [("WEBKIT_USE_SKIA_FOR_COMPOSITION", "0")])
        files["/etc/b.conf"] = "UnsetEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION=0\n"
        self.assertEqual(env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS), [])
        files["/etc/b.conf"] = "UnsetEnvironment=WEBKIT_USE_SKIA_FOR_COMPOSITION\n"
        self.assertEqual(env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS), [])

    def test_an_environment_reset_discards_earlier_assignments(self):
        show = {"Environment": "HOME=/h", "FragmentPath": "/usr/lib/r.service", "DropInPaths": "/etc/z.conf"}
        files = {"/usr/lib/r.service": "[Service]\nEnvironment=WEBKIT_SHOW_FPS=1\n",
                 "/etc/z.conf": "[Service]\nEnvironment=\nEnvironment=HOME=/h\n"}
        self.assertEqual(env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS), [])
        # systemd's merged property decides even when the reset is in a file the scan cannot read.
        del files["/etc/z.conf"]
        self.assertEqual(env_lib.inherited_environment(show, {}, self.read(files), tool.TOOL_DROPINS), [])

    def test_the_unit_wins_over_the_service_manager(self):
        show = {"Environment": "WEBKIT_USE_SKIA_FOR_COMPOSITION=1", "DropInPaths": "/etc/a.conf"}
        files = {"/etc/a.conf": "Environment=WEBKIT_USE_SKIA_FOR_COMPOSITION=1\n"}
        found = env_lib.inherited_environment(show, TEXTUREMAPPER, self.read(files), tool.TOOL_DROPINS)
        self.assertEqual(found[0]["value"], "1")
        self.assertEqual(found[0]["source"], "/etc/a.conf")
        self.assertEqual(len(found[0]["sources"]), 2)

    def test_an_extra_that_keeps_the_compositor_is_not_called_another_compositor(self):
        conflicts = [{"name": "WEBKIT_SHOW_FPS", "value": "1", "source": "/etc/a.conf"}]
        message = env_lib.describe_conflicts(conflicts, TEXTUREMAPPER)
        self.assertIn("compositor stays texturemapper", message)
        self.assertNotIn("runs as skia", message)
        message = env_lib.describe_conflicts([{"name": "WEBKIT_USE_SKIA_FOR_COMPOSITION", "value": "0",
                                               "source": "/etc/a.conf"}], {})
        self.assertIn("runs as texturemapper", message)


class TraceReplacement(unittest.TestCase):
    def test_a_refused_replacement_keeps_the_active_trace(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.run(tool.trace_enable)
            before = (screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.TRACE_DROPIN).read_text()
            restarts = screen.restart_count()
            override = screen.paths.etc_units / f"{tool.RENDERER_UNIT}.d"
            override.mkdir(parents=True, exist_ok=True)
            (override / "50-fps.conf").write_text("[Service]\nEnvironment=WEBKIT_SHOW_FPS=1\n")
            screen.unit_env["WEBKIT_SHOW_FPS"] = "1"
            with self.assertRaises(tool.Refused):
                screen.run(tool.trace_enable)
            with self.assertRaisesRegex(tool.Refused, "between 5 and 1800"):
                screen.run(tool.trace_enable, seconds=1)
            self.assertEqual((screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.TRACE_DROPIN).read_text(),
                             before)
            self.assertEqual(screen.restart_count(), restarts)
            output, _ = screen.run(tool.trace_disable)
            self.assertIn("disabled", output)

    def test_a_renderer_that_exits_while_it_is_read_is_rolled_back(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)

            def vanished(_directory):
                raise FileNotFoundError(2, "No such file or directory")

            with mock.patch.object(tool, "tree_hashes", vanished):
                with self.assertRaisesRegex(tool.Refused, "cannot read the running renderer"):
                    screen.run(tool.trace_enable)
            self.assertFalse(screen.trace_dropin_exists())
            self.assertEqual(screen.restart_count(), 2)


class RuntimeOverlayRestore(unittest.TestCase):
    def test_restore_disables_a_trace_the_release_renderer_cannot_parse(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            screen.run(tool.trace_enable)
            self.assertTrue(screen.trace_dropin_exists())
            output, _ = screen.run(tool.runtime_overlay_restore)
            self.assertFalse(screen.trace_dropin_exists())
            self.assertIn("visual trace that ran with the overlay was disabled", output)

    def test_a_restore_after_a_failed_restart_restarts_again(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            (screen.paths.run_units / f"{tool.RENDERER_UNIT}.d" / tool.RUNTIME_DROPIN).unlink()
            screen.running = False  # the restart after the drop-in was removed failed
            output, _ = screen.run(tool.runtime_overlay_restore)
            self.assertIn("restarting it", output)
            self.assertIn("restored", output)
            self.assertEqual(sha((screen.paths.proc / str(screen.pid) / "exe").read_bytes()), sha(RELEASE_BINARY))


class ArchiveBoundaries(unittest.TestCase):
    def test_a_damaged_or_incomplete_archive_is_a_refusal(self):
        with tempfile.TemporaryDirectory() as work:
            archive, _ = make_overlay(work)
            good = archive.read_bytes()
            arch = platform.machine()
            with self.assertRaises(runtime_overlay.Invalid):
                runtime_overlay.read_tar(good[:len(good) // 3], arch)
            with self.assertRaises(runtime_overlay.Invalid):
                runtime_overlay.read_tar(b"not a tar file at all" * 40, arch)

            import tarfile

            def rebuilt(edit):
                buffer = io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(good)) as source, tarfile.open(fileobj=buffer, mode="w") as out:
                    members = {m.name: source.extractfile(m).read() for m in source.getmembers()}
                    edit(members)
                    for name, data in members.items():
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        out.addfile(info, io.BytesIO(data))
                return buffer.getvalue()

            manifest_name = "runtime/" + runtime_overlay.MANIFEST

            def no_binary_record(members):
                document = json.loads(members[manifest_name])
                del document["binary"]
                members[manifest_name] = json.dumps(document).encode()

            def no_host_file(members):
                document = json.loads(members[manifest_name])
                name = "renderer-web/tilecast-native-relay.js"
                del members["runtime/" + name], document["files"][name]
                del document["runtime"]["files"]["tilecast-native-relay.js"]
                members[manifest_name] = json.dumps(document).encode()

            def not_json(members):
                members[manifest_name] = b"{"

            for name, edit in (("binary record", no_binary_record), ("host file", no_host_file),
                               ("not json", not_json)):
                with self.assertRaises(runtime_overlay.Invalid, msg=name):
                    runtime_overlay.read_tar(rebuilt(edit), arch)

    def test_a_dirty_renderer_does_not_pass_for_a_clean_manifest(self):
        self.assertEqual(runtime_overlay.build_id(renderer_binary(COMMIT + "-dirty")), COMMIT + "-dirty")
        self.assertEqual(runtime_overlay.build_id(renderer_binary(COMMIT)), COMMIT)
        self.assertIsNone(runtime_overlay.build_id(renderer_binary(COMMIT) + renderer_binary("unknown")))

    def test_damaged_wpe_and_lab_archives_are_refusals(self):
        with self.assertRaisesRegex(tool.Refused, "not a readable tar file|damaged"):
            tool.read_overlay_tar(b"garbage" * 100, platform.machine())
        with self.assertRaisesRegex(tool.Refused, "not a readable tar file|damaged"):
            tool.read_lab_tar(b"garbage" * 100)

    def test_an_oversized_archive_is_refused_before_it_is_read(self):
        with tempfile.TemporaryDirectory() as work:
            big = Path(work) / "big.tar"
            with open(big, "wb") as handle:
                handle.truncate(tool.TAR_OVERHEAD_BYTES + 2048)
            with self.assertRaisesRegex(tool.Refused, "larger than"):
                tool.read_archive(big, 1024)


class PrivilegedFileAccess(unittest.TestCase):
    def test_a_symbolic_link_in_another_accounts_directory_is_not_followed(self):
        with tempfile.TemporaryDirectory() as work:
            secret = Path(work) / "secret"
            secret.write_text("root only")
            results = Path(work) / "results"
            results.mkdir()
            (results / "summary.json").symlink_to(secret)
            (results / "timeline.jsonl").write_text("{}\n")
            with self.assertRaisesRegex(tool.Refused, "summary.json"):
                tool.read_regular_files(results, ("timeline.jsonl", "summary.json"))
            self.assertEqual(tool.read_regular_files(results, ("timeline.jsonl", "missing")),
                             {"timeline.jsonl": b"{}\n"})
            os.mkfifo(results / "fifo")
            with self.assertRaisesRegex(tool.Refused, "not a regular file"):
                tool.read_regular_files(results, ("fifo",))

    def test_root_written_metadata_replaces_rather_than_writes_through(self):
        with tempfile.TemporaryDirectory() as work:
            target = Path(work) / "target"
            target.write_text("untouched")
            out = Path(work) / "out"
            out.mkdir()
            (out / "run.json").symlink_to(target)
            tool.write_replacing(out, "run.json", "{}\n")
            self.assertEqual(target.read_text(), "untouched")
            self.assertFalse((out / "run.json").is_symlink())
            self.assertEqual((out / "run.json").read_text(), "{}\n")
            self.assertEqual(sorted(p.name for p in out.iterdir()), ["run.json"])


class DoctorEdges(unittest.TestCase):
    def test_an_overlay_drop_in_without_its_files_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=False)
            archive, _ = make_overlay(work)
            screen.run(tool.runtime_overlay_install, tar=str(archive))
            shutil.rmtree(screen.paths.runtime_overlays / "diag-a")
            output, status = screen.run(tool.doctor, json=True)
            state = json.loads(output)["state"]
            self.assertEqual(status, 1)
            self.assertFalse(state["traceSupport"]["ok"])
            self.assertIn("files are missing", state["runtimeOverlay"]["problem"])

    def test_the_footer_names_the_overlay_only_when_tracing_needs_it(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True)
            screen.start()
            output, _ = screen.run(tool.doctor)
            self.assertIn("doctor: the lab runs on the release as installed.", output)
            self.assertNotIn("needs the diagnostic", output)

    def test_an_empty_web_process_environment_is_what_the_compositor_is_read_from(self):
        with tempfile.TemporaryDirectory() as work:
            screen = FakeScreen(work, release_traceable=True, unit_env=TEXTUREMAPPER)
            screen.start()
            child = screen.paths.proc / str(screen.pid + 1)
            (child / "environ").write_bytes(b"HOME=/h\0")
            output, _ = screen.run(tool.doctor, json=True)
            self.assertEqual(json.loads(output)["state"]["live"]["compositor"], "skia")

    def test_the_bundle_leaves_out_the_exec_start(self):
        state = {"release": {}, "updateProvisional": False, "inheritedCompositorEnvironment": [],
                 "toolSettings": {}, "traceSupport": {}, "runtimeOverlay": None, "live": None,
                 "renderer": {"active": "active", "pid": 1, "restarts": "0", "unitFile": "/u", "dropIns": [],
                              "execStart": ["/bin/r", "--server=10.0.0.5:8080"], "execStartProblem": None}}
        projected = tool.bundle_doctor_state(state)
        self.assertNotIn("execStart", projected["renderer"])
        self.assertNotIn("10.0.0.5", json.dumps(projected))


class LabBounds(unittest.TestCase):
    def test_the_lab_unit_has_a_runtime_limit_beyond_the_lab_timeout(self):
        props = tool.lab_unit_properties(tool.Paths(root=Path("/tmp/none")), Path("/r/run"), {}, None)
        limit = [int(p.split("=", 1)[1]) for p in props if p.startswith("RuntimeMaxSec=")]
        self.assertEqual(len(limit), 1)
        self.assertGreater(limit[0], tool.LAB_TIMEOUT_SECONDS)
        command = tool.lab_command(tool.Paths(root=Path("/tmp/none")), "crossfade", None, 3, "transitions", "/o")
        self.assertIn(f"--timeout={tool.LAB_TIMEOUT_SECONDS}", command)


if __name__ == "__main__":
    unittest.main()
