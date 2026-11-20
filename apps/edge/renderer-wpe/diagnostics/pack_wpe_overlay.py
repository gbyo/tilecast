"""Packs an installed WPE WebKit prefix as a debug overlay for one screen
(docs/tilecast-edge-wpe-compositor-lab.md, "Testing another WPE build").

The tree is the runtime part of the build, carried exactly as a release
carries it (apps/edge/release/stage-release.py copy_wpe: one file per shared
library under its SONAME, no symbolic links, headers or pkg-config files),
plus tilecast-wpe-overlay.json naming what it is and every file's hash. The
screen-side tool merges it over a copy of the installed release's lib/wpe, so
libraries the release carries for itself (libwpe-1.0.so.1) stay.

    python3 pack_wpe_overlay.py --prefix DIR --label NAME --arch ARCH
        --identity FILE --out DIR
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE_RELEASE = HERE.parents[1] / "release" / "stage-release.py"
MANIFEST = "tilecast-wpe-overlay.json"
SCHEMA = "tilecast-wpe-overlay-v1"
LABEL = re.compile(r"^[a-z0-9][a-z0-9.-]{0,47}$")


def _copy_wpe():
    # stage-release.py imports its sibling runtime_closure.
    if str(STAGE_RELEASE.parent) not in sys.path:
        sys.path.insert(0, str(STAGE_RELEASE.parent))
    spec = importlib.util.spec_from_file_location("stage_release", STAGE_RELEASE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.copy_wpe


def webkit_version(prefix):
    """The version the build reports in its own header."""
    header = Path(prefix) / "include" / "wpe-webkit-2.0" / "wpe" / "WebKitVersion.h"
    text = header.read_text()
    parts = []
    for name in ("MAJOR", "MINOR", "MICRO"):
        match = re.search(rf"#define\s+WEBKIT_{name}_VERSION\s+\(?(\d+)\)?", text)
        if not match:
            raise ValueError(f"{header} has no WEBKIT_{name}_VERSION")
        parts.append(match.group(1))
    return ".".join(parts)


def file_table(root):
    table = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_symlink():
            raise ValueError(f"an overlay holds no symbolic links: {path}")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            table[relative] = {
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": path.stat().st_size,
                "mode": oct(path.stat().st_mode & 0o777),
            }
    return table


def _normalize(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    return info


def pack(prefix, label, arch, identity, out):
    if not LABEL.match(label):
        raise ValueError("a label is lower-case letters, digits, '.' and '-'")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    version = webkit_version(prefix)
    with tempfile.TemporaryDirectory() as work:
        _copy_wpe()(prefix, work)
        tree = Path(work) / "lib" / "wpe"
        manifest = {
            "schema": SCHEMA,
            "label": label,
            "arch": arch,
            "webkitVersion": version,
            "source": identity,
            "files": file_table(tree),
        }
        (tree / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        os.chmod(tree / MANIFEST, 0o644)
        name = f"wpe-overlay-{label}-{arch}.tar"
        target = out / name
        with tarfile.open(target, "w", format=tarfile.PAX_FORMAT) as archive:
            for path in sorted(tree.rglob("*")):
                archive.add(path, arcname="wpe/" + path.relative_to(tree).as_posix(), recursive=False,
                            filter=_normalize)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    (out / f"{name}.sha256").write_text(f"{digest}  {name}\n")
    return target, version


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--arch", required=True, choices=["x86_64", "aarch64"])
    parser.add_argument("--identity", required=True, help="JSON file describing the source")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    identity = json.loads(Path(args.identity).read_text())
    target, version = pack(args.prefix, args.label, args.arch, identity, args.out)
    print(f"pack-wpe-overlay: {target} (WPE WebKit {version})")


if __name__ == "__main__":
    main()
