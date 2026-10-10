import json
import unittest
from pathlib import Path

import release_version as rv

CORPUS = json.loads(
    (Path(__file__).resolve().parents[2] / "packages/player-contracts/fixtures/release-versions.json").read_text()
)


class SharedCorpus(unittest.TestCase):
    def test_constants_match_the_corpus(self):
        self.assertEqual(rv.CUTOVER_CORE_CODE, CORPUS["cutoverCoreCode"])
        self.assertEqual(rv.MAXIMUM_CODE, CORPUS["maximumCode"])

    def test_codes(self):
        for case in CORPUS["codes"]:
            self.assertEqual(rv.version_code(case["name"]), case["code"], case["name"])

    def test_invalid_names(self):
        for name in CORPUS["invalid"]:
            self.assertIsNone(rv.version_code(name), repr(name))

    def test_channels(self):
        for case in CORPUS["channels"]:
            self.assertEqual(rv.version_channel(case["name"]), case["channel"], case["name"])

    def test_codes_strictly_increase_in_release_order(self):
        codes = [rv.version_code(name) for name in CORPUS["ordered"]]
        self.assertEqual(codes, sorted(set(codes)))


class Ordering(unittest.TestCase):
    def test_beta_to_beta_to_stable_to_next(self):
        sequence = ["0.26.0-beta.1", "0.26.0-beta.2", "0.26.0", "0.26.1-beta.1", "0.26.1", "0.27.0-beta.1"]
        for earlier, later in zip(sequence, sequence[1:]):
            self.assertEqual(rv.compare(earlier, later), -1, f"{earlier} -> {later}")
            self.assertEqual(rv.compare(later, earlier), 1)
        self.assertEqual(rv.compare("0.26.0", "0.26.0"), 0)

    def test_every_unified_code_exceeds_every_shipped_code(self):
        shipped = ["0.25.0", "0.17.0", "0.2.1-preview.1", "0.25.999"]
        first = rv.version_code("0.26.0-beta.1")
        for name in shipped:
            self.assertLess(rv.version_code(name), first, name)
        # The Android versionCode that shipped with 0.25.0.
        self.assertLess(46, first)

    def test_a_shipped_prerelease_has_no_implied_channel(self):
        self.assertIsNone(rv.version_channel("0.2.1-preview.1"))

    def test_compare_refuses_invalid_names(self):
        with self.assertRaises(ValueError):
            rv.compare("0.26.0", "0.26.0-rc.1")


class Tags(unittest.TestCase):
    def test_stable_and_beta_tags(self):
        stable = rv.parse_tag("v0.26.0")
        self.assertEqual((stable.name, stable.channel, stable.code), ("0.26.0", "stable", 2600099))
        beta = rv.parse_tag("v0.26.0-beta.3")
        self.assertEqual((beta.name, beta.channel, beta.code), ("0.26.0-beta.3", "beta", 2600003))

    def test_rejected_tags(self):
        for tag in [
            "",
            None,
            "0.26.0",
            "v0.26",
            "v0.25.0",  # below the cutover: not a coordinated release
            "v0.26.0-beta",
            "v0.26.0-beta.0",
            "v0.26.0-beta.99",
            "v0.26.0-beta.01",
            "v0.26.0-rc.1",
            "v21.0.0",
            "v0.26.0 ",
            "player-v0.26.0",
            "server-v0.26.0",
            "edge-v0.26.0",
            "refs/tags/v0.26.0",
        ]:
            with self.assertRaises(ValueError, msg=repr(tag)):
                rv.parse_tag(tag)


if __name__ == "__main__":
    unittest.main()
