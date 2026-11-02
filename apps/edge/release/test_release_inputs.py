import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sbom = load("sbom")
inputs = load("inputs")
BINARIES = ["tilecastd", "tilecastctl", "tilecast-edge-migrate", "tilecast-edge-update"]


def build_fixture():
    packages = [{"id": f"path+file:///edge/{name}#0.1.0", "name": name, "version": "0.1.0"} for name in BINARIES]
    # Two versions must retain their own checksum; unrelated future-host and
    # dev-only packages may coexist in the one root lockfile.
    for name, version in [("shared-library", "1.0.0"), ("shared-library", "2.0.0"), ("future-host", "9.0.0"), ("test-only", "1.0.0")]:
        packages.append({"id": f"registry+https://registry.example/index#{name}@{version}",
                         "name": name, "version": version, "source": "registry+https://registry.example/index"})
    lock = {"package": [dict(p, checksum=str(i) * 64) if p.get("source") else dict(p)
                        for i, p in enumerate(packages)]}
    artifacts = [{"reason": "compiler-artifact", "package_id": p["id"],
                  "executable": f"/target/release/{p['name']}" if p["name"] in BINARIES else None,
                  "target": {"kind": ["bin" if p["name"] in BINARIES else "lib"]}, "fresh": True}
                 for p in packages[:6]]
    artifacts.append({"reason": "build-finished", "success": True})
    return artifacts, {"packages": packages}, lock


class SbomTests(unittest.TestCase):
    def test_only_actual_build_packages_are_included_even_for_cached_builds(self):
        artifacts, metadata, lock = build_fixture()
        components = sbom.built_cargo_components(artifacts, metadata, lock)
        self.assertEqual(len(components), 6)
        self.assertEqual({p["name"] for p in components}, {*BINARIES, "shared-library"})
        versions = [p for p in components if p["name"] == "shared-library"]
        self.assertEqual([p["version"] for p in versions], ["1.0.0", "2.0.0"])
        self.assertEqual([p["hashes"][0]["content"] for p in versions], ["4" * 64, "5" * 64])
        self.assertEqual(components, sbom.built_cargo_components(list(reversed(artifacts)), metadata, lock))

    def test_empty_failed_unknown_and_incomplete_builds_fail_closed(self):
        artifacts, metadata, lock = build_fixture()
        failed = copy.deepcopy(artifacts)
        failed[-1]["success"] = False
        unknown = copy.deepcopy(artifacts)
        unknown[0]["package_id"] = "unknown"
        for invalid in [[], failed, unknown, artifacts[1:]]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                sbom.built_cargo_components(invalid, metadata, lock)

    def test_a_second_product_binary_is_refused(self):
        artifacts, metadata, lock = build_fixture()
        artifacts.insert(0, {"reason": "compiler-artifact", "package_id": metadata["packages"][6]["id"],
                             "executable": "/target/release/future-host", "target": {"kind": ["bin"]}})
        with self.assertRaises(ValueError):
            sbom.built_cargo_components(artifacts, metadata, lock)

    def test_missing_lock_entry_is_refused(self):
        artifacts, metadata, lock = build_fixture()
        lock["package"] = lock["package"][1:]
        with self.assertRaises(KeyError):
            sbom.built_cargo_components(artifacts, metadata, lock)


class InputTests(unittest.TestCase):
    def test_product_version_comes_from_edge_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_file = root / "apps/edge/release/VERSION"
            version_file.parent.mkdir(parents=True)
            version_file.write_text("2.3.4\n")
            with patch.object(inputs, "ROOT", root):
                self.assertEqual(inputs.version(), "2.3.4")
                version_file.write_text("2.3.4\n9.9.9\n")
                with self.assertRaises(ValueError):
                    inputs.version()

    def test_schema_lookup_follows_state_manifest_before_and_after_extraction(self):
        for name in ["edge-state", "player-state"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = root / "relocated" / name
                migrations = state / "migrations"
                migrations.mkdir(parents=True)
                for file in ["0001_initial.sql", "0007_last.sql", "README.md"]:
                    (migrations / file).write_text("")
                metadata = {"packages": [{"name": name, "manifest_path": str(state / "Cargo.toml")}]}
                with patch.object(inputs.subprocess, "check_output", return_value=json.dumps(metadata)):
                    self.assertEqual(inputs.state_schema(), 7)

    def test_wpe_key_ignores_comments_and_whitespace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "apps/edge/release"
            release.mkdir(parents=True)
            (release / "Dockerfile.builder").write_text("FROM example@sha256:abc\nRUN apt-get install -y foo \\\n    bar\n")
            (release / "build-wpe.sh").write_text("WPE_VERSION=2.54.0\ncmake --build /work/build\n")
            with patch.object(inputs, "ROOT", root):
                before = inputs.wpe_key()
                (release / "Dockerfile.builder").write_text(
                    "# a comment\n\nFROM example@sha256:abc\n\n# another\nRUN apt-get install -y foo \\\n        bar\n")
                (release / "build-wpe.sh").write_text("\n# header\nWPE_VERSION=2.54.0\ncmake --build /work/build\n")
                self.assertEqual(inputs.wpe_key(), before)

    def test_wpe_key_moves_on_real_input_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "apps/edge/release"
            release.mkdir(parents=True)
            docker = release / "Dockerfile.builder"
            wpe = release / "build-wpe.sh"
            docker.write_text("FROM example@sha256:abc\n")
            wpe.write_text("WPE_VERSION=2.54.0\n-DENABLE_FOO=ON\n")
            with patch.object(inputs, "ROOT", root):
                before = inputs.wpe_key()
                wpe.write_text("WPE_VERSION=2.54.1\n-DENABLE_FOO=ON\n")
                self.assertNotEqual(inputs.wpe_key(), before)
                wpe.write_text("WPE_VERSION=2.54.0\n-DENABLE_FOO=OFF\n")
                self.assertNotEqual(inputs.wpe_key(), before)
                wpe.write_text("WPE_VERSION=2.54.0\n-DENABLE_FOO=ON\n")
                docker.write_text("FROM example@sha256:def\n")
                self.assertNotEqual(inputs.wpe_key(), before)

    def test_wpe_tag_and_tar_bind_version_key_and_arch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "apps/edge/release"
            release.mkdir(parents=True)
            (release / "Dockerfile.builder").write_text("FROM example@sha256:abc\n")
            (release / "build-wpe.sh").write_text("WPE_VERSION=2.54.0\n")
            with patch.object(inputs, "ROOT", root):
                self.assertEqual(inputs.wpe_version(), "2.54.0")
                key = inputs.wpe_key()
                self.assertRegex(key, r"^[0-9a-f]{16}$")
                self.assertEqual(inputs.wpe_tag("x86_64"), f"wpe-2.54.0-{key}-x86_64")
                self.assertEqual(inputs.wpe_tar("aarch64"), f"wpe-2.54.0-{key}-aarch64.tar")
                # The registry tag is the legacy release tag without its "wpe-"
                # prefix, so every published prebuild maps to exactly one tag.
                self.assertEqual(inputs.wpe_ref("x86_64"), f"ghcr.io/gbyo/tilecast-wpe:2.54.0-{key}-x86_64")
                self.assertEqual(inputs.wpe_ref("aarch64").split(":", 1)[1], inputs.wpe_tag("aarch64")[len("wpe-"):])
                for bad in ["x64", "arm64", "x86_64;evil", ""]:
                    with self.subTest(bad=bad), self.assertRaises(ValueError):
                        inputs.wpe_tag(bad)
                    with self.subTest(bad=bad), self.assertRaises(ValueError):
                        inputs.wpe_tar(bad)
                    with self.subTest(bad=bad), self.assertRaises(ValueError):
                        inputs.wpe_ref(bad)

    def test_wpe_version_parsing_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "apps/edge/release"
            release.mkdir(parents=True)
            (release / "Dockerfile.builder").write_text("FROM example@sha256:abc\n")
            script = release / "build-wpe.sh"
            with patch.object(inputs, "ROOT", root):
                for body in ["WPE_VERSION=\n", "WPE_VERSION=2.54.0\nWPE_VERSION=2.54.0\n",
                             "# WPE_VERSION=2.54.0\n", "WPE_VERSION=2.54.0 # pinned\n"]:
                    with self.subTest(body=body):
                        script.write_text(body)
                        with self.assertRaises(ValueError):
                            inputs.wpe_version()

    def test_schema_lookup_ignores_edge_repository_adapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "player-state"
            (state / "migrations").mkdir(parents=True)
            (state / "migrations/0007_last.sql").write_text("")
            # An empty old directory can remain after moving tracked files.
            (root / "edge-state/migrations").mkdir(parents=True)
            metadata = {"packages": [
                {"name": "edge-state", "manifest_path": str(root / "edge-state/Cargo.toml")},
                {"name": "player-state", "manifest_path": str(state / "Cargo.toml")},
            ]}
            with patch.object(inputs.subprocess, "check_output", return_value=json.dumps(metadata)):
                self.assertEqual(inputs.state_schema(), 7)


if __name__ == "__main__":
    unittest.main()


class ReleaseVersionNumbering(unittest.TestCase):
    """The release scripts derive the same update version code as the server,
    Edge, and the Windows Player (scripts/release/release_version.py)."""

    @classmethod
    def setUpClass(cls):
        cls.stage = load("stage-release")
        cls.envelope = load("envelope")

    def test_stage_release_uses_the_shared_ordering(self):
        self.assertEqual(self.stage.version_code("0.2.1-preview.1"), 2001)
        self.assertEqual(self.stage.version_code("0.26.0-beta.1"), 2600001)
        self.assertEqual(self.stage.version_code("0.26.0"), 2600099)

    def test_stage_release_refuses_a_name_the_ordering_does_not_define(self):
        for name in ("0.26.0-rc.1", "1.2.3-hotfix", "21.0.0"):
            with self.assertRaises(SystemExit, msg=name):
                self.stage.version_code(name)
