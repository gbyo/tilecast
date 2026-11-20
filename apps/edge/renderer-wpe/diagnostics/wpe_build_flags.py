"""The WPE WebKit build configuration of a Tilecast release, read from
apps/edge/release/build-wpe.sh, so a developer build of a local WebKit
checkout uses exactly the release's flags (docs/tilecast-edge-wpe-compositor-lab.md).

build-wpe.sh stays the only place the flags are written. It is not changed
for this: a change to it changes the WPE inputs key and the release would
compile WebKit again (apps/edge/release/inputs.py).

    python3 wpe_build_flags.py [BUILD_WPE_SH]   prints the configuration as JSON
"""
import json
import re
import sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parents[2] / "release" / "build-wpe.sh"

# Flags that must be present for a build to behave like the release: a
# missing one means build-wpe.sh changed shape and this parser is stale.
REQUIRED = ("-DPORT=WPE", "-DENABLE_WPE_PLATFORM=ON", "-DENABLE_BUBBLEWRAP_SANDBOX=ON")


def _assignment(text, name):
    values = re.findall(rf"^{name}=([^\s#]+)$", text, re.M)
    if len(values) != 1:
        raise ValueError(f"build-wpe.sh must assign {name} exactly once")
    return values[0]


def read(path=DEFAULT):
    """Returns {version, sha256, prefix, flags} from build-wpe.sh."""
    text = Path(path).read_text()
    prefix = _assignment(text, "PREFIX")
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip().startswith("cmake -S ")]
    if len(starts) != 1:
        raise ValueError("build-wpe.sh must have exactly one configure command")
    command = []
    for line in lines[starts[0]:]:
        stripped = line.strip()
        command.append(stripped.rstrip("\\").strip())
        if not stripped.endswith("\\"):
            break
    flags = []
    for token in " ".join(command).split():
        if not token.startswith("-D"):
            continue
        token = token.replace('"$PREFIX"', prefix).replace("$PREFIX", prefix).replace('"', "")
        if "$" in token:
            raise ValueError(f"unexpected variable in a build flag: {token}")
        flags.append(token)
    for required in REQUIRED:
        if required not in flags:
            raise ValueError(f"build-wpe.sh no longer sets {required}")
    return {
        "version": _assignment(text, "WPE_VERSION"),
        "sha256": _assignment(text, "WPE_SHA256"),
        "prefix": prefix,
        "flags": flags,
    }


if __name__ == "__main__":
    print(json.dumps(read(sys.argv[1] if len(sys.argv) > 1 else DEFAULT), indent=2))
