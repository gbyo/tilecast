"""What reaches the renderer: parsing, comparison and observation.

An experiment profile ("Skia", "TextureMapper") is only true if the compositor
variables that reach the WebKit processes say so. systemd can add variables the
tool did not ask for (a unit's own Environment=, any drop-in under /etc or /run,
an EnvironmentFile=, the service manager's environment). So the tool never
labels a run from what it requested. It reads what the unit would pass
(`inherited_environment`), and after the process starts it reads
/proc/<pid>/environ of the renderer (or lab) and of its WPEWebProcess and
compares that with the profile (`compare_environment`).

Everything here is pure or reads files under an injected /proc root, so the
tests cover it without systemd. See docs/tilecast-edge-wpe-compositor-lab.md.
"""
import re
import shlex
import time
from pathlib import Path

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

# The processes whose environment decides the compositor: the renderer (or
# lab) itself and the WebKit web process, which runs the compositor.
WEB_PROCESS_NAME = "WPEWebProcess"

_ASSIGNMENT = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def parse_show(text):
    """`systemctl show` output as {property: value}."""
    properties = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key:
            properties[key] = value
    return properties


def parse_environment_property(value):
    """The Environment (or manager environment) value of systemd, shell-quoted."""
    environment = {}
    if not value.strip():
        return environment
    try:
        words = shlex.split(value)
    except ValueError:
        words = value.split()
    for word in words:
        name, sep, text = word.partition("=")
        if sep and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            environment[name] = text
    return environment


def parse_show_environment(text):
    """`systemctl show-environment`: one NAME=value per line (C-quoted when needed)."""
    environment = {}
    for line in text.splitlines():
        match = _ASSIGNMENT.match(line.strip())
        if not match:
            continue
        value = match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif value.startswith("$'") and value.endswith("'"):
            value = value[2:-1]
        environment[match.group(1)] = value
    return environment


def parse_environment_file(text):
    """The assignments of an EnvironmentFile=. Comments and bad lines are skipped."""
    environment = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#;":
            continue
        match = _ASSIGNMENT.match(line)
        if not match:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        environment[match.group(1)] = value
    return environment


def parse_environment_files_property(value):
    """EnvironmentFiles=path (ignore_errors=no) ... -> [path]."""
    return [match.group(1) for match in re.finditer(r"(\S+) \(ignore_errors=(?:yes|no)\)", value)]


def parse_unset(value):
    """UnsetEnvironment= names (a NAME or a NAME=VALUE both unset NAME)."""
    return {word.partition("=")[0] for word in value.split() if word}


def allowlisted(environment):
    return {name: value for name, value in environment.items() if name in ENV_ALLOWLIST}


def parse_environ(data):
    """/proc/<pid>/environ: NUL-separated assignments."""
    environment = {}
    for item in data.split(b"\0"):
        name, sep, value = item.partition(b"=")
        if sep and name:
            environment[name.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return environment


def classify_compositor(environment):
    """What WPE WebKit 2.54 does with these variables.

    DrawingAreaCoordinatedGraphicsGLib.cpp turns Skia compositing off only for
    WEBKIT_USE_SKIA_FOR_COMPOSITION exactly "0". WebProcessGLib.cpp turns
    accelerated buffers off when WEBKIT_SKIA_ENABLE_CPU_RENDERING is set to
    anything but "0".
    """
    texturemapper = environment.get("WEBKIT_USE_SKIA_FOR_COMPOSITION") == "0"
    cpu = environment.get("WEBKIT_SKIA_ENABLE_CPU_RENDERING") not in (None, "0")
    name = "texturemapper" if texturemapper else "skia"
    if cpu:
        name += "+cpu-buffers" if texturemapper else "-cpu"
    return name


def compare_environment(expected, observed):
    """Problems between the allowlisted variables a profile wants and the ones seen.

    The profile is the whole truth: a variable that is set and not in the
    profile is as wrong as one that is missing.
    """
    problems = []
    for name in sorted(set(expected) | set(observed)):
        want, have = expected.get(name), observed.get(name)
        if want == have:
            continue
        if have is None:
            problems.append(f"{name} should be {want!r} but is not set")
        elif want is None:
            problems.append(f"{name}={have} is set but the profile does not set it")
        else:
            problems.append(f"{name} should be {want!r} but is {have!r}")
    return problems


# ---- what the unit would pass ----------------------------------------------


def inherited_environment(show, manager_environment, read_file, tool_dropins):
    """Allowlisted variables that reach the unit from somewhere other than this tool.

    show               parsed `systemctl show` of the unit (Environment,
                       EnvironmentFiles, DropInPaths, FragmentPath, UnsetEnvironment)
    manager_environment  `systemctl show-environment`
    read_file          path -> text or None (the unit file, drop-ins, EnvironmentFile)
    tool_dropins       base names of this tool's drop-ins (they are the request)

    Returns [{"name", "value", "source"}], sorted by name. A variable the
    unit's own UnsetEnvironment= removes does not reach the process.
    """
    found, unset = {}, set()

    def add(name, value, source):
        if name in ENV_ALLOWLIST:
            found.setdefault(name, []).append((value, source))

    effective = parse_environment_property(show.get("Environment", ""))
    files = [path for path in [show.get("FragmentPath", "")] + show.get("DropInPaths", "").split() if path]
    attributed, tool_owned, scanned = set(), set(), False
    for path in files:
        text = read_file(path)
        if text is None:
            continue
        scanned = True
        mine = Path(path).name in tool_dropins
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("UnsetEnvironment=") and not mine:
                unset |= parse_unset(line[len("UnsetEnvironment="):])
            if not line.startswith("Environment="):
                continue
            for name, value in parse_environment_property(line[len("Environment="):]).items():
                if name not in ENV_ALLOWLIST:
                    continue
                if mine:
                    tool_owned.add(name)
                else:
                    add(name, value, path)
                    attributed.add(name)
    if not scanned:
        # Without the files, the property is all there is. It includes this
        # tool's own UnsetEnvironment=, which only a scan can tell apart.
        unset |= parse_unset(show.get("UnsetEnvironment", ""))
    # Effective Environment= that no scanned file explains (a transient unit,
    # a file this tool cannot read, a template): still reaches the process.
    for name, value in effective.items():
        if name in ENV_ALLOWLIST and name not in attributed and name not in tool_owned:
            add(name, value, "the unit's Environment= (file not found)")
    for path in parse_environment_files_property(show.get("EnvironmentFiles", "")):
        text = read_file(path)
        if text is None:
            continue
        for name, value in parse_environment_file(text).items():
            add(name, value, f"EnvironmentFile {path}")
    for name, value in manager_environment.items():
        add(name, value, "the service manager's environment (systemctl show-environment)")
    for name in unset:
        found.pop(name, None)
    result = []
    for name in sorted(found):
        # The last assignment systemd reads wins; report each source, take the last value.
        value, source = found[name][-1]
        result.append({"name": name, "value": value, "source": source,
                       "sources": [{"value": v, "source": s} for v, s in found[name]]})
    return result


def plan_environment(requested, inherited, clear):
    """(expected, unset, conflicts) for a profile.

    expected   the allowlisted environment the profile means: exactly requested
    unset      names a drop-in must UnsetEnvironment= so only the profile reaches
               the process (only with clear=True)
    conflicts  inherited variables the profile does not set: refuse unless cleared
    """
    extras = [item for item in inherited if item["name"] not in requested]
    unset = sorted(item["name"] for item in extras) if clear else []
    conflicts = [] if clear else extras
    return dict(requested), unset, conflicts


def describe_conflicts(conflicts, requested_label):
    lines = [f"the renderer would not run the {requested_label} configuration: systemd already sets "
             "compositor variables that the profile does not:"]
    for item in conflicts:
        lines.append(f"  {item['name']}={item['value']}  from {item['source']}")
    lines.append(f"With those variables the renderer runs as {classify_compositor({i['name']: i['value'] for i in conflicts})},"
                 " not as the profile says. Remove them, or run again with --clear-inherited, which adds "
                 "UnsetEnvironment= to this tool's temporary drop-in.")
    return "\n".join(lines)


# ---- what the processes got -------------------------------------------------


def read_process_environment(proc, pid):
    try:
        return allowlisted(parse_environ((Path(proc) / str(pid) / "environ").read_bytes()))
    except OSError:
        return None


def process_command_name(proc, pid):
    try:
        return (Path(proc) / str(pid) / "comm").read_text().strip()
    except OSError:
        return ""


def descendants(proc, pid):
    """Process IDs below pid, found through the parent field of /proc/<n>/stat."""
    children = {}
    for entry in Path(proc).iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        # pid (comm) state ppid ...: comm may hold spaces and parentheses.
        rest = stat[stat.rfind(")") + 2:].split()
        if len(rest) > 1 and rest[1].isdigit():
            children.setdefault(int(rest[1]), []).append(int(entry.name))
    found, queue = [], [pid]
    while queue:
        parent = queue.pop()
        for child in children.get(parent, ()):
            found.append(child)
            queue.append(child)
    return sorted(found)


def observe(proc, pid):
    """The allowlisted environment of the main process and of its web process.

    Returns {"pid", "main": env|None, "webPid", "web": env|None}. web is None
    until the web process exists.
    """
    observation = {"pid": pid, "main": read_process_environment(proc, pid), "webPid": None, "web": None}
    for child in descendants(proc, pid):
        if process_command_name(proc, child) == WEB_PROCESS_NAME:
            environment = read_process_environment(proc, child)
            if environment is not None:
                observation["webPid"], observation["web"] = child, environment
                break
    return observation


def verdict(expected, observation):
    """(complete, problems) for one observation against the profile."""
    problems = []
    if observation["main"] is None:
        problems.append("the process environment could not be read")
    else:
        problems += [f"renderer process: {p}" for p in compare_environment(expected, observation["main"])]
    if observation["web"] is not None:
        problems += [f"web process: {p}" for p in compare_environment(expected, observation["web"])]
    complete = observation["main"] is not None and observation["web"] is not None
    return complete, problems


def evaluate(expected, observation, give_up):
    """The result of one observation. give_up: no more waiting for the web process."""
    complete, problems = verdict(expected, observation)
    if not problems and not complete and give_up:
        problems.append("the WebKit web process was not found, so the compositor variables it runs with are unverified")
    seen = observation["web"] if observation["web"] is not None else (observation["main"] or {})
    return {
        "ok": not problems,
        "complete": complete,
        "problems": problems,
        "observed": {"rendererPid": observation["pid"], "renderer": observation["main"],
                     "webProcessPid": observation["webPid"], "webProcess": observation["web"]},
        "compositor": classify_compositor(seen),
    }


def verify_process_environment(proc, pid, expected, wait_seconds=30.0, sleep=time.sleep, interval=0.25):
    """Waits for the web process, then compares both processes with the profile.

    Raises nothing: the caller decides. Returns
    {"ok", "complete", "problems", "observed": {...}, "compositor"}.
    A mismatch is reported at once; the web process is waited for only while
    nothing is wrong yet.
    """
    deadline = time.monotonic() + wait_seconds
    while True:
        observation = observe(proc, pid)
        complete, problems = verdict(expected, observation)
        if problems or complete or time.monotonic() >= deadline:
            break
        sleep(interval)
    return evaluate(expected, observation, give_up=True)
