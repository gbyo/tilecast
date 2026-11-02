"""The staged tree must carry the WPE bridge that enables the plugin ABI."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


def load():
    spec = importlib.util.spec_from_file_location("stage_release", Path(__file__).with_name("stage-release.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage = load()
SOURCE = Path(__file__).resolve().parents[1] / "renderer-wpe" / "web" / "tilecast-bridge.js"


def tree(bridge):
    root = tempfile.mkdtemp()
    target = Path(root, "share/tilecast/renderer-web/tilecast-bridge.js")
    target.parent.mkdir(parents=True)
    target.write_text(bridge, encoding="utf-8")
    return root


class PluginBridgeTest(unittest.TestCase):
    def test_the_shipped_bridge_passes(self):
        stage.require_plugin_bridge(tree(SOURCE.read_text(encoding="utf-8")))

    def test_a_bridge_without_the_flag_is_refused(self):
        source = SOURCE.read_text(encoding="utf-8")
        for broken in (source.replace("externalPluginFrames: true,", ""),
                       source.replace("externalPluginFrames: true,", "externalPluginFrames: false,"),
                       "// externalPluginFrames: true, (comment only)\nconst x = 1;"):
            with self.assertRaises(SystemExit):
                stage.require_plugin_bridge(tree(broken))


if __name__ == "__main__":
    unittest.main()
