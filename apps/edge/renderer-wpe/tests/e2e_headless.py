#!/usr/bin/env python3
"""Headless end-to-end test: tilecastd + tilecast-renderer-wpe (WPEPlatform).

Starts a real daemon and a real renderer on WPE_PLATFORM=headless, then
observes the renderer lifecycle only through `tilecastctl --json status`,
exactly as an operator would. Scenarios:

  status   the status surface activates and produces meaningful evidence
  fixture  a CAS-backed playlist (image, H.264 video, render tree, layout)
           activates, and the renderer reports item evidence for each kind
  reconnect  killing the renderer does not disturb the daemon; a new
             renderer receives the same activation (generation unchanged)
  selftest   `tilecastd self-test` (the migration's release self-test) passes
             only after the renderer proves every fixture item, and fails
             with a typed reason when no renderer connects

Usage: e2e_headless.py --bin-dir DIR --renderer PATH --runtime-dir DIR
                       [--scenario status|fixture|reconnect|all]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time


def wait_for(description, predicate, timeout=60.0, interval=0.25):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as error:  # noqa: BLE001 - reported below
            last = error
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {description}; last={last!r}")


class Stack:
    def __init__(self, args, workdir, fixture=None):
        self.args = args
        self.workdir = workdir
        self.socket = os.path.join(workdir, "run", "edge.sock")
        self.config = os.path.join(workdir, "edge.toml")
        lines = [
            "[paths]",
            f'state_dir = "{workdir}/state"',
            f'runtime_dir = "{workdir}/run"',
            "[renderer]",
            f'binary = "{args.renderer}"',
            "stall_threshold_seconds = 60",
            "[log]",
            'level = "info"',
            'format = "text"',
        ]
        if fixture:
            lines += ["[dev]", f'fixture = "{fixture}"']
        with open(self.config, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        self.daemon = None
        self.renderer = None
        self.logs = []

    def start_daemon(self):
        log = open(os.path.join(self.workdir, "tilecastd.log"), "w", encoding="utf-8")
        self.logs.append(log.name)
        self.daemon = subprocess.Popen(
            [os.path.join(self.args.bin_dir, "tilecastd"), "--config", self.config, "run"],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        wait_for("daemon socket", lambda: os.path.exists(self.socket), timeout=30)

    def start_renderer(self, run_dir=None):
        run_dir = run_dir or os.path.join(self.workdir, "run")
        log = open(os.path.join(self.workdir, "renderer.log"), "a", encoding="utf-8")
        self.logs.append(log.name)
        env = dict(os.environ)
        # Containers without unprivileged user namespaces cannot run WebKit's
        # bubblewrap sandbox. CI only; production keeps the sandbox.
        env.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
        self.renderer = subprocess.Popen(
            [
                self.args.renderer,
                "--platform=headless",
                f"--socket={os.path.join(run_dir, 'edge.sock')}",
                f"--media-socket={os.path.join(run_dir, 'media.sock')}",
                f"--runtime-dir={self.args.runtime_dir}",
                f"--gst-plugin-dir={self.args.gst_plugin_dir}",
                "--headless-size=1280x720",
                "--console",
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )

    def ctl(self, *command):
        output = subprocess.run(
            [os.path.join(self.args.bin_dir, "tilecastctl"), "--socket", self.socket, "--json", *command],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return json.loads(output.stdout)

    def status(self):
        return self.ctl("status")

    def stop(self):
        for process in (self.renderer, self.daemon):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()

    def dump_logs(self):
        for name in dict.fromkeys(self.logs):
            print(f"----- {name} -----")
            with open(name, encoding="utf-8", errors="replace") as handle:
                print(handle.read()[-6000:])


def healthy(stack):
    status = stack.status()
    renderer = status["renderer"]
    return status if renderer["state"] == "healthy" else None


def scenario_status(args):
    with tempfile.TemporaryDirectory() as workdir:
        stack = Stack(args, workdir)
        try:
            stack.start_daemon()
            stack.start_renderer()
            status = wait_for("healthy renderer on the status surface", lambda: healthy(stack))
            renderer = status["renderer"]
            assert renderer["platform"] == "headless", renderer
            assert renderer["kind"] == "wpe", renderer
            print(f"status: renderer healthy, generation {renderer['currentActivationGeneration']}")
            # Clean shutdown of the daemon leaves the renderer waiting to reconnect.
            stack.daemon.terminate()
            assert stack.daemon.wait(timeout=20) == 0, "tilecastd exits 0 on SIGTERM"
            time.sleep(1)
            assert stack.renderer.poll() is None, "renderer survives a daemon stop"
            stack.start_daemon()
            wait_for("renderer reconnects after daemon restart", lambda: healthy(stack))
            print("status: renderer reconnected after daemon restart")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def scenario_reconnect(args):
    with tempfile.TemporaryDirectory() as workdir:
        stack = Stack(args, workdir)
        try:
            stack.start_daemon()
            stack.start_renderer()
            before = wait_for("healthy renderer", lambda: healthy(stack))["renderer"]
            stack.renderer.kill()
            stack.renderer.wait(timeout=10)
            wait_for("daemon notices the renderer is gone", lambda: not stack.status()["renderer"]["connected"])
            assert stack.daemon.poll() is None, "daemon unaffected by a renderer crash"
            stack.start_renderer()
            after = wait_for("healthy renderer after restart", lambda: healthy(stack))["renderer"]
            assert after["currentActivationGeneration"] == before["currentActivationGeneration"], (before, after)
            print("reconnect: same activation restored after renderer crash")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def build_fixture(workdir):
    """Copies the playlist fixture and generates its media with ffmpeg."""
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "playlist.json")
    fixture_dir = os.path.join(workdir, "fixture")
    media = os.path.join(fixture_dir, "media")
    os.makedirs(media)
    with open(source, encoding="utf-8") as handle, open(
        os.path.join(fixture_dir, "playlist.json"), "w", encoding="utf-8"
    ) as out:
        out.write(handle.read())
    run = lambda *argv: subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *argv], check=True)  # noqa: E731
    run("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1", os.path.join(media, "still.png"))
    run(
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4",
        "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        os.path.join(media, "clip.mp4"),
    )
    return os.path.join(fixture_dir, "playlist.json")


def scenario_fixture(args):
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        stack = Stack(args, workdir, fixture=fixture)
        try:
            stack.start_daemon()
            stack.start_renderer()
            status = wait_for("fixture activation", lambda: healthy(stack), timeout=90)
            # The renderer can be healthy on the setup surface before the
            # fixture task has imported and pinned both media files.
            wait_for(
                "the fixture's media verified and pinned",
                lambda: (lambda c: c if c["objectCount"] >= 2 and c["pinnedBytes"] > 0 else None)(stack.ctl("cache")),
                timeout=60,
            )
            evidence = wait_for(
                "evidence for every item kind",
                lambda: fixture_evidence(stack),
                timeout=120,
                interval=1.0,
            )
            presentation = wait_for(
                "the fixture accepted with evidence in status",
                lambda: (lambda p: p if p and p["accepted"] and p["evidence"] else None)(
                    stack.status().get("presentation")
                ),
            )
            assert presentation["source"] == "fixture", presentation
            status = stack.status()
            assert presentation["generation"] == status["renderer"]["currentActivationGeneration"], presentation
            assert status["renderer"].get("engineVersion") and status["renderer"].get("gstreamerVersion"), status
            print(f"fixture: generation {status['renderer']['currentActivationGeneration']}, evidence {sorted(evidence)}")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def run_self_test(args, workdir, fixture, timeout, with_renderer):
    stack = Stack(args, workdir)
    run_dir = os.path.join(workdir, "selftest")
    os.makedirs(run_dir, mode=0o750)
    log = open(os.path.join(workdir, "selftest.log"), "w", encoding="utf-8")
    stack.logs.append(log.name)
    host = subprocess.Popen(
        [os.path.join(args.bin_dir, "tilecastd"), "--config", stack.config, "self-test",
         f"--fixture={fixture}", f"--runtime-dir={run_dir}", f"--timeout-seconds={timeout}"],
        stdout=subprocess.PIPE, stderr=log, text=True,
    )
    try:
        if with_renderer:
            wait_for("self-test socket", lambda: os.path.exists(os.path.join(run_dir, "edge.sock")), timeout=30)
            stack.start_renderer(run_dir)
        output, _ = host.communicate(timeout=timeout + 30)
        report = json.loads(output.strip().splitlines()[-1])
        return host.returncode, report, stack
    except Exception:
        host.kill()
        stack.dump_logs()
        raise
    finally:
        stack.stop()


def scenario_selftest(args):
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        code, report, stack = run_self_test(args, workdir, fixture, 120, with_renderer=True)
        if code != 0 or report["outcome"] != "passed":
            stack.dump_logs()
            raise AssertionError(f"self-test failed: {report}")
        assert report["expectedItems"] == report["provenItems"] and len(report["expectedItems"]) == 4, report
        renderer = report["renderer"]
        assert renderer["platform"] == "headless" and "video" in renderer["features"], renderer
        assert renderer["engineVersion"] and renderer["gstreamerVersion"], renderer
        assert not os.path.exists(os.path.join(workdir, "state")), "the self-test never touches installation state"
        print(f"selftest: passed in {report['elapsedMs']} ms, items {report['provenItems']}, "
              f"WPE {renderer['engineVersion']}, GStreamer {renderer['gstreamerVersion']}")
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        code, report, _ = run_self_test(args, workdir, fixture, 10, with_renderer=False)
        assert code == 1 and report["outcome"] == "failed" and report["reason"] == "renderer_not_ready", report
        print("selftest: without a renderer it fails with renderer_not_ready")


def fixture_evidence(stack):
    # The daemon logs each meaningful evidence kind it accepts once per item.
    seen = set()
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "evidence_accepted" in line:
                for kind in ("image_shown", "video_progress", "widget_shown", "layout_shown", "item_transition"):
                    if kind in line:
                        seen.add(kind)
    required = {"image_shown", "video_progress", "widget_shown", "layout_shown", "item_transition"}
    return seen if required <= seen else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", required=True)
    parser.add_argument("--renderer", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--gst-plugin-dir", required=True)
    parser.add_argument("--scenario", default="all")
    args = parser.parse_args()
    scenarios = {
        "status": scenario_status,
        "reconnect": scenario_reconnect,
        "fixture": scenario_fixture,
        "selftest": scenario_selftest,
    }
    selected = scenarios.values() if args.scenario == "all" else [scenarios[args.scenario]]
    for scenario in selected:
        scenario(args)
    print("e2e: all scenarios passed")


if __name__ == "__main__":
    sys.exit(main())
