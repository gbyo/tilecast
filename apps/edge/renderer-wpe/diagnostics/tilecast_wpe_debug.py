#!/usr/bin/env python3
"""tilecast-wpe-debug: graphics diagnostics on one Tilecast Edge screen.

Developer and operator tool; it is not part of an Edge release. Copy this
directory to the screen and run it as root (python3 -I). Every change it
makes is temporary: drop-ins go to /run/systemd/system, which a reboot
clears, and nothing in an installed release (/opt/tilecast-edge) is ever
written. See docs/tilecast-edge-wpe-compositor-lab.md.

  trace enable [--deep] [--seconds N] [--env NAME=VALUE ...]
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
import sanitize_log  # noqa: E402

TOOL_VERSION = "1"
RENDERER_UNIT = "tilecast-renderer.service"
WEB_UNIT = "tilecast-web-renderer.service"
RENDERER_BINARY = "/opt/tilecast-edge/current/bin/tilecast-renderer-wpe"
OVERLAY_MANIFEST = "tilecast-wpe-overlay.json"
OVERLAY_DROPIN = "90-tilecast-wpe-debug.conf"
TRACE_DROPIN = "91-tilecast-visual-trace.conf"
LABEL = re.compile(r"^[a-z0-9][a-z0-9.-]{0,47}$")
TOKEN = re.compile(r"^[A-Za-z0-9_.:,-]{0,64}$")
SCENE = re.compile(r"^[a-z0-9-]{1,48}$")
VARIANT = re.compile(r"^[A-Za-z0-9_.:-]{1,48}$")
ARG = re.compile(r"^[A-Za-z0-9_./=:,+-]+$")
MAX_OVERLAY_BYTES = 2 * 1024 * 1024 * 1024
MAX_LAB_BYTES = 256 * 1024 * 1024

# Mirrors tc_trace_env_allowlist in src/visual-trace-format.c; a test
# compares the two.
ENV_ALLOWLIST = (
    "WEBKIT_USE_SKIA_FOR_COMPOSITION",
    "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
    "WEBKIT_SKIA_CPU_PAINTING_THREADS",
    "WEBKIT_SKIA_GPU_PAINTING_THREADS",
    "WEBKIT_SKIA_USE_LINEAR_TILE_TEXTURES",
    "WEBKIT_SHOW_DAMAGE",
    "WEBKIT_SHOW_FPS",
    "WEBKIT_FORCE_VBLANK_TIMER",
    "WEBKIT_DISPLAY_REFRESH_THROTTLE_FPS",
    "WEBKIT_DISABLE_DMABUF_ATLAS",
    "WEBKIT_DEBUG",
    "WPE_BUFFER_FORMAT",
    "WPE_DRM_DISABLE_ATOMIC",
    "WPE_USE_EXPLICIT_SYNC",
)


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

    def __post_init__(self):
        r = self.root
        self.state = self.state or r / "var/lib/tilecast-wpe-debug"
        self.run_units = self.run_units or r / "run/systemd/system"
        self.etc_units = self.etc_units or r / "etc/systemd/system"
        self.release_link = self.release_link or r / "opt/tilecast-edge/current"
        self.trace_dir = self.trace_dir or r / "var/cache/tilecast-renderer/tilecast-visual-trace"
        self.sys_drm = self.sys_drm or r / "sys/class/drm"

    @property
    def overlays(self):
        return self.state / "overlays"

    @property
    def lab(self):
        return self.state / "lab"

    @property
    def results(self):
        return self.state / "results"

    def release_wpe(self):
        return self.release_link / "lib" / "wpe"


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


def trace_dropin(argv, seconds, deep, env):
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
    return "\n".join(lines) + "\n"


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
    value = systemctl("show", "-p", "MainPID", "--value", unit, check=False).strip()
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


def restart_renderers(paths):
    systemctl("daemon-reload")
    if unit_active(WEB_UNIT) or (paths.run_units / f"{WEB_UNIT}.d" / OVERLAY_DROPIN).exists():
        systemctl("restart", WEB_UNIT, check=False)
    systemctl("restart", RENDERER_UNIT)
    return wait_active(RENDERER_UNIT)


def loaded_webkit(pid):
    """(path, sha256) of the libWPEWebKit the process has mapped, read through
    the process's own mount namespace."""
    try:
        maps = Path(f"/proc/{pid}/maps").read_text()
    except OSError:
        return None, None
    for line in maps.splitlines():
        if line.endswith("libWPEWebKit-2.0.so.1"):
            path = line.split(None, 5)[-1]
            data = Path(f"/proc/{pid}/root{path}").read_bytes()
            return path, hashlib.sha256(data).hexdigest()
    return None, None


# ---- trace ----------------------------------------------------------------


def trace_enable(paths, args):
    require_root()
    env = parse_env(args.env)
    argv = parse_exec_start(systemctl("show", "-p", "ExecStart", "--value", RENDERER_UNIT))
    path = write_dropin(paths, RENDERER_UNIT, TRACE_DROPIN, trace_dropin(argv, args.seconds, args.deep, env))
    pid = restart_renderers(paths)
    print(f"trace: the renderer (pid {pid}) is recording {args.seconds} s{' (deep)' if args.deep else ''}"
          f"{' with ' + ', '.join(f'{k}={v}' for k, v in env.items()) if env else ''}.")
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
    print(f"trace: copied {', '.join(copied)} to {out}")


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
    seen = Path(f"/proc/{pid}/root/opt/tilecast-edge/current/lib/wpe/{OVERLAY_MANIFEST}")
    mapped, digest = loaded_webkit(pid)
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
    _, digest = loaded_webkit(pid)
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
        path, digest = loaded_webkit(pid)
        seen = Path(f"/proc/{pid}/root/opt/tilecast-edge/current/lib/wpe/{OVERLAY_MANIFEST}")
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
    (out / "run.json").write_text(json.dumps({
        "scene": scene, "variant": variant, "iterations": iterations, "wpe": wpe or "release", "env": env,
        "inspect": inspect,
    }, indent=2) + "\n")
    props = lab_unit_properties(paths, out, env, overlay)
    command = lab_command(paths, scene, variant, iterations, inspect, out)
    args = ["systemd-run", "--wait", "--collect", "--quiet", "--unit=tilecast-wpe-lab", "--service-type=exec"]
    for prop in props:
        args += ["-p", prop]
    args += command
    status = subprocess.run(args, check=False).returncode
    summary_path = out / "summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.is_file() else {"result": "no_summary"}
    summary["_run"] = {"dir": str(out), "exit": status, "wpe": wpe or "release", "env": env, "tag": tag}
    return summary


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
    header = ["wpe", "webkit", "config", "scene", "result", "anomalies", "fps", "p95Ms", "p99Ms", "maxMs",
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
    """The compositor variables set by this tool's drop-ins, by unit."""
    env = {}
    for unit in (RENDERER_UNIT, WEB_UNIT):
        for name in (TRACE_DROPIN, OVERLAY_DROPIN):
            text = read_text(paths.run_units / f"{unit}.d" / name) or ""
            for line in text.splitlines():
                match = re.match(r"^Environment=([A-Z0-9_]+)=(.*)$", line)
                if match and match.group(1) in ENV_ALLOWLIST:
                    env.setdefault(unit, {})[match.group(1)] = match.group(2)
                if line.startswith("BindReadOnlyPaths="):
                    env.setdefault(unit, {})["overlay"] = Path(line.split("=", 1)[1].split(":")[0]).parent.name
    return env


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
        "synthetic lab results and the renderer's visual trace (event names, ordinals and timestamps). No "
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
    }
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
    enable.set_defaults(handler=trace_enable)
    trace.add_parser("disable").set_defaults(handler=trace_disable)
    collect = trace.add_parser("collect")
    collect.add_argument("--out", required=True)
    collect.set_defaults(handler=trace_collect)

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
        args.handler(Paths(), args)
    except Refused as refusal:
        print(f"tilecast-wpe-debug: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
