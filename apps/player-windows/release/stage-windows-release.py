#!/usr/bin/env python3
"""Stages and packages a Tilecast Player for Windows release.

Renders AppxManifest.xml from the template (package version from the
tilecast-msix-version helper, the single implementation of the version
mapping), stages the executable with its Runtime artifact, packs the
MSIX with the Windows SDK makeappx, signs it when a PFX is provided,
and writes the unsigned update envelope JSON. Envelope signing with
the Tilecast update key is a separate workflow step, exactly like the
Edge release build.

Usage:
  stage-windows-release.py --exe FILE --runtime-dir DIR --arch x86_64|aarch64
      --channel stable|beta --publisher CN=... --version-file FILE
      --msix-version-bin FILE --template FILE --assets DIR --out DIR
      [--pfx FILE --pfx-password TEXT] [--notes TEXT]
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sdk_tool(name):
    kits = os.environ.get("WindowsSdkDir", r"C:\Program Files (x86)\Windows Kits\10")
    candidates = sorted(glob.glob(os.path.join(kits, "bin", "*", "x64", name)))
    if not candidates:
        sys.exit(f"stage: {name} not found under {kits}; install the Windows SDK")
    return candidates[-1]


def run(argv, secrets=()):
    """Runs a tool. Any value in `secrets` is replaced in everything the
    script prints, so a signing password never reaches stdout or the logs."""

    def redact(text):
        for secret in secrets:
            if secret:
                text = text.replace(secret, "***")
        return text

    print(f"stage: {redact(' '.join(argv))}")
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"stage: {' '.join(argv[:2])} failed: {redact(result.stderr.strip())}")
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--arch", required=True, choices=["x86_64", "aarch64"])
    parser.add_argument("--channel", required=True, choices=["stable", "beta"])
    parser.add_argument("--publisher", required=True)
    parser.add_argument("--version-file", required=True)
    parser.add_argument("--msix-version-bin", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument("--pfx", default="")
    parser.add_argument("--pfx-password", default="")
    args = parser.parse_args()

    with open(args.version_file) as handle:
        version = handle.read().strip()
    if not re.fullmatch(r"[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z.]+)?", version):
        sys.exit(f"stage: invalid version {version}")
    if len(args.notes) > 4000:
        sys.exit("stage: release notes are too long")
    if bool(args.pfx) != bool(args.pfx_password):
        sys.exit("stage: --pfx and --pfx-password go together")

    versions = subprocess.run(
        [args.msix_version_bin, version, args.channel, "--json"], capture_output=True, text=True
    )
    if versions.returncode != 0:
        sys.exit(f"stage: no MSIX version for {version} ({args.channel}): {versions.stderr.strip()}")
    try:
        mapped = json.loads(versions.stdout)
        package_version = mapped["packageVersion"]
        version_code = int(mapped["versionCode"])
    except (ValueError, KeyError, TypeError):
        sys.exit("stage: the version helper answered something else")
    msix_arch = {"x86_64": "x64", "aarch64": "arm64"}[args.arch]

    with open(args.template) as handle:
        manifest = handle.read()
    for token in ("@TILECAST_MSIX_PUBLISHER@", "@TILECAST_MSIX_VERSION@", "@TILECAST_MSIX_ARCH@"):
        if token not in manifest:
            sys.exit(f"stage: template lost its {token} token")
    manifest = (
        manifest.replace("@TILECAST_MSIX_PUBLISHER@", args.publisher)
        .replace("@TILECAST_MSIX_VERSION@", package_version)
        .replace("@TILECAST_MSIX_ARCH@", msix_arch)
    )
    if "@TILECAST_MSIX_" in manifest:
        sys.exit("stage: an MSIX token survived rendering")

    runtime_manifest = os.path.join(args.runtime_dir, "runtime-manifest.json")
    if not os.path.isfile(runtime_manifest):
        sys.exit(f"stage: {args.runtime_dir} has no runtime-manifest.json; build @tilecast/player-runtime first")
    staging = os.path.join(args.out, "staging")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(os.path.join(staging, "Assets"))
    with open(os.path.join(staging, "AppxManifest.xml"), "w") as handle:
        handle.write(manifest)
    shutil.copy(args.exe, os.path.join(staging, "tilecast-windows.exe"))
    shutil.copytree(args.runtime_dir, os.path.join(staging, "runtime"))
    for asset in ("StoreLogo.png", "Square150x150Logo.png", "Square44x44Logo.png"):
        shutil.copy(os.path.join(args.assets, asset), os.path.join(staging, "Assets", asset))

    artifact_name = f"tilecast-windows-{version}-{args.arch}.msix"
    artifact = os.path.join(args.out, artifact_name)
    if os.path.exists(artifact):
        os.remove(artifact)
    run([sdk_tool("makeappx.exe"), "pack", "/d", staging, "/p", artifact, "/o", "/nv"])
    if args.pfx:
        run([
            sdk_tool("signtool.exe"), "sign", "/fd", "SHA256", "/f", args.pfx,
            "/p", args.pfx_password, artifact,
        ], secrets=(args.pfx_password,))
    else:
        print("stage: no PFX; the package is unsigned", file=sys.stderr)

    envelope = {
        "schemaVersion": 1,
        "product": "tilecast-windows",
        "playerFamily": "windows",
        "platform": "windows",
        "arch": args.arch,
        "versionName": version,
        "versionCode": version_code,
        "channel": args.channel,
        "releaseNotes": args.notes,
        "artifactAssetName": artifact_name,
        "artifactSizeBytes": os.path.getsize(artifact),
        "artifactSha256": sha256(artifact),
    }
    envelope_name = f"tilecast-windows-update-{args.arch}.json"
    with open(os.path.join(args.out, envelope_name), "w") as handle:
        json.dump(envelope, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"stage: {artifact_name} ({envelope['artifactSizeBytes']} bytes), {envelope_name}")
    print(f"stage: package version {package_version}, publisher {args.publisher}")


if __name__ == "__main__":
    main()
