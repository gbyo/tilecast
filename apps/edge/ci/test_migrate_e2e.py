import importlib.util
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migrate_e2e = load("migrate_e2e")


def provided_roots(probe):
    """Absolute sandbox paths the probe creates: bind destinations, symlinks,
    and the --proc/--dev/--tmpfs mounts, each covering the tree below it."""
    roots = set()
    args = list(probe)
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--ro-bind", "--bind", "--dev-bind"):
            roots.add(args[index + 2])
            index += 3
        elif arg == "--symlink":
            roots.add(args[index + 2])
            index += 3
        elif arg in ("--proc", "--dev", "--tmpfs"):
            roots.add(args[index + 1])
            index += 2
        elif arg in ("--die-with-parent", "--unshare-pid", "--unshare-net", "--unshare-user",
                      "--unshare-uts", "--unshare-ipc", "--unshare-cgroup"):
            index += 1
        else:
            index += 1
    return roots


def covered(path, roots):
    return any(path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


class SandboxProbeTest(unittest.TestCase):
    def test_probe_executable_is_inside_a_bound_tree(self):
        probe = migrate_e2e.SANDBOX_PROBE
        executable = probe[-1]
        self.assertTrue(executable.startswith("/"), executable)
        parent = str(Path(executable).parent)
        self.assertTrue(covered(parent, provided_roots(probe)),
                        f"{executable} is not under any path the probe sandbox provides")

    def test_probe_provides_the_loader_directory(self):
        # The probe execs a dynamically linked /usr/bin/true on x86_64 Debian,
        # whose loader lives in /lib64. Without that bind the exec fails with
        # ENOENT and preflight misreports missing user-namespace support.
        probe = migrate_e2e.SANDBOX_PROBE
        self.assertIn(("--ro-bind", "/lib64", "/lib64"),
                      [tuple(probe[i:i + 3]) for i in range(len(probe) - 2)])


if __name__ == "__main__":
    unittest.main()
