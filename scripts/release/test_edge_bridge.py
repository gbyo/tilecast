import json
import os
import shutil
import tempfile
import unittest

import edge_bridge as eb
import release_assemble as ra

SHIPPED = [
    {"tagName": "edge-v0.1.0-preview.1", "isDraft": False},
    {"tagName": "edge-v0.2.0-preview.2", "isDraft": False},
    {"tagName": "edge-v0.2.1-preview.1", "isDraft": False},
    {"tagName": "player-v0.25.0", "isDraft": False},
]


class Identity(unittest.TestCase):
    def test_the_next_preview_version_is_a_valid_bridge(self):
        result = eb.identity("0.2.2", 1, SHIPPED)
        self.assertEqual(result, {"tag": "edge-v0.2.2-preview.1", "version": "0.2.2", "code": 2002, "channel": "beta", "prerelease": "true"})

    def test_a_unified_version_is_not_a_bridge(self):
        for version in ("0.26.0", "0.26.0-beta.1", "0.27.0", "1.0.0"):
            with self.assertRaisesRegex(eb.BridgeError, "not a bridge version"):
                eb.identity(version, 1, SHIPPED)

    def test_a_malformed_version_is_refused(self):
        for version in ("0.2", "v0.2.2", "0.2.2-", "0.2.2 ", "", "latest", "0.2.2+build"):
            with self.assertRaises(eb.BridgeError, msg=version):
                eb.identity(version, 1, SHIPPED)

    def test_a_version_that_is_not_newer_than_the_shipped_previews_is_refused(self):
        for version in ("0.2.1", "0.2.0", "0.1.9", "0.0.1"):
            with self.assertRaisesRegex(eb.BridgeError, "must be newer"):
                eb.identity(version, 1, SHIPPED)

    def test_the_shipped_floor_applies_even_when_the_release_list_is_short(self):
        with self.assertRaisesRegex(eb.BridgeError, "must be newer"):
            eb.identity("0.2.1", 1, [])
        self.assertEqual(eb.identity("0.2.2", 1, [])["code"], 2002)

    def test_a_later_bridge_must_still_be_newer_than_an_earlier_one(self):
        releases = SHIPPED + [{"tagName": "edge-v0.2.2-preview.1", "isDraft": False}]
        with self.assertRaisesRegex(eb.BridgeError, "must be newer"):
            eb.identity("0.2.2", 2, releases)
        self.assertEqual(eb.identity("0.2.3", 1, releases)["tag"], "edge-v0.2.3-preview.1")

    def test_a_tag_is_never_reused_even_by_a_draft(self):
        releases = SHIPPED + [{"tagName": "edge-v0.2.3-preview.1", "isDraft": True}]
        with self.assertRaises(eb.BridgeError):
            eb.identity("0.2.3", 1, releases)

    def test_every_version_the_bridge_may_take_is_below_every_unified_release(self):
        self.assertLess(eb.identity("0.25.999", 1, SHIPPED)["code"], ra.rv.version_code("0.26.0-beta.1"))


class Assets(unittest.TestCase):
    version = "0.2.2"

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.contract = ra.load_contract()

    def write(self, directory, name, content="x"):
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, name), "w") as handle:
            handle.write(content)

    def build_artifacts(self):
        for arch in eb.ARCHES:
            directory = os.path.join(self.root, "artifacts", arch)
            for name in eb.asset_names(self.contract, self.version):
                if arch in name:
                    self.write(directory, name, f"{arch} {name}")

    def test_the_bridge_carries_exactly_the_edge_files_of_both_architectures(self):
        names = eb.asset_names(self.contract, self.version)
        self.assertEqual(len(names), 12)
        self.assertIn("tilecast-edge-0.2.2-x86_64.tar.zst", names)
        self.assertIn("tilecast-edge-update-aarch64.json.sig", names)
        self.assertFalse([n for n in names if "windows" in n or n.endswith(".apk")])

    def test_collect_gathers_both_architectures_and_writes_the_checksums(self):
        self.build_artifacts()
        sources = [os.path.join(self.root, "artifacts", a) for a in eb.ARCHES]
        names = eb.collect(self.contract, self.version, sources, os.path.join(self.root, "out"))
        self.assertEqual(len(names), 12)
        self.assertIn("SHA256SUMS", os.listdir(os.path.join(self.root, "out")))

    def test_collect_refuses_a_missing_architecture_and_a_stray_release_file(self):
        self.build_artifacts()
        shutil.rmtree(os.path.join(self.root, "artifacts", "aarch64"))
        with self.assertRaisesRegex(eb.BridgeError, "lack"):
            eb.collect(self.contract, self.version, [os.path.join(self.root, "artifacts", "x86_64")], os.path.join(self.root, "out"))
        self.build_artifacts()
        self.write(os.path.join(self.root, "artifacts", "x86_64"), "tilecast-windows-0.2.2-x86_64.msix")
        with self.assertRaisesRegex(eb.BridgeError, "not part of a bridge release"):
            eb.collect(self.contract, self.version, [os.path.join(self.root, "artifacts", a) for a in eb.ARCHES], os.path.join(self.root, "out2"))

    def test_collect_refuses_two_builds_of_one_file_that_differ(self):
        self.build_artifacts()
        self.write(os.path.join(self.root, "artifacts", "x86_64"), "tilecast-edge-update-aarch64.json", "another")
        with self.assertRaisesRegex(eb.BridgeError, "differs"):
            eb.collect(self.contract, self.version, [os.path.join(self.root, "artifacts", a) for a in eb.ARCHES], os.path.join(self.root, "out"))

    def report(self, **changes):
        components = [{"family": "edge", "architecture": a, "versionName": self.version, "versionCode": 2002, "channel": "beta"} for a in eb.ARCHES]
        return {"components": components, "problems": [], **changes}

    def verified(self, report):
        self.build_artifacts()
        out = os.path.join(self.root, "out")
        sources = [os.path.join(self.root, "artifacts", a) for a in eb.ARCHES]
        eb.collect(self.contract, self.version, sources, out)
        return out, lambda *args: report

    def test_verify_accepts_what_the_importer_accepts(self):
        out, runner = self.verified(self.report())
        self.assertEqual(len(eb.verify(self.contract, self.version, out, "key", "verifier", runner)["components"]), 2)

    def test_verify_requires_both_architectures_and_the_right_identity(self):
        out, _ = self.verified(self.report())
        one = self.report(components=self.report()["components"][:1])
        with self.assertRaisesRegex(eb.BridgeError, "does not verify"):
            eb.verify(self.contract, self.version, out, "key", "v", lambda *a: one)
        wrong = self.report()
        wrong["components"][0]["versionCode"] = 26000
        with self.assertRaisesRegex(eb.BridgeError, "26000"):
            eb.verify(self.contract, self.version, out, "key", "v", lambda *a: wrong)
        stable = self.report()
        stable["components"][1]["channel"] = "stable"
        with self.assertRaisesRegex(eb.BridgeError, "stable"):
            eb.verify(self.contract, self.version, out, "key", "v", lambda *a: stable)

    def test_verify_reports_every_importer_problem(self):
        out, _ = self.verified(self.report())
        bad = self.report(problems=[{"family": "edge", "architecture": "x86_64", "message": "the signature does not verify"}])
        with self.assertRaisesRegex(eb.BridgeError, "signature does not verify"):
            eb.verify(self.contract, self.version, out, "key", "v", lambda *a: bad)

    def test_verify_refuses_an_extra_a_missing_or_an_altered_file(self):
        out, runner = self.verified(self.report())
        self.write(out, "tilecast-windows-0.2.2-x86_64.msix")
        with self.assertRaisesRegex(eb.BridgeError, "unexpected asset"):
            eb.verify(self.contract, self.version, out, "key", "v", runner)
        os.remove(os.path.join(out, "tilecast-windows-0.2.2-x86_64.msix"))
        self.write(out, "tilecast-edge-0.2.2-x86_64.tar.zst", "altered after the checksums")
        with self.assertRaisesRegex(eb.BridgeError, "does not match SHA256SUMS"):
            eb.verify(self.contract, self.version, out, "key", "v", runner)
        os.remove(os.path.join(out, "tilecast-edge-0.2.2-aarch64.json"))
        with self.assertRaisesRegex(eb.BridgeError, "missing asset"):
            eb.verify(self.contract, self.version, out, "key", "v", runner)

    def test_verify_refuses_a_unified_version(self):
        out, runner = self.verified(self.report())
        with self.assertRaisesRegex(eb.BridgeError, "not a bridge version"):
            eb.verify(self.contract, "0.26.0", out, "key", "v", runner)

    def test_arrange_lays_out_the_preview_and_the_bridge_for_the_oracle(self):
        base = os.path.join(self.root, "base")
        for name in ("tilecast-edge-update-x86_64.json", "tilecast-edge-update-x86_64.json.sig", "tilecast-edge-0.2.1-x86_64.tar.zst"):
            self.write(base, name, "preview " + name)
        self.build_artifacts()
        out = os.path.join(self.root, "out")
        eb.collect(self.contract, self.version, [os.path.join(self.root, "artifacts", a) for a in eb.ARCHES], out)
        eb.arrange(self.contract, self.version, out, base, "x86_64", os.path.join(self.root, "oracle"))
        for label in ("base", "bridge"):
            self.assertEqual(sorted(os.listdir(os.path.join(self.root, "oracle", label))), ["archive.tar.zst", "update.json", "update.json.sig"])
        with open(os.path.join(self.root, "oracle", "base", "archive.tar.zst")) as handle:
            self.assertTrue(handle.read().startswith("preview"))

    def test_the_notes_tell_an_operator_what_this_release_is_for(self):
        text = eb.notes("0.2.2", "edge-v0.2.2-preview.1")
        self.assertIn("0.2.1 or older", text)
        self.assertIn("code `2002`", text)
        self.assertIn("Do not install it on a screen that already runs a unified release", text)
        self.assertIn("edge-v0.2.2-preview.1", text)


if __name__ == "__main__":
    unittest.main()
