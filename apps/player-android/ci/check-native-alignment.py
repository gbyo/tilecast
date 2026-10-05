#!/usr/bin/env python3
"""Validate 16 KB page-size compatibility of an APK's native libraries.

Checks every bundled `.so` (Tilecast-built and third-party):
  1. ELF LOAD segments carry at least 16 KB alignment, and
  2. `zipalign -P 16` accepts the APK's uncompressed library placement.

Usage: check-native-alignment.py <apk> [--sdk-root DIR] [--ndk-revision REV]
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REQUIRED_ALIGNMENT = 0x4000
NDK_REVISION = "29.0.14206865"
# LOAD offset, addresses, sizes, flags ("R E"), then the alignment last.
LOAD_RE = re.compile(r"^\s*LOAD\s+.*?\s+(0x[0-9a-fA-F]+)\s*$", re.MULTILINE)


def sdk_root(explicit):
    if explicit:
        return Path(explicit)
    for variable in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(variable):
            return Path(os.environ[variable])
    home = Path.home()
    for candidate in (home / "Library/Android/sdk", home / "Android/Sdk"):
        if candidate.is_dir():
            return candidate
    raise SystemExit("no Android SDK found; set ANDROID_HOME or pass --sdk-root")


def _build_tools_key(name):
    """Sort key: numeric dotted version first, then release over preview."""
    match = re.match(r"(\d+(?:\.\d+)*)(.*)\Z", name)
    if not match:
        return ((), False, name)
    numbers = tuple(int(part) for part in match.group(1).split("."))
    suffix = match.group(2)
    return (numbers, suffix == "", suffix)


def newest_build_tools(sdk):
    tools = sdk / "build-tools"
    names = [p.name for p in tools.iterdir() if (p / "zipalign").exists()]
    versions = sorted(names, key=_build_tools_key, reverse=True)
    if not versions:
        raise SystemExit(f"no zipalign under {tools}")
    return tools / versions[0] / "zipalign"


def llvm_readelf(sdk, revision):
    prebuilt = {
        "darwin": "darwin-x86_64",
        "linux": "linux-x86_64",
        "win32": "windows-x86_64",
    }[sys.platform]
    tool = sdk / "ndk" / revision / "toolchains/llvm/prebuilt" / prebuilt / "bin/llvm-readelf"
    if not tool.exists():
        raise SystemExit(f"llvm-readelf not found at {tool}")
    return tool


def check_elf_alignment(readelf, path):
    output = subprocess.run(
        [str(readelf), "-lW", str(path)], check=True, capture_output=True, text=True
    ).stdout
    segments = LOAD_RE.findall(output)
    if not segments:
        return [f"{path.name}: no LOAD segments found"]
    errors = []
    for alignment in segments:
        value = int(alignment, 16)
        if value < REQUIRED_ALIGNMENT or value % REQUIRED_ALIGNMENT != 0:
            errors.append(f"{path.name}: LOAD alignment {alignment} is not 16 KB compatible")
    return errors


def main():
    parser = argparse.ArgumentParser(description="Validate APK native-library 16 KB alignment.")
    parser.add_argument("apk")
    parser.add_argument("--sdk-root", default=None)
    parser.add_argument("--ndk-revision", default=NDK_REVISION)
    args = parser.parse_args()

    apk = Path(args.apk)
    if not apk.is_file():
        raise SystemExit(f"APK not found: {apk}")
    sdk = sdk_root(args.sdk_root)
    zipalign = newest_build_tools(sdk)
    readelf = llvm_readelf(sdk, args.ndk_revision)

    errors = []
    with tempfile.TemporaryDirectory(prefix="tilecast-apk-") as work:
        with zipfile.ZipFile(apk) as archive:
            members = [name for name in archive.namelist() if name.startswith("lib/") and name.endswith(".so")]
            if not members:
                raise SystemExit(f"{apk}: APK contains no native libraries")
            for name in members:
                archive.extract(name, work)
        for name in sorted(members):
            errors += check_elf_alignment(readelf, Path(work) / name)

    aligned = subprocess.run([str(zipalign), "-c", "-P", "16", "4", str(apk)], capture_output=True, text=True)
    if aligned.returncode != 0:
        errors.append(f"{apk.name}: zipalign -P 16 failed:\n{aligned.stdout}{aligned.stderr}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"{apk.name}: {len(members)} native libraries are 16 KB compatible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
