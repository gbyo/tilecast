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

    def windows_host(self, dependencies=""):
        self.crate(architecture.WINDOWS_HOST, dependencies, directory="apps/player-windows")

    def test_shared_crate_must_not_depend_on_the_windows_host(self):
        self.windows_host()
        self.crate("player-core", '[dependencies]\nhost = {package = "tilecast-windows", path = "../../apps/player-windows"}')
        errors = "\n".join(architecture.violations(self.root))
        self.assertIn("outside the shared Player crates", errors)
        self.assertIn("forbidden native host dependency tilecast-windows", errors)

    def test_shared_crate_must_not_alias_the_windows_host(self):
        self.crate("player-core", '[dependencies]\nhost = {package = "tilecast-windows", version = "1"}')
        self.assertIn(
            "forbidden native host dependency tilecast-windows", "\n".join(architecture.violations(self.root))
        )

    def test_shared_crate_must_not_take_os_specific_dependencies(self):
        self.crate("player-core", '[dependencies]\nwindows = "0.62"\n[target.\'cfg(windows)\'.dependencies]\nwebview2-com = "0.39"')
        errors = "\n".join(architecture.violations(self.root))
        self.assertIn("forbidden OS-specific dependency windows", errors)
        self.assertIn("forbidden OS-specific dependency webview2-com", errors)

    def test_windows_host_must_not_depend_on_edge(self):
        self.crate("edge-ipc", directory="apps/edge/crates/edge-ipc")
        self.windows_host('[dependencies]\nedge-ipc = {path = "../edge/crates/edge-ipc"}\n[dev-dependencies]\nprotocol = {package = "edge-protocol", version = "1"}')
        errors = "\n".join(architecture.violations(self.root))
        self.assertIn("tilecast-windows: edge-ipc depends on the Edge host", errors)
        self.assertIn("forbidden native host dependency edge-protocol", errors)

    def test_windows_host_must_not_depend_on_the_electron_player(self):
        self.write("apps/player-linux/Cargo.toml", '[package]\nname = "player-linux"\nversion = "0.1.0"\n')
        self.windows_host('[dependencies]\nlinux = {package = "player-linux", path = "../player-linux"}')
        self.assertIn(
            "tilecast-windows: linux depends on the Electron Player", "\n".join(architecture.violations(self.root))
        )

    def test_windows_host_may_use_shared_and_external_crates(self):
        self.crate("player-core")
        self.windows_host(
            '[dependencies]\nplayer-core = {path = "../../crates/player-core"}\nserde = "1"\n'
            '[target.\'cfg(windows)\'.dependencies]\nwindows = "0.62"\n'
            '[dev-dependencies]\ntilecast-windows = {path = "."}'
        )
        self.assertEqual(architecture.violations(self.root), [])


if __name__ == "__main__":
    unittest.main()
