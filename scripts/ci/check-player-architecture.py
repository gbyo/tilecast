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
# Android platform host: depends downward on the shared crates only. It is
# platform code under apps/player-android, never a sixth shared crate.
ANDROID_NATIVE = "apps/player-android/native"
ANDROID_CRATE = "tilecast-player-android-native"
KINDS = ("dependencies", "dev-dependencies", "build-dependencies")
# Anything only a Windows host can use stays in apps/player-windows; the
# shared crates build and test on every host OS.
PLATFORM_PREFIXES = ("windows", "webview2")
WINDOWS_HOST = "tilecast-windows"
WINDOWS_MANIFEST = Path("apps/player-windows/Cargo.toml")


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


def classify_dependency(alias, original, base, workspace_path, workspace):
    """Resolve one dependency to (kind, package, target).

    kind is "registry" (a package name with no local target), "local" (a
    package name with its resolved directory), "unresolved" (a workspace
    alias without a workspace definition) or "missing" (a path without a
    manifest).
    """
    dependency = original if isinstance(original, dict) else {}
    if dependency.get("workspace"):
        inherited = workspace.get("dependencies", {}).get(alias)
        if inherited is None:
            return ("unresolved", alias, None)
        dependency = inherited if isinstance(inherited, dict) else {}
        base = workspace_path.parent
    package = dependency.get("package", alias)
    if "path" not in dependency:
        return ("registry", str(package), None)
    target = (base / dependency["path"]).resolve()
    if not (target / "Cargo.toml").is_file():
        return ("missing", alias, target)
    package = read_manifest(target / "Cargo.toml").get("package", {}).get("name")
    return ("local", str(package), target)


def shared_violations(root, registered):
    errors = []
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
            kind, package, target = classify_dependency(alias, original, path.parent, workspace_path, workspace)
            if kind == "unresolved":
                errors.append(f"{name}: unresolved workspace dependency {alias}")
                continue
            if kind == "missing":
                errors.append(f"{name}: missing local dependency {alias}")
                continue
            if kind == "local":
                # Local shared dependencies must stay in the shared layer,
                # even if an Edge package uses an innocent package name.
                if target != (root / "crates" / package).resolve():
                    errors.append(f"{name}: {alias} points outside the shared Player crates")
            if package in SHARED:
                # Self dev-dependencies enable test features in Cargo.
                if package != name and package not in SHARED[name]:
                    errors.append(f"{name}: forbidden shared dependency {package}")
            elif kind == "local" or package.startswith(("edge-", "tilecast")):
                errors.append(f"{name}: forbidden native host dependency {package}")
            elif package.startswith(PLATFORM_PREFIXES):
                errors.append(f"{name}: forbidden OS-specific dependency {package}")
    return errors


def windows_violations(root):
    """The Windows host builds on the shared crates, never on another host."""
    path = root / WINDOWS_MANIFEST
    if not path.is_file():
        return []
    manifest = read_manifest(path)
    if manifest.get("package", {}).get("name") != WINDOWS_HOST:
        return [f"{WINDOWS_MANIFEST}: the Windows host keeps its documented package name"]
    errors = []
    workspace_path, workspace = workspace_for(path)
    hosts = ((root / "apps" / "edge").resolve(), "the Edge host"), ((root / "apps" / "player-linux").resolve(), "the Electron Player")
    for alias, original in dependency_tables(manifest):
        kind, package, target = classify_dependency(alias, original, path.parent, workspace_path, workspace)
        if kind == "unresolved":
            errors.append(f"{WINDOWS_HOST}: unresolved workspace dependency {alias}")
        elif kind == "missing":
            errors.append(f"{WINDOWS_HOST}: missing local dependency {alias}")
        elif kind == "local":
            for host, label in hosts:
                if target == host or host in target.parents:
                    errors.append(f"{WINDOWS_HOST}: {alias} depends on {label}")
        elif package.startswith(("edge-", "tilecast")):
            errors.append(f"{WINDOWS_HOST}: forbidden native host dependency {package}")
    return errors


def android_native_violations(root):
    """The Android host may depend on the shared crates, never on Edge."""
    errors = []
    path = root / ANDROID_NATIVE / "Cargo.toml"
    if not path.is_file():
        return [f"{ANDROID_NATIVE}/Cargo.toml: Android native host crate is missing"]
    manifest = read_manifest(path)
    if manifest.get("package", {}).get("name") != ANDROID_CRATE:
        errors.append(f"{ANDROID_NATIVE}/Cargo.toml: expected package {ANDROID_CRATE}")
    workspace_path, workspace = workspace_for(path)
    for alias, original in dependency_tables(manifest):
        kind, package, target = classify_dependency(alias, original, path.parent, workspace_path, workspace)
        if kind == "unresolved":
            errors.append(f"{ANDROID_CRATE}: unresolved workspace dependency {alias}")
            continue
        if kind == "missing":
            errors.append(f"{ANDROID_CRATE}: missing local dependency {alias}")
            continue
        if kind == "local":
            # Local dependencies must stay in the shared layer: no Edge
            # crates, no other apps, no sibling platform code.
            if target != (root / "crates" / package).resolve():
                errors.append(f"{ANDROID_CRATE}: {alias} points outside the shared Player crates")
        if package in SHARED:
            continue
        if target_is_host(package):
            errors.append(f"{ANDROID_CRATE}: forbidden native host dependency {package}")
    return errors


def target_is_host(package):
    return str(package).startswith(("edge-", "tilecast"))


def violations(root):
    registered = registered_crates(root)
    return shared_violations(root, registered) + windows_violations(root)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--registered-crates":
        print(json.dumps(sorted(registered_crates(Path(sys.argv[2])))))
        return 0
    root = Path(__file__).resolve().parents[2]
    errors = violations(root) + android_native_violations(root)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Player architecture dependency check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
