import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


closure = load("runtime_closure")
sbom = load("sbom")
RELEASE = Path(__file__).parent


def make_tree(files):
    """A release tree of fake ELF files: {relative path: bytes}."""
    root = tempfile.mkdtemp()
    for relative, content in files.items():
        path = Path(root, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(closure.ELF_MAGIC + content)
    return root


NEEDS = {
    "bin/tilecast-renderer-wpe": ["libWPEWebKit-2.0.so.1", "libglib-2.0.so.0", "libc.so.6"],
    "bin/tilecast-web-renderer-wpe": ["libWPEWebKit-2.0.so.1", "libglib-2.0.so.0"],
    "lib/wpe/lib/libWPEWebKit-2.0.so.1": ["libwpe-1.0.so.1", "libglib-2.0.so.0", "libsoup-3.0.so.0"],
    "libwpe-real": ["libglib-2.0.so.0", "libxkbcommon.so.0", "libc.so.6"],
}
SYSTEM = {
    "libglib-2.0.so.0": ("/usr/lib/libglib-2.0.so.0", "libglib2.0-0t64"),
    "libsoup-3.0.so.0": ("/usr/lib/libsoup-3.0.so.0", "libsoup-3.0-0"),
    "libxkbcommon.so.0": ("/usr/lib/libxkbcommon.so.0", "libxkbcommon0"),
    "libc.so.6": ("/usr/lib/libc.so.6", "libc6"),
    "libwpe-1.0.so.1": ("/usr/lib/libwpe-real", "libwpe-1.0-1"),
}


def planner(tree, baseline_closure, system=SYSTEM, needs=NEEDS):
    def needed(path):
        relative = os.path.relpath(path, tree) if path.startswith(tree) else os.path.basename(path)
        return needs.get(relative, [])

    libraries = {name: path for name, (path, _) in system.items()}
    owners = {path: package for path, package in system.values()}
    return closure.plan(
        tree, baseline_closure, libraries, owners.get, needed=needed,
        bundled_sonames=closure.bundled_sonames(tree),
    )


class DependencyFieldTests(unittest.TestCase):
    def test_versions_architectures_and_alternatives_are_reduced_to_names(self):
        value = "libc6 (>= 2.38), libglib2.0-0t64:any, libgl1 | libgles2 (>= 1), "
        self.assertEqual(
            closure.parse_dependency_field(value), ["libc6", "libglib2.0-0t64", "libgl1", "libgles2"]
        )
        self.assertEqual(closure.parse_dependency_field(None), [])


class ClosureTests(unittest.TestCase):
    def test_dependencies_virtual_packages_and_alternatives_count(self):
        packages = {
            "libwebkit-base": {"version": "1", "depends": ["libc6", "libgl1", "libmissing", "libglib"], "provides": []},
            "libc6": {"version": "1", "depends": [], "provides": []},
            "libglib": {"version": "1", "depends": ["libc6"], "provides": []},
            "libglvnd0": {"version": "1", "depends": ["libc6"], "provides": ["libgl1"]},
            "unrelated": {"version": "1", "depends": [], "provides": []},
        }
        result = closure.dependency_closure(["libwebkit-base"], packages)
        self.assertEqual(result, {"libwebkit-base", "libc6", "libglib", "libglvnd0"})

    def test_a_baseline_package_the_image_lacks_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "libnothere"):
            closure.dependency_closure(["libnothere"], {"libc6": {"version": "1", "depends": [], "provides": []}})

    def test_the_baseline_file_ignores_comments_and_blank_lines(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write("# comment\nlibc6  # inline\n\nlibglib2.0-0t64\n")
        self.assertEqual(closure.read_baseline(handle.name), ["libc6", "libglib2.0-0t64"])
        os.unlink(handle.name)

    def test_the_shipped_baseline_does_not_provide_libwpe(self):
        names = closure.read_baseline(RELEASE / "system-baseline.txt")
        self.assertNotIn("libwpe-1.0-1", names)
        self.assertEqual(len(names), len(set(names)), "one line per package")
        self.assertIn("libglib2.0-0t64", names)


class PlanTests(unittest.TestCase):
    BASE = {"libc6", "libglib2.0-0t64", "libsoup-3.0-0", "libxkbcommon0"}

    def tree(self):
        return make_tree({name: b"" for name in ("bin/tilecast-renderer-wpe", "bin/tilecast-web-renderer-wpe",
                                                 "lib/wpe/lib/libWPEWebKit-2.0.so.1")})

    def test_libwpe_is_carried_and_base_libraries_are_not(self):
        chosen = planner(self.tree(), self.BASE)
        self.assertEqual(list(chosen), ["libwpe-1.0.so.1"])
        self.assertEqual(chosen["libwpe-1.0.so.1"]["package"], "libwpe-1.0-1")

    def test_a_carried_library_is_scanned_for_its_own_needs(self):
        # libwpe needs libxkbcommon; with it outside the baseline it travels too.
        chosen = planner(self.tree(), self.BASE - {"libxkbcommon0"})
        self.assertEqual(sorted(chosen), ["libwpe-1.0.so.1", "libxkbcommon.so.0"])

    def test_a_library_already_in_the_release_is_not_carried_again(self):
        tree = make_tree({
            "bin/tilecast-renderer-wpe": b"", "lib/wpe/lib/libWPEWebKit-2.0.so.1": b"",
            "lib/wpe/lib/libwpe-1.0.so.1": b"",
        })
        self.assertEqual(planner(tree, self.BASE), {})

    def test_a_library_nothing_provides_fails_the_build(self):
        system = {name: value for name, value in SYSTEM.items() if name != "libwpe-1.0.so.1"}
        with self.assertRaisesRegex(ValueError, r"libWPEWebKit-2\.0\.so\.1 needs libwpe-1\.0\.so\.1"):
            planner(self.tree(), self.BASE, system=system)

    def test_planning_is_deterministic(self):
        tree = self.tree()
        self.assertEqual(planner(tree, self.BASE), planner(tree, self.BASE))


class SbomTests(unittest.TestCase):
    def test_carried_libraries_are_components_marked_as_carried(self):
        tree = tempfile.mkdtemp()
        record = Path(tree, closure.RECORD)
        record.parent.mkdir(parents=True)
        record.write_text(json.dumps({"libraries": [
            {"soname": "libwpe-1.0.so.1", "package": "libwpe-1.0-1", "version": "1.16.2-1", "sha256": "ab"},
            {"soname": "libwpe-extra.so.1", "package": "libwpe-1.0-1", "version": "1.16.2-1", "sha256": "cd"},
        ]}))
        components = sbom.carried_components(tree, "20260920T000000Z")
        self.assertEqual([c["name"] for c in components], ["libwpe-1.0-1"])
        self.assertIn("pkg:deb/debian/libwpe-1.0-1@1.16.2-1", components[0]["purl"])
        self.assertEqual(components[0]["properties"], [{"name": "tilecast:carried", "value": "true"}])

    def test_a_release_without_a_record_has_no_carried_components(self):
        self.assertEqual(sbom.carried_components(tempfile.mkdtemp(), "x"), [])

    def test_a_carried_package_replaces_the_same_builder_package(self):
        tree = tempfile.mkdtemp()
        record = Path(tree, closure.RECORD)
        record.parent.mkdir(parents=True)
        record.write_text(json.dumps({"libraries": [
            {"soname": "libwpe-1.0.so.1", "package": "libwpe-1.0-1", "version": "1.16.2-1", "sha256": "ab"}]}))
        with patch.object(sbom.subprocess, "run") as run, patch.object(sbom.os, "walk", return_value=[]):
            run.return_value.stdout = ""
            components = sbom.debian_components(tree, "20260920T000000Z")
        self.assertEqual([c["name"] for c in components], ["libwpe-1.0-1"])


if __name__ == "__main__":
    unittest.main()
