#!/usr/bin/env python3
"""The Edge bridge release: tooling to name, assemble and verify it.

A Tilecast Edge screen that runs 0.2.1 or older cannot install a unified release
(0.26.0-beta.1, 0.26.0). Its update helper recomputes a release's version code
with the legacy formula, MAJOR*1000000 + MINOR*1000 + PATCH, and refuses an
envelope whose code differs. A unified code is core*100 + slot, so every unified
release is refused. The bridge is an Edge-only release with a legacy-compatible
version name, 0.2.2, built from the commit that carries the new helper. The old
helper installs it, and the helper inside it installs the unified releases.

A bridge release is an Edge preview in the layout every earlier one used:

  * a GitHub pre-release tagged edge-vX.Y.Z-preview.N
  * per architecture: tilecast-edge-update-<arch>.json and .sig, the archive,
    the signed release manifest and its .sig, and the SBOM
  * SHA256SUMS

and nothing else. The coordinated release (release.yml) never contains one.

  edge_bridge.py identity --version V [--preview N] --releases releases.json
  edge_bridge.py collect  --version V --out DIR --source DIR...
  edge_bridge.py verify   --version V --dir DIR --public-key PEM --verifier PATH
  edge_bridge.py arrange  --version V --dir DIR --base-dir DIR --arch ARCH --out DIR
  edge_bridge.py notes    --version V --tag TAG --out FILE
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

import release_assemble as ra
import release_version as rv

SHIPPED_TAG = "edge-v0.2.1-preview.1"
SHIPPED_VERSION = "0.2.1"
TAG = re.compile(r"edge-v(?P<version>[0-9]+\.[0-9]+\.[0-9]+)-preview\.(?P<preview>[0-9]+)")
ARCHES = ("x86_64", "aarch64")


class BridgeError(Exception):
    pass


def edge_components(contract):
    return [c for c in contract["components"] if c.get("family") == "edge"]


def asset_names(contract, version):
    """Every file a bridge release carries, from the release contract's Edge
    entries: the same files a coordinated release carries for Edge."""
    return sorted(ra.expand(a["name"], version) for c in edge_components(contract) for a in c["assets"])


def shipped_edge_versions(releases):
    """The Edge preview releases that exist, as {version name: tag}."""
    found = {}
    for release in releases:
        match = TAG.fullmatch(release.get("tagName", ""))
        if match:
            found[match.group("version")] = release["tagName"]
    return found


def identity(version, preview, releases):
    """Validates a bridge version and returns its release identity.

    The version must be one a deployed Edge 0.2.1 screen accepts: a valid name
    below the unified cutover, so the legacy formula gives its code and the
    update helper's check agrees. It must be newer than every Edge preview that
    shipped, or the screen would refuse it as no update. The tag must be new.
    """
    parsed = rv.parse_version(version)
    if parsed is None or parsed.unified or parsed.name != version:
        raise BridgeError(
            f"{version!r} is not a bridge version: it must be a valid version below 0.26.0, "
            "because Edge 0.2.1 and older refuse every unified release"
        )
    shipped = dict(shipped_edge_versions(releases))
    shipped.setdefault(SHIPPED_VERSION, SHIPPED_TAG)
    newest = max(shipped, key=rv.version_code)
    if parsed.code <= rv.version_code(newest):
        raise BridgeError(
            f"{version} (code {parsed.code}) must be newer than the newest Edge preview, {newest} "
            f"(code {rv.version_code(newest)}): a screen refuses an update that is not newer"
        )
    tag = f"edge-v{version}-preview.{preview}"
    if any(r.get("tagName") == tag for r in releases):
        raise BridgeError(f"the release {tag} already exists; a release tag is never reused")
    return {"tag": tag, "version": version, "code": parsed.code, "channel": "beta", "prerelease": "true"}


def collect(contract, version, sources, out):
    """Gathers the bridge's assets from the Edge build artifacts. Every file of
    both architectures must be there, and nothing else may be."""
    wanted = set(asset_names(contract, version))
    os.makedirs(out, exist_ok=True)
    found = {}
    for source in sources:
        if not os.path.isdir(source):
            continue
        for root, _, names in os.walk(source):
            for name in names:
                if name == ra.CHECKSUMS:
                    continue
                if name not in wanted:
                    if name.startswith("tilecast-"):
                        raise BridgeError(f"{name} is not part of a bridge release")
                    continue
                path = os.path.join(root, name)
                if name in found and ra.sha256_file(found[name]) != ra.sha256_file(path):
                    raise BridgeError(f"{name} differs between two build artifacts")
                found.setdefault(name, path)
    missing = sorted(wanted - set(found))
    if missing:
        raise BridgeError("the build artifacts lack: " + ", ".join(missing))
    for name, path in found.items():
        shutil.copyfile(path, os.path.join(out, name))
    ra.write_checksums(out)
    return sorted(found)


def run_verifier(verifier, directory, public_key, version):
    run = subprocess.run(
        [verifier, "--dir", directory, "--public-key", public_key, "--version", version, "--bridge"],
        capture_output=True, text=True,
    )
    if run.returncode not in (0, 1):
        raise BridgeError(f"the release verifier failed: {run.stderr.strip() or run.stdout.strip()}")
    return json.loads(run.stdout)


def verify(contract, version, directory, public_key, verifier, runner=run_verifier):
    """Checks a bridge directory the way the server imports it, and that it is
    exactly the layout every Edge preview had. Returns the importer's report."""
    parsed = rv.parse_version(version)
    if parsed is None or parsed.unified:
        raise BridgeError(f"{version!r} is not a bridge version")
    problems = []
    expected = set(asset_names(contract, version)) | {ra.CHECKSUMS}
    present = set(os.listdir(directory))
    for name in sorted(present - expected):
        problems.append(f"unexpected asset {name}")
    for name in sorted(expected - present):
        problems.append(f"missing asset {name}")
    checksums = os.path.join(directory, ra.CHECKSUMS)
    if os.path.isfile(checksums):
        recorded = ra.parse_checksums(checksums)
        for name in sorted(expected - {ra.CHECKSUMS}):
            path = os.path.join(directory, name)
            if os.path.isfile(path) and recorded.get(name) != ra.sha256_file(path):
                problems.append(f"{name} does not match {ra.CHECKSUMS}")
    report = runner(verifier, directory, public_key, version)
    seen = {(c["family"], c["architecture"]): c for c in report["components"]}
    for arch in ARCHES:
        component = seen.get(("edge", arch))
        if component is None:
            problems.append(f"edge {arch} does not verify")
        elif (component["versionName"], component["versionCode"], component["channel"]) != (version, parsed.code, "beta"):
            problems.append(f"edge {arch} is {component['versionName']} / {component['versionCode']} / {component['channel']}")
    for item in report["problems"]:
        problems.append(f"{item['family']} {item['architecture']}: {item['message']}".strip())
    if problems:
        raise BridgeError("; ".join(problems))
    return report


def arrange(contract, version, directory, base_directory, arch, out):
    """Lays out the files the shipped helper oracle reads: the published
    preview and this bridge, for one architecture."""
    for label, source, release in (("base", base_directory, SHIPPED_VERSION), ("bridge", directory, version)):
        target = os.path.join(out, label)
        os.makedirs(target, exist_ok=True)
        for part, name in (
            ("update.json", f"tilecast-edge-update-{arch}.json"),
            ("update.json.sig", f"tilecast-edge-update-{arch}.json.sig"),
            ("archive.tar.zst", f"tilecast-edge-{release}-{arch}.tar.zst"),
        ):
            path = os.path.join(source, name)
            if not os.path.isfile(path):
                raise BridgeError(f"{path} is missing")
            shutil.copyfile(path, os.path.join(target, part))
    return out


def notes(version, tag):
    code = rv.version_code(version)
    return "\n".join([
        f"# Tilecast Edge {version}: the bridge to the unified releases",
        "",
        "**Install this release on a screen that runs Tilecast Edge 0.2.1 or older, then update that screen to a "
        "unified release (`v0.26.0-beta.1` or later).** It carries no new features. Do not install it on a screen "
        "that already runs a unified release.",
        "",
        "Edge 0.2.1 and older refuse every unified release, because they compute a release's version code with "
        "the older rule. This release has a version they accept (`" + version + "`, code `" + str(code) + "`). It "
        "carries the update helper that understands both rules, so the screen can take the next update.",
        "",
        "Update through Studio: Player Updates, choose this Edge release for the screens that run 0.2.1 or older, "
        "wait for each to confirm it, then deploy the unified release. Update one screen first. "
        "The guide is [Update Edge screens](https://tilecast.org/edge/updates/).",
        "",
        "## Files",
        "",
        f"Tag `{tag}`. For each architecture (`x86_64`, `aarch64`): the update envelope and its signature, the "
        "release archive, its signed manifest and signature, and its software bill of materials. `SHA256SUMS` lists "
        "every file.",
        "",
    ])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["identity", "collect", "verify", "arrange", "notes"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--preview", type=int, default=1)
    parser.add_argument("--releases")
    parser.add_argument("--source", nargs="*", default=[])
    parser.add_argument("--dir")
    parser.add_argument("--out")
    parser.add_argument("--public-key")
    parser.add_argument("--verifier")
    parser.add_argument("--base-dir")
    parser.add_argument("--arch", choices=ARCHES)
    parser.add_argument("--tag")
    args = parser.parse_args(argv)
    contract = ra.load_contract()
    try:
        if args.command == "identity":
            if not args.releases:
                parser.error("identity needs --releases")
            with open(args.releases) as handle:
                result = identity(args.version, args.preview, json.load(handle))
            for key, value in result.items():
                print(f"{key}={value}")
        elif args.command == "collect":
            names = collect(contract, args.version, args.source, args.out)
            print(f"collect: {len(names)} assets in {args.out}")
        elif args.command == "verify":
            if not (args.dir and args.public_key and args.verifier):
                parser.error("verify needs --dir, --public-key and --verifier")
            report = verify(contract, args.version, args.dir, args.public_key, args.verifier)
            print(f"verify: {len(report['components'])} Edge builds verify as the server imports them")
        elif args.command == "arrange":
            if not (args.dir and args.base_dir and args.arch and args.out):
                parser.error("arrange needs --dir, --base-dir, --arch and --out")
            arrange(contract, args.version, args.dir, args.base_dir, args.arch, args.out)
        else:
            if not (args.tag and args.out):
                parser.error("notes needs --tag and --out")
            with open(args.out, "w") as handle:
                handle.write(notes(args.version, args.tag))
    except BridgeError as error:
        sys.exit(f"edge_bridge: {error}")


if __name__ == "__main__":
    main()
