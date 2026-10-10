import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("stamp_version.py")
GRADLE = """android {
    defaultConfig {
        // Keep versionCode monotonic for signed GitHub releases.
        versionCode = 46
        versionName = "0.25.0"
    }
}
"""


def run(root, *args):
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), *args], capture_output=True, text=True)


class StampVersion(unittest.TestCase):
    def tree(self):
        root = Path(tempfile.mkdtemp())
        for relative, content in {
            "apps/edge/release/VERSION": "0.2.1\n",
            "apps/player-windows/release/VERSION": "0.1.0\n",
            "apps/player-android/app/build.gradle.kts": GRADLE,
        }.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        return root

    def test_stamps_every_product_version_source(self):
        root = self.tree()
        result = run(root, "--version", "0.26.0-beta.1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "apps/edge/release/VERSION").read_text(), "0.26.0-beta.1\n")
        self.assertEqual((root / "apps/player-windows/release/VERSION").read_text(), "0.26.0-beta.1\n")
        gradle = (root / "apps/player-android/app/build.gradle.kts").read_text()
        self.assertIn("versionCode = 2600001", gradle)
        self.assertIn('versionName = "0.26.0-beta.1"', gradle)
        self.assertIn("// Keep versionCode monotonic", gradle)

    def test_stamping_is_idempotent_and_check_detects_drift(self):
        root = self.tree()
        self.assertNotEqual(run(root, "--version", "0.26.0", "--check").returncode, 0)
        self.assertEqual(run(root, "--version", "0.26.0").returncode, 0)
        self.assertEqual(run(root, "--version", "0.26.0", "--check").returncode, 0)
        self.assertEqual(run(root, "--version", "0.26.0").returncode, 0)
        self.assertIn("versionCode = 2600099", (root / "apps/player-android/app/build.gradle.kts").read_text())
        # A different version is drift against the stamped tree.
        self.assertNotEqual(run(root, "--version", "0.26.1", "--check").returncode, 0)

    def test_refuses_versions_that_are_not_coordinated_releases(self):
        root = self.tree()
        for version in ("0.25.0", "0.26.0-rc.1", "v0.26.0", "21.0.0", "0.26"):
            result = run(root, "--version", version)
            self.assertNotEqual(result.returncode, 0, version)
        self.assertEqual((root / "apps/edge/release/VERSION").read_text(), "0.2.1\n")

    def test_refuses_a_gradle_file_it_cannot_stamp(self):
        root = self.tree()
        (root / "apps/player-android/app/build.gradle.kts").write_text('versionName = "0.25.0"\n')
        result = run(root, "--version", "0.26.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("versionCode", result.stderr)
        self.assertEqual((root / "apps/edge/release/VERSION").read_text(), "0.2.1\n")

    def test_the_bridge_stamps_only_edge_and_only_with_a_legacy_compatible_version(self):
        root = self.tree()
        result = run(root, "--version", "0.2.2", "--edge-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "apps/edge/release/VERSION").read_text(), "0.2.2\n")
        self.assertEqual((root / "apps/player-windows/release/VERSION").read_text(), "0.1.0\n")
        self.assertIn('versionName = "0.25.0"', (root / "apps/player-android/app/build.gradle.kts").read_text())
        self.assertEqual(run(root, "--version", "0.2.2", "--edge-only", "--check").returncode, 0)
        # A unified version is not a bridge: it stamps every platform, or nothing.
        for version in ("0.26.0", "0.26.0-beta.1", "1.0.0", "0.2", "v0.2.2", "0.2.2-"):
            self.assertNotEqual(run(root, "--version", version, "--edge-only").returncode, 0, version)
        self.assertEqual((root / "apps/edge/release/VERSION").read_text(), "0.2.2\n")

    def test_a_legacy_version_is_still_not_a_coordinated_release(self):
        root = self.tree()
        self.assertNotEqual(run(root, "--version", "0.2.2").returncode, 0)


if __name__ == "__main__":
    unittest.main()
