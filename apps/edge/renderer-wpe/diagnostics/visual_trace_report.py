"""Reads a visual trace (tilecast-renderer-wpe --visual-trace) or a lab
timeline and puts Runtime events and presented buffers on one clock
(docs/tilecast-edge-visual-trace.md).

For each traced transition it lists, in time order, what the Runtime did
(pin, animate, animation ready, finish, unpin, settle, outgoing release) and
every buffer WPE presented, and it flags:
  end-window   frames presented after an animation's end on the compositor
               clock (start time + duration) and before the Runtime's cleanup
               for that animation. An engine that composites an ended
               animation with the element's resting value (WebKit 2.54.0's
               SkiaCompositingLayer) shows the wrong opacity or transform in
               exactly these frames.
  long-frame   an interval over 1.5 display intervals.

    python3 visual_trace_report.py TRACE.jsonl [--json] [--window MS]
"""
import argparse
import bisect
import json
import sys
from collections import defaultdict

FADE_MS = {"fade-in": 300}
# The Runtime step that ends each animation's effect on screen. Others end
# when the main thread sees `finished` and stops the accelerated animation.
CLEANUP = {
    "fade-in": ("fade.unpin",),
    "card-push": ("startup.covered",),
    "resolve": ("startup.remove", "startup.resolve-end"),
}


def load(path):
    lines = []
    with open(path) as handle:
        for raw in handle:
            raw = raw.strip()
            if raw:
                try:
                    lines.append(json.loads(raw))
                except ValueError:
                    continue
    return lines


def documents(lines):
    """Runtime records grouped by document (a new document starts with the
    trace/start record or when batch numbers go back)."""
    docs = []
    current = None
    last_batch = 0
    for line in lines:
        if line.get("type") not in ("runtime", "marker"):
            continue
        rec = line.get("rec", {})
        batch = line.get("batch", 0)
        starts = rec.get("scope") == "trace" and rec.get("ev") == "start"
        if current is None or starts or (line.get("type") == "runtime" and batch < last_batch):
            current = {"records": [], "first_recv": line.get("recv")}
            docs.append(current)
        last_batch = batch
        current["records"].append(line)
    return docs


def clock_offset(doc, clocks):
    """Microseconds to add to (performance.now() ms * 1000) for this document,
    and the half round trip that bounds its error. A clock sample is used only
    if it is consistent with every record of the document (nothing received
    before it was sent)."""
    records = doc["records"]
    bound = min((r["recv"] - r["rec"]["t"] * 1000 for r in records if "recv" in r), default=None)
    best = None
    for sample in clocks:
        offset = (sample["t0"] + sample["t1"]) / 2 - sample["js"] * 1000
        error = (sample["t1"] - sample["t0"]) / 2
        if bound is not None and offset - error > bound + 1:
            continue
        if sample["t1"] < (doc["first_recv"] or 0) - 2_000_000:
            continue
        if best is None or error < best[1]:
            best = (offset, error)
    if best is None and bound is not None:
        return bound, None
    return best if best else (None, None)


def analyze(lines, window_ms=150):
    header = next((l for l in lines if l.get("type") == "header"), {})
    summary = next((l for l in lines if l.get("type") == "summary"), None)
    clocks = [l for l in lines if l.get("type") == "clock" and {"t0", "t1", "js"} <= l.keys()]
    frames = [l for l in lines if l.get("type") == "frame" and l.get("ev") == "rendered"]
    frame_times = [f["mono"] for f in frames]
    screen = header.get("screen") or {}
    millihertz = screen.get("refreshMilliHz") or 0
    nominal_us = 1e9 / millihertz if millihertz else None
    if nominal_us is None and len(frame_times) > 2:
        gaps = sorted(b - a for a, b in zip(frame_times, frame_times[1:]))
        nominal_us = gaps[len(gaps) // 2]

    events = []
    for index, doc in enumerate(documents(lines)):
        offset, error = clock_offset(doc, clocks)
        if offset is None:
            continue
        for record in doc["records"]:
            rec = record["rec"]
            events.append({**rec, "doc": index, "mono": offset + rec["t"] * 1000, "clockError": error})
    events.sort(key=lambda e: e["mono"])

    groups = defaultdict(list)
    for event in events:
        key = None
        if event.get("tx") is not None:
            key = (event["scope"], event["doc"], int(event["tx"]))
        elif event["scope"] == "startup":
            key = ("startup", event["doc"], 0)
        if key:
            groups[key].append(event)

    transitions = []
    for (scope, doc, tx), group in sorted(groups.items(), key=lambda item: item[1][0]["mono"]):
        start = group[0]["mono"] - window_ms * 1000
        end = group[-1]["mono"] + window_ms * 1000
        lo = bisect.bisect_left(frame_times, start)
        hi = bisect.bisect_right(frame_times, end)
        windows = end_windows(group)
        timeline = [{**e, "entry": "event"} for e in group]
        previous = frames[lo - 1]["mono"] if lo > 0 else None
        flagged = []
        for frame in frames[lo:hi]:
            item = {"entry": "frame", "mono": frame["mono"], "seq": frame.get("seq"), "buf": frame.get("buf"),
                    "mem": frame.get("mem"), "flags": []}
            if previous is not None and nominal_us and frame["mono"] - previous > 1.5 * nominal_us:
                item["flags"].append("long-frame")
            for window in windows:
                if window["from"] <= frame["mono"] <= window["to"]:
                    item["flags"].append("end-window")
                    item["animation"] = window["anim"]
            if item["flags"]:
                flagged.append(item)
            previous = frame["mono"]
            timeline.append(item)
        timeline.sort(key=lambda item: item["mono"])
        origin = group[0]["mono"]
        for item in timeline:
            item["ms"] = round((item["mono"] - origin) / 1000, 3)
        transitions.append({
            "scope": scope, "doc": doc, "tx": tx, "events": len(group), "frames": hi - lo,
            "endWindows": windows, "flagged": flagged, "timeline": timeline,
        })
    return {
        "header": {k: header.get(k) for k in ("schema", "source", "webkit", "platform", "deep", "env", "screen")},
        "summary": summary,
        "clockSamples": len(clocks),
        "frames": len(frames),
        "nominalIntervalMs": round(nominal_us / 1000, 3) if nominal_us else None,
        "transitions": transitions,
    }


def end_windows(group):
    """For each traced animation: from its end on the document timeline to the
    Runtime's cleanup of it (fade.unpin / swap.settle / the next startup step)."""
    windows = []
    ready = {}
    for event in group:
        if event["ev"] == "anim.ready" and isinstance(event.get("startTime"), (int, float)):
            ready[event["anim"]] = event
    for anim, event in ready.items():
        create = next((e for e in group if e["ev"] == "anim.create" and e.get("anim") == anim), None)
        finish = next((e for e in group if e["ev"] in ("anim.finish", "anim.cancel") and e.get("anim") == anim), None)
        label = event.get("label")
        duration = None
        if finish and finish["ev"] == "anim.finish" and isinstance(finish.get("currentTime"), (int, float)):
            duration = finish["currentTime"]
        duration = duration if duration is not None else FADE_MS.get(label)
        if duration is None:
            continue
        # The document timeline and performance.now() share an origin.
        compositor_end = event["mono"] - event["t"] * 1000 + (event["startTime"] + duration) * 1000
        cleanup = next((e for e in group if e["mono"] >= compositor_end and e["ev"] in CLEANUP.get(label, ())),
                       finish)
        if cleanup is None or cleanup["mono"] < compositor_end:
            continue
        windows.append({"anim": anim, "label": label, "from": compositor_end, "to": cleanup["mono"],
                        "ms": round((cleanup["mono"] - compositor_end) / 1000, 3),
                        "created": create["mono"] if create else None})
    return windows


def render_text(report, out):
    header = report["header"]
    out.write(f"WebKit {header.get('webkit')} on {header.get('platform')}, {report['frames']} presented frames, "
              f"display interval {report['nominalIntervalMs']} ms, {report['clockSamples']} clock samples\n")
    env = {k: v for k, v in (header.get("env") or {}).items() if v is not None}
    out.write(f"compositor environment: {env or 'default'}\n\n")
    for transition in report["transitions"]:
        out.write(f"== {transition['scope']} transition {transition['tx']} (document {transition['doc']}): "
                  f"{transition['events']} events, {transition['frames']} frames\n")
        for window in transition["endWindows"]:
            out.write(f"   animation {window['anim']} ({window['label']}): {window['ms']} ms between its end "
                      f"on the compositor clock and the Runtime's cleanup\n")
        for item in transition["timeline"]:
            if item["entry"] == "event":
                details = {k: v for k, v in item.items() if k not in (
                    "entry", "t", "scope", "ev", "doc", "mono", "clockError", "ms")}
                out.write(f"  {item['ms']:>9.3f} ms  runtime  {item['ev']}  {json.dumps(details, sort_keys=True)}\n")
            else:
                flags = (" <-- " + ", ".join(item["flags"])) if item["flags"] else ""
                out.write(f"  {item['ms']:>9.3f} ms  frame    seq {item['seq']} buf {item['buf']}"
                          f"{' mem ' + str(item['mem']) if item.get('mem') else ''}{flags}\n")
        out.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("trace")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--window", type=float, default=150, help="ms of frames around each transition")
    args = parser.parse_args(argv)
    report = analyze(load(args.trace), args.window)
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        render_text(report, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
