"""Headless smoke run of every compositor-lab scene (ci/run-e2e.sh).

It checks the lab's plumbing on a real engine: the scene loads, sends its
palette and markers, completes its iterations, and the lab inspects presented
buffers and writes a bounded summary and timeline. It does not judge the
engine: a headless pass says nothing about a DRM screen
(docs/tilecast-edge-wpe-compositor-lab.md), so a scene that finds anomalies
here still passes the smoke run, and the anomalies are printed.

    python3 lab_smoke.py --lab BUILD/tilecast-wpe-compositor-lab
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.join(HERE, "..", "lab", "scenes")
RUNS = [
    ("opacity-basic", None),
    ("opacity-basic", "busy-end"),
    ("crossfade", None),
    ("crossfade-cleanup-variants", "retain-animation:outgoing-2f"),
    ("crossfade-cleanup-variants", "image:no-pin"),
    ("transform-3d", "cross-camera"),
    ("startup-minimal", None),
    ("video-crossfade", None),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", required=True)
    args = parser.parse_args()
    env = dict(os.environ)
    # Containers without user namespaces; the lab binary is a development build.
    env.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
    with tempfile.TemporaryDirectory() as work:
        scenes = os.path.join(work, "scenes")
        shutil.copytree(SCENES, scenes, ignore=shutil.ignore_patterns("media"))
        subprocess.run([os.path.join(HERE, "..", "lab", "make-media.sh"), os.path.join(scenes, "media")], check=True)
        for scene, variant in RUNS:
            out = os.path.join(work, f"{scene}-{variant or 'default'}".replace(":", "_"))
            command = [args.lab, "--platform=headless", f"--scene={scene}", "--iterations=2", "--size=640x360",
                       f"--out={out}", f"--scenes-dir={scenes}", "--inspect=all", "--timeout=240"]
            if variant:
                command.append(f"--variant={variant}")
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=300)
            assert result.returncode in (0, 3), (scene, variant, result.returncode, result.stderr[-3000:])
            summary = json.load(open(os.path.join(out, "summary.json")))
            assert summary["schema"] == "tilecast-compositor-lab-v1", summary
            assert summary["result"] in ("pass", "anomalies"), summary["result"]
            assert summary["iterationsCompleted"] == 2, summary
            assert summary["transitions"] >= 2 and summary["markers"] > 4, summary
            assert summary["pacing"]["frames"] > 10 and summary["import"]["count"] > 0, summary
            assert summary["import"]["failures"] == 0, summary["import"]
            assert summary["variant"] == variant, summary
            assert os.path.getsize(os.path.join(out, "timeline.jsonl")) < 64 * 1024 * 1024
            print(f"lab: {scene} {variant or ''}: {summary['result']}, {summary['pacing']['frames']} frames, "
                  f"anomalies {summary['anomalies']['byKind']}, WebKit {summary['webkit']}")
        # Refusals: unknown scene, bad variant, relative output.
        for bad in (["--scene=other"], ["--scene=crossfade", "--variant=has space"]):
            result = subprocess.run([args.lab, *bad, f"--out={work}/x"], env=env, capture_output=True)
            assert result.returncode == 4, bad
        result = subprocess.run([args.lab, "--scene=crossfade", "--out=relative"], env=env, capture_output=True)
        assert result.returncode == 4
        result = subprocess.run([args.lab, "--scene=crossfade", f"--out={work}/y", "--inspector=0.0.0.0:9222"],
                                env=env, capture_output=True)
        assert result.returncode == 4, "the lab accepted a non-loopback inspector address"
    print("lab: smoke runs passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
