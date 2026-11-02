#!/usr/bin/env python3
"""Decides which components of a coordinated release are built and which are
carried forward, unchanged, from an earlier published release.

A hotfix for one platform should not rebuild, re-sign and redistribute the
others. When Windows is the only thing that changed from v0.26.0 to v0.26.1,
v0.26.1 builds Windows and records Server, Edge and Android as *inherited* from
v0.26.0: the real files, versions, signed manifests and hashes that v0.26.0
published, referenced where they already are. Nothing is copied, relabeled or
signed again, so an old binary is never presented as a new version.

Reuse is the conservative path. A component is carried forward only when every
one of these holds, and otherwise it is built:

* reuse is on (the release was dispatched with reuse_unchanged);
* the earlier release (the baseline) is published, its tag is at the commit its
  inventory records, and its inventory holds the component as available;
* the component's build inputs are identical to the ones its earlier build
  recorded (release_inputs.py), including its release-contract entry;
* the earlier build is not Beta when this release is Stable. A Beta binary is
  stamped Beta, so a Stable release never carries one;
* no newer published release holds a newer build of the component. Carrying an
  older build forward would move a channel, or a moving Server alias, backwards;
* the earlier assets verify today with the server's own importer
  (tilecast-release-verify), at the version they were built as. A player
  component whose files are missing, corrupt, rejected, or no longer accepted by
  the importer is built again. The Server image's digest must still exist in the
  registry and name the release it was built for.

The decision is a function of the commit, the two earlier inventories and the
verification results, so it is reproducible and auditable: the plan records, for
every component, what was decided and why, and for an inherited one exactly
which release supplied it.

Usage:
  release_reuse.py plan     --version V --commit SHA --baseline TAG [--newest TAG] --pending JSON
                            --verifier PATH --public-key PEM --workdir DIR --out plan.json
                            [--android-certificate SHA256] [--repo DIR] [--image-check CMD]
  release_reuse.py reverify --plan plan.json --verifier PATH --public-key PEM --workdir DIR
                            [--android-certificate SHA256] [--image-check CMD]
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

import github_release
import release_assemble as ra
import release_inputs as ri
import release_version as rv

PLAN_SCHEMA = 1


class ReuseError(Exception):
    pass


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def read_inventory(directory):
    path = os.path.join(directory, ra.INVENTORY)
    if not os.path.isfile(path):
        raise ReuseError(f"{ra.INVENTORY} is missing")
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        inventory = json.loads(raw)
    except ValueError:
        raise ReuseError(f"{ra.INVENTORY} is not JSON") from None
    if not isinstance(inventory, dict) or inventory.get("schemaVersion") != 1 or not isinstance(inventory.get("components"), list):
        raise ReuseError(f"{ra.INVENTORY} is not a Tilecast release inventory")
    return inventory, sha256_bytes(raw)


class Release:
    """A published release read for reuse: its inventory and where its assets
    were downloaded. `load` is injected so tests need no network."""

    def __init__(self, tag, inventory, inventory_sha256, directory):
        self.tag = tag
        self.inventory = inventory
        self.inventory_sha256 = inventory_sha256
        self.directory = directory
        self.version = inventory.get("version")
        self.commit = inventory.get("commit")

    def entry(self, component_id):
        return next((c for c in self.inventory["components"] if c.get("id") == component_id), None)


def origin_of(release, entry):
    """The release that holds a component's files: the entry's own source when
    it was inherited, otherwise the release that carries it."""
    if entry.get("origin") == "inherited":
        source = entry.get("source") or {}
        return {key: source.get(key) for key in ("tag", "commit", "inventorySha256")}
    return {"tag": release.tag, "commit": release.commit, "inventorySha256": release.inventory_sha256}


def channel_of(name):
    return rv.version_channel(name)


def entry_version(entry):
    return entry.get("versionName") or ""


def entry_code(entry):
    code = entry.get("versionCode")
    return code if isinstance(code, int) else rv.version_code(entry_version(entry)) or 0


def channel_allows(origin_channel, release_channel):
    """A Stable build can be carried into any release. A Beta build only into
    another Beta: it is stamped Beta, so a Stable release must not hold it."""
    return origin_channel == "stable" or origin_channel == release_channel


def decide(contract, *, channel, current, baseline, newest, pending, unavailable, verify_origin, check_image):
    """Returns the plan: one decision per contract component.

    `current` maps component id to its fingerprint at the release commit.
    `baseline` and `newest` are Release or None. `pending` is the component ids
    that still need a build (what a resumed draft already holds is not listed).
    `unavailable` is the reason reuse cannot apply at all, or "".
    `verify_origin(origin, component, entry)` and `check_image(entry, origin)`
    raise ReuseError when the earlier files do not verify today.
    """
    components = []
    for component in contract["components"]:
        cid = component["id"]
        decision = {"id": cid, "action": "build", "reason": ""}
        components.append(decision)
        if cid not in pending:
            decision["reason"] = "the draft already holds a verified build"
            continue
        if unavailable:
            decision["reason"] = unavailable
            continue
        entry = baseline.entry(cid)
        if entry is None or entry.get("status") != "available":
            decision["reason"] = f"{baseline.tag} has no available {cid}"
            continue
        changed = ri.differences(entry.get("inputs"), current[cid])
        if changed:
            decision["reason"] = f"build inputs changed since {baseline.tag}: {', '.join(changed)}"
            continue
        origin = origin_of(baseline, entry)
        version = entry_version(entry)
        origin_channel = entry.get("channel") or channel_of(version)
        if not channel_allows(origin_channel, channel):
            decision["reason"] = f"{cid} at {version} is a {origin_channel} build; a {channel} release needs its own build"
            continue
        if newest is not None and newest.tag != baseline.tag:
            later = newest.entry(cid)
            if later is not None and later.get("status") == "available" and entry_code(later) > entry_code(entry):
                decision["reason"] = f"{newest.tag} holds a newer {cid} ({entry_version(later)}) than {baseline.tag} ({version})"
                continue
        try:
            facts = verify_origin(origin, component, entry) if component["kind"] == "player" else check_image(entry, origin)
        except ReuseError as error:
            decision["reason"] = f"the earlier {cid} does not verify today: {error}"
            continue
        decision.update(
            action="inherit",
            reason=f"build inputs are unchanged since {baseline.tag}",
            versionName=version,
            versionCode=entry_code(entry),
            channel=origin_channel,
            source={**origin, "url": release_url(contract, origin["tag"])},
            inputs=entry["inputs"],
            **facts,
        )
    return {
        "schemaVersion": PLAN_SCHEMA,
        "baseline": None if baseline is None else {"tag": baseline.tag, "commit": baseline.commit, "inventorySha256": baseline.inventory_sha256},
        "newest": None if newest is None else {"tag": newest.tag, "commit": newest.commit, "inventorySha256": newest.inventory_sha256},
        "components": components,
    }


def release_url(contract, tag):
    return f"https://github.com/{contract['repository']}/releases/tag/{tag}"


# ---- verifying what an earlier release published ----------------------------

def run_verifier(verifier, directory, public_key, version, android_certificate):
    command = [verifier, "--dir", directory, "--public-key", public_key, "--version", version]
    if android_certificate:
        command += ["--android-certificate", android_certificate]
    run = subprocess.run(command, capture_output=True, text=True)
    if run.returncode not in (0, 1):
        raise ReuseError(f"the release verifier failed: {run.stderr.strip() or run.stdout.strip()}")
    try:
        return json.loads(run.stdout)
    except ValueError:
        raise ReuseError("the release verifier printed no report") from None


def player_facts(origin_dir, component, entry, report):
    """The verified facts of one component from an origin directory, or a
    ReuseError. Cross-checks the origin's inventory entry against the bytes."""
    problems = [p["message"] for p in report["problems"] if p["family"] == component["family"] and p["architecture"] == component["architecture"]]
    if problems:
        raise ReuseError("; ".join(sorted(set(problems))))
    verified = next((c for c in report["components"] if c["family"] == component["family"] and c["architecture"] == component["architecture"]), None)
    if verified is None:
        raise ReuseError("the release no longer holds it")
    if verified["versionName"] != entry_version(entry) or verified["versionCode"] != entry_code(entry):
        raise ReuseError(f"it verifies as {verified['versionName']}, not the recorded {entry_version(entry)}")
    assets = []
    for asset in component["assets"]:
        name = ra.expand(asset["name"], verified["versionName"])
        path = os.path.join(origin_dir, name)
        if not os.path.isfile(path):
            raise ReuseError(f"{name} is missing")
        assets.append({"name": name, "role": asset["role"], "sizeBytes": os.path.getsize(path), "sha256": ra.sha256_file(path)})
    recorded = {a["name"]: a for a in entry.get("assets", [])}
    for asset in assets:
        was = recorded.get(asset["name"])
        if was is None or was.get("sha256") != asset["sha256"] or was.get("sizeBytes") != asset["sizeBytes"]:
            raise ReuseError(f"{asset['name']} does not match what the release recorded")
    return {"assets": assets}


class OriginVerifier:
    """Downloads an origin release once and verifies its players with the
    server's importer. Used while planning and again before the release is
    assembled."""

    def __init__(self, contract, fetch, verifier, public_key, android_certificate, workdir):
        self.contract = contract
        self.fetch = fetch
        self.verifier = verifier
        self.public_key = public_key
        self.android_certificate = android_certificate
        self.workdir = workdir
        self._cache = {}

    def directory(self, tag):
        if tag not in self._cache:
            target = os.path.join(self.workdir, "origin-" + tag)
            self.fetch(tag, target)
            self._cache[tag] = target
        return self._cache[tag]

    def __call__(self, origin, component, entry):
        tag = origin["tag"]
        if not tag:
            raise ReuseError("the earlier release does not say which release holds it")
        directory = self.directory(tag)
        inventory, digest = read_inventory(directory)
        if origin.get("inventorySha256") and digest != origin["inventorySha256"]:
            raise ReuseError(f"the inventory of {tag} changed since it was read")
        held = next((c for c in inventory["components"] if c.get("id") == component["id"]), None)
        if held is None or held.get("status") != "available" or held.get("origin") == "inherited":
            raise ReuseError(f"{tag} does not carry {component['id']} itself")
        if entry_version(held) != entry_version(entry) or entry_code(held) != entry_code(entry):
            raise ReuseError(f"{tag} holds {component['id']} as {entry_version(held)}, not {entry_version(entry)}")
        report = run_verifier(self.verifier, directory, self.public_key, inventory["version"], self.android_certificate)
        return player_facts(directory, component, entry, report)


def image_checker(contract, inspect):
    """Checks a Server image the earlier release recorded: the digest must
    still exist in the registry and its annotations must name the release and
    commit it was built for. `inspect(reference)` returns the manifest JSON."""

    def check(entry, origin):
        digest = entry.get("digest") or ""
        if len(digest) != 71 or not digest.startswith("sha256:"):
            raise ReuseError("the recorded image digest is malformed")
        try:
            manifest = inspect(f"{contract['serverImage']}@{digest}")
        except Exception as error:  # noqa: BLE001 - any registry failure is a refusal
            raise ReuseError(f"the image {digest} cannot be read from the registry: {error}") from None
        annotations = (manifest or {}).get("annotations") or {}
        if annotations.get("org.opencontainers.image.version") != entry_version(entry):
            raise ReuseError(f"the image is version {annotations.get('org.opencontainers.image.version') or 'unknown'}, not {entry_version(entry)}")
        if origin.get("commit") and annotations.get("org.opencontainers.image.revision") != origin["commit"]:
            raise ReuseError("the image was built from another commit than its release records")
        return {"image": contract["serverImage"], "tag": entry_version(entry), "digest": digest}

    return check


def registry_inspect(reference):
    run = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--raw", reference], capture_output=True, text=True)
    if run.returncode != 0:
        raise ReuseError(run.stderr.strip() or "inspect failed")
    return json.loads(run.stdout)


# ---- reading earlier releases -----------------------------------------------

def load_release(tag, fetch, workdir, tag_commit):
    """Reads a published release. Its tag must exist and name the commit its
    inventory records: an immutable release fixes its tag when it is published,
    so a mismatch means the inventory is not that release's."""
    directory = os.path.join(workdir, "release-" + tag)
    fetch(tag, directory)
    inventory, digest = read_inventory(directory)
    if inventory.get("tag") != tag:
        raise ReuseError(f"the inventory of {tag} is for {inventory.get('tag')}")
    commit = tag_commit(tag)
    if not commit or commit != inventory.get("commit"):
        raise ReuseError(f"{tag} is at {commit or 'no commit'}, but its inventory records {inventory.get('commit')}")
    return Release(tag, inventory, digest, directory)


def git_tag_commit(repo):
    def resolve(tag):
        run = subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "-q", f"refs/tags/{tag}^{{commit}}"], capture_output=True, text=True)
        return run.stdout.strip() if run.returncode == 0 else ""

    return resolve


def fetch_published(tag, directory):
    """Downloads every asset of a published release. A draft is refused: only
    a published release is immutable."""
    client = github_release.Client()
    release = client.find(tag)
    if release is None:
        raise ReuseError(f"there is no release {tag}")
    if release["draft"]:
        raise ReuseError(f"{tag} is a draft, not a published release")
    try:
        client.download(release, directory)
    except github_release.GitHubError as error:
        raise ReuseError(str(error)) from None


# ---- command line -----------------------------------------------------------

def build_plan(args, contract, fetch, tag_commit, inspect):
    os.makedirs(args.workdir, exist_ok=True)
    version = args.version
    parsed = rv.parse_version(version)
    if parsed is None or not parsed.unified:
        raise ReuseError(f"{version} is not a coordinated release version")
    commit = subprocess.run(["git", "-C", args.repo, "rev-parse", "--verify", f"{args.commit}^{{commit}}"], capture_output=True, text=True)
    if commit.returncode != 0:
        raise ReuseError(f"{args.commit} is not a commit")
    current = ri.fingerprints(contract, args.repo, commit.stdout.strip())
    pending = json.loads(args.pending)
    unavailable = ""
    baseline = newest = None
    if args.reuse != "on":
        unavailable = "reuse is turned off for this run"
    elif not args.baseline:
        unavailable = "there is no earlier release to carry it forward from"
    elif any(c in pending for c in current):
        try:
            baseline = load_release(args.baseline, fetch, args.workdir, tag_commit)
            if args.newest and args.newest != args.baseline:
                newest = load_release(args.newest, fetch, args.workdir, tag_commit)
        except ReuseError as error:
            # A baseline that cannot be read is never guessed at: build.
            baseline = newest = None
            unavailable = f"the earlier release could not be used: {error}"
    verifier = OriginVerifier(contract, fetch, args.verifier, args.public_key, args.android_certificate, args.workdir)
    plan = decide(
        contract, channel=parsed.channel, current=current, baseline=baseline, newest=newest or baseline,
        pending=pending, unavailable=unavailable, verify_origin=verifier,
        check_image=image_checker(contract, inspect),
    )
    plan["version"] = version
    plan["commit"] = commit.stdout.strip()
    plan["reuse"] = args.reuse
    # The fingerprint of every component at this commit, for the inventory.
    plan["inputs"] = current
    return plan


def reverify(plan, contract, fetch, verifier, inspect):
    """Checks every inherited component of a plan again, against the earlier
    release as it is now. Raises ReuseError on any difference."""
    for item in plan["components"]:
        if item["action"] != "inherit":
            continue
        component = next(c for c in contract["components"] if c["id"] == item["id"])
        recorded = {"versionName": item["versionName"], "versionCode": item["versionCode"], "assets": item.get("assets", []), "digest": item.get("digest")}
        if component["kind"] == "player":
            facts = verifier(item["source"], component, recorded)
            if facts["assets"] != item["assets"]:
                raise ReuseError(f"{item['id']}: the assets of {item['source']['tag']} changed since the release was planned")
        else:
            entry = {"digest": item["digest"], "versionName": item["versionName"]}
            image_checker(contract, inspect)(entry, item["source"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["plan", "reverify"])
    parser.add_argument("--version")
    parser.add_argument("--commit")
    parser.add_argument("--baseline", default="")
    parser.add_argument("--newest", default="")
    parser.add_argument("--reuse", choices=["on", "off"], default="on")
    parser.add_argument("--pending", default="[]")
    parser.add_argument("--plan")
    parser.add_argument("--verifier", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--android-certificate", default="")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    contract = ra.load_contract()
    fetch = fetch_published
    try:
        if args.command == "plan":
            if not (args.version and args.commit and args.out):
                parser.error("plan needs --version, --commit and --out")
            plan = build_plan(args, contract, fetch, git_tag_commit(args.repo), registry_inspect)
            with open(args.out, "w") as handle:
                json.dump(plan, handle, indent=2, sort_keys=True)
                handle.write("\n")
            for item in plan["components"]:
                print(f"{item['id']}: {item['action']}: {item['reason']}")
        else:
            if not args.plan:
                parser.error("reverify needs --plan")
            with open(args.plan) as handle:
                plan = json.load(handle)
            verifier = OriginVerifier(contract, fetch, args.verifier, args.public_key, args.android_certificate, args.workdir)
            reverify(plan, contract, fetch, verifier, registry_inspect)
            print("reverify: every inherited component still verifies")
    except (ReuseError, ri.InputsError) as error:
        sys.exit(f"release_reuse: {error}")


if __name__ == "__main__":
    main()
