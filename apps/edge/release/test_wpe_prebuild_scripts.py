"""The GHCR publish and fetch scripts for the private WPE WebKit prebuild, run
against a fake oras that keeps its registry in a directory and a fake gh that
records how the attestation was verified."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARCH = "x86_64"

FAKE_ORAS = r"""#!/usr/bin/env bash
# Registry layout: $FAKE_REGISTRY/<tag>/manifest.json and <tag>/layer/<title>
set -euo pipefail
echo "$*" >> "$FAKE_REGISTRY/calls.log"
cmd=$1; shift
tag_of() { printf '%s' "${1##*:}"; }
case "$cmd" in
  manifest)
    shift                                   # fetch
    descriptor=false
    if [ "$1" = "--descriptor" ]; then descriptor=true; shift; fi
    dir="$FAKE_REGISTRY/$(tag_of "$1")"
    [ -f "$dir/manifest.json" ] || { echo "not found" >&2; exit 1; }
    if $descriptor; then
      digest=$(sha256sum "$dir/manifest.json" | cut -d' ' -f1)
      jq -n --arg d "sha256:$digest" '{mediaType:"application/vnd.oci.image.manifest.v1+json",digest:$d,size:1}'
    else
      cat "$dir/manifest.json"
    fi ;;
  pull)
    ref=$1; shift; out=
    while [ $# -gt 0 ]; do case "$1" in --output) out=$2; shift 2 ;; *) shift ;; esac; done
    dir="$FAKE_REGISTRY/$(tag_of "$ref")"
    cp "$dir"/layer/* "$out/" ;;
  push)
    ref=$1; shift; file=; type=; annotations=()
    while [ $# -gt 0 ]; do case "$1" in
      --artifact-type) type=$2; shift 2 ;;
      --annotation) annotations+=("$2"); shift 2 ;;
      --no-tty) shift ;;
      *) file=${1%%:*}; shift ;;
    esac; done
    dir="$FAKE_REGISTRY/$(tag_of "$ref")"
    mkdir -p "$dir/layer"; cp "$file" "$dir/layer/$file"
    digest=$(sha256sum "$file" | cut -d' ' -f1)
    annotations_json=$(printf '%s\n' "${annotations[@]}" | jq -R 'split("=") | {(.[0]): (.[1:] | join("="))}' | jq -s add)
    jq -n --arg type "$type" --arg d "sha256:$digest" --arg title "$file" --argjson size "$(wc -c < "$file")" --argjson a "$annotations_json" \
      '{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",artifactType:$type,
        config:{mediaType:"application/vnd.oci.empty.v1+json",digest:"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",size:2},
        layers:[{mediaType:"application/x-tar",digest:$d,size:$size,annotations:{"org.opencontainers.image.title":$title}}],
        annotations:$a}' > "$dir/manifest.json" ;;
esac
"""

FAKE_GH = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_REGISTRY/gh.log"
case "$1 $2" in
  "release view") cat "$FAKE_RELEASE_JSON"; exit 0 ;;
  "release download")
    shift 3; pattern=; dir=
    while [ $# -gt 0 ]; do case "$1" in --pattern) pattern=$2; shift 2 ;; --dir) dir=$2; shift 2 ;; *) shift ;; esac; done
    cp "$FAKE_RELEASE_TAR" "$dir/$pattern"; exit 0 ;;
esac
[ "${FAKE_GH_FAIL:-0}" = 1 ] && exit 1
exit 0
"""


class ScriptFixture(unittest.TestCase):
    """A fake registry, a fake gh, and helpers to run the scripts against them."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.registry = self.root / "registry"
        self.registry.mkdir()
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in (("oras", FAKE_ORAS), ("gh", FAKE_GH)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.env = dict(os.environ, FAKE_REGISTRY=str(self.registry), TILECAST_ORAS=str(bin_dir / "oras"),
                        TILECAST_GH=str(bin_dir / "gh"), GITHUB_REPOSITORY="gbyo/tilecast", GITHUB_SHA="c" * 40)
        self.env.pop("GITHUB_OUTPUT", None)
        self.name = self.inputs("wpe-tar", ARCH)
        self.ref = self.inputs("wpe-ref", ARCH)
        self.tag = self.ref.split(":", 1)[1]
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))

    def inputs(self, *args):
        return subprocess.check_output(["python3", str(HERE / "inputs.py"), *args], text=True).strip()

    def tar(self, content=b"a private WPE WebKit build"):
        path = self.root / "build" / self.name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(content)
        return path

    def run_script(self, script, *args, extra=None):
        return subprocess.run(["bash", str(HERE / script), *args], capture_output=True, text=True, env=dict(self.env, **(extra or {})))

    def publish(self, content=b"a private WPE WebKit build"):
        return self.run_script("publish-wpe-prebuild.sh", str(self.tar(content)), ARCH)

    def fetch(self, extra=None):
        out = self.root / "out"
        return self.run_script("fetch-wpe-prebuild.sh", ARCH, str(out), extra=extra), out

    def manifest_path(self):
        return self.registry / self.tag / "manifest.json"

    def edit_manifest(self, change):
        manifest = json.loads(self.manifest_path().read_text())
        change(manifest)
        self.manifest_path().write_text(json.dumps(manifest))

    def pushes(self):
        return [line for line in (self.registry / "calls.log").read_text().splitlines() if line.startswith("push ")]



class WpePrebuildScripts(ScriptFixture):
    def test_a_published_prebuild_is_fetched_and_verified(self):
        published = self.publish()
        self.assertEqual(published.returncode, 0, published.stderr)
        result, out = self.fetch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((out / self.name).read_bytes(), b"a private WPE WebKit build")
        gh_log = (self.registry / "gh.log").read_text()
        self.assertTrue(gh_log.startswith("attestation verify "), gh_log)
        self.assertIn("--repo gbyo/tilecast", gh_log)
        self.assertIn("--signer-workflow gbyo/tilecast/.github/workflows/wpe-prebuild.yml", gh_log)

    def test_the_artifact_carries_the_build_identity(self):
        self.publish()
        manifest = json.loads(self.manifest_path().read_text())
        self.assertEqual(manifest["artifactType"], "application/vnd.tilecast.wpe-prebuild.v1")
        self.assertEqual(len(manifest["layers"]), 1)
        annotations = manifest["annotations"]
        self.assertEqual(annotations["org.tilecast.wpe.architecture"], ARCH)
        self.assertEqual(annotations["org.tilecast.wpe.inputs-key"], self.inputs("wpe-key"))
        self.assertEqual(annotations["org.tilecast.wpe.tar-sha256"], hashlib.sha256(b"a private WPE WebKit build").hexdigest())
        self.assertEqual(annotations["org.opencontainers.image.revision"], "c" * 40)
        self.assertEqual(annotations["org.opencontainers.image.source"], "https://github.com/gbyo/tilecast")
        self.assertEqual(annotations["org.opencontainers.image.version"], self.inputs("wpe-version"))

    def test_the_tag_is_published_once_and_never_replaced(self):
        self.assertEqual(self.publish().returncode, 0)
        first = self.manifest_path().read_text()
        again = self.publish(b"a different tar under the same inputs")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("already exists", again.stdout)
        self.assertEqual(self.manifest_path().read_text(), first)
        self.assertEqual(len(self.pushes()), 1)

    def test_publish_refuses_a_tar_with_another_name(self):
        path = self.root / "other.tar"
        path.write_bytes(b"x")
        result = self.run_script("publish-wpe-prebuild.sh", str(path), ARCH)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be named", result.stderr)
        self.assertFalse((self.registry / "calls.log").exists() and self.pushes())

    def test_a_missing_prebuild_is_not_an_error_class_of_its_own(self):
        result, out = self.fetch()
        self.assertEqual(result.returncode, 1)
        self.assertIn("no prebuild", result.stderr)
        self.assertFalse(out.exists())

    def assert_rejected(self, result, out, reason):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(reason, result.stderr)
        self.assertFalse((out / self.name).exists(), "a rejected prebuild must leave nothing behind")

    def test_another_architectures_annotation_is_rejected(self):
        self.publish()
        self.edit_manifest(lambda m: m["annotations"].update({"org.tilecast.wpe.architecture": "aarch64"}))
        result, out = self.fetch()
        self.assert_rejected(result, out, "not this build's WPE prebuild")

    def test_other_builder_inputs_are_rejected(self):
        self.publish()
        self.edit_manifest(lambda m: m["annotations"].update({"org.tilecast.wpe.inputs-key": "0" * 16}))
        result, out = self.fetch()
        self.assert_rejected(result, out, "not this build's WPE prebuild")

    def test_an_extra_layer_is_rejected(self):
        self.publish()
        self.edit_manifest(lambda m: m["layers"].append(dict(m["layers"][0])))
        result, out = self.fetch()
        self.assert_rejected(result, out, "not this build's WPE prebuild")

    def test_a_layer_digest_that_does_not_match_the_recorded_tar_hash_is_rejected(self):
        self.publish()
        self.edit_manifest(lambda m: m["layers"][0].update({"digest": "sha256:" + "1" * 64}))
        result, out = self.fetch()
        self.assert_rejected(result, out, "not this build's WPE prebuild")

    def test_tampered_bytes_are_rejected(self):
        self.publish()
        (self.registry / self.tag / "layer" / self.name).write_bytes(b"swapped after publication")
        result, out = self.fetch()
        self.assert_rejected(result, out, "hashes to")

    def test_a_tar_without_build_provenance_is_rejected(self):
        self.publish()
        result, out = self.fetch(extra={"FAKE_GH_FAIL": "1"})
        self.assert_rejected(result, out, "no build provenance attestation")


class MigrateWpePrebuild(ScriptFixture):
    """The one-time move of the old wpe-* GitHub release prebuilds to GHCR."""

    OLD_KEY = "abcdef0123456789"
    TAG = f"wpe-2.54.0-{OLD_KEY}-x86_64"
    CONTENT = b"the tar the old release published"

    def setUp(self):
        super().setUp()
        self.tag_ref = f"2.54.0-{self.OLD_KEY}-x86_64"
        self.old_tar = self.root / "old.tar"
        self.old_tar.write_bytes(self.CONTENT)
        self.write_release(hashlib.sha256(self.CONTENT).hexdigest())
        self.env.update(FAKE_RELEASE_JSON=str(self.root / "release.json"), FAKE_RELEASE_TAR=str(self.old_tar))

    def write_release(self, sha256, digest=None, stated=None):
        digest = f"sha256:{sha256}" if digest is None else digest
        stated = sha256 if stated is None else stated
        body = f"Prebuilt WPE WebKit.\nTar SHA-256: {stated}. Built from commit {'d' * 40}."
        (self.root / "release.json").write_text(json.dumps({
            "assets": [{"name": f"{self.TAG}.tar", "digest": digest}], "body": body, "publishedAt": "2026-10-08T06:48:14Z",
        }))

    def migrate(self, command, tag=None, *extra):
        return self.run_script("migrate-wpe-prebuild.sh", command, tag or self.TAG, *extra)

    def registry_manifest(self):
        return json.loads((self.registry / self.tag_ref / "manifest.json").read_text())

    def pushed(self):
        calls = self.registry / "calls.log"
        return calls.exists() and any(line.startswith("push ") for line in calls.read_text().splitlines())

    def test_a_dry_run_verifies_and_publishes_nothing(self):
        result = self.migrate("backfill", None, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would publish", result.stdout)
        self.assertFalse(self.pushed())

    def test_backfill_publishes_under_the_old_builds_own_inputs(self):
        result = self.migrate("backfill")
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = self.registry_manifest()
        self.assertEqual(manifest["annotations"]["org.tilecast.wpe.inputs-key"], self.OLD_KEY)
        self.assertEqual(manifest["annotations"]["org.opencontainers.image.revision"], "d" * 40)
        self.assertEqual(manifest["annotations"]["org.opencontainers.image.created"], "2026-10-08T06:48:14Z")
        self.assertEqual(manifest["annotations"]["org.tilecast.wpe.tar-sha256"], hashlib.sha256(self.CONTENT).hexdigest())
        self.assertEqual(manifest["layers"][0]["annotations"]["org.opencontainers.image.title"], f"{self.TAG}.tar")

    def test_backfill_is_repeatable_and_never_pushes_twice(self):
        self.assertEqual(self.migrate("backfill").returncode, 0)
        again = self.migrate("backfill")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("already holds", again.stdout)
        pushes = [line for line in (self.registry / "calls.log").read_text().splitlines() if line.startswith("push ")]
        self.assertEqual(len(pushes), 1)

    def test_a_tar_that_does_not_match_the_digest_github_records_is_refused(self):
        self.write_release("0" * 64)
        result = self.migrate("backfill")
        self.assertEqual(result.returncode, 2)
        self.assertIn("GitHub records", result.stderr)
        self.assertFalse(self.pushed())

    def test_a_tar_that_does_not_match_its_notes_is_refused(self):
        self.write_release(hashlib.sha256(self.CONTENT).hexdigest(), stated="1" * 64)
        result = self.migrate("backfill")
        self.assertEqual(result.returncode, 2)
        self.assertIn("its notes state", result.stderr)
        self.assertFalse(self.pushed())

    def test_a_tar_without_provenance_is_refused(self):
        result = self.run_script("migrate-wpe-prebuild.sh", "backfill", self.TAG, extra={"FAKE_GH_FAIL": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("no build provenance attestation", result.stderr)
        self.assertFalse(self.pushed())

    def test_a_different_tar_already_in_ghcr_is_never_replaced(self):
        self.assertEqual(self.migrate("backfill").returncode, 0)
        self.old_tar.write_bytes(b"a tar that has since been swapped")
        self.write_release(hashlib.sha256(b"a tar that has since been swapped").hexdigest())
        result = self.migrate("backfill")
        self.assertEqual(result.returncode, 2)
        self.assertIn("never replaced", result.stderr)

    def test_check_passes_only_once_ghcr_holds_the_tar(self):
        before = self.migrate("check")
        self.assertEqual(before.returncode, 1)
        self.assertIn("not in GHCR yet", before.stderr)
        self.migrate("backfill")
        after = self.migrate("check")
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertIn("is safe in GHCR", after.stdout)

    def test_only_wpe_prebuild_tags_are_accepted(self):
        for tag in ("edge-v0.2.1-preview.1", "wpe-2.54.0-nothex-x86_64", "wpe-2.54.0-abcdef0123456789-riscv64"):
            result = self.migrate("backfill", tag)
            self.assertEqual(result.returncode, 1, tag)
            self.assertIn("not a WPE prebuild release tag", result.stderr)


if __name__ == "__main__":
    unittest.main()
