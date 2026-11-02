"""promote-server-aliases.sh against a fake docker that keeps its registry in a
JSON file: which aliases may move, for which channel, and what they end up
naming."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("promote-server-aliases.sh")
IMAGE = "ghcr.io/gbyo/tilecast-server"
NEW = "sha256:" + "a" * 64
OLD = "sha256:" + "b" * 64
NEWER = "sha256:" + "c" * 64

FAKE_DOCKER = r"""#!/usr/bin/env python3
import json, os, sys
registry = os.environ["FAKE_REGISTRY"]
state = json.load(open(registry))
args = sys.argv[1:]
with open(registry + ".log", "a") as log:
    log.write(" ".join(args) + "\n")
assert args[:2] == ["buildx", "imagetools"], args
if args[2] == "inspect":
    ref = args[3]
    if "--raw" in args:
        ref = args[-1]
        digest = ref.split("@", 1)[1] if "@" in ref else state["tags"].get(ref.rsplit(":", 1)[1])
        if digest not in state["digests"]:
            sys.exit(1)
        version = state.get("versions", {}).get(digest)
        print(json.dumps({"annotations": {"org.opencontainers.image.version": version} if version else {}}))
    elif "@" in ref:
        digest = ref.split("@", 1)[1]
        if digest not in state["digests"]:
            sys.exit(1)
        print(json.dumps({"digest": digest}))
    else:
        alias = ref.rsplit(":", 1)[1]
        if alias not in state["tags"]:
            sys.exit(1)
        print(json.dumps({"digest": state["tags"][alias]}))
elif args[2] == "create":
    tags, source, index = [], None, 3
    while index < len(args):
        if args[index] == "--tag":
            tags.append(args[index + 1].rsplit(":", 1)[1])
            index += 2
        else:
            source = args[index]
            index += 1
    if os.environ.get("FAKE_CREATE_FAILS"):
        sys.exit(1)
    for tag in tags:
        state["tags"][tag] = source.split("@", 1)[1]
    json.dump(state, open(registry, "w"))
"""


class PromoteAliases(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.registry = self.root / "registry.json"
        self.registry.write_text(json.dumps({
            "digests": [NEW, OLD, NEWER], "tags": {"stable": OLD, "latest": OLD, "beta": OLD},
            "versions": {OLD: "0.26.0", NEW: "0.26.1", NEWER: "0.27.0-beta.1"},
        }))
        docker = self.root / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.env = dict(os.environ, DOCKER=str(docker), FAKE_REGISTRY=str(self.registry), IMAGE=IMAGE)
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def promote(self, digest=NEW, aliases=("stable", "latest", "beta"), channel="stable", **extra):
        env = dict(self.env, PROMOTE_DIGEST=digest, ALIASES=json.dumps(list(aliases)), RELEASE_CHANNEL=channel, **extra)
        return subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env)

    def tags(self):
        return json.loads(self.registry.read_text())["tags"]

    def test_a_stable_release_moves_every_alias_it_is_due(self):
        result = self.promote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(), {"stable": NEW, "latest": NEW, "beta": NEW})

    def test_a_beta_release_moves_only_beta(self):
        result = self.promote(aliases=("beta",), channel="beta")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": NEW})

    def test_a_beta_release_can_never_claim_the_stable_aliases(self):
        for alias in ("stable", "latest"):
            result = self.promote(aliases=(alias, "beta"), channel="beta")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"must not move {alias}", result.stderr)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD}, "nothing moved")

    def test_a_stable_hotfix_beside_a_newer_beta_moves_only_the_stable_aliases(self):
        result = self.promote(aliases=("stable", "latest"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(), {"stable": NEW, "latest": NEW, "beta": OLD})

    def test_only_known_aliases_can_move(self):
        for alias in ("development", "sha-abc", "0.26.0", "main"):
            result = self.promote(aliases=(alias,))
            self.assertNotEqual(result.returncode, 0, alias)
            self.assertIn("unknown alias", result.stderr)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD})

    def test_an_empty_alias_list_is_not_an_error_and_touches_nothing(self):
        result = self.promote(aliases=())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No alias is due", result.stdout)
        self.assertFalse(Path(str(self.registry) + ".log").exists())

    def test_a_malformed_or_unknown_digest_moves_nothing(self):
        for digest in ("", "latest", "sha256:abc", "sha256:" + "G" * 64, "0.26.0"):
            result = self.promote(digest=digest)
            self.assertNotEqual(result.returncode, 0, digest)
        unknown = self.promote(digest="sha256:" + "d" * 64)
        self.assertNotEqual(unknown.returncode, 0, "a digest that is not in the registry")
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD})

    def test_the_channel_must_be_stable_or_beta(self):
        for channel in ("", "development", "latest"):
            self.assertNotEqual(self.promote(channel=channel).returncode, 0, channel)

    def test_it_promotes_the_digest_and_never_resolves_the_version_tag(self):
        self.promote()
        log = Path(str(self.registry) + ".log").read_text()
        self.assertIn(f"{IMAGE}@{NEW}", log)
        self.assertNotIn("0.26.0", log)
        self.assertEqual(log.count("imagetools create"), 1, "one registry operation moves every alias")

    def set_state(self, **changes):
        state = json.loads(self.registry.read_text())
        for key, value in changes.items():
            state[key].update(value) if isinstance(value, dict) else state.__setitem__(key, value)
        self.registry.write_text(json.dumps(state))

    def test_an_alias_never_moves_to_an_older_version(self):
        self.set_state(tags={"stable": NEW, "latest": NEW, "beta": NEWER})
        # 0.26.0's image is promoted by a Beta release that carried it forward,
        # while the beta alias already names 0.27.0-beta.1.
        result = self.promote(digest=OLD, aliases=("beta",), channel="beta")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backwards", result.stderr)
        self.assertEqual(self.tags()["beta"], NEWER)

    def test_one_alias_moving_backwards_stops_every_alias(self):
        self.set_state(tags={"stable": OLD, "latest": OLD, "beta": NEWER})
        result = self.promote(digest=NEW)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": NEWER}, "nothing moved")

    def test_a_carried_forward_image_may_be_promoted_to_the_aliases_that_already_name_it(self):
        self.set_state(tags={"stable": OLD, "latest": OLD, "beta": OLD})
        result = self.promote(digest=OLD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD})

    def test_a_hotfix_may_carry_the_older_server_to_a_stable_alias_that_is_older_still(self):
        self.set_state(tags={"stable": OLD, "latest": OLD, "beta": NEWER})
        result = self.promote(digest=NEW, aliases=("stable", "latest"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(), {"stable": NEW, "latest": NEW, "beta": NEWER})

    def test_a_version_never_names_two_images(self):
        self.set_state(digests=[NEW, OLD, NEWER, "sha256:" + "e" * 64], versions={"sha256:" + "e" * 64: "0.26.1"})
        self.set_state(tags={"stable": "sha256:" + "e" * 64})
        result = self.promote(digest=NEW, aliases=("stable",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already", result.stderr)

    def test_an_image_without_a_version_annotation_is_refused(self):
        self.set_state(versions={NEW: ""})
        result = self.promote(digest=NEW)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no version annotation", result.stderr)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD})

    def test_a_failed_registry_operation_fails_the_promotion(self):
        result = self.promote(FAKE_CREATE_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.tags(), {"stable": OLD, "latest": OLD, "beta": OLD})


if __name__ == "__main__":
    unittest.main()
