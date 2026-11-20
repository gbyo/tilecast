#!/usr/bin/env python3
"""tilecast-wpe-debug: graphics diagnostics on one Tilecast Edge screen.

Developer and operator tool; it is not part of an Edge release. Copy this
directory to the screen and run it as root (python3 -I). Every change it
makes is temporary: drop-ins go to /run/systemd/system, which a reboot clears
(and with them every bind mount below), and nothing in an installed release
(/opt/tilecast-edge) is ever written. See
docs/tilecast-edge-wpe-compositor-lab.md.

  doctor [--json]                        what reaches the renderer, and what each experiment needs

  runtime-overlay install TAR [--sha256 HEX]
                                         run the renderer with an instrumented Tilecast
                                         renderer and Runtime from one git commit
  runtime-overlay status
  runtime-overlay restore                back to the signed release's own files

  trace enable [--deep] [--seconds N] [--env NAME=VALUE ...] [--clear-inherited]
  trace disable
  trace collect --out DIR

  overlay install TAR [--sha256 HEX]     run the renderer on another WPE build
  overlay restore                        back to the release's own WPE
  overlay status

  lab install TAR
  lab run --scene NAME [--variant V] [--iterations N] [--wpe release|LABEL]
          [--env NAME=VALUE ...] [--inspect MODE]
  lab matrix [--preset baseline|versions|extended] [--wpe release,LABEL]
             [--scenes a,b] [--iterations N]

  bundle --out FILE.tar.gz [--trace] [--results DIR ...] [--renderer-log]
"""
import argparse
import datetime
import hashlib
import io
import json
import os
import platform
import re
import shutil
import shlex
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import environment  # noqa: E402
import runtime_overlay  # noqa: E402
import sanitize_log  # noqa: E402

TOOL_VERSION = "2"
RENDERER_UNIT = "tilecast-renderer.service"
WEB_UNIT = "tilecast-web-renderer.service"
RENDERER_BINARY = "/opt/tilecast-edge/current/bin/tilecast-renderer-wpe"
OVERLAY_MANIFEST = "tilecast-wpe-overlay.json"
# systemd applies drop-ins in file name order and the last assignment wins.
# These names sort after anything an operator or a package would name, so what
# this tool sets is what the unit gets (and the tool checks that it did).
OVERLAY_DROPIN = "zz-tilecast-wpe-overlay.conf"
RUNTIME_DROPIN = "zz-tilecast-runtime-overlay.conf"
TRACE_DROPIN = "zz-tilecast-visual-trace.conf"
TOOL_DROPINS = frozenset((OVERLAY_DROPIN, RUNTIME_DROPIN, TRACE_DROPIN))
LAB_UNIT = "tilecast-wpe-lab"
RELEASE_WEB_TARGET = "/opt/tilecast-edge/current/share/tilecast/renderer-web"
# After a restart the renderer must still be the same process this long
# (a mismatched Tilecast daemon makes it exit or restart); tests set 0.
SETTLE_SECONDS = 6
LABEL = re.compile(r"^[a-z0-9][a-z0-9.-]{0,47}$")
TOKEN = re.compile(r"^[A-Za-z0-9_.:,-]{0,64}$")
SCENE = re.compile(r"^[a-z0-9-]{1,48}$")
VARIANT = re.compile(r"^[A-Za-z0-9_.:-]{1,48}$")
ARG = re.compile(r"^[A-Za-z0-9_./=:,+-]+$")
MAX_OVERLAY_BYTES = 2 * 1024 * 1024 * 1024
MAX_LAB_BYTES = 256 * 1024 * 1024

ENV_ALLOWLIST = environment.ENV_ALLOWLIST


class Refused(Exception):
    """A request the tool will not carry out; the message says why."""


@dataclass
class Paths:
    """Every location the tool reads or writes. Tests point them elsewhere."""
    root: Path = Path("/")
    state: Path = field(default=None)
    run_units: Path = field(default=None)
    etc_units: Path = field(default=None)
    release_link: Path = field(default=None)
    trace_dir: Path = field(default=None)
    sys_drm: Path = field(default=None)
    proc: Path = field(default=None)

    def __post_init__(self):
        r = self.root
        self.state = self.state or r / "var/lib/tilecast-wpe-debug"
        self.run_units = self.run_units or r / "run/systemd/system"
        self.etc_units = self.etc_units or r / "etc/systemd/system"
        self.release_link = self.release_link or r / "opt/tilecast-edge/current"
        self.trace_dir = self.trace_dir or r / "var/cache/tilecast-renderer/tilecast-visual-trace"
        self.sys_drm = self.sys_drm or r / "sys/class/drm"
        self.proc = self.proc or r / "proc"

    @property
    def overlays(self):
        return self.state / "overlays"

    @property
    def runtime_overlays(self):
        return self.state / "runtime-overlays"

    @property
    def session(self):
        return self.state / "trace-session.json"

    @property
    def lab(self):
        return self.state / "lab"

    @property
    def results(self):
        return self.state / "results"

    def release_wpe(self):
        return self.release_link / "lib" / "wpe"

    def release_binary(self):
        return self.release_link / "bin" / "tilecast-renderer-wpe"

    def release_web(self):
        return self.release_link / "share" / "tilecast" / "renderer-web"


# ---- validation (pure) ----------------------------------------------------


def parse_env(pairs):
    """NAME=VALUE pairs, allowlisted names and token values only."""
    env = {}
    for pair in pairs or ():
        name, sep, value = pair.partition("=")
        if not sep or name not in ENV_ALLOWLIST:
            raise Refused(f"{name or pair!r} is not a compositor variable this tool sets; see --help")
        if not TOKEN.match(value):
            raise Refused(f"the value of {name} must be letters, digits and _ . : , -")
        env[name] = value
    return env


def parse_exec_start(show_output):
    """argv of the first command in `systemctl show -p ExecStart --value`."""
    match = re.search(r"argv\[\]=(.*?) ;", show_output)
    if not match:
        raise Refused("cannot read the renderer's ExecStart")
    argv = match.group(1).split(" ")
    if not argv or argv[0] != RENDERER_BINARY:
        raise Refused(f"the renderer does not start {RENDERER_BINARY}; refusing to change it")
    for arg in argv:
        if not ARG.match(arg):
            raise Refused("the renderer's ExecStart has an argument this tool will not copy")
    if any(arg.startswith("--visual-trace") for arg in argv):
        raise Refused("the renderer already runs with --visual-trace")
    return argv


def trace_dropin(argv, seconds, deep, env, unset=()):
    if not 5 <= seconds <= 1800:
        raise Refused("--seconds must be between 5 and 1800")
    command = list(argv) + ["--visual-trace", f"--visual-trace-seconds={seconds}"]
    if deep:
        command.append("--visual-trace-deep")
    lines = [
        "# Written by tilecast-wpe-debug `trace enable`; `trace disable` or a reboot removes it.",
        "[Service]",
        "ExecStart=",
        "ExecStart=" + " ".join(command),
    ]
    lines += [f"Environment={name}={value}" for name, value in sorted(env.items())]
    # Names other configuration sets that the profile must not have (only with
    # --clear-inherited); systemd applies UnsetEnvironment after every Environment.
    lines += [f"UnsetEnvironment={name}" for name in sorted(unset)]
    return "\n".join(lines) + "\n"


def runtime_overlay_dropin(directory, label):
    return (
        f"# Written by tilecast-wpe-debug `runtime-overlay install {label}`; `runtime-overlay restore` or a reboot "
        "removes it.\n"
        "# The release's own files under /opt are not changed: these mounts hide two of them for this unit only.\n"
        "[Service]\n"
        f"BindReadOnlyPaths={directory}/bin/tilecast-renderer-wpe:{RENDERER_BINARY}\n"
        f"BindReadOnlyPaths={directory}/renderer-web:{RELEASE_WEB_TARGET}\n"
    )


def overlay_dropin(source, target, label):
    return (
        f"# Written by tilecast-wpe-debug `overlay install {label}`; `overlay restore` or a reboot removes it.\n"
        "# The release's own files under /opt are not changed: this mount hides them for this unit only.\n"
        "[Service]\n"
        f"BindReadOnlyPaths={source}:{target}\n"
    )


def read_overlay_tar(data, arch):
    """Checks an overlay archive and returns (manifest, {path: bytes}).

    Only regular files and directories under wpe/, no absolute paths, no '..',
    every file listed in the manifest with its SHA-256 and nothing extra.
    """
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        total = 0
        for member in archive.getmembers():
            name = member.name
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts or not parts or parts[0] != "wpe":
                raise Refused(f"overlay member outside wpe/: {name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise Refused(f"overlay member is not a regular file: {name}")
            total += member.size
            if total > MAX_OVERLAY_BYTES:
                raise Refused("overlay is larger than the 2 GiB bound")
            files["/".join(parts[1:])] = archive.extractfile(member).read()
    raw = files.pop(OVERLAY_MANIFEST, None)
    if raw is None:
        raise Refused(f"overlay has no {OVERLAY_MANIFEST}")
    manifest = json.loads(raw)
    if manifest.get("schema") != "tilecast-wpe-overlay-v1" or not LABEL.match(str(manifest.get("label", ""))):
        raise Refused("overlay manifest is not a tilecast-wpe-overlay-v1 manifest with a valid label")
    if manifest.get("arch") != arch:
        raise Refused(f"overlay is for {manifest.get('arch')}, this screen is {arch}")
    listed = manifest.get("files", {})
    if set(listed) != set(files):
        raise Refused("overlay files do not match its manifest")
    for path, entry in listed.items():
        if hashlib.sha256(files[path]).hexdigest() != entry.get("sha256"):
            raise Refused(f"overlay file {path} does not match its manifest hash")
    if "lib/libWPEWebKit-2.0.so.1" not in files:
        raise Refused("overlay has no lib/libWPEWebKit-2.0.so.1")
    files[OVERLAY_MANIFEST] = raw
    return manifest, files


def read_lab_tar(data):
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        total = 0
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if member.name.startswith("/") or ".." in parts or not parts or parts[0] != "lab":
                raise Refused(f"lab member outside lab/: {member.name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise Refused(f"lab member is not a regular file: {member.name}")
            total += member.size
            if total > MAX_LAB_BYTES:
                raise Refused("lab bundle is too large")
            members["/".join(parts[1:])] = (archive.extractfile(member).read(), member.mode & 0o111)
    if "bin/tilecast-wpe-compositor-lab" not in members:
        raise Refused("lab bundle has no bin/tilecast-wpe-compositor-lab")
    return members


def write_tree(target, files, executable=lambda path, mode: mode):
    """Writes {relative: bytes} under target: root-owned, 0755 dirs, files 0644 or 0755."""
    for relative, content in files.items():
        data, mode = content if isinstance(content, tuple) else (content, None)
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        path.write_bytes(data)
        os.chmod(path, 0o755 if executable(relative, mode) else 0o644)


def is_executable_overlay_file(relative, _mode):
    return relative.startswith("libexec/") or relative.startswith("bin/")


# ---- system helpers -------------------------------------------------------


def run(args, check=True, capture=True):
    result = subprocess.run(args, check=False, capture_output=capture, text=True)
    if check and result.returncode != 0:
        raise Refused(f"{' '.join(args[:3])} failed: {(result.stderr or '').strip()[:300]}")
    return result.stdout if capture else ""


def systemctl(*args, check=True):
    return run(["systemctl", *args], check=check)


def unit_active(unit):
    return systemctl("is-active", unit, check=False).strip() == "active"


def main_pid(unit):
    value = unit_show(unit, "MainPID").get("MainPID", "").strip()
    return int(value) if value.isdigit() and int(value) > 0 else None


def wait_active(unit, seconds=30):
    for _ in range(seconds * 2):
        pid = main_pid(unit)
        if unit_active(unit) and pid:
            return pid
        time.sleep(0.5)
    raise Refused(f"{unit} did not become active; see journalctl -u {unit}")


def provisional_update(paths):
    return (paths.etc_units / "tilecast-edge-update-guard.timer").exists()


def require_root():
    if os.geteuid() != 0:
        raise Refused("run as root: this tool changes systemd units on the screen")


def write_dropin(paths, unit, name, text):
    directory = paths.run_units / f"{unit}.d"
    directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    path = directory / name
    path.write_text(text)
    os.chmod(path, 0o644)
    return path


def remove_dropin(paths, unit, name):
    path = paths.run_units / f"{unit}.d" / name
    if path.exists():
        path.unlink()
        return True
    return False


def restart_renderers(paths, web=True):
    systemctl("daemon-reload")
    if web and (unit_active(WEB_UNIT) or (paths.run_units / f"{WEB_UNIT}.d" / OVERLAY_DROPIN).exists()):
        systemctl("restart", WEB_UNIT, check=False)
    systemctl("restart", RENDERER_UNIT)
    return wait_active(RENDERER_UNIT)


def loaded_webkit(pid, proc=Path("/proc")):
    """(path, sha256) of the libWPEWebKit the process has mapped, read through
    the process's own mount namespace."""
    try:
        maps = (Path(proc) / str(pid) / "maps").read_text()
    except OSError:
        return None, None
    for line in maps.splitlines():
        if line.endswith("libWPEWebKit-2.0.so.1"):
            path = line.split(None, 5)[-1]
            data = (Path(proc) / str(pid) / "root").joinpath(path.lstrip("/")).read_bytes()
            return path, hashlib.sha256(data).hexdigest()
    return None, None


# ---- the unit, its artifacts and its environment --------------------------------


def read_optional(path):
    try:
        return Path(path).read_text()
    except OSError:
        return None


def unit_show(unit, *properties):
    return environment.parse_show(systemctl("show", *[f"-p{name}" for name in properties], unit, check=False))


def unit_inherited(paths, unit):
    """Allowlisted variables the unit would pass that this tool did not set."""
    show = unit_show(unit, "Environment", "EnvironmentFiles", "DropInPaths", "FragmentPath", "UnsetEnvironment")
    manager = environment.parse_show_environment(systemctl("show-environment", check=False))
    return environment.inherited_environment(show, manager, read_optional, TOOL_DROPINS), show


def tool_settings(paths, unit):
    """What this tool's own drop-ins set for a unit: env, unset names, mounts."""
    settings = {"env": {}, "unset": [], "wpeOverlay": None, "runtimeOverlay": None}
    for name in (OVERLAY_DROPIN, RUNTIME_DROPIN, TRACE_DROPIN):
        for line in (read_text(paths.run_units / f"{unit}.d" / name) or "").splitlines():
            match = re.match(r"^Environment=([A-Z0-9_]+)=(.*)$", line)
            if match and match.group(1) in ENV_ALLOWLIST:
                settings["env"][match.group(1)] = match.group(2)
            if line.startswith("UnsetEnvironment="):
                settings["unset"].append(line.split("=", 1)[1])
            if line.startswith("BindReadOnlyPaths="):
                source = line.split("=", 1)[1].split(":")[0]
                if name == OVERLAY_DROPIN:
                    settings["wpeOverlay"] = Path(source).parent.name
                elif name == RUNTIME_DROPIN and source.endswith("/bin/tilecast-renderer-wpe"):
                    settings["runtimeOverlay"] = Path(source).parent.parent.name
    return settings


def release_manifest(paths):
    try:
        return json.loads((paths.release_link / "tilecast-edge-release.json").read_text())
    except (OSError, ValueError):
        return {}


def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree_hashes(directory):
    """{relative path: sha256} of a directory; a symbolic link is reported, not followed."""
    files = {}
    directory = Path(directory)
    if not directory.is_dir():
        return files
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            files[path.relative_to(directory).as_posix()] = "symbolic-link"
        elif path.is_file():
            files[path.relative_to(directory).as_posix()] = sha256_of(path)
    return files


def release_expectation(paths):
    """The renderer binary and Runtime the signed release says it has."""
    listed = {entry["path"]: entry["sha256"] for entry in release_manifest(paths).get("files", [])
              if isinstance(entry, dict) and "path" in entry and "sha256" in entry}
    prefix = "share/tilecast/renderer-web/"
    web = {path[len(prefix):]: digest for path, digest in listed.items() if path.startswith(prefix)}
    binary = listed.get("bin/tilecast-renderer-wpe")
    origin = "the signed release manifest"
    if binary is None or not web:
        # A tree without a manifest (a development install): the files on disk.
        binary = sha256_of(paths.release_binary()) if paths.release_binary().is_file() else None
        web = tree_hashes(paths.release_web())
        origin = "the release files on disk"
    return {"source": "release", "label": None, "origin": origin, "binary": binary, "runtime": web,
            "commit": None, "modifiedFiles": None, "manifestSha256": web.get("runtime-manifest.json")}


def active_runtime_overlay(paths):
    """(label, manifest) of the runtime overlay the renderer unit is set to use, or None."""
    settings = tool_settings(paths, RENDERER_UNIT)
    label = settings["runtimeOverlay"]
    if label is None:
        return None
    try:
        return label, json.loads((paths.runtime_overlays / label / "manifest.json").read_text())
    except (OSError, ValueError):
        raise Refused(f"the renderer unit mounts runtime overlay {label!r} but its files are missing; "
                      "run `runtime-overlay restore`")


def expected_artifacts(paths):
    """What the renderer unit should run: the active runtime overlay, else the release."""
    active = active_runtime_overlay(paths)
    if active is None:
        return release_expectation(paths)
    label, manifest = active
    source = manifest["source"]
    return {"source": "overlay", "label": label, "origin": f"runtime overlay {label}",
            "binary": manifest["binary"]["sha256"], "runtime": dict(manifest["runtime"]["files"]),
            "commit": source["commit"], "modifiedFiles": source.get("modifiedFiles"),
            "diffSha256": source.get("diffSha256"), "manifestSha256": manifest["runtime"]["manifestSha256"]}


def running_artifacts(paths, pid):
    """The binary and Runtime a running renderer really has, through /proc/<pid>."""
    proc = paths.proc / str(pid)
    try:
        binary = hashlib.sha256((proc / "exe").read_bytes()).hexdigest()
    except OSError:
        binary = None
    return {"binary": binary, "runtime": tree_hashes(proc / "root" / RELEASE_WEB_TARGET.lstrip("/"))}


def describe_expectation(expected):
    if expected["source"] == "overlay":
        return (f"runtime overlay {expected['label']}, commit {expected['commit'][:12]}"
                f"{' + local changes' if expected.get('modifiedFiles') else ''}")
    return expected["origin"]


def verify_artifacts(expected, running):
    """Problems between the renderer a profile expects and the one running."""
    problems = []
    if running["binary"] is None:
        problems.append("the running renderer binary could not be read")
    elif running["binary"] != expected["binary"]:
        problems.append(f"the running renderer binary has SHA-256 {running['binary'][:16]}..., expected "
                        f"{expected['binary'][:16] if expected['binary'] else '?'}... ({describe_expectation(expected)})")
    want, have = expected["runtime"], running["runtime"]
    for label, names in (("missing from the running Runtime", sorted(set(want) - set(have))),
                         ("not in the expected Runtime", sorted(set(have) - set(want))),
                         ("different in the running Runtime", sorted(n for n in set(want) & set(have)
                                                                      if want[n] != have[n]))):
        if names:
            problems.append(f"Runtime files {label}: {', '.join(names[:5])}{' ...' if len(names) > 5 else ''}")
    return problems


def trace_support(paths):
    """(ok, message): does the renderer this unit starts take --visual-trace, with a Runtime that has the sink?"""
    active = active_runtime_overlay(paths)
    manifest = release_manifest(paths)
    if active:
        binary_path = paths.runtime_overlays / active[0] / "bin" / "tilecast-renderer-wpe"
        web = paths.runtime_overlays / active[0] / "renderer-web"
        where = f"the diagnostic Tilecast overlay {active[0]}"
    else:
        binary_path, web = paths.release_binary(), paths.release_web()
        where = f"the installed Tilecast Edge {manifest.get('versionName') or '(unknown version)'}"
    try:
        binary = binary_path.read_bytes()
    except OSError:
        return False, f"cannot read the renderer binary {binary_path}"
    problem = None
    if not runtime_overlay.binary_supports_visual_trace(binary):
        problem = "a renderer without the --visual-trace option"
    else:
        names = [p.relative_to(web).as_posix() for p in web.rglob("*") if p.is_file()] if web.is_dir() else []
        ok, reason = runtime_overlay.runtime_traceable(lambda name: (web / name).read_bytes(), names)
        if not ok:
            problem = f"a Runtime without the trace sink ({reason})"
    if problem is None:
        return True, where
    return False, (f"{where} has {problem}. Tracing the real Runtime needs the instrumented renderer and Runtime of "
                   "#1946. Build the diagnostic Tilecast overlay from that checkout (`wpe-local.sh --runtime-overlay`) "
                   "and install it first: `runtime-overlay install tilecast-runtime-overlay-<label>-<arch>.tar`. "
                   "`runtime-overlay restore` removes it again, and so does a reboot.")


def settle(paths, pid):
    """The renderer must stay the same process for a few seconds after a restart."""
    time.sleep(SETTLE_SECONDS)
    state = unit_show(RENDERER_UNIT, "MainPID", "ActiveState", "NRestarts")
    if state.get("ActiveState") != "active" or state.get("MainPID") != str(pid):
        raise Refused(f"the renderer did not stay up after the restart (state {state.get('ActiveState')}, "
                      f"restarts {state.get('NRestarts')}); see journalctl -u {RENDERER_UNIT}")


def running_wpe(paths, pid):
    path, digest = loaded_webkit(pid, paths.proc)
    seen = paths.proc / str(pid) / "root" / "opt/tilecast-edge/current/lib/wpe" / OVERLAY_MANIFEST
    label = None
    if seen.is_file():
        try:
            label = json.loads(seen.read_text()).get("label")
        except ValueError:
            label = "unreadable"
    return {"overlay": label, "libSha256": digest, "path": path}


# ---- trace ----------------------------------------------------------------


def session_record(paths, pid, args, requested, unset, result, expected):
    release = release_manifest(paths)
    record = {
        "schema": "tilecast-trace-session-v1",
        "tool": TOOL_VERSION,
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "seconds": args.seconds,
        "deep": bool(args.deep),
        "profile": {
            "requestedEnv": requested,
            "requestedCompositor": environment.classify_compositor(requested),
            "unsetInherited": unset,
            "observedCompositor": result["compositor"],
            "observed": result["observed"],
            "verified": result["ok"],
        },
        "tilecast": {
            "edgeVersion": release.get("versionName"),
            "source": expected["source"],
            "overlay": expected["label"],
            "commit": expected["commit"],
            "modifiedFiles": expected.get("modifiedFiles"),
            "diffSha256": expected.get("diffSha256"),
            "rendererSha256": expected["binary"],
            "runtimeManifestSha256": expected["manifestSha256"],
            "runtimeFiles": len(expected["runtime"]),
        },
        "wpe": dict(running_wpe(paths, pid), releaseVersion=release.get("wpeWebkitVersion")),
    }
    try:
        record["previous"] = json.loads(paths.session.read_text()).get("current")
    except (OSError, ValueError):
        record["previous"] = None
    return {"current": {k: v for k, v in record.items() if k != "previous"}, "previous": record["previous"]}


def rollback(paths, unit, name, web=False):
    """Removes a drop-in and restarts, so a refused change leaves nothing behind."""
    remove_dropin(paths, unit, name)
    try:
        restart_renderers(paths, web=web)
    except Refused:
        pass


def trace_enable(paths, args):
    require_root()
    env = parse_env(args.env)
    # A new trace replaces the previous one: read the unit's own ExecStart and
    # environment, not the ones this tool's earlier drop-in set.
    if remove_dropin(paths, RENDERER_UNIT, TRACE_DROPIN):
        systemctl("daemon-reload")
    supported, where = trace_support(paths)
    if not supported:
        raise Refused(where)
    argv = parse_exec_start(unit_show(RENDERER_UNIT, "ExecStart").get("ExecStart", ""))
    inherited, _ = unit_inherited(paths, RENDERER_UNIT)
    expected_env, unset, conflicts = environment.plan_environment(env, inherited, args.clear_inherited)
    if conflicts:
        raise Refused(environment.describe_conflicts(conflicts, environment.classify_compositor(env)))
    expected = expected_artifacts(paths)
    path = write_dropin(paths, RENDERER_UNIT, TRACE_DROPIN, trace_dropin(argv, args.seconds, args.deep, env, unset))
    try:
        pid = restart_renderers(paths)
        result = environment.verify_process_environment(paths.proc, pid, expected_env)
        problems = result["problems"] + verify_artifacts(expected, running_artifacts(paths, pid))
        if not problems:
            settle(paths, pid)
    except Refused:
        rollback(paths, RENDERER_UNIT, TRACE_DROPIN)
        raise
    if problems:
        rollback(paths, RENDERER_UNIT, TRACE_DROPIN)
        raise Refused("the renderer does not run the configuration this trace was asked for, so no trace was "
                      "kept; the drop-in is removed and the renderer restarted:\n  " + "\n  ".join(problems))
    paths.state.mkdir(parents=True, exist_ok=True, mode=0o755)
    paths.session.write_text(json.dumps(session_record(paths, pid, args, env, unset, result, expected),
                                        indent=2, sort_keys=True) + "\n")
    commit = (f", Tilecast commit {expected['commit'][:12]}{' + local changes' if expected.get('modifiedFiles') else ''}"
              if expected["commit"] else "")
    print(f"trace: the renderer (pid {pid}) is recording {args.seconds} s{' (deep)' if args.deep else ''}; "
          f"verified {describe_expectation(expected)}{commit}.")
    print(f"trace: compositor as the processes see it: {result['compositor']}"
          f"{' (' + ', '.join(f'{k}={v}' for k, v in env.items()) + ')' if env else ''}"
          f"{'; cleared inherited ' + ', '.join(unset) if unset else ''}.")
    print(f"trace: drop-in {path}; reproduce the glitch now, then run `trace collect`.")


def trace_disable(paths, _args):
    require_root()
    if remove_dropin(paths, RENDERER_UNIT, TRACE_DROPIN):
        pid = restart_renderers(paths)
        print(f"trace: disabled; the renderer (pid {pid}) runs as installed.")
    else:
        print("trace: was not enabled.")


def trace_collect(paths, args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in ("visual-trace.jsonl", "visual-trace.jsonl.prev"):
        source = paths.trace_dir / name
        if source.is_file():
            shutil.copyfile(source, out / name)
            copied.append(name)
    if not copied:
        raise Refused(f"no trace in {paths.trace_dir}; was the renderer started with `trace enable`?")
    if paths.session.is_file():
        shutil.copyfile(paths.session, out / "trace-meta.json")
        copied.append("trace-meta.json")
    else:
        print("trace: no session record: this trace was not started by `trace enable` on this screen, so its "
              "environment and Tilecast commit are only what the trace header says.")
    print(f"trace: copied {', '.join(copied)} to {out}")


# ---- runtime overlay ---------------------------------------------------------


def runtime_overlay_install(paths, args):
    require_root()
    if provisional_update(paths):
        raise Refused("an Edge update is provisional; let it confirm or roll back first")
    data = Path(args.tar).read_bytes()
    if args.sha256 and hashlib.sha256(data).hexdigest() != args.sha256.lower():
        raise Refused("the archive does not match --sha256")
    try:
        manifest, files = runtime_overlay.read_tar(data, platform.machine())
    except runtime_overlay.Invalid as error:
        raise Refused(f"not a usable diagnostic Tilecast overlay: {error}")
    if not paths.release_binary().is_file() or not paths.release_web().is_dir():
        raise Refused(f"{paths.release_link} is not an Edge release")
    label = manifest["label"]
    target, staging = paths.runtime_overlays / label, paths.runtime_overlays / f".staging-{label}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, mode=0o755)
    for relative, content in files.items():
        if relative == runtime_overlay.MANIFEST:
            continue
        destination = staging / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        destination.write_bytes(content)
        os.chmod(destination, 0o755 if relative == runtime_overlay.BINARY else 0o644)
    release = release_manifest(paths)
    (staging / "manifest.json").write_bytes(files[runtime_overlay.MANIFEST])
    (staging / "base.json").write_text(json.dumps({
        "label": label,
        "baseRelease": release.get("versionName"),
        "baseWpe": release.get("wpeWebkitVersion"),
        "commit": manifest["source"]["commit"],
        "modifiedFiles": manifest["source"].get("modifiedFiles"),
        "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }, indent=2) + "\n")
    shutil.rmtree(target, ignore_errors=True)
    staging.rename(target)
    write_dropin(paths, RENDERER_UNIT, RUNTIME_DROPIN, runtime_overlay_dropin(target, label))
    try:
        pid = restart_renderers(paths, web=False)
        expected = expected_artifacts(paths)
        problems = verify_artifacts(expected, running_artifacts(paths, pid))
        if not problems:
            settle(paths, pid)
    except Refused:
        rollback(paths, RENDERER_UNIT, RUNTIME_DROPIN)
        raise
    if problems:
        rollback(paths, RENDERER_UNIT, RUNTIME_DROPIN)
        raise Refused("the renderer restarted but does not run the overlay, so it was removed again:\n  "
                      + "\n  ".join(problems))
    source = manifest["source"]
    print(f"runtime-overlay: the renderer (pid {pid}) runs overlay {label}: Tilecast commit {source['commit']}"
          f"{' + ' + str(source['modifiedFiles']) + ' modified files' if source.get('modifiedFiles') else ''}.")
    print(f"runtime-overlay: renderer SHA-256 {expected['binary'][:16]}..., Runtime manifest "
          f"{expected['manifestSha256'][:16]}... ({len(expected['runtime'])} files), both read from the running process.")
    print("runtime-overlay: the release under /opt is unchanged. `runtime-overlay restore` or a reboot undoes this.")
    print("runtime-overlay: the overlay replaces the renderer and the Runtime as a whole; if the screen shows "
          "an unexpected state, check that it was built from the screen's release commit plus the diagnostics.")


def runtime_overlay_restore(paths, _args):
    require_root()
    if not remove_dropin(paths, RENDERER_UNIT, RUNTIME_DROPIN):
        print("runtime-overlay: none installed; the renderer runs the release's own files.")
        return
    pid = restart_renderers(paths, web=False)
    expected = release_expectation(paths)
    problems = verify_artifacts(expected, running_artifacts(paths, pid))
    if problems:
        raise Refused("the renderer restarted but does not run the release's own files:\n  " + "\n  ".join(problems))
    print(f"runtime-overlay: restored; the renderer (pid {pid}) runs the release's files, verified against "
          f"{expected['origin']}.")


def runtime_overlay_status(paths, _args):
    settings = tool_settings(paths, RENDERER_UNIT)
    label = settings["runtimeOverlay"]
    print(f"runtime overlay drop-in: {'present (' + label + ')' if label else 'absent'}")
    for base in sorted(paths.runtime_overlays.glob("*/base.json")):
        info = json.loads(base.read_text())
        print(f"  overlay {info['label']}: commit {info.get('commit')}"
              f"{' + ' + str(info.get('modifiedFiles')) + ' modified files' if info.get('modifiedFiles') else ''}, "
              f"over release {info.get('baseRelease')} (installed {info.get('installedAt')})")
    pid = main_pid(RENDERER_UNIT)
    if pid:
        running = running_artifacts(paths, pid)
        problems = verify_artifacts(expected_artifacts(paths), running)
        print(f"renderer pid {pid}: binary sha256 {(running['binary'] or '?')[:16]}..., "
              f"{len(running['runtime'])} Runtime files, "
              f"{'matches ' + describe_expectation(expected_artifacts(paths)) if not problems else 'DIFFERS: ' + '; '.join(problems)}")


# ---- doctor ----------------------------------------------------------------


def doctor_state(paths):
    """Everything `doctor` reports, as data (also stored in the bundle)."""
    release = release_manifest(paths)
    unit = unit_show(RENDERER_UNIT, "ActiveState", "MainPID", "ExecStart", "FragmentPath", "DropInPaths", "NRestarts")
    pid = int(unit["MainPID"]) if unit.get("MainPID", "").isdigit() and int(unit["MainPID"]) > 0 else None
    inherited, _ = unit_inherited(paths, RENDERER_UNIT)
    settings = tool_settings(paths, RENDERER_UNIT)
    try:
        argv = parse_exec_start(unit.get("ExecStart", ""))
        exec_problem = None
    except Refused as refusal:
        argv, exec_problem = None, str(refusal)
    supported, support_message = trace_support(paths)
    state = {
        "release": {"edgeVersion": release.get("versionName"), "wpeVersion": release.get("wpeWebkitVersion"),
                    "arch": platform.machine()},
        "updateProvisional": provisional_update(paths),
        "renderer": {"active": unit.get("ActiveState"), "pid": pid, "restarts": unit.get("NRestarts"),
                     "unitFile": unit.get("FragmentPath"),
                     "dropIns": [{"path": path, "toolOwned": Path(path).name in TOOL_DROPINS}
                                 for path in unit.get("DropInPaths", "").split()],
                     "execStart": argv, "execStartProblem": exec_problem},
        "inheritedCompositorEnvironment": inherited,
        "toolSettings": settings,
        "traceSupport": {"ok": supported, "message": support_message},
        "runtimeOverlay": None,
        "live": None,
    }
    try:
        active = active_runtime_overlay(paths)
    except Refused as refusal:
        active = None
        state["runtimeOverlay"] = {"label": settings["runtimeOverlay"], "problem": str(refusal)}
    if active:
        state["runtimeOverlay"] = {"label": active[0], "commit": active[1]["source"]["commit"],
                                   "modifiedFiles": active[1]["source"].get("modifiedFiles")}
    if pid:
        observation = environment.observe(paths.proc, pid)
        try:
            expected = expected_artifacts(paths)
        except Refused:
            expected = None
        live = {"environment": {"renderer": observation["main"], "webProcess": observation["web"]},
                "compositor": environment.classify_compositor(observation["web"] or observation["main"] or {}),
                "wpe": running_wpe(paths, pid)}
        if expected is not None:
            live["artifactProblems"] = verify_artifacts(expected, running_artifacts(paths, pid))
        configured = {item["name"]: item["value"] for item in inherited}
        configured.update(settings["env"])
        for name in settings["unset"]:
            configured.pop(name, None)
        if observation["main"] is not None:
            live["environmentDiffersFromConfiguration"] = environment.compare_environment(configured,
                                                                                         observation["main"])
        state["live"] = live
    return state


def doctor_findings(state):
    """[(level, text)]: level is ok, info, warn or block."""
    findings = []
    add = lambda level, text: findings.append((level, text))
    release = state["release"]
    add("info", f"Tilecast Edge {release['edgeVersion'] or '(no release manifest)'} on {release['arch']}, "
                f"WPE WebKit {release['wpeVersion'] or '?'}")
    renderer = state["renderer"]
    if renderer["active"] == "active" and renderer["pid"]:
        add("ok", f"the renderer is running (pid {renderer['pid']}, {renderer['restarts']} restarts)")
    else:
        add("warn", f"the renderer is not running ({renderer['active']})")
    if renderer["execStartProblem"]:
        add("block", renderer["execStartProblem"])
    outside = [d["path"] for d in renderer["dropIns"] if not d["toolOwned"]]
    add("info", "drop-ins of the renderer unit: " + (", ".join(outside) if outside else "none besides this tool's"))
    if state["updateProvisional"]:
        add("block", "an Edge update is provisional: do not install an overlay until it confirms or rolls back")
    inherited = state["inheritedCompositorEnvironment"]
    if inherited:
        for item in inherited:
            add("block", f"{item['name']}={item['value']} is already set by {item['source']}; an experiment profile "
                         "that does not set it would not be what runs "
                         f"(it makes the renderer {environment.classify_compositor({i['name']: i['value'] for i in inherited})})")
        add("info", "remove those settings, or add --clear-inherited to `trace enable` (the lab always clears them)")
    else:
        add("ok", "no compositor variable is set by the unit, its drop-ins, an EnvironmentFile or the service manager")
    live = state["live"]
    if live is None:
        add("info", "no live renderer process to read; start it or run as root for the process check")
    else:
        if live["environment"]["renderer"] is None:
            add("info", "cannot read /proc/<pid>/environ: run as root for the live environment check")
        else:
            seen = {**live["environment"]["renderer"]}
            add("ok" if not seen else "info",
                f"the renderer process has compositor variables: {seen or 'none'}; compositor: {live['compositor']}")
            if live["environment"]["webProcess"] is None:
                add("info", "no WPEWebProcess found yet")
            elif live["environment"]["webProcess"] != live["environment"]["renderer"]:
                add("warn", f"the web process has different compositor variables: {live['environment']['webProcess']}")
        for problem in live.get("environmentDiffersFromConfiguration") or ():
            add("warn", f"the running renderer differs from its unit configuration ({problem}); it was started "
                        "before a configuration change")
        for problem in live.get("artifactProblems") or ():
            add("warn", problem)
    overlay = state["runtimeOverlay"]
    if overlay and "problem" in overlay:
        add("block", overlay["problem"])
    elif overlay:
        add("info", f"diagnostic Tilecast overlay {overlay['label']} is active (commit {overlay['commit'][:12]}"
                    f"{' + local changes' if overlay.get('modifiedFiles') else ''})")
    else:
        add("info", "no diagnostic Tilecast overlay: the renderer runs the signed release's files")
    support = state["traceSupport"]
    add("ok" if support["ok"] else "warn",
        ("real-Runtime tracing is possible: " if support["ok"] else "`trace enable` would refuse: ")
        + support["message"])
    wpe = state["toolSettings"]["wpeOverlay"]
    add("info", f"WPE overlay: {wpe}" if wpe else "WPE overlay: none (the release's WebKit)")
    return findings


def doctor(paths, args):
    state = doctor_state(paths)
    findings = doctor_findings(state)
    if args.json:
        print(json.dumps({"state": state, "findings": [{"level": a, "text": b} for a, b in findings]}, indent=2))
    else:
        marks = {"ok": "ok   ", "info": "info ", "warn": "WARN ", "block": "BLOCK"}
        for level, text in findings:
            print(f"{marks[level]} {text}")
        blocks = sum(1 for level, _ in findings if level == "block")
        print(f"doctor: {blocks} blocking problem(s)." if blocks else "doctor: nothing blocks the experiments.")
        print("doctor: the lab runs on the release as installed; only `trace enable` needs the diagnostic "
              "Tilecast overlay.")
    return 1 if any(level == "block" for level, _ in findings) else 0


# ---- overlay --------------------------------------------------------------


def overlay_install(paths, args):
    require_root()
    if provisional_update(paths):
        raise Refused("an Edge update is provisional; let it confirm or roll back first")
    data = Path(args.tar).read_bytes()
    if args.sha256 and hashlib.sha256(data).hexdigest() != args.sha256.lower():
        raise Refused("the overlay archive does not match --sha256")
    manifest, files = read_overlay_tar(data, platform.machine())
    label = manifest["label"]
    release_wpe = paths.release_wpe().resolve()
    if not (release_wpe / "lib" / "libWPEWebKit-2.0.so.1").is_file():
        raise Refused(f"{release_wpe} is not an Edge release WPE directory")
    target = paths.overlays / label
    staging = paths.overlays / f".staging-{label}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, mode=0o755)
    # Start from the release's own lib/wpe (it carries libraries such as
    # libwpe-1.0.so.1 that a WebKit build does not), then lay the build over it.
    shutil.copytree(release_wpe, staging / "wpe", symlinks=False)
    write_tree(staging / "wpe", files, is_executable_overlay_file)
    release = json.loads((paths.release_link / "tilecast-edge-release.json").read_text())
    (staging / "base.json").write_text(json.dumps({
        "label": label,
        "baseRelease": release.get("versionName"),
        "baseWpe": release.get("wpeWebkitVersion"),
        "overlayWebkit": manifest.get("webkitVersion"),
        "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    }, indent=2) + "\n")
    shutil.rmtree(target, ignore_errors=True)
    staging.rename(target)
    for unit in (RENDERER_UNIT, WEB_UNIT):
        write_dropin(paths, unit, OVERLAY_DROPIN, overlay_dropin(target / "wpe", "/opt/tilecast-edge/current/lib/wpe",
                                                                 label))
    pid = restart_renderers(paths)
    seen = paths.proc / str(pid) / "root/opt/tilecast-edge/current/lib/wpe" / OVERLAY_MANIFEST
    mapped, digest = loaded_webkit(pid, paths.proc)
    expected = manifest["files"]["lib/libWPEWebKit-2.0.so.1"]["sha256"]
    if not seen.is_file() or digest != expected:
        raise Refused("the renderer restarted but is not running the overlay; run `overlay restore`")
    print(f"overlay: the renderer (pid {pid}) runs WPE WebKit {manifest.get('webkitVersion')} from overlay {label}.")
    print(f"overlay: {mapped} is the overlay's build (sha256 {digest[:16]}...). `overlay restore` undoes this.")


def overlay_restore(paths, _args):
    require_root()
    removed = [remove_dropin(paths, unit, OVERLAY_DROPIN) for unit in (RENDERER_UNIT, WEB_UNIT)]
    if not any(removed):
        print("overlay: none installed; the renderer runs the release's WPE.")
        return
    pid = restart_renderers(paths)
    _, digest = loaded_webkit(pid, paths.proc)
    release_lib = paths.release_wpe().resolve() / "lib" / "libWPEWebKit-2.0.so.1"
    expected = hashlib.sha256(release_lib.read_bytes()).hexdigest()
    if digest != expected:
        raise Refused("the renderer restarted but does not run the release's WebKit; check systemctl cat")
    print(f"overlay: restored; the renderer (pid {pid}) runs the release's own WPE WebKit.")


def overlay_status(paths, _args):
    dropin = paths.run_units / f"{RENDERER_UNIT}.d" / OVERLAY_DROPIN
    print(f"overlay drop-in: {'present' if dropin.exists() else 'absent'}")
    for base in sorted(paths.overlays.glob("*/base.json")):
        info = json.loads(base.read_text())
        print(f"  overlay {info['label']}: WebKit {info.get('overlayWebkit')} over release "
              f"{info.get('baseRelease')} (WPE {info.get('baseWpe')})")
    pid = main_pid(RENDERER_UNIT)
    if pid:
        path, digest = loaded_webkit(pid, paths.proc)
        seen = paths.proc / str(pid) / "root/opt/tilecast-edge/current/lib/wpe" / OVERLAY_MANIFEST
        label = json.loads(seen.read_text())["label"] if seen.is_file() else "release"
        print(f"renderer pid {pid}: {label} WPE, {path} sha256 {digest[:16] if digest else '?'}...")


# ---- lab ------------------------------------------------------------------


def lab_install(paths, args):
    require_root()
    members = read_lab_tar(Path(args.tar).read_bytes())
    staging = paths.state / ".staging-lab"
    shutil.rmtree(staging, ignore_errors=True)
    write_tree(staging, members, lambda relative, mode: bool(mode))
    shutil.rmtree(paths.lab, ignore_errors=True)
    paths.state.mkdir(parents=True, exist_ok=True, mode=0o755)
    staging.rename(paths.lab)
    print(f"lab: installed in {paths.lab}")


def lab_command(paths, scene, variant, iterations, inspect, out):
    if not SCENE.match(scene):
        raise Refused("--scene must be a scene name")
    command = [str(paths.lab / "bin" / "tilecast-wpe-compositor-lab"), "--platform=drm", f"--scene={scene}",
               f"--iterations={iterations}", f"--out={out}", f"--inspect={inspect}"]
    if variant:
        if not VARIANT.match(variant):
            raise Refused("--variant must be a short name")
        command.append(f"--variant={variant}")
    return command


def lab_unit_properties(paths, out, env, overlay):
    """systemd-run properties: the renderer unit's account, devices and TTY,
    WebKit's sandbox on, and the overlay mount when one is chosen."""
    home = out / "home"
    props = [
        "User=tilecast", "Group=tilecast", "SupplementaryGroups=video render input",
        "TTYPath=/dev/tty1", "StandardInput=tty-force", "TTYReset=yes", "TTYVHangup=yes",
        f"StandardOutput=file:{out}/lab.log", f"StandardError=file:{out}/lab.log",
        "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectHome=yes", "ProtectSystem=strict",
        f"ReadWritePaths={out}", "InaccessiblePaths=-/var/lib/tilecast-edge",
        f"Environment=HOME={home}", f"Environment=XDG_CACHE_HOME={home}/cache",
        f"Environment=XDG_CONFIG_HOME={home}/config", f"Environment=XDG_DATA_HOME={home}/data",
    ]
    props += [f"Environment={name}={value}" for name, value in sorted(env.items())]
    # The lab is this tool's own transient unit, so the profile is the whole
    # compositor environment: whatever the service manager would add is unset.
    props += [f"UnsetEnvironment={name}" for name in ENV_ALLOWLIST if name not in env]
    if overlay:
        props.append(f"BindReadOnlyPaths={overlay}:/opt/tilecast-edge/current/lib/wpe")
    return props


def resolve_wpe(paths, wpe):
    if wpe in (None, "release"):
        return None
    if not LABEL.match(wpe) or not (paths.overlays / wpe / "wpe").is_dir():
        raise Refused(f"no overlay {wpe!r}; install it with `overlay install` (it stays until `overlay purge`)")
    return paths.overlays / wpe / "wpe"


def run_lab(paths, scene, variant, iterations, env, wpe, inspect, tag):
    """One lab run as a transient unit; the renderer is stopped meanwhile."""
    if not (paths.lab / "bin" / "tilecast-wpe-compositor-lab").is_file():
        raise Refused("the lab is not installed; run `lab install`")
    overlay = resolve_wpe(paths, wpe)
    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    out = paths.results / f"{stamp}-{tag}"
    (out / "home").mkdir(parents=True, mode=0o750)
    shutil.chown(out, "tilecast", "tilecast")
    shutil.chown(out / "home", "tilecast", "tilecast")
    run_info = {"scene": scene, "variant": variant, "iterations": iterations, "wpe": wpe or "release",
                "env": env, "inspect": inspect, "tool": TOOL_VERSION}
    (out / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
    props = lab_unit_properties(paths, out, env, overlay)
    command = lab_command(paths, scene, variant, iterations, inspect, out)
    args = ["systemd-run", "--wait", "--collect", "--quiet", f"--unit={LAB_UNIT}", "--service-type=exec"]
    for prop in props:
        args += ["-p", prop]
    args += command
    process = subprocess.Popen(args)
    check = watch_lab_environment(paths, process, env)
    status = process.wait()
    # Requested and observed, side by side, in the run's own record.
    run_info.update({"requestedEnv": env, "requestedCompositor": environment.classify_compositor(env),
                     "observed": check["observed"], "observedCompositor": check["compositor"],
                     "environmentVerified": check["ok"], "environmentProblems": check["problems"], "exit": status})
    (out / "run.json").write_text(json.dumps(run_info, indent=2) + "\n")
    if not check["ok"]:
        raise Refused(f"lab run {tag}: the environment that reached the lab is not the profile's, so the run is "
                      f"not counted (see {out}/run.json):\n  " + "\n  ".join(check["problems"]))
    summary_path = out / "summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.is_file() else {"result": "no_summary"}
    summary["_run"] = {"dir": str(out), "exit": status, "wpe": wpe or "release", "env": env, "tag": tag,
                       "compositor": check["compositor"]}
    return summary


def watch_lab_environment(paths, process, expected, wait=60.0, poll=0.1):
    """Reads the lab's real environment while it runs; stops it on a mismatch."""
    deadline = time.monotonic() + wait
    result = None
    while process.poll() is None:
        pid = main_pid(LAB_UNIT)
        if pid:
            observation = environment.observe(paths.proc, pid)
            result = environment.evaluate(expected, observation, give_up=False)
            if result["problems"]:
                systemctl("stop", LAB_UNIT, check=False)
                return result
            if result["complete"]:
                return result
        if time.monotonic() >= deadline:
            break
        time.sleep(poll)
    if result is None:
        result = environment.evaluate(expected, {"pid": None, "main": None, "webPid": None, "web": None}, give_up=True)
    elif not result["complete"]:
        result = dict(result, ok=False, problems=result["problems"] + [
            "the WebKit web process was not found, so the compositor variables it runs with are unverified"])
    return result


class RenderersStopped:
    """Stops the renderer (and the web helper) for DRM master, and always
    starts what was running again."""

    def __init__(self):
        self.restart = []

    def __enter__(self):
        for unit in (RENDERER_UNIT, WEB_UNIT):
            if unit_active(unit):
                self.restart.append(unit)
        for unit in (RENDERER_UNIT, WEB_UNIT):
            systemctl("stop", unit, check=False)
        return self

    def __exit__(self, *exc):
        for unit in reversed(self.restart):
            systemctl("start", unit, check=False)
        return False


def lab_run(paths, args):
    require_root()
    env = parse_env(args.env)
    tag = f"{args.scene}-{args.wpe or 'release'}" + ("-" + "-".join(f"{k}={v}" for k, v in env.items()) if env else "")
    tag = re.sub(r"[^A-Za-z0-9_.=-]", "_", tag)[:120]
    with RenderersStopped():
        summary = run_lab(paths, args.scene, args.variant, args.iterations, env, args.wpe, args.inspect, tag)
    print(json.dumps(row(summary), indent=2))


def row(summary):
    pacing = summary.get("pacing") or {}
    anomalies = summary.get("anomalies") or {}
    run_info = summary.get("_run", {})
    return {
        "wpe": run_info.get("wpe"),
        "webkit": summary.get("webkit"),
        "config": run_info.get("config"),
        "compositor": run_info.get("compositor"),
        "scene": summary.get("scene"),
        "variant": summary.get("variant"),
        "result": summary.get("result"),
        "iterations": summary.get("iterationsCompleted"),
        "anomalies": anomalies.get("total"),
        "byKind": anomalies.get("byKind"),
        "frames": pacing.get("frames"),
        "fps": pacing.get("fps"),
        "medianMs": pacing.get("medianMs"),
        "p95Ms": pacing.get("p95Ms"),
        "p99Ms": pacing.get("p99Ms"),
        "maxMs": pacing.get("maxMs"),
        "longFrames": pacing.get("longFrames"),
        "missedFrames": pacing.get("missedFrames"),
        "formats": (summary.get("buffers") or {}).get("formats"),
        "dir": run_info.get("dir"),
    }


def matrix_table(rows):
    header = ["wpe", "webkit", "config", "compositor", "scene", "result", "anomalies", "fps", "p95Ms", "p99Ms", "maxMs",
              "missedFrames"]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for r in rows:
        lines.append("| " + " | ".join("" if r.get(h) is None else str(r.get(h)) for h in header) + " |")
    return "\n".join(lines) + "\n"


def matrix_plan(definition, preset, wpes, scenes):
    configs = definition["presets"][preset]
    plan = []
    for wpe in wpes:
        for config in configs:
            for scene in scenes:
                plan.append((wpe, config, scene))
    return plan


def lab_matrix(paths, args):
    require_root()
    definition = json.loads((HERE / "compositor-matrix.json").read_text())
    if args.preset not in definition["presets"]:
        raise Refused(f"--preset must be one of {', '.join(definition['presets'])}")
    scenes = args.scenes.split(",") if args.scenes else definition["scenes"]
    wpes = args.wpe.split(",") if args.wpe else ["release"]
    for wpe in wpes:
        resolve_wpe(paths, wpe)
    plan = matrix_plan(definition, args.preset, wpes, scenes)
    rows = []
    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    report_dir = paths.results / f"matrix-{stamp}"
    report_dir.mkdir(parents=True)
    with RenderersStopped():
        for index, (wpe, config, scene) in enumerate(plan, 1):
            env = parse_env(f"{k}={v}" for k, v in config["env"].items())
            print(f"matrix {index}/{len(plan)}: {wpe} {config['name']} {scene}", flush=True)
            summary = run_lab(paths, scene, None, args.iterations, env, wpe, config.get("inspect", "transitions"),
                              f"{scene}-{wpe}-{config['name']}")
            summary["_run"]["config"] = config["name"]
            rows.append(row(summary))
            (report_dir / "matrix.json").write_text(json.dumps({"preset": args.preset, "rows": rows}, indent=2))
    (report_dir / "matrix.md").write_text(matrix_table(rows))
    print(matrix_table(rows))
    print(f"matrix: {report_dir}")


# ---- bundle ---------------------------------------------------------------


def read_text(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def drm_facts(paths):
    """Driver and connector facts from sysfs: IDs, driver names, modes. No
    serial numbers and no EDID."""
    cards, connectors = [], []
    for card in sorted(paths.sys_drm.glob("card[0-9]*")):
        if "-" in card.name:
            connectors.append({
                "name": card.name.split("-", 1)[1],
                "status": read_text(card / "status"),
                "enabled": read_text(card / "enabled"),
                "dpms": read_text(card / "dpms"),
                "modes": (read_text(card / "modes") or "").splitlines()[:8],
            })
        else:
            device = card / "device"
            driver = device / "driver"
            cards.append({
                "card": card.name,
                "driver": os.path.basename(os.readlink(driver)) if driver.is_symlink() else None,
                "vendor": read_text(device / "vendor"),
                "device": read_text(device / "device"),
                "subsystemVendor": read_text(device / "subsystem_vendor"),
                "subsystemDevice": read_text(device / "subsystem_device"),
            })
    return {"cards": cards, "connectors": connectors}


def package_versions(packages):
    result = run(["dpkg-query", "-W", "-f", "${Package}\t${Version}\n", *packages], check=False)
    versions = {}
    for line in result.splitlines():
        name, _, version = line.partition("\t")
        if name:
            versions[name] = version
    return versions


GRAPHICS_PACKAGES = (
    "libgbm1", "libegl-mesa0", "libgl1-mesa-dri", "mesa-libgallium", "mesa-vulkan-drivers", "libdrm2",
    "libgstreamer1.0-0", "gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good", "gstreamer1.0-plugins-bad",
    "gstreamer1.0-libav", "gstreamer1.0-vaapi", "intel-media-va-driver", "i965-va-driver", "libva2", "bubblewrap",
)


def cpu_facts(root=Path("/")):
    model, cores = None, 0
    for line in (read_text(root / "proc/cpuinfo") or "").splitlines():
        key, _, value = line.partition(":")
        if key.strip() in ("model name", "Model") and model is None:
            model = value.strip()
        if key.strip() == "processor":
            cores += 1
    return {"model": model, "logicalCpus": cores}


def renderer_facts():
    keys = ("NRestarts", "MemoryCurrent", "MemoryPeak", "ActiveState", "SubState", "ExecMainStartTimestampMonotonic")
    output = systemctl("show", *[f"-p{k}" for k in keys], RENDERER_UNIT, check=False)
    facts = {}
    for line in output.splitlines():
        key, _, value = line.partition("=")
        if key in keys:
            facts[key] = value
    return facts


def compositor_dropins(paths):
    """What this tool's drop-ins set, by unit: variables, cleared names and mounts."""
    result = {}
    for unit in (RENDERER_UNIT, WEB_UNIT):
        settings = tool_settings(paths, unit)
        if any(settings.values()):
            result[unit] = settings
    return result


def known_private_values(root=Path("/")):
    values = {socket.gethostname(), read_text(root / "etc/machine-id") or ""}
    try:
        for address in socket.getaddrinfo(socket.gethostname(), None):
            values.add(address[4][0])
    except OSError:
        pass
    return [value for value in values if value]


RESULT_FILES = re.compile(r"^(summary\.json|timeline\.jsonl|run\.json|anomaly-\d+-(before|frame|after)-seq\d+\.ppm)$")


def bundle(paths, args):
    out = Path(args.out)
    index = {"schema": "tilecast-graphics-bundle-v1", "tool": TOOL_VERSION, "files": [], "privacy": (
        "Graphics facts only: versions, driver and connector IDs, modes, buffer formats, compositor variables, "
        "synthetic lab results, the renderer's visual trace (event names, ordinals and timestamps), the "
        "diagnostic Tilecast overlay's git commit and file hashes, and the environment the renderer ran with. No "
        "credentials, Server addresses, screen, player or manifest IDs, file names, content, host name or "
        "journal unless --renderer-log, which is sanitized and checked first.")}
    release = json.loads(read_text(paths.release_link / "tilecast-edge-release.json") or "{}")
    facts = {
        "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "tilecastEdge": release.get("versionName"),
        "releaseWpe": release.get("wpeWebkitVersion"),
        "baseDistribution": release.get("baseDistribution"),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu": cpu_facts(paths.root),
        "drm": drm_facts(paths),
        "packages": package_versions(GRAPHICS_PACKAGES),
        "renderer": renderer_facts(),
        "compositorDropins": compositor_dropins(paths),
        "overlays": [json.loads(p.read_text()) for p in sorted(paths.overlays.glob("*/base.json"))],
        "runtimeOverlays": [json.loads(p.read_text()) for p in sorted(paths.runtime_overlays.glob("*/base.json"))],
        "doctor": doctor_state(paths),
    }
    # The Tilecast commit this screen was running, when it is a diagnostic build.
    try:
        active = active_runtime_overlay(paths)
    except Refused:
        active = None
    facts["tilecastCommit"] = ({"commit": active[1]["source"]["commit"], "modifiedFiles":
                                active[1]["source"].get("modifiedFiles"), "overlay": active[0]}
                               if active else None)
    probe = run([RENDERER_BINARY, "--probe-drm"], check=False) if Path(RENDERER_BINARY).exists() else ""
    try:
        facts["drmProbe"] = json.loads(probe) if probe.strip() else None
    except ValueError:
        facts["drmProbe"] = None
    with tempfile.TemporaryDirectory() as work:
        staging = Path(work) / "tilecast-graphics-bundle"
        staging.mkdir()

        def add(relative, data):
            path = staging / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data if isinstance(data, bytes) else data.encode())
            index["files"].append(relative)

        add("facts.json", json.dumps(facts, indent=2) + "\n")
        if args.trace:
            for name in ("visual-trace.jsonl", "visual-trace.jsonl.prev"):
                source = paths.trace_dir / name
                if source.is_file():
                    add(f"trace/{name}", source.read_bytes())
            if paths.session.is_file():
                add("trace/trace-meta.json", paths.session.read_bytes())
        for result in args.results or ():
            directory = Path(result)
            for path in sorted(directory.iterdir()):
                if path.is_file() and RESULT_FILES.match(path.name):
                    add(f"lab/{directory.name}/{path.name}", path.read_bytes())
        if args.renderer_log:
            journal = run(["journalctl", "-u", RENDERER_UNIT, "-b", "-o", "short-monotonic", "--no-pager",
                           "-n", "5000"], check=False)
            cleaned = sanitize_log.sanitize(journal)
            left = sanitize_log.find_private(cleaned, known_private_values(paths.root))
            if left:
                raise Refused(f"the sanitized renderer log still has {', '.join(sorted(set(left)))}; not included")
            add("logs/renderer.log", cleaned)
        add("bundle.json", json.dumps(index, indent=2) + "\n")
        with tarfile.open(out, "w:gz") as archive:
            archive.add(staging, arcname=staging.name)
    print(f"bundle: {out} ({len(index['files'])} files)")


# ---- command line ---------------------------------------------------------


def parser():
    top = argparse.ArgumentParser(prog="tilecast-wpe-debug", description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = top.add_subparsers(dest="area", required=True)

    trace = sub.add_parser("trace").add_subparsers(dest="action", required=True)
    enable = trace.add_parser("enable")
    enable.add_argument("--deep", action="store_true", help="also sample computed styles (perturbs rendering)")
    enable.add_argument("--seconds", type=int, default=120)
    enable.add_argument("--env", action="append", help="NAME=VALUE compositor variable (allowlisted)")
    enable.add_argument("--clear-inherited", action="store_true",
                        help="UnsetEnvironment= for compositor variables the unit already sets (see doctor)")
    enable.set_defaults(handler=trace_enable)
    trace.add_parser("disable").set_defaults(handler=trace_disable)
    collect = trace.add_parser("collect")
    collect.add_argument("--out", required=True)
    collect.set_defaults(handler=trace_collect)

    check = sub.add_parser("doctor", help="what reaches the renderer, and what each experiment needs")
    check.add_argument("--json", action="store_true")
    check.set_defaults(handler=doctor)

    runtime = sub.add_parser("runtime-overlay").add_subparsers(dest="action", required=True)
    runtime_install = runtime.add_parser("install")
    runtime_install.add_argument("tar")
    runtime_install.add_argument("--sha256")
    runtime_install.set_defaults(handler=runtime_overlay_install)
    runtime.add_parser("restore").set_defaults(handler=runtime_overlay_restore)
    runtime.add_parser("status").set_defaults(handler=runtime_overlay_status)

    overlay = sub.add_parser("overlay").add_subparsers(dest="action", required=True)
    install = overlay.add_parser("install")
    install.add_argument("tar")
    install.add_argument("--sha256")
    install.set_defaults(handler=overlay_install)
    overlay.add_parser("restore").set_defaults(handler=overlay_restore)
    overlay.add_parser("status").set_defaults(handler=overlay_status)

    lab = sub.add_parser("lab").add_subparsers(dest="action", required=True)
    lab_inst = lab.add_parser("install")
    lab_inst.add_argument("tar")
    lab_inst.set_defaults(handler=lab_install)
    lab_one = lab.add_parser("run")
    lab_one.add_argument("--scene", required=True)
    lab_one.add_argument("--variant")
    lab_one.add_argument("--iterations", type=int, default=30)
    lab_one.add_argument("--wpe", default="release")
    lab_one.add_argument("--env", action="append")
    lab_one.add_argument("--inspect", default="transitions", choices=["off", "transitions", "all"])
    lab_one.set_defaults(handler=lab_run)
    matrix = lab.add_parser("matrix")
    matrix.add_argument("--preset", default="baseline")
    matrix.add_argument("--wpe", help="comma-separated: release and overlay labels")
    matrix.add_argument("--scenes", help="comma-separated scene names (default: all)")
    matrix.add_argument("--iterations", type=int, default=30)
    matrix.set_defaults(handler=lab_matrix)

    pack = sub.add_parser("bundle")
    pack.add_argument("--out", required=True)
    pack.add_argument("--trace", action="store_true", help="include the renderer's visual trace")
    pack.add_argument("--results", action="append", help="a lab result directory to include")
    pack.add_argument("--renderer-log", action="store_true", help="include the sanitized renderer journal")
    pack.set_defaults(handler=bundle)
    return top


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return args.handler(Paths(), args) or 0
    except Refused as refusal:
        print(f"tilecast-wpe-debug: {refusal}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
