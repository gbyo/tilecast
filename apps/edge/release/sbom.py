#!/usr/bin/env python3
"""Writes the CycloneDX SBOM of a Tilecast Edge release.

It lists what the release is made of, from the inputs that pinned it:

* the Rust packages emitted by the shipped-binary release build, with their
  registry checksums from the root Cargo.lock;
* the npm packages that the Player Runtime bundle was built from;
* WPE WebKit, by its upstream source tarball digest;
* the Debian packages whose shared libraries the release's executables load
  (found with ldd and dpkg-query in the builder image), at the pinned
  snapshot.

Usage: sbom.py --release-tree DIR --version X.Y.Z --snapshot TIMESTAMP --out FILE
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tomllib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
EDGE = os.path.join(ROOT, "apps", "edge")


def built_cargo_components(artifacts, metadata, lock):
    package_ids = {a["package_id"] for a in artifacts if a.get("reason") == "compiler-artifact"}
    packages = {p["id"]: p for p in metadata["packages"]}
    if not package_ids or package_ids - packages.keys():
        raise ValueError("Cargo build artifacts are empty or do not match the locked metadata")
    shipped = {"tilecastd", "tilecastctl", "tilecast-edge-migrate", "tilecast-edge-update"}
    binaries = {packages[a["package_id"]]["name"] for a in artifacts
                if a.get("reason") == "compiler-artifact" and a.get("executable")
                and "bin" in a.get("target", {}).get("kind", [])}
    if binaries != shipped:
        raise ValueError("Cargo build artifacts must describe exactly the four shipped Edge Rust binaries")
    if not any(a.get("reason") == "build-finished" and a.get("success") for a in artifacts):
        raise ValueError("Cargo release build did not finish successfully")
    locked = {(p["name"], p["version"], p.get("source")): p for p in lock["package"]}
    out = []
    for package in sorted((packages[p] for p in package_ids), key=lambda p: (p["name"], p["version"], p["id"])):
        entry = locked[(package["name"], package["version"], package.get("source"))]
        component = {"type": "library", "name": package["name"], "version": package["version"],
                     "purl": f"pkg:cargo/{package['name']}@{package['version']}"}
        if entry.get("checksum"):
            component["hashes"] = [{"alg": "SHA-256", "content": entry["checksum"]}]
        out.append(component)
    return out


def cargo_components(artifact_path):
    with open(os.path.join(ROOT, "Cargo.lock"), "rb") as handle:
        lock = tomllib.load(handle)
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--format-version", "1"], cwd=ROOT
    ))
    with open(artifact_path) as handle:
        artifacts = [json.loads(line) for line in handle if line.strip()]
    return built_cargo_components(artifacts, metadata, lock)


def npm_components():
    with open(os.path.join(ROOT, "package-lock.json")) as handle:
        lock = json.load(handle)
    out, seen = [], set()
    # Only what the runtime bundle is built from: the workspace and its
    # production dependencies.
    runtime = lock["packages"].get("packages/player-runtime", {})
    pending = list(runtime.get("dependencies", {}))
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        entry = lock["packages"].get(f"node_modules/{name}")
        if not entry:
            continue
        out.append({"type": "library", "name": name, "version": entry.get("version", ""),
                    "purl": f"pkg:npm/{name.replace('@', '%40')}@{entry.get('version', '')}"})
        pending.extend(entry.get("dependencies", {}))
    return sorted(out, key=lambda c: c["name"])


def debian_components(tree, snapshot):
    libraries = set()
    for root, _, names in os.walk(tree):
        for name in names:
            path = os.path.join(root, name)
            with open(path, "rb") as handle:
                if handle.read(4) != b"\x7fELF":
                    continue
            result = subprocess.run(["ldd", path], capture_output=True, text=True)
            for line in result.stdout.splitlines():
                match = re.search(r"=> (/\S+)", line)
                if match and not match.group(1).startswith(tree):
                    libraries.add(os.path.realpath(match.group(1)))
    packages = set()
    for library in sorted(libraries):
        result = subprocess.run(["dpkg-query", "-S", library], capture_output=True, text=True)
        if result.returncode == 0:
            packages.add(result.stdout.split(":")[0].strip())
    out = []
    for package in sorted(packages):
        version = subprocess.run(["dpkg-query", "-W", "-f=${Version}", package], capture_output=True,
                                 text=True).stdout.strip()
        out.append({"type": "library", "name": package, "version": version,
                    "purl": f"pkg:deb/debian/{package}@{version}?distro=debian-13&snapshot={snapshot}",
                    "scope": "required"})
    return out


def main():
    parser = argparse.ArgumentParser()
    for name in ("--release-tree", "--version", "--snapshot", "--out", "--wpe-version", "--wpe-sha256"):
        parser.add_argument(name, required=True)
    parser.add_argument("--cargo-artifacts", required=True)
    args = parser.parse_args()
    components = [{
        "type": "framework", "name": "wpewebkit", "version": args.wpe_version,
        "purl": f"pkg:generic/wpewebkit@{args.wpe_version}?download_url=https://wpewebkit.org/releases/"
                f"wpewebkit-{args.wpe_version}.tar.xz",
        "hashes": [{"alg": "SHA-256", "content": args.wpe_sha256}],
    }]
    components += cargo_components(args.cargo_artifacts) + npm_components() + debian_components(args.release_tree, args.snapshot)
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    bom = {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "metadata": {
            "timestamp": __import__("datetime").datetime.fromtimestamp(epoch, __import__("datetime").UTC)
            .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {"type": "application", "name": "tilecast-edge", "version": args.version,
                          "licenses": [{"license": {"id": "AGPL-3.0-only"}}]},
        },
        "components": components,
    }
    with open(args.out, "w") as handle:
        json.dump(bom, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"sbom: {len(components)} components")


if __name__ == "__main__":
    sys.exit(main())
