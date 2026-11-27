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
            assert summary["inspection"]["framesChecked"] > 0, summary["inspection"]
            assert summary["variant"] == variant, summary
            assert os.path.getsize(os.path.join(out, "timeline.jsonl")) < 64 * 1024 * 1024
            print(f"lab: {scene} {variant or ''}: {summary['result']}, {summary['pacing']['frames']} frames, "
                  f"anomalies {summary['anomalies']['byKind']}, WebKit {summary['webkit']}")
        # Refusals, each checked by its own message so another validation
        # failure cannot satisfy it. Every one passes the real scenes directory.
        refusals = [
            (["--scene=other"], "--scene must be one of"),
            (["--scene=crossfade", "--variant=has space"], "--variant must be a short name"),
            # The baseline crossfade reads no variant; a misspelled one is not silently recorded.
            (["--scene=crossfade", "--variant=busy-end"], "crossfade takes no variant"),
            (["--scene=crossfade-cleanup-variants", "--variant=retain-animaton"], "crossfade-cleanup-variants takes"),
            (["--scene=crossfade", "--grid=65536x65536"], "--grid must be CxR"),
            (["--scene=crossfade", "--inspector=0.0.0.0:9222"], "--inspector takes 127.0.0.1:PORT"),
        ]
        for bad, message in refusals:
            result = subprocess.run([args.lab, *bad, f"--out={work}/x", f"--scenes-dir={scenes}"], env=env,
                                    capture_output=True, text=True)
            assert result.returncode == 4 and message in result.stderr, (bad, result.returncode, result.stderr[-500:])
        result = subprocess.run([args.lab, "--scene=crossfade", "--out=relative", f"--scenes-dir={scenes}"], env=env,
                                capture_output=True, text=True)
        assert result.returncode == 4 and "--out must be a clean absolute path" in result.stderr, result.stderr
        # A scenes directory without the scene's page is a setup failure at
        # once, not a wait for the timeout.
        partial = os.path.join(work, "partial-scenes")
        shutil.copytree(scenes, partial)
        os.remove(os.path.join(partial, "opacity-basic.html"))
        out = os.path.join(work, "missing-scene")
        result = subprocess.run([args.lab, "--platform=headless", "--scene=opacity-basic", "--size=640x360",
                                 f"--out={out}", f"--scenes-dir={partial}", "--timeout=200"],
                                env=env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 4 and "cannot load scene opacity-basic" in result.stderr, result.stderr[-1000:]
        assert json.load(open(os.path.join(out, "summary.json")))["result"] == "scene_not_found"
    print("lab: smoke runs passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
