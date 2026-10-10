import json
import os
import re
import shutil
import tempfile
import unittest

import release_assemble as ra

DIGEST = "sha256:" + "a" * 64
COMMIT = "0123456789abcdef0123456789abcdef01234567"


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(content if isinstance(content, bytes) else content.encode())


class Fixture(unittest.TestCase):
    version = "0.26.0-beta.1"
    channel = "beta"

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.contract = ra.load_contract()

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def component(self, component_id):
        return next(c for c in self.contract["components"] if c["id"] == component_id)

    def names(self, component_id, version=None):
        return [ra.expand(a["name"], version or self.version) for a in self.component(component_id)["assets"]]

    def make_component(self, directory, component_id, with_sums=False):
        """Writes one build's artifact directory, as a build job uploads it."""
        for name in self.names(component_id):
            write(os.path.join(directory, name), f"{component_id}:{name}")
        if with_sums:
            lines = [f"{ra.sha256_file(os.path.join(directory, n))}  {n}\n" for n in sorted(self.names(component_id))]
            write(os.path.join(directory, "SHA256SUMS"), "".join(lines))

    def report(self, ids, problems=()):
        components = []
        for component_id in ids:
            component = self.component(component_id)
            components.append({
                "family": component["family"], "architecture": component["architecture"],
                "manifest": "m.json", "artifact": "a", "versionName": self.version,
                "versionCode": ra.rv.version_code(self.version), "channel": self.channel,
                "sizeBytes": 1, "sha256": "b" * 64,
            })
        return {"version": self.version, "channel": self.channel, "components": components,
                "problems": [dict(zip(("family", "architecture", "message"), p)) for p in problems]}

    def assembled(self, ids, **kwargs):
        """Builds the assets directory for the given components and returns it."""
        assets = self.path("assets")
        os.makedirs(assets, exist_ok=True)
        for component_id in ids:
            self.make_component(assets, component_id)
        return assets

    def build(self, ids, report_ids=None, problems=(), results=None, digest=DIGEST, changes=""):
        assets = self.assembled(ids)
        report = self.report(ids if report_ids is None else report_ids, problems)
        inventory = ra.build(self.contract, self.version, self.channel, COMMIT, assets, report, results or {}, digest)
        return assets, report, inventory


ALL = ["edge-x86_64", "edge-aarch64", "windows-x86_64", "windows-aarch64", "android"]
REQUIRED_BETA = ["edge-x86_64", "edge-aarch64", "android"]


class Collect(Fixture):
    def test_gathers_the_contract_assets_from_every_artifact(self):
        for component_id in REQUIRED_BETA:
            self.make_component(self.path("artifacts", component_id), component_id, with_sums=True)
        names = ra.collect(self.contract, self.version, [self.path("artifacts", c) for c in REQUIRED_BETA], self.path("out"))
        expected = sorted(n for c in REQUIRED_BETA for n in self.names(c))
        self.assertEqual(names, expected)
        self.assertNotIn("SHA256SUMS", os.listdir(self.path("out")))

    def test_a_corrupt_artifact_is_caught_by_the_builds_own_checksums(self):
        self.make_component(self.path("artifacts", "android"), "android", with_sums=True)
        write(self.path("artifacts", "android", "tilecast-player.apk"), "tampered in transit")
        with self.assertRaisesRegex(ra.ReleaseError, "corrupt"):
            ra.collect(self.contract, self.version, [self.path("artifacts", "android")], self.path("out"))

    def test_an_asset_outside_the_contract_is_refused(self):
        self.make_component(self.path("artifacts", "android"), "android")
        write(self.path("artifacts", "android", "tilecast-player-debug.apk"), "x")
        with self.assertRaisesRegex(ra.ReleaseError, "not an asset of the release contract"):
            ra.collect(self.contract, self.version, [self.path("artifacts", "android")], self.path("out"))

    def test_other_files_in_an_artifact_directory_are_not_assets(self):
        self.make_component(self.path("artifacts", "android"), "android")
        write(self.path("artifacts", "android", "build.log"), "log")
        names = ra.collect(self.contract, self.version, [self.path("artifacts", "android")], self.path("out"))
        self.assertEqual(names, sorted(self.names("android")))

    def test_two_sources_may_carry_the_same_bytes_but_not_different_ones(self):
        self.make_component(self.path("artifacts", "a"), "android")
        self.make_component(self.path("draft"), "android")
        self.assertEqual(len(ra.collect(self.contract, self.version, [self.path("artifacts", "a"), self.path("draft")], self.path("out"))), 3)
        write(self.path("draft", "tilecast-player.apk"), "another build")
        with self.assertRaisesRegex(ra.ReleaseError, "differs"):
            ra.collect(self.contract, self.version, [self.path("artifacts", "a"), self.path("draft")], self.path("out2"))

    def test_a_missing_source_directory_is_not_an_error(self):
        self.assertEqual(ra.collect(self.contract, self.version, [self.path("absent")], self.path("out")), [])


class Build(Fixture):
    def test_a_beta_needs_only_its_required_components(self):
        assets, _, inventory = self.build(REQUIRED_BETA, results={"windows-x86_64": "failure", "windows-aarch64": "skipped"})
        by_id = {c["id"]: c for c in inventory["components"]}
        self.assertEqual(by_id["windows-x86_64"]["status"], "unavailable")
        self.assertEqual(by_id["windows-x86_64"]["reason"], "the build failed")
        self.assertEqual(by_id["windows-aarch64"]["reason"], "the build skipped")
        self.assertEqual(by_id["server"]["status"], "available")
        self.assertEqual(by_id["server"]["digest"], DIGEST)
        self.assertEqual(by_id["edge-x86_64"]["versionCode"], 2600001)
        self.assertEqual(inventory["channel"], "beta")
        self.assertTrue(inventory["prerelease"])
        self.assertEqual(inventory["commit"], COMMIT)
        listed = sorted(os.listdir(assets))
        self.assertIn("SHA256SUMS", listed)
        self.assertIn("tilecast-release.json", listed)
        self.assertFalse([n for n in listed if "windows" in n])

    def test_stable_requires_windows(self):
        self.version, self.channel = "0.26.0", "stable"
        with self.assertRaisesRegex(ra.ReleaseError, r"windows-x86_64 \(the build failed\)"):
            self.build(REQUIRED_BETA, results={"windows-x86_64": "failure"})

    def test_a_complete_stable_publishes_everything(self):
        self.version, self.channel = "0.26.0", "stable"
        _, _, inventory = self.build(ALL)
        self.assertEqual([c["status"] for c in inventory["components"]], ["available"] * 6)
        self.assertEqual(len(inventory["assets"]), 12 + 6 + 3, "Edge x2 (6 files), Windows x2 (3), Android (3)")

    def test_a_missing_required_asset_fails_the_release(self):
        assets = self.assembled(REQUIRED_BETA)
        os.remove(os.path.join(assets, "tilecast-edge-0.26.0-beta.1-x86_64.sbom.cdx.json"))
        with self.assertRaisesRegex(ra.ReleaseError, "edge-x86_64 .*incomplete build; missing .*sbom"):
            ra.build(self.contract, self.version, self.channel, COMMIT, assets, self.report(REQUIRED_BETA), {}, DIGEST)

    def test_a_required_component_that_does_not_verify_fails_the_release(self):
        with self.assertRaisesRegex(ra.ReleaseError, r"edge-aarch64 \(verification failed: the signature is invalid\)"):
            self.build(REQUIRED_BETA, report_ids=["edge-x86_64", "android"], problems=[("edge", "aarch64", "the signature is invalid")])

    def test_an_optional_component_that_does_not_verify_is_left_out_with_its_reason(self):
        assets, _, inventory = self.build(
            REQUIRED_BETA + ["windows-aarch64"],
            report_ids=REQUIRED_BETA, problems=[("windows", "aarch64", "invalid update manifest signature")],
        )
        entry = next(c for c in inventory["components"] if c["id"] == "windows-aarch64")
        self.assertEqual(entry["status"], "unavailable")
        self.assertIn("invalid update manifest signature", entry["reason"])
        self.assertFalse([n for n in os.listdir(assets) if "windows" in n], "a rejected build must not be published")

    def test_a_missing_server_image_fails_a_release_that_requires_it(self):
        with self.assertRaisesRegex(ra.ReleaseError, "server"):
            self.build(REQUIRED_BETA, digest="")

    def test_a_file_outside_the_contract_in_the_assets_is_refused(self):
        assets = self.assembled(REQUIRED_BETA)
        write(os.path.join(assets, "tilecast-extra.bin"), "x")
        with self.assertRaisesRegex(ra.ReleaseError, "not an asset of the release contract"):
            ra.build(self.contract, self.version, self.channel, COMMIT, assets, self.report(REQUIRED_BETA), {}, DIGEST)

    def test_the_report_must_be_for_this_release(self):
        assets = self.assembled(REQUIRED_BETA)
        report = self.report(REQUIRED_BETA)
        report["version"] = "0.26.0-beta.2"
        with self.assertRaisesRegex(ra.ReleaseError, "another version or channel"):
            ra.build(self.contract, self.version, self.channel, COMMIT, assets, report, {}, DIGEST)

    def test_the_channel_must_agree_with_the_version(self):
        assets = self.assembled(REQUIRED_BETA)
        with self.assertRaisesRegex(ra.ReleaseError, "beta version, not stable"):
            ra.build(self.contract, self.version, "stable", COMMIT, assets, self.report(REQUIRED_BETA), {}, DIGEST)

    def test_checksums_cover_every_published_file_and_match(self):
        assets, _, _ = self.build(REQUIRED_BETA)
        recorded = ra.parse_checksums(os.path.join(assets, "SHA256SUMS"))
        files = set(os.listdir(assets)) - {"SHA256SUMS"}
        self.assertEqual(set(recorded), files)
        for name in files:
            self.assertEqual(recorded[name], ra.sha256_file(os.path.join(assets, name)))

    def test_the_output_is_deterministic(self):
        first, _, inventory = self.build(REQUIRED_BETA)
        snapshot = {n: ra.sha256_file(os.path.join(first, n)) for n in os.listdir(first)}
        shutil.rmtree(first)
        second, _, again = self.build(REQUIRED_BETA)
        self.assertEqual(snapshot, {n: ra.sha256_file(os.path.join(second, n)) for n in os.listdir(second)})
        self.assertEqual(ra.notes(self.contract, inventory), ra.notes(self.contract, again))


class VerifierReport(Fixture):
    """The report tilecast-release-verify writes is the input of `build`. The Go
    test of that command compares its output with this same file."""

    def test_the_golden_report_drives_the_assembly(self):
        golden = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "verify-report.json")
        with open(golden) as handle:
            report = json.load(handle)
        ids = ["edge-x86_64", "edge-aarch64", "android", "windows-aarch64"]
        assets = self.assembled(ids)
        # The Windows build was rejected by the verifier and is optional in a Beta.
        inventory = ra.build(self.contract, self.version, self.channel, COMMIT, assets, report, {}, DIGEST)
        by_id = {c["id"]: c for c in inventory["components"]}
        self.assertEqual([c for c, e in by_id.items() if e["status"] == "available"], ["server", "edge-x86_64", "edge-aarch64", "android"])
        self.assertIn("invalid update manifest signature", by_id["windows-aarch64"]["reason"])
        self.assertFalse([n for n in os.listdir(assets) if "windows" in n])


class Notes(Fixture):
    def test_beta_notes_are_grouped_by_platform(self):
        _, _, inventory = self.build(REQUIRED_BETA, results={"windows-x86_64": "failure"})
        text = ra.notes(self.contract, inventory, "* A change")
        for heading in ("## Server", "## Tilecast Edge (Linux)", "## Windows", "## Android and Fire TV", "## iOS and iPadOS", "## Not included in this release", "## Verify your download", "## What's changed"):
            self.assertIn(heading, text)
        self.assertLess(text.index("## Server"), text.index("## Tilecast Edge (Linux)"))
        self.assertLess(text.index("## Tilecast Edge (Linux)"), text.index("## Windows"))
        self.assertLess(text.index("## Windows"), text.index("## Android and Fire TV"))
        self.assertIn("`ghcr.io/gbyo/tilecast-server:0.26.0-beta.1`", text)
        self.assertIn("`ghcr.io/gbyo/tilecast-server:beta`", text)
        self.assertNotIn("`stable` and `latest`", text)
        self.assertIn("Windows x64**: not included in this release (the build failed)", text)
        self.assertIn("Apple's App Store, not as a GitHub release asset", text)
        self.assertIn("Browser Player is bundled", text)
        self.assertIn("https://github.com/gbyo/tilecast/releases/download/v0.26.0-beta.1/tilecast-player.apk", text)
        self.assertIn("A **Beta** release", text)

    def test_the_server_digest_line_is_the_one_a_resumed_release_reads(self):
        _, _, inventory = self.build(REQUIRED_BETA)
        text = ra.notes(self.contract, inventory)
        self.assertRegex(text, re.compile(r"^- digest: `sha256:[0-9a-f]{64}`$", re.M))

    def test_stable_notes_name_the_stable_aliases(self):
        self.version, self.channel = "0.26.0", "stable"
        _, _, inventory = self.build(ALL)
        text = ra.notes(self.contract, inventory)
        self.assertIn("`stable` and `latest`", text)
        self.assertNotIn("Not included in this release", text)
        self.assertIn("A **Stable** release", text)


class Verify(Fixture):
    def verified(self):
        assets, report, _ = self.build(REQUIRED_BETA)
        return assets, report

    def check(self, assets, report):
        return ra.verify(self.contract, self.version, self.channel, assets, report)

    def test_a_downloaded_draft_that_matches_passes(self):
        assets, report = self.verified()
        self.assertEqual(len(self.check(assets, report)["assets"]), 12 + 3)

    def test_a_changed_asset_is_caught(self):
        assets, report = self.verified()
        write(os.path.join(assets, "tilecast-player.apk"), "someone replaced this")
        with self.assertRaisesRegex(ra.ReleaseError, "tilecast-player.apk does not match the inventory"):
            self.check(assets, report)

    def test_an_extra_and_a_missing_asset_are_caught(self):
        assets, report = self.verified()
        write(os.path.join(assets, "stray.txt"), "x")
        os.remove(os.path.join(assets, "tilecast-player-update.json"))
        with self.assertRaises(ra.ReleaseError) as caught:
            self.check(assets, report)
        self.assertIn("unexpected asset stray.txt", str(caught.exception))
        self.assertIn("missing asset tilecast-player-update.json", str(caught.exception))

    def test_a_checksums_file_that_disagrees_is_caught(self):
        assets, report = self.verified()
        with open(os.path.join(assets, "SHA256SUMS")) as handle:
            lines = handle.read().splitlines()
        lines[0] = "0" * 64 + lines[0][64:]
        write(os.path.join(assets, "SHA256SUMS"), "\n".join(lines) + "\n")
        with self.assertRaisesRegex(ra.ReleaseError, "does not match SHA256SUMS"):
            self.check(assets, report)

    def test_a_build_that_no_longer_verifies_is_caught(self):
        assets, report = self.verified()
        report["components"] = [c for c in report["components"] if c["family"] != "android"]
        report["problems"] = [{"family": "android", "architecture": "", "message": "invalid update manifest signature"}]
        with self.assertRaises(ra.ReleaseError) as caught:
            self.check(assets, report)
        self.assertIn("android does not verify", str(caught.exception))
        self.assertIn("invalid update manifest signature", str(caught.exception))

    def test_a_report_for_another_release_is_caught(self):
        assets, report = self.verified()
        report["version"] = "0.26.0"
        with self.assertRaisesRegex(ra.ReleaseError, "another version or channel"):
            self.check(assets, report)

    def test_a_required_component_the_inventory_marks_unavailable_is_caught(self):
        assets, report = self.verified()
        path = os.path.join(assets, "tilecast-release.json")
        with open(path) as handle:
            inventory = json.load(handle)
        next(c for c in inventory["components"] if c["id"] == "android")["status"] = "unavailable"
        ra.write_json(path, inventory)
        ra.write_checksums(assets)
        with self.assertRaisesRegex(ra.ReleaseError, "required component android is not available"):
            self.check(assets, report)

    def test_a_missing_inventory_is_caught(self):
        assets, report = self.verified()
        os.remove(os.path.join(assets, "tilecast-release.json"))
        with self.assertRaisesRegex(ra.ReleaseError, "tilecast-release.json is missing"):
            self.check(assets, report)


class Resume(Fixture):
    def test_verified_components_are_reused_and_the_rest_rebuilt(self):
        draft = self.path("draft")
        self.make_component(draft, "edge-x86_64")
        self.make_component(draft, "android")
        os.remove(os.path.join(draft, "tilecast-player-update.json.sig"))  # an interrupted upload
        self.make_component(draft, "windows-x86_64")
        report = self.report(["edge-x86_64", "windows-x86_64"], problems=[("windows", "x86_64", "artifact does not match")])
        result = ra.resume(self.contract, self.version, self.channel, draft, report, self.path("reuse"))
        self.assertEqual(result["verified"], ["edge-x86_64"])
        self.assertEqual(sorted(result["pending"]), ["android", "edge-aarch64", "windows-aarch64", "windows-x86_64"])
        self.assertEqual(sorted(os.listdir(self.path("reuse"))), sorted(self.names("edge-x86_64")))

    def test_an_empty_draft_rebuilds_everything(self):
        os.makedirs(self.path("draft"))
        result = ra.resume(self.contract, self.version, self.channel, self.path("draft"), self.report([]), self.path("reuse"))
        self.assertEqual(result["verified"], [])
        self.assertEqual(len(result["pending"]), 5)

    def test_a_verified_component_with_a_missing_file_is_rebuilt(self):
        draft = self.path("draft")
        self.make_component(draft, "android")
        os.remove(os.path.join(draft, "tilecast-player.apk"))
        result = ra.resume(self.contract, self.version, self.channel, draft, self.report(["android"]), self.path("reuse"))
        self.assertIn("android", result["pending"])


class Contract(unittest.TestCase):
    def test_every_component_has_a_group_and_the_required_channels_are_valid(self):
        contract = ra.load_contract()
        for component in contract["components"]:
            self.assertIn(component["group"], contract["groups"])
            self.assertTrue(set(component["required"]) <= {"stable", "beta"})
        for item in contract["external"]:
            self.assertIn(item["group"], contract["groups"])

    def test_the_contract_names_exactly_the_assets_the_server_discovers(self):
        contract = ra.load_contract()
        names = ra.contract_assets(contract, "0.26.0")
        self.assertEqual(len([n for n in names if n.startswith("tilecast-edge-update-")]), 4)
        self.assertEqual(len([n for n in names if n.startswith("tilecast-windows-update-")]), 4)
        self.assertIn("tilecast-player-update.json", names)
        self.assertIn("tilecast-player-update.json.sig", names)
        self.assertNotIn("tilecast-player-update-linux.json", names)

    def test_stable_requires_every_platform_and_beta_makes_windows_optional(self):
        contract = ra.load_contract()
        required = {c: {x["id"] for x in contract["components"] if ra.is_required(x, c)} for c in ("stable", "beta")}
        self.assertEqual(required["stable"], {"server", "edge-x86_64", "edge-aarch64", "windows-x86_64", "windows-aarch64", "android"})
        self.assertEqual(required["beta"], {"server", "edge-x86_64", "edge-aarch64", "android"})


if __name__ == "__main__":
    unittest.main()
