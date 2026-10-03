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
