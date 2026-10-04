"""Exercise the gate with real manifests, including disguised host dependencies."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "architecture", Path(__file__).with_name("check-player-architecture.py")
)
architecture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(architecture)


class ArchitectureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.write("Cargo.toml", '[workspace]\nmembers = ["crates/player-*"]')

    def write(self, path, text):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def crate(self, name, dependencies="", directory=None):
        self.write(
            f"{directory or 'crates/' + name}/Cargo.toml",
            f'[package]\nname = "{name}"\nversion = "0.1.0"\n{dependencies}',
        )

    def test_no_shared_crates_before_extraction(self):
        self.assertEqual(architecture.violations(self.root), [])

    def test_permitted_graph_and_external_library(self):
        self.crate("player-types", '[dependencies]\nserde = "1"')
        self.crate("player-state", '[dependencies]\nplayer-types = {path = "../player-types"}')
        self.assertEqual(architecture.violations(self.root), [])

    def test_forbidden_reverse_shared_edge(self):
        self.crate("player-core")
        self.crate("player-types", '[dependencies]\nplayer-core = {path = "../player-core"}')
        self.assertIn("forbidden shared dependency player-core", "\n".join(architecture.violations(self.root)))

    def test_permitted_workspace_alias_and_test_features(self):
        self.crate("player-types")
        self.write("Cargo.toml", '[workspace]\nmembers = ["crates/player-*"]\n[workspace.dependencies]\ntypes = {package = "player-types", path = "crates/player-types"}')
        self.crate("player-core", '[dependencies]\ntypes.workspace = true\n[dev-dependencies]\nplayer-core = {path = ".", features = ["test-util"]}')
        self.assertEqual(architecture.violations(self.root), [])

    def test_renamed_target_and_workspace_host_dependencies(self):
        self.crate("edge-ipc", directory="apps/edge/crates/edge-ipc")
        self.write("Cargo.toml", '[workspace]\nmembers = ["crates/player-*"]\n[workspace.dependencies]\ntransport = {package = "edge-ipc", path = "apps/edge/crates/edge-ipc"}')
        self.crate("player-core", '[target.\'cfg(unix)\'.build-dependencies]\ntransport.workspace = true')
        errors = "\n".join(architecture.violations(self.root))
        self.assertIn("outside the shared Player crates", errors)
        self.assertIn("forbidden native host dependency edge-ipc", errors)

    def test_platform_path_with_shared_package_name(self):
        self.crate("player-types", directory="apps/edge/innocent")
        self.crate("player-core", '[dev-dependencies]\ntypes = {package = "player-types", path = "../../apps/edge/innocent"}')
        self.assertIn("outside the shared Player crates", "\n".join(architecture.violations(self.root)))

    def test_registry_host_alias_is_rejected(self):
        self.crate("player-core", '[dependencies]\ntransport = {package = "edge-protocol", version = "1"}')
        self.assertIn("forbidden native host dependency edge-protocol", "\n".join(architecture.violations(self.root)))

    def test_unresolved_workspace_and_missing_path_fail_closed(self):
        self.crate("player-client", '[dependencies]\nmissing.workspace = true\nlocal = {path = "../missing"}')
        errors = architecture.violations(self.root)
        self.assertEqual(len(errors), 2)

    def test_extra_shared_crate_requires_explicit_boundary_review(self):
        self.crate("player-platform")
        self.assertIn("five documented Player crates", "\n".join(architecture.violations(self.root)))

    def test_unregistered_and_excluded_crates_fail_validation(self):
        self.crate("player-types")
        for workspace in [
            '[workspace]\nmembers = []',
            '[workspace]\nmembers = ["crates/player-*"]\nexclude = ["crates/player-types"]',
        ]:
            self.write("Cargo.toml", workspace)
            self.assertEqual(architecture.registered_crates(self.root), set())
            self.assertIn("not registered in the root Cargo workspace", "\n".join(architecture.violations(self.root)))

    def test_nested_workspace_is_not_root_registration(self):
        self.crate("player-types", '[workspace]')
        self.assertEqual(architecture.registered_crates(self.root), set())
        self.assertIn("not registered in the root Cargo workspace", "\n".join(architecture.violations(self.root)))


if __name__ == "__main__":
    unittest.main()
