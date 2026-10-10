#!/usr/bin/env python3
"""Collects, describes, and re-checks the assets of one coordinated release.

The release workflow builds each platform in its own job, then runs this script
in three steps. Every step applies the release contract (contract.json), which
says which components a Stable or Beta release must carry and which assets each
component's files are.

  collect  gather the contract's assets from the build artifacts, and from a
           draft release being resumed, into one flat directory
  resume   split the components of a draft into verified (reused as they are)
           and pending (built again)
  build    require the contract, drop what failed, and write SHA256SUMS, the
           machine-readable inventory (tilecast-release.json) and the notes
  verify   re-check a directory of assets, for example a draft downloaded back
           from GitHub, against the inventory it carries

Signatures, artifact hashes and package metadata are verified by
tilecast-release-verify (apps/server/cmd/tilecast-release-verify), which runs
the server's own importer over the directory; this script consumes its report.
Nothing here signs anything. The assembled files are deterministic: the same
inputs give the same bytes, so a resumed run reproduces what an earlier run
uploaded.

Usage:
  release_assemble.py collect --version V --channel C --out DIR --source DIR...
  release_assemble.py resume  --version V --channel C --assets DRAFT --report verify.json --out DIR
  release_assemble.py build   --version V --channel C --commit SHA --assets DIR
                              --report verify.json [--results results.json]
                              [--server-digest sha256:...] [--changes FILE] --notes-out FILE
  release_assemble.py verify  --version V --channel C --assets DIR --report verify.json
"""
import argparse
import hashlib
import json
import os
import shutil
import sys

import release_version as rv

HERE = os.path.dirname(os.path.abspath(__file__))
INVENTORY = "tilecast-release.json"
CHECKSUMS = "SHA256SUMS"


class ReleaseError(Exception):
    """The release cannot be published; the message says why."""


def load_contract():
    with open(os.path.join(HERE, "contract.json")) as handle:
        return json.load(handle)


def expand(name, version):
    return name.replace("{version}", version)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_required(component, channel):
    return channel in component.get("required", [])


def contract_assets(contract, version):
    """Every asset name a release may carry, mapped to its component id."""
    names = {}
    for component in contract["components"]:
        for asset in component.get("assets", []):
            names[expand(asset["name"], version)] = component["id"]
    for asset in contract["releaseAssets"]:
        names[asset["name"]] = "release"
    return names


# ---- collect ----------------------------------------------------------------

def parse_checksums(path):
    entries = {}
    with open(path) as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            digest, _, name = line.partition("  ")
            if len(digest) != 64 or not name:
                raise ReleaseError(f"{path}: malformed checksum line {line!r}")
            entries[name.lstrip("*")] = digest
    return entries


def collect(contract, version, sources, out):
    """Copies the contract's assets from the source directories into `out`.

    A source is one build's artifact directory, or a downloaded draft. A build's
    own SHA256SUMS is used to confirm its files survived the artifact transfer,
    then dropped: the release writes one SHA256SUMS of its own. A file that two
    sources both carry must be identical. A tilecast-* file the contract does
    not list is an error: it would otherwise ship, or be silently lost.
    """
    wanted = contract_assets(contract, version)
    os.makedirs(out, exist_ok=True)
    collected = {}
    for source in sources:
        if not os.path.isdir(source):
            continue
        files = {}
        for root, _, names in os.walk(source):
            for name in names:
                files[name] = os.path.join(root, name)
        if CHECKSUMS in files:
            recorded = parse_checksums(files[CHECKSUMS])
            # A draft's SHA256SUMS covers the whole release, so only files
            # present in this source can be checked against it.
            for name, digest in recorded.items():
                if name in files and sha256_file(files[name]) != digest:
                    raise ReleaseError(f"{source}: {name} does not match its checksum; the artifact is corrupt")
        for name, path in sorted(files.items()):
            if name in (CHECKSUMS, INVENTORY) and name not in wanted:
                continue
            if name not in wanted:
                if name.startswith("tilecast-"):
                    raise ReleaseError(f"{source}: {name} is not an asset of the release contract")
                continue
            if name in (CHECKSUMS, INVENTORY):
                continue  # regenerated by `build`
            if name in collected:
                if sha256_file(collected[name]) != sha256_file(path):
                    raise ReleaseError(f"{name} differs between {os.path.dirname(collected[name])} and {source}")
                continue
            collected[name] = path
    for name, path in collected.items():
        shutil.copyfile(path, os.path.join(out, name))
    return sorted(collected)


# ---- build ------------------------------------------------------------------

def component_status(contract, component, version, channel, assets_dir, report, results, server_digest):
    """Returns the inventory entry for one contract component."""
    entry = {
        "id": component["id"],
        "group": component["group"],
        "label": component["label"],
        "required": is_required(component, channel),
    }
    if component["kind"] == "image":
        if server_digest:
            entry.update(status="available", image=contract["serverImage"], tag=version, digest=server_digest)
        else:
            entry.update(status="unavailable", reason=reason_for(component, results, "the image was not published"))
        return entry
    entry.update(family=component["family"], architecture=component["architecture"])
    names = [expand(asset["name"], version) for asset in component["assets"]]
    present = [name for name in names if os.path.isfile(os.path.join(assets_dir, name))]
    verified = [
        item for item in report["components"]
        if item["family"] == component["family"] and item["architecture"] == component["architecture"]
    ]
    problems = [
        item for item in report["problems"]
        if item["family"] == component["family"] and item["architecture"] == component["architecture"]
    ]
    if verified and len(present) == len(names) and not problems:
        item = verified[0]
        entry.update(
            status="available",
            versionName=item["versionName"],
            versionCode=item["versionCode"],
            channel=item["channel"],
            assets=[
                {
                    "name": name,
                    "role": asset["role"],
                    "sizeBytes": os.path.getsize(os.path.join(assets_dir, name)),
                    "sha256": sha256_file(os.path.join(assets_dir, name)),
                }
                for asset, name in zip(component["assets"], names)
            ],
        )
        return entry
    if problems:
        reason = "verification failed: " + "; ".join(sorted({item["message"] for item in problems}))
    elif present and len(present) < len(names):
        missing = sorted(set(names) - set(present))
        reason = "incomplete build; missing " + ", ".join(missing)
    else:
        reason = reason_for(component, results, "no build artifact was produced")
    entry.update(status="unavailable", reason=reason)
    return entry


def reason_for(component, results, default):
    result = (results or {}).get(component["id"])
    if result in ("failure", "cancelled", "skipped"):
        return f"the build {result if result != 'failure' else 'failed'}"
    return default


def build(contract, version, channel, commit, assets_dir, report, results, server_digest):
    parsed = rv.parse_tag("v" + version)
    if parsed.channel != channel:
        raise ReleaseError(f"{version} is a {parsed.channel} version, not {channel}")
    if report.get("version") != version or report.get("channel") != channel:
        raise ReleaseError("the verification report is for another version or channel")
    allowed = contract_assets(contract, version)
    for name in sorted(os.listdir(assets_dir)):
        if name not in allowed:
            raise ReleaseError(f"{name} is not an asset of the release contract")
    components = [
        component_status(contract, c, version, channel, assets_dir, report, results, server_digest)
        for c in contract["components"]
    ]
    missing = [c for c in components if c["required"] and c["status"] != "available"]
    if missing:
        raise ReleaseError(
            f"a {channel} release requires every required component; unavailable: "
            + "; ".join(f"{c['id']} ({c['reason']})" for c in missing)
        )
    # Files of a component that did not verify must never be published.
    for component in components:
        if component["status"] == "unavailable" and component["id"] != "server":
            definition = next(c for c in contract["components"] if c["id"] == component["id"])
            for asset in definition["assets"]:
                path = os.path.join(assets_dir, expand(asset["name"], version))
                if os.path.isfile(path):
                    os.remove(path)
    external = [
        {key: item[key] for key in ("id", "group", "label", "status", "note", "docs")}
        for item in contract["external"]
    ]
    published = sorted(
        asset["name"] for component in components if component["status"] == "available"
        for asset in component.get("assets", [])
    )
    inventory = {
        "schemaVersion": 1,
        "product": "tilecast",
        "repository": contract["repository"],
        "version": version,
        "tag": f"v{version}",
        "channel": channel,
        "prerelease": channel == "beta",
        "versionCode": parsed.code,
        "commit": commit,
        "components": components,
        "external": external,
        "assets": [
            {"name": name, "sizeBytes": os.path.getsize(os.path.join(assets_dir, name)),
             "sha256": sha256_file(os.path.join(assets_dir, name))}
            for name in published
        ],
    }
    write_json(os.path.join(assets_dir, INVENTORY), inventory)
    write_checksums(assets_dir)
    return inventory


def write_json(path, value):
    with open(path, "w") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")


def write_checksums(assets_dir):
    names = sorted(name for name in os.listdir(assets_dir) if name != CHECKSUMS)
    with open(os.path.join(assets_dir, CHECKSUMS), "w") as handle:
        for name in names:
            handle.write(f"{sha256_file(os.path.join(assets_dir, name))}  {name}\n")


# ---- resume -----------------------------------------------------------------

def resume(contract, version, channel, draft_dir, report, out):
    """Splits the components into those a draft already holds, verified, and
    those still to build, and copies the verified components' assets to `out`.

    A resumed release never rebuilds or re-signs a component whose signed
    manifest, signature, and artifact all verify: those bytes are reused as
    they are. A component the draft holds partly, or whose files no longer
    verify, is pending and is built again. The server image is not a file; the
    workflow resumes it from the draft's inventory.
    """
    os.makedirs(out, exist_ok=True)
    verified_keys = {(item["family"], item["architecture"]) for item in report["components"]}
    broken = {(item["family"], item["architecture"]) for item in report["problems"]}
    done, pending = [], []
    for component in contract["components"]:
        if component["kind"] != "player":
            continue
        names = [expand(asset["name"], version) for asset in component["assets"]]
        key = (component["family"], component["architecture"])
        complete = key in verified_keys and key not in broken and all(
            os.path.isfile(os.path.join(draft_dir, name)) for name in names
        )
        if complete:
            for name in names:
                shutil.copyfile(os.path.join(draft_dir, name), os.path.join(out, name))
            done.append(component["id"])
        else:
            pending.append(component["id"])
    return {"verified": done, "pending": pending}


# ---- verify -----------------------------------------------------------------

def verify(contract, version, channel, assets_dir, report):
    """Re-checks a directory of release assets against the inventory it holds.

    Used on a draft downloaded back from GitHub, so what is published is what
    was assembled, and on a resumed run, so a finished component is trusted
    only if it still verifies. Raises ReleaseError listing every failure.
    """
    problems = []
    inventory_path = os.path.join(assets_dir, INVENTORY)
    if not os.path.isfile(inventory_path):
        raise ReleaseError(f"{INVENTORY} is missing")
    with open(inventory_path) as handle:
        inventory = json.load(handle)
    if inventory.get("version") != version or inventory.get("channel") != channel:
        problems.append("the inventory is for another version or channel")
    if report.get("version") != version or report.get("channel") != channel:
        problems.append("the verification report is for another version or channel")
    expected = {asset["name"]: asset for asset in inventory.get("assets", [])}
    expected_files = set(expected) | {INVENTORY, CHECKSUMS}
    present = set(os.listdir(assets_dir))
    for name in sorted(present - expected_files):
        problems.append(f"unexpected asset {name}")
    for name in sorted(expected_files - present):
        problems.append(f"missing asset {name}")
    for name, asset in sorted(expected.items()):
        path = os.path.join(assets_dir, name)
        if os.path.isfile(path) and (os.path.getsize(path) != asset["sizeBytes"] or sha256_file(path) != asset["sha256"]):
            problems.append(f"{name} does not match the inventory")
    checksums = os.path.join(assets_dir, CHECKSUMS)
    if os.path.isfile(checksums):
        recorded = parse_checksums(checksums)
        for name in sorted(expected_files - {CHECKSUMS}):
            path = os.path.join(assets_dir, name)
            if os.path.isfile(path) and recorded.get(name) != sha256_file(path):
                problems.append(f"{name} does not match {CHECKSUMS}")
        for name in sorted(set(recorded) - expected_files):
            problems.append(f"{CHECKSUMS} lists {name}, which is not a release asset")
    verified = {(item["family"], item["architecture"]) for item in report["components"]}
    for component in inventory.get("components", []):
        if component["status"] == "available" and component.get("family"):
            if (component["family"], component["architecture"]) not in verified:
                problems.append(f"{component['id']} does not verify")
    for component in contract["components"]:
        if is_required(component, channel):
            entry = next((c for c in inventory.get("components", []) if c["id"] == component["id"]), None)
            if entry is None or entry["status"] != "available":
                problems.append(f"required component {component['id']} is not available")
    # A rejected build is only acceptable when the inventory already says the
    # component is unavailable, so its assets are not in the release.
    available = {(c["family"], c["architecture"]) for c in inventory.get("components", [])
                 if c["status"] == "available" and "family" in c}
    for item in report["problems"]:
        if not item["family"] or (item["family"], item["architecture"]) in available:
            problems.append(f"{item['family']} {item['architecture']}: {item['message']}".strip().replace("  ", " "))
    if problems:
        raise ReleaseError("; ".join(problems))
    return inventory


# ---- notes ------------------------------------------------------------------

def human_size(size):
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def notes(contract, inventory, changes=""):
    version, channel, repository = inventory["version"], inventory["channel"], inventory["repository"]
    release_url = f"https://github.com/{repository}/releases/download/v{version}"
    groups = contract["groups"]
    by_group = {}
    for component in inventory["components"]:
        by_group.setdefault(component["group"], []).append(component)
    lines = [f"# Tilecast {version}", ""]
    if channel == "beta":
        lines += [
            "A **Beta** release for testing the next Stable before it ships. "
            "It is published as a GitHub pre-release and updates to the next Beta or to Stable.",
        ]
    else:
        lines += ["A **Stable** release. Every platform below is the same Tilecast version, built from one commit."]
    lines += ["", f"Built from commit `{inventory['commit']}`. Update version code: `{inventory['versionCode']}`.", ""]

    def section(group):
        lines.append(f"## {groups[group]}")
        lines.append("")

    for group in ("server",):
        section(group)
        server = by_group[group][0]
        if server["status"] == "available":
            aliases = "`stable` and `latest`" if channel == "stable" else "`beta`"
            lines += [
                f"- `{server['image']}:{server['tag']}`",
                f"- Moving tag: {aliases} (`{server['image']}:{'stable' if channel == 'stable' else 'beta'}`)",
                f"- digest: `{server['digest']}`",
                "",
                "The Browser Player is bundled with the server image and is the same version.",
                "",
            ]
        else:
            lines += [f"Not included: {server['reason']}.", ""]
    for group in ("edge", "windows", "android"):
        section(group)
        for component in by_group[group]:
            if component["status"] != "available":
                lines.append(f"- **{component['label']}**: not included in this release ({component['reason']}).")
                continue
            download = next(a for a in component["assets"] if a["role"] == "download")
            lines.append(
                f"- **{component['label']}**: [`{download['name']}`]({release_url}/{download['name']}) "
                f"({human_size(download['sizeBytes'])}, SHA-256 `{download['sha256']}`)"
            )
        lines.append("")
        if group == "edge":
            lines += ["Each architecture ships a signed update envelope, its signature and a software bill of materials.", ""]
        else:
            lines += ["Studio imports the signed update envelope from this release for screens it manages.", ""]
    for item in inventory["external"]:
        if item["group"] == "browser":
            continue
        section(item["group"])
        lines += [f"{item['note']} See [the guide]({contract['docsUrl']}{item['docs']}).", ""]
    unavailable = [c for c in inventory["components"] if c["status"] != "available" and not c["required"]]
    if unavailable:
        lines += ["## Not included in this release", ""]
        lines += [f"- {c['label']}: {c['reason']}" for c in unavailable]
        lines += [""]
    lines += [
        "## Verify your download",
        "",
        f"`{CHECKSUMS}` lists every file. `{INVENTORY}` is the machine-readable inventory of this release. "
        "Update envelopes are signed with the Tilecast update key and verified by Studio and by each player.",
        "",
        f"    gh release download v{version} --repo {repository} --pattern '{CHECKSUMS}'",
        f"    sha256sum -c {CHECKSUMS} --ignore-missing",
        "",
    ]
    if changes.strip():
        lines += ["## What's changed", "", changes.strip(), ""]
    return "\n".join(lines)


# ---- command line -----------------------------------------------------------

def read_json(path):
    with open(path) as handle:
        return json.load(handle)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["collect", "resume", "build", "verify"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--channel", required=True, choices=["stable", "beta"])
    parser.add_argument("--out")
    parser.add_argument("--source", nargs="*", default=[])
    parser.add_argument("--assets")
    parser.add_argument("--commit")
    parser.add_argument("--report")
    parser.add_argument("--results")
    parser.add_argument("--server-digest", default="")
    parser.add_argument("--changes")
    parser.add_argument("--notes-out")
    args = parser.parse_args(argv)
    contract = load_contract()
    try:
        if args.command == "collect":
            names = collect(contract, args.version, args.source, args.out)
            print(f"collect: {len(names)} assets in {args.out}")
        elif args.command == "resume":
            if not (args.assets and args.report and args.out):
                parser.error("resume needs --assets, --report and --out")
            result = resume(contract, args.version, args.channel, args.assets, read_json(args.report), args.out)
            print(json.dumps(result, sort_keys=True))
        elif args.command == "build":
            if not (args.assets and args.commit and args.report and args.notes_out):
                parser.error("build needs --assets, --commit, --report and --notes-out")
            digest = args.server_digest
            if digest and not (len(digest) == 71 and digest.startswith("sha256:")):
                raise ReleaseError(f"the server image digest {digest!r} is not sha256:<64 hex>")
            inventory = build(
                contract, args.version, args.channel, args.commit, args.assets, read_json(args.report),
                read_json(args.results) if args.results else {}, digest,
            )
            changes = open(args.changes).read() if args.changes and os.path.isfile(args.changes) else ""
            with open(args.notes_out, "w") as handle:
                handle.write(notes(contract, inventory, changes))
            available = [c["id"] for c in inventory["components"] if c["status"] == "available"]
            print(f"build: {len(inventory['assets'])} assets; available: {', '.join(available)}")
        else:
            if not (args.assets and args.report):
                parser.error("verify needs --assets and --report")
            inventory = verify(contract, args.version, args.channel, args.assets, read_json(args.report))
            print(f"verify: {len(inventory['assets'])} assets match the inventory")
    except ReleaseError as error:
        sys.exit(f"release_assemble: {error}")


if __name__ == "__main__":
    main()
