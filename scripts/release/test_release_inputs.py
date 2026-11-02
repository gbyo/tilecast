"""The build-input rules (release_inputs.py and the contract's `reuse` block).

Reuse is only safe if a component's exclusion list names nothing the component
is built from. These tests read what each build really consumes (the Cargo
dependency graph, the Dockerfile, the Go module replacements, the npm workspace
graph, the Gradle build, and the build workflows' own scripts) and fail when an
exclusion would hide an input. A rule that is too broad only costs a rebuild;
one that is too narrow would ship a stale binary, so the checks run one way.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

import release_assemble as ra
import release_inputs as ri

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

BUILD_WORKFLOW = {
    "server": ".github/workflows/server-release.yml",
    "edge": ".github/workflows/edge-release.yml",
    "windows": ".github/workflows/windows-player-release.yml",
    "android": ".github/workflows/player-release.yml",
}


def tracked():
    out = subprocess.run(["git", "-C", ROOT, "ls-files", "-z"], capture_output=True, check=True).stdout
    return [p for p in out.decode().split("\0") if p and os.path.exists(os.path.join(ROOT, p))]


def load(path):
    with open(path) as handle:
        return json.load(handle)


def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


# The build workflows also run steps that are not part of building the
# component. Moving the Server image aliases changes tags, never image bytes.
NOT_BUILD_STEPS = {"scripts/release/promote-server-aliases.sh"}


class Support:
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.contract = ra.load_contract()
        cls.files = tracked()
        cls.profiles = {c["inputs"]: c for c in cls.contract["components"]}

    def rules(self, profile):
        return ri.rules_for(self.contract, self.profiles[profile])

    def counted(self, profile, path):
        return ri.counts(path, self.rules(profile))


class Rules(Support, unittest.TestCase):
    def test_every_component_names_a_profile(self):
        for component in self.contract["components"]:
            self.assertIn(component["inputs"], self.contract["reuse"]["profiles"], component["id"])

    def test_a_pattern_that_matches_nothing_is_stale(self):
        reuse = self.contract["reuse"]
        patterns = reuse["exclude"] + reuse["keep"]
        for profile in reuse["profiles"].values():
            patterns += profile["exclude"] + profile["keep"]
        for pattern in patterns:
            expression = ri._pattern(pattern)
            self.assertTrue(any(expression.fullmatch(p) for p in self.files), f"{pattern} matches no tracked file")

    def test_matching_rules(self):
        rules = ri.rules_for(self.contract, self.profiles["windows"])
        for path, expected in {
            "apps/player-windows/src/main.rs": True,
            "apps/edge/tilecastd/main.rs": False,
            "crates/player-core/lib.rs": True,
            "docs/guide.md": False,
            "README.md": False,
            "packages/x/README.md": True,
            "apps/player-windows/AGENTS.md": False,
            "AGENTS.md": False,
            "scripts/ci/check.mjs": False,
            "scripts/release/release_assemble.py": False,
            "scripts/release/stamp_version.py": True,
            "scripts/build-player-release.sh": True,
            ".github/workflows/windows-player-release.yml": True,
            ".github/workflows/ci-windows.yml": False,
            "Cargo.lock": True,
            "brand-new/file.txt": True,
        }.items():
            self.assertEqual(ri.counts(path, rules), expected, path)

    def test_the_stamping_scripts_are_an_input_of_every_component(self):
        for profile in self.profiles:
            for path in ("scripts/release/stamp_version.py", "scripts/release/release_version.py"):
                self.assertTrue(self.counted(profile, path), f"{profile}: {path}")

    def test_each_component_counts_its_own_build_workflow_and_the_coordinator_is_not_an_input(self):
        for profile, workflow in BUILD_WORKFLOW.items():
            self.assertTrue(self.counted(profile, workflow), profile)
            self.assertFalse(self.counted(profile, ".github/workflows/release.yml"), profile)

    def test_the_release_workflow_calls_the_build_workflow_each_profile_keeps(self):
        text = read(".github/workflows/release.yml")
        for workflow in BUILD_WORKFLOW.values():
            self.assertIn("uses: ./" + workflow, text)

    def test_what_each_build_workflow_runs_is_an_input_of_its_component(self):
        pattern = re.compile(r"(?<![\w/.-])((?:apps|scripts|packages|crates|deploy|plugins|widgets|data-sources)/[A-Za-z0-9_./-]*[A-Za-z0-9_])")
        for profile, workflow in BUILD_WORKFLOW.items():
            for match in sorted(set(pattern.findall(read(workflow)))):
                if match in NOT_BUILD_STEPS or not os.path.exists(os.path.join(ROOT, match)):
                    continue
                self.assertTrue(self.counted(profile, match), f"{workflow} uses {match}, which {profile} excludes")


@unittest.skipUnless(shutil.which("cargo"), "cargo is required")
class RustGraph(Support, unittest.TestCase):
    """A Rust player's dependency closure must not be excluded."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        out = subprocess.run(
            ["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
        cls.packages = {}
        for package in json.loads(out)["packages"]:
            directory = os.path.relpath(os.path.dirname(package["manifest_path"]), ROOT)
            cls.packages[package["name"]] = (directory, [d["name"] for d in package["dependencies"] if d.get("path")])

    def closure(self, roots):
        seen, queue = {}, list(roots)
        while queue:
            name = queue.pop()
            if name in seen:
                continue
            seen[name] = self.packages[name][0]
            queue.extend(self.packages[name][1])
        return seen

    def roots_in(self, directory):
        return [name for name, (where, _) in self.packages.items() if where == directory or where.startswith(directory + "/")]

    def check(self, profile, roots):
        for name, directory in self.closure(roots).items():
            self.assertTrue(self.counted(profile, directory + "/Cargo.toml"), f"{profile} excludes {directory}, which {name} needs")
        for path in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml"):
            if os.path.exists(os.path.join(ROOT, path)):
                self.assertTrue(self.counted(profile, path), f"{profile} excludes {path}")

    def test_edge(self):
        roots = self.roots_in("apps/edge")
        self.assertIn("tilecastd", roots)
        self.check("edge", roots)

    def test_windows(self):
        roots = self.roots_in("apps/player-windows")
        self.assertTrue(roots)
        self.check("windows", roots)

    def test_android(self):
        roots = self.roots_in("apps/player-android")
        self.assertTrue(roots)
        self.check("android", roots)


class OtherGraphs(Support, unittest.TestCase):
    def test_every_source_the_server_dockerfile_copies_counts(self):
        for line in read("deploy/docker/Dockerfile").splitlines():
            parts = line.split()
            if not parts or parts[0] != "COPY" or any(p.startswith("--from") for p in parts):
                continue
            sources = [p for p in parts[1:-1] if not p.startswith("--")]
            for source in sources:
                prefix = re.split(r"[*?\[]", source)[0].rstrip("/")
                probe = prefix if os.path.isfile(os.path.join(ROOT, prefix)) else prefix + "/x"
                self.assertTrue(self.counted("server", probe), f"the Dockerfile copies {source}, which the server excludes")

    def test_every_go_module_the_server_replaces_counts(self):
        for match in re.finditer(r"=>\s+(\.\.?/[^\s]+)", read("apps/server/go.mod")):
            target = os.path.normpath(os.path.join("apps/server", match.group(1)))
            self.assertTrue(self.counted("server", target + "/go.mod"), f"the server module replaces {target}")

    def workspaces(self):
        names = {}
        for pattern in json.loads(read("package.json")).get("workspaces", []):
            base = pattern.rstrip("*").rstrip("/")
            for entry in sorted(os.listdir(os.path.join(ROOT, base))) if pattern.endswith("*") else [""]:
                directory = os.path.join(base, entry).rstrip("/")
                manifest = os.path.join(ROOT, directory, "package.json")
                if os.path.isfile(manifest):
                    names[load(manifest)["name"]] = directory
        return names

    def closure(self, roots):
        names = self.workspaces()
        seen, queue = set(), list(roots)
        while queue:
            directory = queue.pop()
            if directory in seen:
                continue
            seen.add(directory)
            manifest = load(os.path.join(ROOT, directory, "package.json"))
            for group in ("dependencies", "devDependencies", "peerDependencies"):
                for name in manifest.get(group, {}):
                    if name in names:
                        queue.append(names[name])
        return seen

    def test_the_npm_workspaces_a_build_uses_count(self):
        roots = {
            "server": ["apps/dashboard", "apps/player-web"],
            "edge": ["packages/player-runtime"],
            "windows": ["packages/player-runtime"],
            "android": ["packages/player-runtime"],
        }
        for profile, directories in roots.items():
            for directory in sorted(self.closure(directories)):
                self.assertTrue(self.counted(profile, directory + "/package.json"), f"{profile} excludes {directory}")
            for path in ("package.json", "package-lock.json"):
                self.assertTrue(self.counted(profile, path), f"{profile} excludes {path}")

    def test_the_android_gradle_build_reads_only_counted_paths(self):
        for path in ("apps/player-android/app/build.gradle.kts", "apps/player-android/settings.gradle.kts", "apps/player-android/build.gradle.kts"):
            if not os.path.exists(os.path.join(ROOT, path)):
                continue
            for match in re.finditer(r"\.\./\.\./\.\./([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)", read(path)):
                self.assertTrue(self.counted("android", match.group(1) + "/x"), f"{path} reads {match.group(1)}")


class Fingerprints(unittest.TestCase):
    def test_a_fingerprint_is_deterministic_and_covers_the_contract_entry(self):
        contract = ra.load_contract()
        component = contract["components"][1]
        files = {"apps/edge/x.rs": "100644:aaa", "docs/a.md": "100644:bbb"}
        first = ri.fingerprint(contract, component, files)
        self.assertEqual(first, ri.fingerprint(contract, component, dict(reversed(list(files.items())))))
        changed = dict(component, assets=component["assets"][:-1])
        self.assertNotEqual(first["digest"], ri.fingerprint(contract, changed, files)["digest"])

    def test_an_excluded_file_does_not_change_the_fingerprint_and_an_included_one_does(self):
        contract = ra.load_contract()
        component = next(c for c in contract["components"] if c["id"] == "windows-x86_64")
        files = {"apps/player-windows/x.rs": "100644:aaa", "apps/edge/y.rs": "100644:bbb"}
        base = ri.fingerprint(contract, component, files)
        self.assertEqual(base["digest"], ri.fingerprint(contract, component, dict(files, **{"apps/edge/y.rs": "100644:ccc"}))["digest"])
        moved = ri.fingerprint(contract, component, dict(files, **{"apps/player-windows/x.rs": "100644:ccc"}))
        self.assertNotEqual(base["digest"], moved["digest"])
        self.assertEqual(ri.differences(base, moved), ["apps/player-windows"])

    def test_a_missing_fingerprint_is_a_difference(self):
        contract = ra.load_contract()
        current = ri.fingerprint(contract, contract["components"][0], {})
        self.assertEqual(ri.differences(None, current), ["the earlier release records no build inputs"])
        self.assertEqual(ri.differences({"schema": 99, "digest": "x"}, current), ["the earlier release records no build inputs"])


if __name__ == "__main__":
    unittest.main()
