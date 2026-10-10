"""Edge-owned release inputs; no root workspace product version."""

from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
WPE_INPUTS = ("Dockerfile.builder", "build-wpe.sh")
WPE_ARCHES = ("x86_64", "aarch64")
# The OCI repository of the prebuilt private WPE WebKit: an artifact, not a
# runnable image. Its tag is wpe_version-wpe_key-arch and is published once.
WPE_REPOSITORY = "ghcr.io/gbyo/tilecast-wpe"
WPE_ARTIFACT_TYPE = "application/vnd.tilecast.wpe-prebuild.v1"


def version():
    value = (ROOT / "apps/edge/release/VERSION").read_text().strip()
    if not value or "\n" in value or "\r" in value:
        raise ValueError("one Edge release version is required")
    return value


def state_schema():
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"], cwd=ROOT
    ))
    state = [
        p for p in metadata["packages"]
        if p["name"] in ("edge-state", "player-state")
        and any((Path(p["manifest_path"]).parent / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
    ]
    if len(state) != 1:
        raise ValueError("exactly one Player state migration owner is required")
    directory = Path(state[0]["manifest_path"]).parent / "migrations"
    return max(int(p.name.split("_", 1)[0]) for p in directory.glob("[0-9][0-9][0-9][0-9]_*.sql"))


def _normalized_wpe_inputs():
    """Builder inputs with comments and blank lines removed.

    Both files use full-line comments only, so a comment or whitespace edit
    never changes the key and never invalidates a published WPE prebuild.
    """
    release = ROOT / "apps/edge/release"
    chunks = []
    for name in WPE_INPUTS:
        for line in (release / name).read_text().splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                # Neither file gives leading whitespace meaning (Dockerfile
                # plus a flat shell script), so indentation edits are ignored.
                chunks.append(stripped)
    return "\n".join(chunks) + "\n"


def wpe_key():
    """Short hash identifying one WPE WebKit build's inputs."""
    digest = hashlib.sha256(_normalized_wpe_inputs().encode()).hexdigest()
    return digest[:16]


def wpe_version():
    """Pinned WPE WebKit version from build-wpe.sh."""
    matches = re.findall(r"^WPE_VERSION=([0-9A-Za-z.+-]+)$",
                         (ROOT / "apps/edge/release/build-wpe.sh").read_text(), re.M)
    if len(matches) != 1:
        raise ValueError("exactly one WPE_VERSION assignment is required")
    return matches[0]


def wpe_tag(arch):
    """Immutable prebuild tag binding version, inputs and architecture."""
    if arch not in WPE_ARCHES:
        raise ValueError(f"unsupported WPE architecture: {arch}")
    return f"wpe-{wpe_version()}-{wpe_key()}-{arch}"


def wpe_ref_for(version, key, arch):
    """OCI reference of one prebuild. The tag binds a WPE version, the
    normalized builder inputs key and an architecture; a registry tag allows
    no other characters than these."""
    if arch not in WPE_ARCHES:
        raise ValueError(f"unsupported WPE architecture: {arch}")
    if not re.fullmatch(r"[0-9A-Za-z.]+", version) or not re.fullmatch(r"[0-9a-f]{16}", key):
        raise ValueError("a WPE version and inputs key must be plain, for a registry tag")
    return f"{WPE_REPOSITORY}:{version}-{key}-{arch}"


def wpe_ref(arch):
    """OCI reference of this checkout's prebuild: the immutable registry tag
    binding the pinned WPE version, the normalized builder inputs and the
    architecture."""
    return wpe_ref_for(wpe_version(), wpe_key(), arch)


def wpe_tar(arch):
    """Cache filename the release builder restores a WPE tar from."""
    if arch not in WPE_ARCHES:
        raise ValueError(f"unsupported WPE architecture: {arch}")
    return f"wpe-{wpe_version()}-{wpe_key()}-{arch}.tar"


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["version"]:
        print(version())
    elif args == ["state-schema"]:
        print(state_schema())
    elif args == ["wpe-key"]:
        print(wpe_key())
    elif args == ["wpe-version"]:
        print(wpe_version())
    elif len(args) == 2 and args[0] == "wpe-tag":
        print(wpe_tag(args[1]))
    elif len(args) == 2 and args[0] == "wpe-tar":
        print(wpe_tar(args[1]))
    elif len(args) == 2 and args[0] == "wpe-ref":
        print(wpe_ref(args[1]))
    elif len(args) == 4 and args[0] == "wpe-ref-for":
        print(wpe_ref_for(args[1], args[2], args[3]))
    else:
        raise SystemExit("use version, state-schema, wpe-key, wpe-version, wpe-tag <arch>, wpe-tar <arch>, wpe-ref <arch> or wpe-ref-for <version> <key> <arch>")
