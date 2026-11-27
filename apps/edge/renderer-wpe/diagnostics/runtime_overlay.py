#!/usr/bin/env python3
"""The diagnostic Tilecast overlay: an instrumented renderer and its Runtime.

A Tilecast Edge release before #1946 has no `--visual-trace` in its renderer
and no trace sink in its Runtime, so tracing the real Runtime needs both from a
newer checkout. This module packs them into one archive and checks one on the
screen. The archive carries:

  runtime/bin/tilecast-renderer-wpe        built from one git commit
  runtime/renderer-web/...                 the exact assembled Runtime and bridge
  runtime/tilecast-runtime-overlay.json    commit, hashes, features, builder

and `tilecast_wpe_debug.py runtime-overlay install` mounts it read-only over
the release's own files for the renderer unit only. The release is never
written. See docs/tilecast-edge-wpe-compositor-lab.md.

    runtime_overlay.py pack --renderer BIN --runtime-dir DIR --label NAME
        --arch ARCH --commit HEX --modified-files N [--diff-sha256 HEX]
        [--wpe-version V] --out DIR
"""
import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

MANIFEST = "tilecast-runtime-overlay.json"
SCHEMA = "tilecast-runtime-overlay-v1"
BINARY = "bin/tilecast-renderer-wpe"
WEB_DIR = "renderer-web"
LABEL = re.compile(r"^[a-z0-9][a-z0-9.-]{0,47}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_BYTES = 256 * 1024 * 1024
# The Runtime assembled by renderer-wpe/assemble-runtime.sh, besides its own
# manifest files: the host adapter, the native relay and the trace sink.
HOST_FILES = ("tilecast-bridge.js", "tilecast-native-relay.js", "tilecast-visual-trace.js")
# The renderer's GOption long name for --visual-trace-seconds, and the Runtime's
# global for the sink (packages/player-runtime/src/diagnostics/visual-trace.ts).
BINARY_MARKER = b"visual-trace-seconds"
RUNTIME_MARKER = b"__tilecastVisualTrace"
# src/visual-trace.c keeps "tilecast-build-id:<TILECAST_BUILD_COMMIT>" as one
# NUL-terminated string, so the identity reads back whole and compares exactly.
BUILD_ID = re.compile(rb"tilecast-build-id:([0-9a-z-]{1,64})\0")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def source_id(commit, modified):
    """The identity the binary is built with (TILECAST_BUILD_COMMIT)."""
    return commit + ("-dirty" if modified else "")


def binary_supports_visual_trace(data):
    return BINARY_MARKER in data


def build_id(data):
    """The TILECAST_BUILD_COMMIT a renderer binary was built with, or None.

    None when the binary has no build identity or more than one distinct one.
    """
    found = {match.decode() for match in BUILD_ID.findall(data)}
    return found.pop() if len(found) == 1 else None


def runtime_traceable(read, names):
    """(ok, reason) for a Runtime directory: the sink file, and Runtime code that looks for it.

    read(name) -> bytes; names: the file names of the directory.
    """
    if "tilecast-visual-trace.js" not in names:
        return False, "the Runtime directory has no tilecast-visual-trace.js (the host's trace sink)"
    for name in sorted(names):
        if name.endswith(".js") and name != "tilecast-visual-trace.js" and RUNTIME_MARKER in read(name):
            return True, ""
    return False, "no Runtime script looks for the trace sink (__tilecastVisualTrace)"


def verify_runtime_manifest(files):
    """The Runtime's own manifest against its files, as assemble-runtime.sh does."""
    manifest = json.loads(files["runtime-manifest.json"])
    for entry in manifest["files"]:
        if sha256(files[entry["path"]]) != entry["sha256"]:
            raise ValueError(f"{entry['path']} does not match the runtime manifest")
    return manifest


def read_dir(directory):
    files = {}
    root = Path(directory)
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"{path} is a symbolic link")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = path.read_bytes()
    return files


def build_manifest(label, arch, source, wpe_version, binary, runtime_files):
    files = {f"{WEB_DIR}/{name}": {"sha256": sha256(data)} for name, data in runtime_files.items()}
    files[BINARY] = {"sha256": sha256(binary)}
    return {
        "schema": SCHEMA,
        "label": label,
        "arch": arch,
        "source": source,
        "builtAgainstWpe": wpe_version,
        "features": ["visual-trace"],
        "binary": {"path": BINARY, "sha256": sha256(binary), "size": len(binary)},
        "runtime": {"manifestSha256": sha256(runtime_files["runtime-manifest.json"]),
                    "files": {name: sha256(data) for name, data in sorted(runtime_files.items())}},
        "files": files,
    }


def pack(renderer, runtime_dir, label, arch, commit, modified_files, diff_sha256, wpe_version, out_dir):
    if not LABEL.match(label):
        raise ValueError("--label must be lower-case letters, digits, '.' and '-'")
    if not COMMIT.match(commit):
        raise ValueError("--commit must be a full 40-digit git commit")
    if modified_files and not (diff_sha256 and SHA256.match(diff_sha256)):
        raise ValueError("a build from modified files needs --diff-sha256")
    binary = Path(renderer).read_bytes()
    if not binary_supports_visual_trace(binary):
        raise ValueError("the renderer binary has no --visual-trace option; build it from a checkout with #1946")
    identity = source_id(commit, bool(modified_files))
    if build_id(binary) != identity:
        raise ValueError(f"the renderer binary was not built with TILECAST_BUILD_COMMIT={identity} "
                         f"(it says {build_id(binary) or 'nothing readable'})")
    runtime_files = read_dir(runtime_dir)
    for name in ("runtime-manifest.json", "index.html", *HOST_FILES):
        if name not in runtime_files:
            raise ValueError(f"the Runtime directory has no {name}")
    verify_runtime_manifest(runtime_files)
    ok, reason = runtime_traceable(lambda name: runtime_files[name], list(runtime_files))
    if not ok:
        raise ValueError(reason)
    source = {"commit": commit, "modifiedFiles": modified_files, "diffSha256": diff_sha256 if modified_files else None}
    manifest = build_manifest(label, arch, source, wpe_version, binary, runtime_files)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"tilecast-runtime-overlay-{label}-{arch}.tar"
    entries = {f"runtime/{BINARY}": (binary, 0o755), f"runtime/{MANIFEST}":
               ((json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode(), 0o644)}
    for name, data in runtime_files.items():
        entries[f"runtime/{WEB_DIR}/{name}"] = (data, 0o644)
    with tarfile.open(target, "w") as archive:
        for name in sorted(entries):
            data, mode = entries[name]
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime, info.uid, info.gid = len(data), mode, 0, 0, 0
            archive.addfile(info, io.BytesIO(data))
    digest = sha256(target.read_bytes())
    (out / f"{target.name}.sha256").write_text(f"{digest}  {target.name}\n")
    return target, manifest


class Invalid(Exception):
    """An archive the screen's tool will not install."""


def read_tar(data, arch):
    """Checks an archive and returns (manifest, {relative path: bytes}).

    Only regular files under runtime/, no absolute paths, no '..'; every file
    listed in the manifest with its hash and nothing else; the binary and the
    Runtime consistent with their own claims.
    """
    files = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive.getmembers():
                name = member.name
                parts = Path(name).parts
                if name.startswith("/") or ".." in parts or not parts or parts[0] != "runtime":
                    raise Invalid(f"member outside runtime/: {name}")
                if member.isdir():
                    continue
                if not member.isfile():
                    raise Invalid(f"member is not a regular file: {name}")
                total += member.size
                if total > MAX_BYTES:
                    raise Invalid("the archive is larger than the 256 MiB bound")
                files["/".join(parts[1:])] = archive.extractfile(member).read()
    except (tarfile.TarError, EOFError, OSError, UnicodeError) as error:
        raise Invalid(f"the archive is not a readable tar file ({error})")
    raw = files.pop(MANIFEST, None)
    if raw is None:
        raise Invalid(f"the archive has no {MANIFEST}")
    try:
        manifest = json.loads(raw)
    except ValueError as error:
        raise Invalid(f"the manifest is not JSON ({error})")
    if not isinstance(manifest, dict):
        raise Invalid("the manifest is not a JSON object")
    if manifest.get("schema") != SCHEMA or not LABEL.match(str(manifest.get("label", ""))):
        raise Invalid(f"the manifest is not a {SCHEMA} manifest with a valid label")
    if manifest.get("arch") != arch:
        raise Invalid(f"the archive is for {manifest.get('arch')}, this screen is {arch}")
    source = manifest.get("source") or {}
    if not COMMIT.match(str(source.get("commit", ""))):
        raise Invalid("the manifest does not name a full git commit")
    listed = manifest.get("files", {})
    if not isinstance(listed, dict) or set(listed) != set(files):
        raise Invalid("the archive files do not match its manifest")
    for path, entry in listed.items():
        if not isinstance(entry, dict) or sha256(files[path]) != entry.get("sha256"):
            raise Invalid(f"{path} does not match its manifest hash")
    binary = files.get(BINARY)
    if binary is None:
        raise Invalid(f"the archive has no {BINARY}")
    # The installer reads this record after it restarts the renderer, so it is
    # checked against the binary's bytes here, before anything changes.
    if manifest.get("binary") != {"path": BINARY, "sha256": sha256(binary), "size": len(binary)}:
        raise Invalid("the manifest's binary record does not match the renderer in the archive")
    if not binary_supports_visual_trace(binary):
        raise Invalid("the renderer in this archive has no --visual-trace option")
    identity = source_id(source["commit"], bool(source.get("modifiedFiles")))
    if build_id(binary) != identity:
        raise Invalid("the renderer was not built from the commit the manifest names")
    web = {path[len(WEB_DIR) + 1:]: content for path, content in files.items() if path.startswith(WEB_DIR + "/")}
    for name in ("runtime-manifest.json", "index.html", *HOST_FILES):
        if name not in web:
            raise Invalid(f"the archive has no Runtime file {name}")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("files") != {
            name: sha256(content) for name, content in sorted(web.items())}:
        raise Invalid("the Runtime file list in the manifest does not match the archive")
    if runtime.get("manifestSha256") != sha256(web["runtime-manifest.json"]):
        raise Invalid("the manifest's Runtime manifest hash does not match the archive")
    try:
        verify_runtime_manifest(web)
    except (KeyError, ValueError, TypeError) as error:
        raise Invalid(f"the Runtime does not match its own manifest: {error}")
    ok, reason = runtime_traceable(lambda name: web[name], list(web))
    if not ok:
        raise Invalid(reason)
    files[MANIFEST] = raw
    return manifest, files


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    pack_parser = sub.add_parser("pack")
    for name in ("renderer", "runtime-dir", "label", "arch", "commit", "out"):
        pack_parser.add_argument(f"--{name}", required=True)
    pack_parser.add_argument("--modified-files", type=int, default=0)
    pack_parser.add_argument("--diff-sha256")
    pack_parser.add_argument("--wpe-version")
    args = parser.parse_args(argv)
    try:
        target, manifest = pack(args.renderer, args.runtime_dir, args.label, args.arch, args.commit,
                                args.modified_files, args.diff_sha256, args.wpe_version, args.out)
    except (ValueError, KeyError) as error:
        print(f"runtime_overlay: {error}", file=sys.stderr)
        return 1
    print(f"runtime_overlay: {target} ({manifest['source']['commit'][:12]}"
          f"{', modified' if manifest['source']['modifiedFiles'] else ''}, {len(manifest['files'])} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
