#!/usr/bin/env python3
"""Check native Player dependency direction without fetching Cargo dependencies."""

from pathlib import Path
import json
import sys
import tomllib


SHARED = {
    "player-types": set(),
    "player-state": {"player-types"},
    "player-cas": {"player-types", "player-state"},
    "player-client": {"player-types"},
    "player-core": {"player-types", "player-state", "player-cas", "player-client"},
}
KINDS = ("dependencies", "dev-dependencies", "build-dependencies")


def read_manifest(path):
    with path.open("rb") as source:
        return tomllib.load(source)


def dependency_tables(manifest):
    for table in [manifest, *manifest.get("target", {}).values()]:
        for kind in KINDS:
            yield from table.get(kind, {}).items()


def workspace_for(path):
    for directory in path.parent.parents:
        candidate = directory / "Cargo.toml"
        if candidate.is_file():
            manifest = read_manifest(candidate)
            if "workspace" in manifest:
                return candidate, manifest["workspace"]
    return None, {}


def registered_crates(root):
    """Return documented crates registered in the root workspace, without Cargo."""
    root = root.resolve()
    root_manifest = root / "Cargo.toml"
    if not root_manifest.is_file():
        return set()
    workspace = read_manifest(root_manifest).get("workspace", {})
    members = {
        path.resolve()
        for pattern in workspace.get("members", [])
        for path in root.glob(pattern)
    }
    excluded = {
        path.resolve()
        for pattern in workspace.get("exclude", [])
        for path in root.glob(pattern)
    }
    registered = set()
    for path in (root / "crates").glob("player-*/Cargo.toml"):
        manifest = read_manifest(path)
        name = manifest.get("package", {}).get("name")
        owner, _ = workspace_for(path)
        if (
            name in SHARED
            and path.parent.name == name
            and path.parent.resolve() in members - excluded
            and owner == root_manifest
            and "workspace" not in manifest
        ):
            registered.add(path.parent.relative_to(root).as_posix())
    return registered


def violations(root):
    errors = []
    registered = registered_crates(root)
    # Inspect every shared manifest, including a crate not yet registered as
    # a workspace member. Generated build directories are never inputs.
    manifests = sorted((root / "crates").glob("player-*/Cargo.toml"))
    for path in manifests:
        manifest = read_manifest(path)
        name = manifest.get("package", {}).get("name")
        if name not in SHARED or path.parent.name != name:
            errors.append(f"{path.relative_to(root)}: use one of the five documented Player crates")
            continue
        if path.parent.relative_to(root).as_posix() not in registered:
            errors.append(f"{path.relative_to(root)}: not registered in the root Cargo workspace")
        workspace_path, workspace = workspace_for(path)
        for alias, original in dependency_tables(manifest):
            dependency = original if isinstance(original, dict) else {}
            base = path.parent
            if dependency.get("workspace"):
                inherited = workspace.get("dependencies", {}).get(alias)
                if inherited is None:
                    errors.append(f"{name}: unresolved workspace dependency {alias}")
                    continue
                dependency = inherited if isinstance(inherited, dict) else {}
                base = workspace_path.parent
            package = dependency.get("package", alias)
            target = None
            if "path" in dependency:
                target = (base / dependency["path"]).resolve()
                target_manifest = target / "Cargo.toml"
                if not target_manifest.is_file():
                    errors.append(f"{name}: missing local dependency {alias}")
                    continue
                package = read_manifest(target_manifest).get("package", {}).get("name")
                # Local shared dependencies must stay in the shared layer,
                # even if an Edge package uses an innocent package name.
                if target != (root / "crates" / str(package)).resolve():
                    errors.append(f"{name}: {alias} points outside the shared Player crates")
            if package in SHARED:
                # Self dev-dependencies enable test features in Cargo.
                if package != name and package not in SHARED[name]:
                    errors.append(f"{name}: forbidden shared dependency {package}")
            elif target is not None or str(package).startswith(("edge-", "tilecast")):
                errors.append(f"{name}: forbidden native host dependency {package}")
    return errors


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--registered-crates":
        print(json.dumps(sorted(registered_crates(Path(sys.argv[2])))))
        return 0
    root = Path(__file__).resolve().parents[2]
    errors = violations(root)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Player architecture dependency check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
