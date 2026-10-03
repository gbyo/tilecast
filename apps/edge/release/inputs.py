"""Edge-owned release inputs; no root workspace product version."""

from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]


def version():
    value = (ROOT / "apps/edge/release/VERSION").read_text().strip()
    if not value or "\n" in value or "\r" in value:
        raise ValueError("one Edge release version is required")
    return value


def state_schema():
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"], cwd=ROOT
    ))
    state = [p for p in metadata["packages"] if p["name"] in ("edge-state", "player-state")]
    if len(state) != 1:
        raise ValueError("exactly one Player state crate is required")
    directory = Path(state[0]["manifest_path"]).parent / "migrations"
    return max(int(p.name.split("_", 1)[0]) for p in directory.glob("[0-9][0-9][0-9][0-9]_*.sql"))


if __name__ == "__main__":
    if sys.argv[1:] == ["version"]:
        print(version())
    elif sys.argv[1:] == ["state-schema"]:
        print(state_schema())
    else:
        raise SystemExit("use version or state-schema")
