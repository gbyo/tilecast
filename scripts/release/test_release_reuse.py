"""Carrying components forward from an earlier release (release_reuse.py).

Every case runs the real planner and assembler over a throwaway git repository
and a store of fake published releases. The importer that verifies earlier
assets (tilecast-release-verify) is replaced by a small fake that reads an
earlier release directory the way the real one reads it; test_pipeline.py runs
the real one over real signatures.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import release_assemble as ra
import release_inputs as ri
import release_reuse as rr

ALL = ["server", "edge-x86_64", "edge-aarch64", "windows-x86_64", "windows-aarch64", "android"]
PLAYERS = ALL[1:]

BASE_FILES = {
    "apps/server/main.go": "package main",
    "apps/dashboard/index.ts": "export {}",
    "apps/edge/tilecastd/main.rs": "fn main() {}",
    "apps/edge/release/VERSION": "0.2.1",
    "apps/player-windows/src/main.rs": "fn main() {}",
    "apps/player-android/app/build.gradle.kts": "plugins {}",
    "apps/docs/index.md": "docs",
    "crates/player-core/lib.rs": "pub fn core() {}",
    "packages/player-runtime/index.ts": "export {}",
    "packages/player-contracts/fixtures/wire.json": "{}",
    "deploy/docker/Dockerfile": "FROM scratch",
    "Cargo.lock": "# lock",
    "package-lock.json": "{}",
    "README.md": "readme",
    "docs/guide.md": "guide",
    "scripts/release/stamp_version.py": "# stamp",
    "scripts/release/release_assemble.py": "# assemble",
    "scripts/ci/check.mjs": "// ci",
    ".github/workflows/edge-release.yml": "name: edge",
    ".github/workflows/windows-player-release.yml": "name: windows",
    ".github/workflows/player-release.yml": "name: android",
    ".github/workflows/server-release.yml": "name: server",
    ".github/workflows/ci-windows.yml": "name: ci",
}


def digest_of(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


class World(unittest.TestCase):
    """A repository, a store of published releases, and a registry."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(self.repo)
        self.git("init", "-q", "-b", "main")
        self.contract = ra.load_contract()
        self.store = {}  # tag -> directory
        self.images = {}  # reference -> manifest
        self.rejected = set()  # (version, component id) the importer refuses
        self.files = dict(BASE_FILES)
        for path, text in self.files.items():
            self.write(path, text)
        self.head = self.commit("initial")
        patch = mock.patch.object(rr, "run_verifier", self.fake_verifier)
        patch.start()
        self.addCleanup(patch.stop)

    # -- repository ----------------------------------------------------------

    def git(self, *args):
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.org", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.org")
        return subprocess.run(["git", "-C", self.repo, *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def write(self, path, text):
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as handle:
            handle.write(text)
        self.files[path] = text

    def commit(self, message, **changes):
        for path, text in changes.items():
            self.write(path.replace("__", "/"), text)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def edit(self, message, *paths):
        """A commit that changes the given files."""
        for path in paths:
            self.write(path, self.files.get(path, "") + f"\n// {message}")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    # -- the importer and the registry ---------------------------------------

    def fake_verifier(self, verifier, directory, public_key, version, android_certificate):
        with open(os.path.join(directory, ra.INVENTORY)) as handle:
            inventory = json.load(handle)
        components, problems = [], []
        for component in self.contract["components"]:
            if component["kind"] != "player":
                continue
            names = [ra.expand(a["name"], version) for a in component["assets"]]
            present = [n for n in names if os.path.isfile(os.path.join(directory, n))]
            if not present:
                continue
            key = {"family": component["family"], "architecture": component["architecture"]}
            entry = next((c for c in inventory["components"] if c["id"] == component["id"]), None)
            if len(present) != len(names):
                problems.append({**key, "message": "an asset is missing"})
            elif (version, component["id"]) in self.rejected:
                problems.append({**key, "message": "the importer rejects this release"})
            elif entry is None or any(
                ra.sha256_file(os.path.join(directory, a["name"])) != a["sha256"] for a in entry.get("assets", [])
            ):
                problems.append({**key, "message": "the artifact does not match its signed digest"})
            else:
                components.append({**key, "manifest": "m", "artifact": "a", "versionName": entry["versionName"],
                                   "versionCode": entry["versionCode"], "channel": entry["channel"], "sizeBytes": 1, "sha256": "b" * 64})
        return {"version": version, "channel": inventory["channel"], "components": components, "problems": problems}

    def fetch(self, tag, directory):
        if tag not in self.store:
            raise rr.ReuseError(f"there is no release {tag}")
        shutil.copytree(self.store[tag], directory, dirs_exist_ok=True)

    def inspect(self, reference):
        if reference not in self.images:
            raise rr.ReuseError("manifest unknown")
        return self.images[reference]

    # -- a release -----------------------------------------------------------

    def args(self, version, commit, baseline="", newest="", reuse="on", pending=None):
        return argparse.Namespace(
            version=version, commit=commit, baseline=baseline, newest=newest, reuse=reuse,
            pending=json.dumps(ALL if pending is None else pending), verifier="verify", public_key="key",
            android_certificate="", workdir=os.path.join(self.root, "work-" + version), repo=self.repo,
        )

    def plan(self, version, commit=None, baseline="", newest="", **kwargs):
        args = self.args(version, commit or self.head, baseline, newest, **kwargs)
        return rr.build_plan(args, self.contract, self.fetch, rr.git_tag_commit(self.repo), self.inspect)

    def decisions(self, plan):
        return {c["id"]: c["action"] for c in plan["components"]}

    def release(self, version, commit=None, baseline="", newest="", **kwargs):
        """Plans, builds what the plan builds, assembles, and 'publishes':
        stores the release and tags its commit, as the workflow does."""
        commit = commit or self.head
        parsed = ra.rv.parse_version(version)
        channel = parsed.channel
        plan = self.plan(version, commit, baseline, newest, **kwargs)
        assets = os.path.join(self.root, "assets-" + version)
        os.makedirs(assets)
        built = [i["id"] for i in plan["components"] if i["action"] == "build"]
        report_components = []
        for component in self.contract["components"]:
            if component["kind"] != "player" or component["id"] not in built:
                continue
            for name in (ra.expand(a["name"], version) for a in component["assets"]):
                with open(os.path.join(assets, name), "w") as handle:
                    handle.write(f"{component['id']} {version}: {name}")
            report_components.append({
                "family": component["family"], "architecture": component["architecture"], "manifest": "m", "artifact": "a",
                "versionName": version, "versionCode": parsed.code, "channel": channel, "sizeBytes": 1, "sha256": "b" * 64,
            })
        report = {"version": version, "channel": channel, "components": report_components, "problems": []}
        digest = digest_of("image " + version) if "server" in built else ""
        inventory = ra.build(self.contract, version, channel, commit, assets, report, {}, digest, plan)
        if digest:
            self.images[f"{self.contract['serverImage']}@{digest}"] = {
                "annotations": {"org.opencontainers.image.version": version, "org.opencontainers.image.revision": commit}
            }
        self.store[f"v{version}"] = assets
        self.git("tag", f"v{version}", commit)
        return plan, inventory, assets

    def entry(self, inventory, component_id):
        return next(c for c in inventory["components"] if c["id"] == component_id)


class HotfixTests(World):
    """One platform changes; the others are carried forward."""

    def first(self):
        self.release("0.26.0")

    def test_the_first_release_builds_everything(self):
        plan, inventory, _ = self.release("0.26.0")
        self.assertEqual(self.decisions(plan), {c: "build" for c in ALL})
        self.assertEqual({e["origin"] for e in inventory["components"]}, {"built"})
        self.assertEqual(plan["baseline"], None)

    def test_a_windows_only_hotfix_builds_windows_and_carries_the_rest(self):
        self.first()
        commit = self.edit("fix windows", "apps/player-windows/src/main.rs")
        plan, inventory, assets = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(self.decisions(plan), {
            "server": "inherit", "edge-x86_64": "inherit", "edge-aarch64": "inherit", "android": "inherit",
            "windows-x86_64": "build", "windows-aarch64": "build",
        })
        server = self.entry(inventory, "server")
        self.assertEqual((server["origin"], server["tag"], server["versionName"]), ("inherited", "0.26.0", "0.26.0"))
        self.assertEqual(server["digest"], digest_of("image 0.26.0"))
        self.assertEqual(server["source"]["tag"], "v0.26.0")
        self.assertEqual(server["source"]["commit"], self.git("rev-parse", "v0.26.0"))
        edge = self.entry(inventory, "edge-x86_64")
        self.assertEqual((edge["versionName"], edge["versionCode"], edge["channel"]), ("0.26.0", 2600099, "stable"))
        self.assertEqual(edge["source"]["tag"], "v0.26.0")
        self.assertIn("unchanged", edge["reason"])
        windows = self.entry(inventory, "windows-x86_64")
        self.assertEqual((windows["origin"], windows["versionName"], windows["versionCode"]), ("built", "0.26.1", 2600199))
        # Only what this release built is an asset of it, and nothing is copied.
        names = sorted(os.listdir(assets))
        self.assertEqual([n for n in names if "edge" in n or "player.apk" in n or "player-update" in n], [])
        self.assertTrue(all(n.startswith("tilecast-windows-") or n in ("SHA256SUMS", "tilecast-release.json") for n in names), names)
        self.assertEqual(inventory["reuse"]["baseline"]["tag"], "v0.26.0")

    def test_an_edge_only_hotfix(self):
        self.first()
        commit = self.edit("fix edge", "apps/edge/tilecastd/main.rs")
        plan, _, _ = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(self.decisions(plan), {
            "server": "inherit", "edge-x86_64": "build", "edge-aarch64": "build",
            "windows-x86_64": "inherit", "windows-aarch64": "inherit", "android": "inherit",
        })

    def test_an_android_only_hotfix(self):
        self.first()
        commit = self.edit("fix android", "apps/player-android/app/build.gradle.kts")
        plan, _, _ = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual({k for k, v in self.decisions(plan).items() if v == "build"}, {"android"})

    def test_a_server_only_hotfix_builds_the_image_and_carries_every_player(self):
        self.first()
        commit = self.edit("fix server", "apps/server/main.go")
        plan, inventory, _ = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual({k for k, v in self.decisions(plan).items() if v == "build"}, {"server"})
        server = self.entry(inventory, "server")
        self.assertEqual((server["origin"], server["tag"]), ("built", "0.26.1"))

    def test_changes_to_two_platforms_build_two_and_carry_the_rest(self):
        self.first()
        commit = self.edit("two fixes", "apps/player-windows/src/main.rs", "apps/player-android/app/build.gradle.kts")
        plan, _, _ = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual({k for k, v in self.decisions(plan).items() if v == "build"}, {"windows-x86_64", "windows-aarch64", "android"})

    def test_a_documentation_only_change_carries_everything(self):
        self.first()
        commit = self.edit("docs", "docs/guide.md", "README.md", "apps/docs/index.md", ".github/workflows/ci-windows.yml", "scripts/ci/check.mjs", "scripts/release/release_assemble.py")
        plan, _, _ = self.release("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(set(self.decisions(plan).values()), {"inherit"})

    def test_an_unchanged_commit_with_reuse_off_builds_everything(self):
        self.first()
        plan = self.plan("0.26.1", baseline="v0.26.0", newest="v0.26.0", reuse="off")
        self.assertEqual(set(self.decisions(plan).values()), {"build"})
        self.assertEqual({c["reason"] for c in plan["components"]}, {"reuse is turned off for this run"})


class RebuildTests(World):
    """Anything that is not provably unchanged is built."""

    def setUp(self):
        super().setUp()
        self.release("0.26.0")

    def built(self, version="0.26.1", commit=None):
        plan = self.plan(version, commit or self.head, baseline="v0.26.0", newest="v0.26.0")
        return {k for k, v in self.decisions(plan).items() if v == "build"}

    def reason(self, plan, component_id):
        return next(c["reason"] for c in plan["components"] if c["id"] == component_id)

    def test_a_shared_player_crate_change_rebuilds_every_native_player(self):
        commit = self.edit("core", "crates/player-core/lib.rs")
        self.assertEqual(self.built(commit=commit), {"edge-x86_64", "edge-aarch64", "windows-x86_64", "windows-aarch64", "android"})

    def test_a_wire_contract_change_rebuilds_everything(self):
        commit = self.edit("contract", "packages/player-contracts/fixtures/wire.json")
        self.assertEqual(self.built(commit=commit), set(ALL))

    def test_a_dependency_lockfile_change_rebuilds_everything(self):
        commit = self.edit("deps", "package-lock.json")
        self.assertEqual(self.built(commit=commit), set(ALL))

    def test_a_new_unlisted_directory_forces_a_rebuild_of_everything(self):
        commit = self.commit("new top-level directory", **{"newthing__x.txt": "x"})
        self.assertEqual(self.built(commit=commit), set(ALL))

    def test_the_stamping_scripts_are_build_inputs_but_the_assembly_scripts_are_not(self):
        commit = self.edit("assembly only", "scripts/release/release_assemble.py")
        self.assertEqual(self.built(commit=commit), set())
        commit = self.edit("stamp", "scripts/release/stamp_version.py")
        self.assertEqual(self.built(commit=commit), set(ALL))

    def test_a_components_own_build_workflow_is_one_of_its_inputs(self):
        commit = self.edit("windows workflow", ".github/workflows/windows-player-release.yml")
        self.assertEqual(self.built(commit=commit), {"windows-x86_64", "windows-aarch64"})

    def test_a_changed_release_contract_entry_rebuilds_that_component(self):
        self.contract = json_copy(self.contract)
        windows = next(c for c in self.contract["components"] if c["id"] == "windows-x86_64")
        windows["assets"].append({"name": "tilecast-windows-{version}-x86_64.sbom.cdx.json", "role": "sbom"})
        plan = self.plan("0.26.1", baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(self.decisions(plan)["windows-x86_64"], "build")
        self.assertIn("release contract", self.reason(plan, "windows-x86_64"))
        self.assertEqual(self.decisions(plan)["windows-aarch64"], "inherit")

    def test_the_reason_names_what_changed(self):
        commit = self.edit("core", "crates/player-core/lib.rs")
        plan = self.plan("0.26.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(self.reason(plan, "edge-x86_64"), "build inputs changed since v0.26.0: crates")

    def test_a_beta_build_is_never_carried_into_a_stable_release(self):
        self.release("0.27.0-beta.1", baseline="v0.26.0", newest="v0.26.0", reuse="off")
        plan = self.plan("0.27.0", baseline="v0.27.0-beta.1", newest="v0.27.0-beta.1")
        self.assertEqual(set(self.decisions(plan).values()), {"build"})
        self.assertIn("a stable release needs its own build", self.reason(plan, "android"))

    def test_a_stable_build_is_carried_into_a_beta(self):
        plan, inventory, _ = self.release("0.27.0-beta.1", baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(set(self.decisions(plan).values()), {"inherit"})
        self.assertEqual(self.entry(inventory, "android")["channel"], "stable")
        self.assertEqual(self.entry(inventory, "android")["versionName"], "0.26.0")

    def test_a_beta_is_carried_into_the_next_beta(self):
        self.release("0.27.0-beta.1", baseline="v0.26.0", newest="v0.26.0", reuse="off")
        plan, inventory, _ = self.release("0.27.0-beta.2", baseline="v0.27.0-beta.1", newest="v0.27.0-beta.1")
        self.assertEqual(set(self.decisions(plan).values()), {"inherit"})
        self.assertEqual(self.entry(inventory, "windows-x86_64")["versionName"], "0.27.0-beta.1")

    def test_an_older_build_is_not_carried_past_a_newer_one(self):
        # beta.1 changed Windows, then the change was reverted: the sources now
        # equal v0.26.0's, but Beta users already run the newer Windows build.
        commit = self.edit("windows change", "apps/player-windows/src/main.rs")
        self.release("0.27.0-beta.1", commit, baseline="v0.26.0", newest="v0.26.0")
        self.git("revert", "--no-edit", "HEAD")
        reverted = self.git("rev-parse", "HEAD")
        plan = self.plan("0.27.0", reverted, baseline="v0.26.0", newest="v0.27.0-beta.1")
        self.assertEqual(self.decisions(plan)["windows-x86_64"], "build")
        self.assertIn("newer windows-x86_64", self.reason(plan, "windows-x86_64"))
        self.assertEqual(self.decisions(plan)["android"], "inherit")

    def test_a_stable_hotfix_with_a_newer_beta_published_carries_from_the_stable(self):
        commit = self.edit("beta work", "apps/player-android/app/build.gradle.kts")
        self.release("0.27.0-beta.1", commit, baseline="v0.26.0", newest="v0.26.0")
        # The hotfix's baseline is the previous Stable; the newest release
        # below it is that same Stable, so the Beta is not in the way.
        fix = self.edit("hotfix", "apps/player-windows/src/main.rs")
        plan = self.plan("0.26.1", fix, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(self.decisions(plan)["server"], "inherit")

    def test_a_draft_that_already_holds_a_component_does_not_inherit_it(self):
        plan = self.plan("0.26.1", baseline="v0.26.0", newest="v0.26.0", pending=["android", "server"])
        self.assertEqual(self.decisions(plan)["edge-x86_64"], "build")
        self.assertEqual(self.reason(plan, "edge-x86_64"), "the draft already holds a verified build")
        self.assertEqual(self.decisions(plan)["android"], "inherit")


class UnusableEarlierAssets(World):
    def setUp(self):
        super().setUp()
        self.release("0.26.0")
        self.dir = self.store["v0.26.0"]

    def plan_hotfix(self):
        return self.plan("0.26.1", baseline="v0.26.0", newest="v0.26.0")

    def reason(self, plan, component_id):
        return next(c["reason"] for c in plan["components"] if c["id"] == component_id)

    def test_a_deleted_asset_is_built_again(self):
        os.remove(os.path.join(self.dir, "tilecast-player.apk"))
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["android"], "build")
        self.assertIn("does not verify today", self.reason(plan, "android"))
        self.assertEqual(self.decisions(plan)["edge-x86_64"], "inherit")

    def test_a_corrupt_asset_is_built_again(self):
        with open(os.path.join(self.dir, "tilecast-windows-0.26.0-x86_64.msix"), "w") as handle:
            handle.write("tampered")
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["windows-x86_64"], "build")
        self.assertEqual(self.decisions(plan)["windows-aarch64"], "inherit")
        self.assertIn("signed digest", self.reason(plan, "windows-x86_64"))

    def test_a_release_the_importer_now_rejects_is_built_again(self):
        self.rejected.add(("0.26.0", "edge-aarch64"))
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["edge-aarch64"], "build")
        self.assertEqual(self.decisions(plan)["edge-x86_64"], "inherit")

    def test_an_inventory_that_changes_between_reading_and_verifying_is_refused(self):
        reads = []
        original = self.fetch

        def fetch(tag, directory):
            original(tag, directory)
            reads.append(directory)
            if len(reads) == 1:
                return
            path = os.path.join(directory, ra.INVENTORY)
            with open(path) as handle:
                inventory = json.load(handle)
            inventory["components"][1]["label"] = "edited"
            with open(path, "w") as handle:
                json.dump(inventory, handle)

        self.fetch = fetch
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["edge-x86_64"], "build")
        self.assertIn("changed since it was read", self.reason(plan, "edge-x86_64"))

    def test_a_missing_baseline_release_means_everything_is_built(self):
        plan = self.plan("0.26.1", baseline="v0.25.9", newest="v0.25.9")
        self.assertEqual(set(self.decisions(plan).values()), {"build"})
        self.assertIn("could not be used", self.reason(plan, "android"))

    def test_a_baseline_whose_tag_is_at_another_commit_is_refused(self):
        self.git("tag", "-f", "v0.26.0", self.edit("moved", "README.md"))
        plan = self.plan_hotfix()
        self.assertEqual(set(self.decisions(plan).values()), {"build"})
        self.assertIn("inventory records", self.reason(plan, "android"))

    def test_a_server_image_that_left_the_registry_is_built_again(self):
        self.images.clear()
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["server"], "build")
        self.assertIn("cannot be read from the registry", self.reason(plan, "server"))
        self.assertEqual(self.decisions(plan)["android"], "inherit")

    def test_a_server_image_built_for_another_commit_is_built_again(self):
        key = next(iter(self.images))
        self.images[key]["annotations"]["org.opencontainers.image.revision"] = "f" * 40
        plan = self.plan_hotfix()
        self.assertEqual(self.decisions(plan)["server"], "build")
        self.assertIn("another commit", self.reason(plan, "server"))

    def test_a_baseline_that_records_no_build_inputs_is_not_reused(self):
        path = os.path.join(self.dir, ra.INVENTORY)
        with open(path) as handle:
            inventory = json.load(handle)
        for component in inventory["components"]:
            component.pop("inputs", None)
        with open(path, "w") as handle:
            json.dump(inventory, handle)
        plan = self.plan_hotfix()
        self.assertEqual(set(self.decisions(plan).values()), {"build"})
        self.assertIn("records no build inputs", self.reason(plan, "android"))


class ChainTests(World):
    def test_an_inherited_component_names_the_release_that_built_it(self):
        self.release("0.26.0")
        fix = self.edit("windows 1", "apps/player-windows/src/main.rs")
        self.release("0.26.1", fix, baseline="v0.26.0", newest="v0.26.0")
        fix = self.edit("windows 2", "apps/player-windows/src/main.rs")
        plan, inventory, _ = self.release("0.26.2", fix, baseline="v0.26.1", newest="v0.26.1")
        for component_id in ("edge-x86_64", "android", "server"):
            entry = self.entry(inventory, component_id)
            self.assertEqual(entry["source"]["tag"], "v0.26.0", component_id)
            self.assertEqual(entry["versionName"], "0.26.0")
        self.assertEqual(self.entry(inventory, "windows-x86_64")["versionName"], "0.26.2")
        self.assertEqual(plan["baseline"]["tag"], "v0.26.1")

    def test_a_hotfix_that_carries_windows_from_a_hotfix_keeps_its_real_version(self):
        self.release("0.26.0")
        fix = self.edit("windows", "apps/player-windows/src/main.rs")
        self.release("0.26.1", fix, baseline="v0.26.0", newest="v0.26.0")
        fix = self.edit("android", "apps/player-android/app/build.gradle.kts")
        _, inventory, _ = self.release("0.26.2", fix, baseline="v0.26.1", newest="v0.26.1")
        windows = self.entry(inventory, "windows-x86_64")
        self.assertEqual((windows["versionName"], windows["source"]["tag"]), ("0.26.1", "v0.26.1"))

    def test_the_plan_is_deterministic(self):
        self.release("0.26.0")
        fix = self.edit("windows", "apps/player-windows/src/main.rs")
        first = self.plan("0.26.1", fix, baseline="v0.26.0", newest="v0.26.0")
        again = self.plan("0.26.1", fix, baseline="v0.26.0", newest="v0.26.0")
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(again, sort_keys=True))


class AssemblyTests(World):
    def setUp(self):
        super().setUp()
        self.release("0.26.0")
        self.fix = self.edit("windows", "apps/player-windows/src/main.rs")

    def test_a_stable_release_satisfies_its_required_components_by_inheritance(self):
        plan, inventory, assets = self.release("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        required = [c for c in inventory["components"] if c["required"]]
        self.assertTrue(all(c["status"] == "available" for c in required))
        self.assertEqual(len(required), 6)
        report = {"version": "0.26.1", "channel": "stable", "problems": [], "components": [
            {"family": "windows", "architecture": a, "versionName": "0.26.1"} for a in ("x86_64", "aarch64")]}
        ra.verify(self.contract, "0.26.1", "stable", assets, report)

    def test_the_notes_link_every_platform_including_the_carried_ones(self):
        plan, inventory, _ = self.release("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        text = ra.notes(self.contract, inventory)
        self.assertIn("https://github.com/gbyo/tilecast/releases/download/v0.26.0/tilecast-player.apk", text)
        self.assertIn("https://github.com/gbyo/tilecast/releases/download/v0.26.0/tilecast-edge-0.26.0-x86_64.tar.zst", text)
        self.assertIn("https://github.com/gbyo/tilecast/releases/download/v0.26.1/tilecast-windows-0.26.1-x86_64.msix", text)
        self.assertIn("Carried forward unchanged: version 0.26.0 from [v0.26.0]", text)
        self.assertIn("## Carried forward from earlier releases", text)
        self.assertIn(digest_of("image 0.26.0"), text)
        self.assertIn("This release publishes no image of its own", text)

    def test_every_available_component_is_in_exactly_one_state(self):
        _, inventory, _ = self.release("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        states = {c["id"]: (c["status"], c.get("origin")) for c in inventory["components"]}
        self.assertEqual(states["windows-x86_64"], ("available", "built"))
        self.assertEqual(states["android"], ("available", "inherited"))
        self.assertEqual({e["id"] for e in inventory["external"]}, {"ios", "browser"})

    def test_a_component_that_is_both_inherited_and_built_is_refused(self):
        plan = self.plan("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        assets = os.path.join(self.root, "both")
        os.makedirs(assets)
        for name in ("tilecast-player.apk", "tilecast-player-update.json", "tilecast-player-update.json.sig"):
            with open(os.path.join(assets, name), "w") as handle:
                handle.write("x")
        report = {"version": "0.26.1", "channel": "stable", "components": [], "problems": []}
        with self.assertRaisesRegex(ra.ReleaseError, "both carried forward and built"):
            ra.build(self.contract, "0.26.1", "stable", self.fix, assets, report, {}, "", plan)

    def test_an_inherited_server_cannot_also_be_built(self):
        plan = self.plan("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        os.makedirs(os.path.join(self.root, "e"))
        report = {"version": "0.26.1", "channel": "stable", "components": [], "problems": []}
        with self.assertRaisesRegex(ra.ReleaseError, "both carried forward and built"):
            ra.build(self.contract, "0.26.1", "stable", self.fix, os.path.join(self.root, "e"), report, {}, digest_of("x"), plan)

    def test_a_stable_inventory_that_holds_a_beta_build_is_not_publishable(self):
        _, inventory, assets = self.release("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        inventory["components"][-1]["channel"] = "beta"
        with open(os.path.join(assets, ra.INVENTORY), "w") as handle:
            json.dump(inventory, handle)
        report = {"version": "0.26.1", "channel": "stable", "problems": [], "components": [
            {"family": "windows", "architecture": a, "versionName": "0.26.1"} for a in ("x86_64", "aarch64")]}
        with self.assertRaisesRegex(ra.ReleaseError, "Beta build in a Stable release"):
            ra.verify(self.contract, "0.26.1", "stable", assets, report)

    def test_an_inherited_component_without_a_source_is_not_publishable(self):
        _, inventory, assets = self.release("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")
        for component in inventory["components"]:
            if component.get("origin") == "inherited":
                component.pop("source")
        with open(os.path.join(assets, ra.INVENTORY), "w") as handle:
            json.dump(inventory, handle)
        report = {"version": "0.26.1", "channel": "stable", "problems": [], "components": [
            {"family": "windows", "architecture": a, "versionName": "0.26.1"} for a in ("x86_64", "aarch64")]}
        with self.assertRaisesRegex(ra.ReleaseError, "does not say which release supplied it"):
            ra.verify(self.contract, "0.26.1", "stable", assets, report)


class ReverifyTests(World):
    def setUp(self):
        super().setUp()
        self.release("0.26.0")
        self.fix = self.edit("windows", "apps/player-windows/src/main.rs")
        self.plan_ = self.plan("0.26.1", self.fix, baseline="v0.26.0", newest="v0.26.0")

    def verifier(self):
        return rr.OriginVerifier(self.contract, self.fetch, "v", "k", "", os.path.join(self.root, "reverify"))

    def run_reverify(self):
        rr.reverify(self.plan_, self.contract, self.fetch, self.verifier(), self.inspect)

    def test_an_unchanged_origin_still_verifies(self):
        self.run_reverify()

    def test_an_origin_that_lost_an_asset_stops_the_release(self):
        os.remove(os.path.join(self.store["v0.26.0"], "tilecast-edge-0.26.0-x86_64.tar.zst"))
        with self.assertRaises(rr.ReuseError):
            self.run_reverify()

    def test_an_origin_that_was_deleted_stops_the_release(self):
        del self.store["v0.26.0"]
        with self.assertRaisesRegex(rr.ReuseError, "no release"):
            self.run_reverify()

    def test_an_origin_whose_files_changed_stops_the_release(self):
        path = os.path.join(self.store["v0.26.0"], "tilecast-player.apk")
        with open(path, "w") as handle:
            handle.write("different bytes")
        with self.assertRaises(rr.ReuseError):
            self.run_reverify()

    def test_an_image_that_left_the_registry_stops_the_release(self):
        self.images.clear()
        with self.assertRaisesRegex(rr.ReuseError, "registry"):
            self.run_reverify()


def json_copy(value):
    return json.loads(json.dumps(value))


if __name__ == "__main__":
    unittest.main()
