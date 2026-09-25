#!/usr/bin/env python3
"""Assembles an unpacked Tilecast Edge release tree and its unsigned manifest.

The tree is what `tilecast-edge-migrate install --from DIR` installs under
/opt/tilecast-edge/<version>/. The manifest (tilecast-edge-release.json) lists
every file with its size, SHA-256 and mode; build-edge-release.sh signs it
with the Tilecast update key, and the migration integration test signs it
with a throwaway key.

Usage:
  stage-release.py --out DIR --version X.Y.Z --bin-dir DIR --renderer PATH
                   --gst-plugin-dir DIR --runtime-dir DIR --sbom PATH
                   --wpe-version V --base-distribution NAME
                   [--wpe-lib-dir DIR]
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys

EDGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNITS = [
    "tilecast-edge.service",
    "tilecast-renderer.service",
    "tilecast-edge-migrate.service",
    "tilecast-edge-migrate-recover.service",
    "tilecast-edge-selftest.service",
    "tilecast-renderer-selftest.service",
    "tilecast-renderer-probe.service",
    "tilecast-edge-compat.service",
    "tilecast-edge-import.service",
]


def version_code(version):
    core = version.split("-", 1)[0]
    major, minor, patch = (int(part) for part in core.split("."))
    return major * 1_000_000 + minor * 1_000 + patch


def copy(source, out, relative, mode):
    target = os.path.join(out, relative)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(source, target)
    os.chmod(target, mode)


def copy_wpe(prefix, out):
    """Carries the runtime part of the private WPE build under lib/wpe.

    A release holds no symbolic links. A shared library is stored once,
    under the name the loader asks for (its SONAME link, for example
    libWPEWebKit-2.0.so.1); development links, headers and pkg-config files
    are left out.
    """
    soname_targets = set()
    for root, _, names in os.walk(prefix):
        for name in names:
            path = os.path.join(root, name)
            if os.path.islink(path) and re.search(r"\.so\.\d+$", name):
                soname_targets.add(os.path.realpath(path))
    for root, dirs, names in os.walk(prefix):
        relative_root = os.path.relpath(root, prefix)
        if relative_root.split(os.sep)[0] == "include" or relative_root.endswith("pkgconfig"):
            dirs[:] = []
            continue
        for name in names:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, prefix)
            if os.path.islink(path):
                if not re.search(r"\.so\.\d+$", name):
                    continue
                source = os.path.realpath(path)
            elif os.path.realpath(path) in soname_targets:
                continue
            else:
                source = path
            mode = 0o755 if os.access(source, os.X_OK) and not name.endswith((".so",)) and ".so." not in name else 0o644
            copy(source, out, f"lib/wpe/{relative}", mode)


def self_test_fixture(out):
    """The release self-test: the headless e2e playlist (image, H.264 video,
    render tree, layout) with media generated deterministically."""
    base = os.path.join(out, "share", "tilecast", "selftest")
    media = os.path.join(base, "media")
    os.makedirs(media, exist_ok=True)
    shutil.copyfile(os.path.join(EDGE, "renderer-wpe", "tests", "fixtures", "playlist.json"),
                    os.path.join(base, "fixture.json"))
    ffmpeg = ["ffmpeg", "-loglevel", "error", "-y", "-fflags", "+bitexact", "-flags:v", "+bitexact"]
    subprocess.run(ffmpeg + ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1",
                             os.path.join(media, "still.png")], check=True)
    subprocess.run(ffmpeg + ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4",
                             "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
                             "-x264-params", "threads=1", "-map_metadata", "-1", "-movflags", "+faststart",
                             os.path.join(media, "clip.mp4")], check=True)


def main():
    parser = argparse.ArgumentParser()
    for name in ("--out", "--version", "--bin-dir", "--renderer", "--gst-plugin-dir", "--runtime-dir", "--sbom",
                 "--wpe-version", "--base-distribution"):
        parser.add_argument(name, required=True)
    parser.add_argument("--wpe-lib-dir", help="a private WPE WebKit build to carry under lib/wpe")
    args = parser.parse_args()
    out = os.path.abspath(args.out)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    for name in ("tilecastd", "tilecastctl", "tilecast-edge-migrate"):
        copy(os.path.join(args.bin_dir, name), out, f"bin/{name}", 0o755)
    copy(args.renderer, out, "bin/tilecast-renderer-wpe", 0o755)
    copy(os.path.join(args.gst_plugin_dir, "libgsttcmedia.so"), out, "lib/gstreamer-1.0/libgsttcmedia.so", 0o644)
    for root, _, names in os.walk(args.runtime_dir):
        for name in names:
            source = os.path.join(root, name)
            relative = os.path.relpath(source, args.runtime_dir)
            copy(source, out, f"share/tilecast/renderer-web/{relative}", 0o644)
    if args.wpe_lib_dir:
        copy_wpe(args.wpe_lib_dir, out)
    for unit in UNITS:
        copy(os.path.join(EDGE, "packaging", "systemd", unit), out, f"packaging/systemd/{unit}", 0o644)
    copy(os.path.join(EDGE, "packaging", "sysusers.d", "tilecast-edge.conf"), out,
         "packaging/sysusers.d/tilecast-edge.conf", 0o644)
    copy(os.path.join(EDGE, "packaging", "tmpfiles.d", "tilecast-edge.conf"), out,
         "packaging/tmpfiles.d/tilecast-edge.conf", 0o644)
    copy(args.sbom, out, "share/doc/tilecast-edge/sbom.cdx.json", 0o644)
    self_test_fixture(out)

    files = []
    for root, dirs, names in os.walk(out):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            relative = os.path.relpath(path, out)
            with open(path, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
            mode = "0755" if os.stat(path).st_mode & 0o111 else "0644"
            files.append({"path": relative, "sha256": digest, "size": os.path.getsize(path), "mode": mode})
    manifest = {
        "schemaVersion": 1,
        "product": "tilecast-edge",
        "platform": "linux",
        "arch": platform.machine(),
        "versionName": args.version,
        "versionCode": version_code(args.version),
        "wpeWebkitVersion": args.wpe_version,
        "baseDistribution": args.base_distribution,
        "files": files,
    }
    with open(os.path.join(out, "tilecast-edge-release.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"stage-release: {len(files)} files for Tilecast Edge {args.version} in {out}")


if __name__ == "__main__":
    sys.exit(main())
