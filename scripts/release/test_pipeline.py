"""The release pipeline end to end, with real tools: envelopes written by
apps/edge/release/envelope.py and signed with OpenSSL exactly as the release
workflows sign them, checked by the real tilecast-release-verify (the server's
own importer), then collected, assembled, re-verified and resumed.

It needs go and openssl. Without them it is skipped, and the release workflows
run the same commands. Android is left out because a real APK needs the Android
toolchain; the contract is copied with Android made optional.
"""
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import edge_bridge as eb
import release_assemble as ra
import release_reuse as rr

ROOT = Path(__file__).resolve().parents[2]
VERSION = "0.26.0-beta.1"
COMMIT = "0123456789abcdef0123456789abcdef01234567"


def have(*programs):
    return all(shutil.which(program) for program in programs)


@unittest.skipUnless(have("go", "openssl"), "go and openssl are required")
class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.work = Path(tempfile.mkdtemp())
        cls.verifier = cls.work / "tilecast-release-verify"
        built = subprocess.run(
            ["go", "build", "-o", str(cls.verifier), "./cmd/tilecast-release-verify"],
            cwd=ROOT / "apps/server", capture_output=True, text=True,
        )
        if built.returncode != 0:
            raise AssertionError(built.stderr)
        cls.private = cls.work / "update-private.pem"
        cls.public = cls.work / "update-public.pem"
        subprocess.check_call(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(cls.private)], stderr=subprocess.DEVNULL)
        subprocess.check_call(["openssl", "pkey", "-in", str(cls.private), "-pubout", "-out", str(cls.public)])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.work, ignore_errors=True)

    def sign(self, path):
        signature = subprocess.check_output(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(self.private), "-in", str(path)])
        encoded = subprocess.check_output(["openssl", "base64", "-A"], input=signature)
        Path(str(path) + ".sig").write_bytes(encoded)

    def edge(self, assets, arch, version=VERSION):
        code = ra.rv.version_code(version)
        tree = assets.parent / f"tree-{arch}"
        (tree / "share/doc/tilecast-edge").mkdir(parents=True)
        (tree / "share/doc/tilecast-edge/sbom.cdx.json").write_text('{"bomFormat":"CycloneDX"}')
        manifest = {"versionName": version, "versionCode": code, "arch": arch}
        (tree / "tilecast-edge-release.json").write_text(json.dumps(manifest))
        archive = assets / f"tilecast-edge-{version}-{arch}.tar.zst"
        archive.write_bytes(f"edge archive {arch}".encode())
        envelope = assets / f"tilecast-edge-update-{arch}.json"
        subprocess.check_call([
            sys.executable, str(ROOT / "apps/edge/release/envelope.py"), "--tree", str(tree), "--archive", str(archive),
            "--arch", arch, "--state-schema", "6", "--channel", "beta", "--out", str(envelope),
        ], stdout=subprocess.DEVNULL)
        self.sign(envelope)
        shutil.copy(tree / "tilecast-edge-release.json", assets / f"tilecast-edge-{version}-{arch}.json")
        (assets / f"tilecast-edge-{version}-{arch}.json.sig").write_text("sig")
        (assets / f"tilecast-edge-{version}-{arch}.sbom.cdx.json").write_text("{}")

    def windows(self, assets, arch, version=VERSION):
        package = assets / f"tilecast-windows-{version}-{arch}.msix"
        package.write_bytes(f"msix {arch}".encode())
        envelope = assets / f"tilecast-windows-update-{arch}.json"
        envelope.write_text(json.dumps({
            "schemaVersion": 1, "product": "tilecast-windows", "playerFamily": "windows", "platform": "windows",
            "arch": arch, "versionName": version, "versionCode": ra.rv.version_code(version), "channel": "beta", "releaseNotes": "",
            "artifactAssetName": package.name, "artifactSizeBytes": package.stat().st_size,
            "artifactSha256": hashlib.sha256(package.read_bytes()).hexdigest(),
        }, indent=2, sort_keys=True))
        self.sign(envelope)

    def verify(self, directory, version=VERSION):
        run = subprocess.run(
            [str(self.verifier), "--dir", str(directory), "--public-key", str(self.public), "--version", version],
            capture_output=True, text=True,
        )
        self.assertIn(run.returncode, (0, 1), run.stderr)
        return json.loads(run.stdout)

    def contract(self):
        contract = ra.load_contract()
        copy_ = copy.deepcopy(contract)
        for component in copy_["components"]:
            if component["id"] == "android":
                component["required"] = []
        return copy_

    def build_release(self):
        assets = Path(tempfile.mkdtemp(dir=self.work)) / "assets"
        assets.mkdir()
        for arch in ("x86_64", "aarch64"):
            self.edge(assets, arch)
            self.windows(assets, arch)
        return assets

    def test_the_server_importer_accepts_what_the_workflows_sign(self):
        report = self.verify(self.build_release())
        self.assertEqual(report["problems"], [])
        self.assertEqual(
            [(c["family"], c["architecture"], c["versionCode"], c["channel"]) for c in report["components"]],
            [("edge", "aarch64", 2600001, "beta"), ("edge", "x86_64", 2600001, "beta"),
             ("windows", "aarch64", 2600001, "beta"), ("windows", "x86_64", 2600001, "beta")],
        )

    def test_assemble_verify_and_resume_round_trip(self):
        contract = self.contract()
        assets = self.build_release()
        report = self.verify(assets)
        digest = "sha256:" + "f" * 64
        inventory = ra.build(contract, VERSION, "beta", COMMIT, str(assets), report, {}, digest)
        self.assertEqual({c["id"]: c["status"] for c in inventory["components"]}["android"], "unavailable")
        self.assertEqual(len(inventory["assets"]), 6 * 2 + 3 * 2)

        # What GitHub would hold: the assets with the inventory and checksums.
        readback = self.verify(assets)
        self.assertEqual(readback["problems"], [], "the inventory and checksums are not release builds")
        ra.verify(contract, VERSION, "beta", str(assets), readback)

        # A resumed run reuses every component that verifies, byte for byte.
        reuse = assets.parent / "reuse"
        result = ra.resume(contract, VERSION, "beta", str(assets), readback, str(reuse))
        self.assertEqual(sorted(result["verified"]), ["edge-aarch64", "edge-x86_64", "windows-aarch64", "windows-x86_64"])
        self.assertEqual(result["pending"], ["android"])
        for name in os.listdir(reuse):
            self.assertEqual((reuse / name).read_bytes(), (assets / name).read_bytes())

    def test_a_tampered_artifact_is_found_by_the_verifier_and_the_assembly(self):
        contract = self.contract()
        assets = self.build_release()
        (assets / f"tilecast-windows-{VERSION}-aarch64.msix").write_bytes(b"swapped")
        report = self.verify(assets)
        self.assertEqual([(p["family"], p["architecture"]) for p in report["problems"]], [("windows", "aarch64")])
        # Windows is optional in a Beta: the release assembles without it, and
        # its files are not published.
        inventory = ra.build(contract, VERSION, "beta", COMMIT, str(assets), report, {}, "sha256:" + "f" * 64)
        entry = next(c for c in inventory["components"] if c["id"] == "windows-aarch64")
        self.assertEqual(entry["status"], "unavailable")
        self.assertFalse([n for n in os.listdir(assets) if "windows" in n and "aarch64" in n])

    def test_a_tampered_required_build_stops_the_release(self):
        assets = self.build_release()
        (assets / f"tilecast-edge-{VERSION}-x86_64.tar.zst").write_bytes(b"swapped")
        report = self.verify(assets)
        with self.assertRaisesRegex(ra.ReleaseError, r"edge-x86_64 \(verification failed"):
            ra.build(self.contract(), VERSION, "beta", COMMIT, str(assets), report, {}, "sha256:" + "f" * 64)

    def test_a_forged_signature_is_refused(self):
        assets = self.build_release()
        forged = assets / "tilecast-edge-update-x86_64.json"
        forged.write_text(forged.read_text().replace("2600001", "2600002"))
        report = self.verify(assets)
        self.assertEqual(len(report["components"]), 3)
        self.assertEqual([(p["family"], p["architecture"]) for p in report["problems"]], [("edge", "x86_64")])


    # ---- carrying a platform forward, verified by the real importer ----------

    def fingerprints(self, changed=()):
        return {
            c["id"]: {"schema": 1, "digest": "sha256:" + ("1" if c["id"] in changed else "0") * 64, "component": "c", "groups": {"g": "x"}}
            for c in self.contract()["components"]
        }

    def published(self):
        """An earlier release as the workflow leaves it: assets, the inventory
        with the build inputs, and the checksums."""
        contract = self.contract()
        assets = self.build_release()
        report = self.verify(assets)
        plan = {"components": [], "inputs": self.fingerprints()}
        digest = "sha256:" + "f" * 64
        ra.build(contract, VERSION, "beta", COMMIT, str(assets), report, {}, digest, plan)
        return assets

    def decide(self, origin, changed=("windows-x86_64", "windows-aarch64")):
        contract = self.contract()
        inventory, digest = rr.read_inventory(str(origin))
        baseline = rr.Release("v" + VERSION, inventory, digest, str(origin))

        def fetch(tag, target):
            shutil.copytree(origin, target, dirs_exist_ok=True)

        verifier = rr.OriginVerifier(contract, fetch, str(self.verifier), str(self.public), "", str(origin.parent / "verify-work"))
        image = lambda entry, source: {"image": contract["serverImage"], "tag": entry["versionName"], "digest": entry["digest"]}
        return rr.decide(
            contract, channel="beta", current=self.fingerprints(changed), baseline=baseline, newest=baseline,
            pending=[c["id"] for c in contract["components"]], unavailable="", verify_origin=verifier, check_image=image,
        )

    def test_a_platform_is_carried_forward_when_the_real_importer_still_accepts_it(self):
        plan = self.decide(self.published())
        actions = {c["id"]: c["action"] for c in plan["components"]}
        self.assertEqual(actions["edge-x86_64"], "inherit")
        self.assertEqual(actions["edge-aarch64"], "inherit")
        self.assertEqual(actions["windows-x86_64"], "build")
        edge = next(c for c in plan["components"] if c["id"] == "edge-x86_64")
        self.assertEqual((edge["versionName"], edge["versionCode"], edge["channel"]), (VERSION, 2600001, "beta"))
        self.assertEqual(sorted(a["role"] for a in edge["assets"]), ["download", "manifest", "sbom", "signature", "signature", "update"])

    def test_a_hotfix_with_one_platform_is_accepted_by_the_importer_and_assembles(self):
        origin = self.published()
        plan = self.decide(origin)
        hotfix_version = "0.26.0-beta.2"
        assets = Path(tempfile.mkdtemp(dir=self.work)) / "assets"
        assets.mkdir()
        for arch in ("x86_64", "aarch64"):
            self.windows(assets, arch, hotfix_version)
        report = self.verify(assets, hotfix_version)
        self.assertEqual(report["problems"], [])
        self.assertEqual([(c["family"], c["architecture"]) for c in report["components"]], [("windows", "aarch64"), ("windows", "x86_64")])
        plan["inputs"] = self.fingerprints(("windows-x86_64", "windows-aarch64"))
        digest_less = next(c for c in plan["components"] if c["id"] == "server")
        self.assertEqual(digest_less["action"], "inherit")
        inventory = ra.build(self.contract(), hotfix_version, "beta", COMMIT, str(assets), report, {}, "", plan)
        states = {c["id"]: c.get("origin") for c in inventory["components"]}
        self.assertEqual(states["edge-x86_64"], "inherited")
        self.assertEqual(states["windows-x86_64"], "built")
        # The directory is only the hotfix's own files, and what GitHub would
        # hold verifies against its inventory.
        readback = self.verify(assets, hotfix_version)
        self.assertEqual(readback["problems"], [])
        ra.verify(self.contract(), hotfix_version, "beta", str(assets), readback)
        self.assertFalse([n for n in os.listdir(assets) if n.startswith("tilecast-edge")])

    def test_a_swapped_artifact_in_the_earlier_release_is_rebuilt_not_carried(self):
        origin = self.published()
        (origin / f"tilecast-edge-{VERSION}-x86_64.tar.zst").write_bytes(b"swapped after publication")
        actions = {c["id"]: (c["action"], c["reason"]) for c in self.decide(origin)["components"]}
        self.assertEqual(actions["edge-x86_64"][0], "build")
        self.assertIn("does not verify today", actions["edge-x86_64"][1])
        self.assertEqual(actions["edge-aarch64"][0], "inherit")

    def test_a_forged_envelope_in_the_earlier_release_is_rebuilt_not_carried(self):
        origin = self.published()
        envelope = origin / "tilecast-edge-update-aarch64.json"
        envelope.write_text(envelope.read_text().replace("2600001", "2600002"))
        actions = {c["id"]: c["action"] for c in self.decide(origin)["components"]}
        self.assertEqual(actions["edge-aarch64"], "build")
        self.assertEqual(actions["edge-x86_64"], "inherit")

    def test_a_deleted_asset_in_the_earlier_release_is_rebuilt_not_carried(self):
        origin = self.published()
        (origin / "tilecast-windows-update-x86_64.json.sig").unlink()
        actions = {c["id"]: c["action"] for c in self.decide(origin, changed=())["components"]}
        self.assertEqual(actions["windows-x86_64"], "build")
        self.assertEqual(actions["windows-aarch64"], "inherit")


    # ---- the Edge bridge release, verified by the real importer ---------------

    def bridge_assets(self, version="0.2.2"):
        assets = Path(tempfile.mkdtemp(dir=self.work)) / "assets"
        assets.mkdir()
        for arch in ("x86_64", "aarch64"):
            self.edge(assets, arch, version)
        out = assets.parent / "bridge"
        eb.collect(ra.load_contract(), version, [str(assets)], str(out))
        return out

    def test_the_bridge_is_a_legacy_compatible_edge_release_the_importer_accepts(self):
        out = self.bridge_assets()
        report = eb.verify(ra.load_contract(), "0.2.2", str(out), str(self.public), str(self.verifier))
        self.assertEqual(
            [(c["family"], c["architecture"], c["versionName"], c["versionCode"], c["channel"]) for c in report["components"]],
            [("edge", "aarch64", "0.2.2", 2002, "beta"), ("edge", "x86_64", "0.2.2", 2002, "beta")],
        )
        # The envelope carries the legacy code, which the shipped helper recomputes.
        envelope = json.loads((out / "tilecast-edge-update-x86_64.json").read_text())
        self.assertEqual((envelope["versionName"], envelope["versionCode"], envelope["channel"]), ("0.2.2", 2002, "beta"))

    def test_a_bridge_that_is_altered_after_signing_is_refused(self):
        out = self.bridge_assets()
        (out / "tilecast-edge-0.2.2-x86_64.tar.zst").write_bytes(b"swapped")
        with self.assertRaisesRegex(eb.BridgeError, "SHA256SUMS|digest|size"):
            eb.verify(ra.load_contract(), "0.2.2", str(out), str(self.public), str(self.verifier))

    def test_a_unified_edge_release_is_not_a_bridge(self):
        assets = Path(tempfile.mkdtemp(dir=self.work)) / "assets"
        assets.mkdir()
        for arch in ("x86_64", "aarch64"):
            self.edge(assets, arch)
        report = subprocess.run(
            [str(self.verifier), "--dir", str(assets), "--public-key", str(self.public), "--version", VERSION, "--bridge"],
            capture_output=True, text=True,
        )
        self.assertEqual(report.returncode, 2)
        self.assertIn("not a bridge version", report.stderr)


if __name__ == "__main__":
    unittest.main()
