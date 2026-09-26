#!/usr/bin/env python3
"""M8 exit criterion: Activity from Tilecast Edge matches the Electron Linux
Player on the same schedule, as the real server records it.

Runs in the tilecast-edge-parity image (ci/Dockerfile.parity) with the
repository at /src (run-activity-parity.sh). One real Tilecast Server, two
screens:

* the Electron Linux Player (apps/player-linux, the real application under a
  virtual framebuffer), paired through the ordinary protocol;
* Tilecast Edge (tilecastd and the WPE renderer, headless), paired the same
  way and imported with `tilecastd import-legacy`.

Both screens get the same playlist, then the same takeover, then lose the
server for a while, so both queue Activity offline and flush it later. The
script then compares what the server derived for each screen: proof-of-play
sessions (their kinds, content, triggers, terminal reasons and durations),
the screen-state intervals of the outage, and playback compliance.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_server as e2e  # noqa: E402

ITEM_MS = 4000
TAKEOVER_ITEM_MS = 5000
# The server judges an expected-playback window only when it lasts at least
# two minutes, and a window opens when that player first reports the
# manifest. Each phase outlasts that from the moment the later player plays,
# so both players' windows are measured.
PHASE_S = 130
# Over a common window the players differ only by when each reconnected
# after the outage (both use a 2 s jittered backoff) and a few item
# boundaries.
MISSED_TOLERANCE_MS = 15_000


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pair(client, installation_id, player_id, platform):
    player = e2e.Client()
    metadata = {"playerInstallationId": player_id, "platform": platform, "manufacturer": "parity",
                "model": "Linux x64", "androidVersion": "6.8.0-parity", "playerVersion": "0.1.0",
                "screenWidth": 1280, "screenHeight": 720, "density": 1, "locale": "en-US", "timezone": "UTC"}
    session = player.call("POST", "/api/v1/player/pairing-sessions",
                          {"installationId": installation_id, "metadata": metadata}, expect=201)[1]["data"]
    resolved = client.call("POST", "/api/v1/screens/pairing/resolve", {"code": session["code"]}, expect=200)[1]
    client.call("POST", f"/api/v1/screens/pairing/{resolved['data']['id']}/approve",
                {"name": f"Parity {platform}"}, expect=200)
    poll = player.call("GET", f"/api/v1/player/pairing-sessions/{session['id']}",
                       headers={"Authorization": f"Pairing {session['pollSecret']}"}, expect=200)[1]
    return player.call("POST", "/api/v1/player/enroll", {"pairingSessionId": session["id"],
                       "enrollmentToken": poll["data"]["enrollmentToken"]}, expect=201)[1]["data"]


def legacy_state(directory, player_id, installation_id, enrolled, server_url=e2e.BASE + "/"):
    os.makedirs(os.path.join(directory, "cache", "media"), mode=0o700, exist_ok=True)
    files = {
        "installation.json": {"playerInstallationId": player_id},
        "credential.json": {"serverUrl": server_url, "installationId": installation_id,
                            "screenId": enrolled["screenId"], "screenName": enrolled["screenName"],
                            "deviceCredential": enrolled["deviceCredential"], "enrolledAt": "2026-09-25T00:00:00Z"},
        "executed-commands.json": {"keys": []},
        "playback-flags.json": {"playbackDisabled": False},
    }
    for name, value in files.items():
        with open(os.path.join(directory, name), "w") as handle:
            json.dump(value, handle)
        os.chmod(os.path.join(directory, name), 0o600)


def sessions(client, screen_id, since, until):
    out, cursor = [], None
    while True:
        query = f"/api/v1/activity/proof-of-play?screen={screen_id}&from={iso(since)}&to={iso(until)}&limit=200"
        if cursor:
            query += f"&cursor={cursor}"
        page = client.call("GET", query, expect=200)[1]["data"]
        out.extend(page["items"])
        cursor = page.get("nextCursor")
        if not cursor:
            return out


BOUNDARY_STUB_MS = 250


def summarize(records):
    """What the server derived, without per-screen identifiers or times.

    Sessions shorter than BOUNDARY_STUB_MS are left out: when a presentation
    changes on an item boundary, a player can report the restart of the
    outgoing item a few milliseconds before the switch. The Electron player
    attributes that restart to the incoming presentation (as content type
    `media`, because the item is not in it); Edge ignores evidence for an
    activation it has replaced. Neither is a play anyone saw. A takeover can
    interrupt a real item just after it starts, so retain that terminal reason
    even when its short session is excluded from play counts.
    """
    roots = Counter()
    items = Counter()
    reasons = set()
    boundary_ms = []
    for record in records:
        reason = record.get("terminalReason") or "open"
        if record.get("sessionType") == "presentation":
            roots[(record.get("presentationId"), record.get("trigger"), reason)] += 1
            continue
        duration = record.get("actualDurationMs")
        if duration is not None and duration < BOUNDARY_STUB_MS:
            if reason == "takeover":
                reasons.add((record.get("trigger"), reason))
            continue
        items[(record.get("trigger"), record.get("contentType"), record.get("playlistItemId"))] += 1
        reasons.add((record.get("trigger"), reason))
        if reason == "expected_item_boundary" and duration:
            boundary_ms.append(duration)
    return roots, items, reasons, boundary_ms


def print_item_gaps(label, records, outage):
    """Where a player's item sessions leave time uncovered, relative to the
    outage, so a missing play can be placed."""
    items = sorted((stamp(r["startedAt"]), r.get("actualDurationMs") or 0, r.get("trigger"), r.get("terminalReason"))
                   for r in records if r.get("sessionType") != "presentation")
    if not items:
        return
    t0 = items[0][0]
    gaps = []
    for (start, duration, trigger, reason), (next_start, *_rest) in zip(items, items[1:]):
        uncovered = next_start - start - duration / 1000
        if uncovered > 1.0:
            gaps.append(f"{start - t0:.1f}+{duration / 1000:.1f}s {trigger}/{reason} then {uncovered:.1f}s uncovered")
    print(f"parity {label}: first item at {t0:.1f}, outage {outage[0] - t0:.1f}-{outage[1] - t0:.1f} s; "
          f"gaps: {gaps or 'none'}")


def compare(electron, edge, outage):
    """The M8 exit criterion, on the records the server holds."""
    for label, records in (("electron", electron), ("edge", edge)):
        print_item_gaps(label, records, outage)
    (e_roots, e_items, e_reasons, e_boundary), (d_roots, d_items, d_reasons, d_boundary) = (
        summarize(electron), summarize(edge))
    # The same presentations, triggers and endings.
    assert e_roots == d_roots, f"root sessions differ: {e_roots} vs {d_roots}"
    # The same items under the same trigger. The players are not
    # phase-locked: when one is an item ahead, a different item is on screen
    # when the takeover interrupts and when the run ends, which moves two
    # per-item counts by one each. Per trigger, the plays agree within one.
    assert set(e_items) == set(d_items), f"item sessions differ: {set(e_items) ^ set(d_items)}"
    for key in e_items:
        assert abs(e_items[key] - d_items[key]) <= 2, f"{key}: electron {e_items[key]}, edge {d_items[key]}"
    for trigger in {key[0] for key in e_items}:
        plays = [sum(count for key, count in counter.items() if key[0] == trigger) for counter in (e_items, d_items)]
        assert abs(plays[0] - plays[1]) <= 1, f"{trigger}: electron {plays[0]} plays, edge {plays[1]}"
    # The same ways an item ended, per trigger.
    assert e_reasons == d_reasons, f"item endings differ: {e_reasons ^ d_reasons}"
    assert ("direct", "takeover") in d_reasons, "the takeover interrupted the loop on both"
    # Item boundaries at the scheduled durations.
    for label, durations in (("electron", e_boundary), ("edge", d_boundary)):
        wrong = [ms for ms in durations if min(abs(ms - ITEM_MS), abs(ms - TAKEOVER_ITEM_MS)) > 600]
        assert durations and not wrong, f"{label}: boundaries off the schedule: {wrong}"
    # Activity from the outage reached the server afterwards, for both.
    for label, records in (("electron", electron), ("edge", edge)):
        during = [r for r in records if outage[0] <= stamp(r["startedAt"]) <= outage[1]]
        assert during, f"{label}: no session started during the outage reached the server"
        print(f"parity {label}: {len(during)} sessions from the outage flushed after it")
    print(f"parity: {sum(d_roots.values())} root sessions and {sum(d_items.values())} item sessions match")


# The results the server counts as confirmed playback
# (matchExpectedWindow in apps/server/internal/httpapi/expected_playback.go).
CONFIRMING_RESULTS = ("playing", "completed", "recovered", "partial", "failed")


def query(sql):
    out = subprocess.run(["psql", "-At", "-F", "|", e2e.DATABASE, "-c", sql],
                         capture_output=True, text=True, check=True).stdout
    return [line.split("|") for line in out.splitlines()]


def expected_windows(screen):
    """The server's judged expected-playback windows for a screen, in order:
    (manifest version, status, start ms, end ms, confirmed ms, superseded
    reason)."""
    rows = query(
        "SELECT manifest_version, match_status, (EXTRACT(EPOCH FROM expected_start) * 1000)::bigint, "
        "(EXTRACT(EPOCH FROM expected_end) * 1000)::bigint, confirmed_duration_ms, superseded_reason "
        f"FROM expected_playback_windows WHERE screen_id='{screen}' AND expected_end IS NOT NULL "
        "ORDER BY expected_start")
    return [(int(v or 0), status, int(start), int(end), int(confirmed or 0), reason)
            for v, status, start, end, confirmed, reason in rows]


def root_sessions(screen):
    """Root presentation sessions as the server stores them: (start ms, end
    ms or None, result)."""
    rows = query(
        "SELECT (EXTRACT(EPOCH FROM started_at) * 1000)::bigint, (EXTRACT(EPOCH FROM ended_at) * 1000)::bigint, "
        f"result FROM playback_sessions WHERE screen_id='{screen}' AND session_type='presentation' "
        "ORDER BY started_at")
    return [(int(start), int(end) if end else None, result) for start, end, result in rows]


def covered(roots, start, end):
    """Milliseconds of [start, end) covered by root sessions the server
    counts as playback: the numerator of its window match."""
    total = 0
    for s, e, result in roots:
        if result in CONFIRMING_RESULTS:
            total += max(0, min(e if e is not None else end, end) - max(s, start))
    return total


def compare_windows(electron, edge, t0):
    """Each player's heartbeat runs on its own 60 s phase, and a window opens
    and closes on the heartbeat that reports the change, so the two screens'
    windows for one manifest start and end up to a minute apart. Their
    expected and missed times therefore differ by design. What must match is
    playback: over the interval both screens' windows for a manifest share,
    each player's confirmed root-session coverage, as the server counts it."""
    for label, data in (("electron", electron), ("edge", edge)):
        print(f"parity {label} windows (s from start): " + "; ".join(
            f"v{v} {status} {(s - t0) / 1000:.1f}-{(e - t0) / 1000:.1f} confirmed {c / 1000:.1f} ({reason})"
            for v, status, s, e, c, reason in data["windows"]))
        print(f"parity {label} root sessions (s from start): " + "; ".join(
            f"{(s - t0) / 1000:.1f}-{'open' if e is None else f'{(e - t0) / 1000:.1f}'} {result}"
            for s, e, result in data["roots"]))
    compared = 0
    for version in sorted({w[0] for w in electron["windows"]} & {w[0] for w in edge["windows"]}):
        e_windows = [w for w in electron["windows"] if w[0] == version]
        d_windows = [w for w in edge["windows"] if w[0] == version]
        for e_window, d_window in zip(e_windows, d_windows):
            start, end = max(e_window[2], d_window[2]), min(e_window[3], d_window[3])
            if end - start < 60_000:
                continue
            e_missed = (end - start) - covered(electron["roots"], start, end)
            d_missed = (end - start) - covered(edge["roots"], start, end)
            print(f"parity v{version} common {(start - t0) / 1000:.1f}-{(end - t0) / 1000:.1f} s: "
                  f"missed electron {e_missed} ms, edge {d_missed} ms")
            assert abs(e_missed - d_missed) <= MISSED_TOLERANCE_MS, \
                f"manifest {version} missed over the common window: electron {e_missed} ms, edge {d_missed} ms"
            compared += 1
    assert compared, "no manifest had a common window of a minute on both screens"
    print(f"parity: {compared} common expected-playback windows played alike")


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    work = tempfile.mkdtemp(prefix="tilecast-parity-")
    processes = []
    target = os.path.join(os.environ.get("CARGO_TARGET_DIR", os.path.join(e2e.EDGE, "target")), "debug")
    renderer_bin, runtime, gst = "/target/renderer/tilecast-renderer-wpe", "/target/runtime", "/target/renderer/gstreamer-1.0"
    try:
        e2e.run("dropdb", "--if-exists", e2e.DATABASE)
        e2e.run("createdb", e2e.DATABASE)
        server_bin = os.path.join(work, "tilecast")
        e2e.run("go", "build", "-o", server_bin, "./cmd/tilecast", cwd=e2e.SERVER)
        e2e.run("cargo", "build", "-q", "-p", "tilecastd", "-p", "tilecastctl", cwd=e2e.EDGE)
        tilecastd = os.path.join(target, "tilecastd")
        env = dict(os.environ, TILECAST_DATABASE_URL=f"postgres://localhost:5432/{e2e.DATABASE}?sslmode=disable",
                   TILECAST_HTTP_ADDR=f"127.0.0.1:{e2e.PORT}", TILECAST_PUBLIC_URL=e2e.BASE,
                   TILECAST_MDNS_ENABLED="false", TILECAST_MEDIA_ROOT=os.path.join(work, "server-media"),
                   TILECAST_UPDATE_ROOT=os.path.join(work, "server-updates"),
                   TILECAST_BACKUP_ROOT=os.path.join(work, "server-backups"),
                   TILECAST_FFMPEG_PATH=shutil.which("ffmpeg"), TILECAST_FFPROBE_PATH=shutil.which("ffprobe"),
                   # A CI container's disk is small; the media here is a few KiB.
                   TILECAST_MEDIA_RESERVED_FREE_BYTES=str(64 * 1024 * 1024))
        server_log = open(os.path.join(work, "server.log"), "a")

        def start_server():
            process = subprocess.Popen([server_bin], env=env, stdout=server_log, stderr=subprocess.STDOUT)
            processes.append(process)
            e2e.wait_for(lambda: e2e.Client().call("GET", "/readyz")[0] == 200, "server readiness")
            return process

        server = start_server()
        client = e2e.Client()
        created = client.call("POST", "/api/v1/auth/setup", {"organizationName": "Parity Library",
                              "ownerName": "Parity", "username": "owner",
                              "password": "correct horse battery staple"}, expect=201)[1]["data"]
        client.csrf = created["csrfToken"]
        installation_id = client.call("GET", "/api/v1/system/identity", expect=200)[1]["data"]["installationId"]

        electron_id, edge_id = str(uuid.uuid4()), str(uuid.uuid4())
        electron = pair(client, installation_id, electron_id, "linux")
        edge = pair(client, installation_id, edge_id, "linux")

        media = os.path.join(work, "media")
        os.makedirs(media)
        for name, source in (("left.png", "testsrc"), ("right.png", "smptebars"), ("alert.png", "rgbtestsrc")):
            e2e.run("ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"{source}=size=1280x720:rate=1",
                    "-frames:v", "1", os.path.join(media, name))
        left = e2e.upload(client, os.path.join(media, "left.png"), "image/png")
        right = e2e.upload(client, os.path.join(media, "right.png"), "image/png")
        alert = e2e.upload(client, os.path.join(media, "alert.png"), "image/png")

        def playlist(name, entries):
            created = client.call("POST", "/api/v1/playlists", {"name": name, "description": "",
                                                                  "sourceType": "static"}, expect=(200, 201))[1]["data"]
            for asset_id, duration in entries:
                created = client.call("POST", f"/api/v1/playlists/{created['id']}/items",
                                      e2e.item(asset_id, duration), expect=(200, 201))[1]["data"]
            client.call("POST", f"/api/v1/playlists/{created['id']}/publish",
                        {"expectedDraftRevision": created["draftRevision"]}, expect=(200, 201))
            return created["id"]

        loop_id = playlist("Parity loop", [(left["id"], ITEM_MS), (right["id"], ITEM_MS)])
        alert_id = playlist("Parity alert", [(alert["id"], TAKEOVER_ITEM_MS)])
        screens = (electron["screenId"], edge["screenId"])
        for screen in screens:
            client.call("PUT", f"/api/v1/screens/{screen}/playlist-assignment", {"playlistId": loop_id}, expect=200)

        # Tilecast Edge: imported the way a migrated screen is.
        edge_legacy = os.path.join(work, "edge-legacy")
        legacy_state(edge_legacy, edge_id, installation_id, edge)
        state, run_dir = os.path.join(work, "edge-state"), os.path.join(work, "edge-run")
        config = os.path.join(work, "edge.toml")
        with open(config, "w") as handle:
            handle.write(f'[paths]\nstate_dir = "{state}"\nruntime_dir = "{run_dir}"\n[log]\nformat = "text"\n'
                         f'[renderer]\nbinary = "{renderer_bin}"\nstall_threshold_seconds = 60\n'
                         f'{e2e.hardware_roots(work)}')
        e2e.run(tilecastd, "--config", config, "import-legacy", "--from", edge_legacy, stdout=subprocess.DEVNULL)
        daemon_log = open(os.path.join(work, "tilecastd.log"), "w")
        processes.append(subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log,
                                          stderr=subprocess.STDOUT))

        class Args:
            renderer, runtime_dir, gst_plugin_dir = renderer_bin, runtime, gst
        processes.append(e2e.Renderer(Args, run_dir, work).start())

        # The Electron Linux Player: the real application.
        electron_data = os.path.join(work, "electron-data")
        # The Electron player compares the saved address literally.
        legacy_state(electron_data, electron_id, installation_id, electron, server_url=e2e.BASE)
        electron_log = open(os.path.join(work, "electron.log"), "w")
        electron_env = dict(os.environ, TILECAST_DATA_DIR=electron_data, TILECAST_SERVER_URL=e2e.BASE,
                            TILECAST_WINDOWED="1", TILECAST_DISABLE_GPU="1", TILECAST_LOG_LEVEL="info")
        processes.append(subprocess.Popen(
            ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", os.environ["TILECAST_ELECTRON"], "--no-sandbox",
             "--disable-gpu", os.path.join(e2e.ROOT, "apps", "player-linux")],
            env=electron_env, stdout=electron_log, stderr=subprocess.STDOUT, start_new_session=True))

        def playing(screen):
            data = client.call("GET", f"/api/v1/screens/{screen}/playlist-assignment", expect=200)[1]["data"] or {}
            return data.get("playerActiveManifestVersion") == data.get("manifestVersion") and data.get("manifestVersion")

        e2e.wait_for(lambda: all(playing(screen) for screen in screens), "both players playing the loop", timeout=240)
        started = time.time()
        print("parity: both players play the loop")
        time.sleep(PHASE_S)

        takeover = client.call("POST", "/api/v1/takeovers", {
            "name": "Parity takeover", "description": "", "playlistId": alert_id, "screenIds": list(screens),
            "groupIds": [], "expiresAt": iso(time.time() + 600), "password": "correct horse battery staple",
        }, expect=(200, 201))[1]["data"]
        time.sleep(16)
        client.call("POST", f"/api/v1/takeovers/{takeover['id']}/cancel", {}, expect=(200, 204))
        print("parity: takeover shown and cancelled")
        time.sleep(14)

        # An outage: both players keep playing and queue their Activity.
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=20)
        processes.remove(server)
        outage = (time.time(), None)
        time.sleep(25)
        server = start_server()
        outage = (outage[0], time.time())
        print("parity: server back after the outage")
        # Both flush on a 30 s cadence; the wait covers several passes and
        # keeps the window that holds the outage long enough to be measured.
        time.sleep(PHASE_S)
        until = time.time()

        client = e2e.Client()
        login = client.call("POST", "/api/v1/auth/login", {"username": "owner",
                            "password": "correct horse battery staple"}, expect=200)[1]["data"]
        client.csrf = login.get("csrfToken")
        results = {}
        for label, screen in (("electron", electron["screenId"]), ("edge", edge["screenId"])):
            records = [r for r in sessions(client, screen, started - 2, until) if stamp(r["startedAt"]) >= started]
            results[label] = records
            roots, items, reasons, boundary = summarize(records)
            print(f"parity {label}: {len(records)} sessions")
            for key, count in sorted(roots.items()):
                print(f"  root {key} x{count}")
            for key, count in sorted(items.items(), key=str):
                print(f"  item {key} x{count}")
            print(f"  endings {sorted(reasons)}")
        with open("/target/activity-parity-records.json", "w") as handle:
            json.dump({"started": started, "outage": outage, "until": until, **results}, handle)
        compare(results["electron"], results["edge"], outage)

        # A new assignment closes the window that holds the outage, so the
        # server judges it too.
        client.call("PUT", f"/api/v1/screens/{screens[0]}/playlist-assignment", {"playlistId": alert_id}, expect=200)
        client.call("PUT", f"/api/v1/screens/{screens[1]}/playlist-assignment", {"playlistId": alert_id}, expect=200)
        e2e.wait_for(lambda: all(playing(screen) for screen in screens), "both players playing the alert", timeout=120)
        time.sleep(5)
        compliance = client.call("GET", f"/api/v1/activity/compliance?dimension=screen&from={iso(started - 300)}"
                                 f"&to={iso(time.time())}", expect=200)[1]["data"]
        rows = {row["key"]: row for row in compliance.get("breakdown", [])}
        e_row, d_row = rows.get(electron["screenId"]), rows.get(edge["screenId"])
        print(f"parity compliance: electron {e_row}, edge {d_row}")
        assert e_row and d_row, "compliance measured for only one player"
        for field in ("neverStarted", "offlineMisses"):
            assert e_row[field] == d_row[field], f"compliance {field}: electron {e_row[field]}, edge {d_row[field]}"
        compare_windows(
            {"windows": expected_windows(electron["screenId"]), "roots": root_sessions(electron["screenId"])},
            {"windows": expected_windows(edge["screenId"]), "roots": root_sessions(edge["screenId"])},
            int(started * 1000))
        print("parity: Electron and Edge produce the same proof of play")
    except Exception:
        for name in ("electron.log", "tilecastd.log", "renderer.log", "server.log"):
            path = os.path.join(work, name)
            if os.path.exists(path):
                print(f"----- {name} -----")
                with open(path, errors="replace") as handle:
                    print(handle.read()[-5000:])
        raise
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM) if process.args[0] == "xvfb-run" else process.terminate()
                    process.wait(timeout=20)
                except Exception:  # noqa: BLE001
                    process.kill()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--compare":
        # Re-checks saved records without running the players again.
        with open(sys.argv[2]) as handle:
            saved = json.load(handle)
        compare(saved["electron"], saved["edge"], saved["outage"])
    else:
        sys.exit(main())
