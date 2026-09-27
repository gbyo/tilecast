#!/bin/sh
# Runs the Phase 0 spike headless: two off-screen producers, one trusted
# consumer page with both streams in a Layout-like canvas.
set -u
here=$(cd "$(dirname "$0")" && pwd); B=${SPIKE_BUILD:-/tmp/spike-build}; out=${SPIKE_OUT:-/tmp/spike-out}
mkdir -p "$out/frames"; rm -f "$out"/frames/*
(cd "$here/www" && exec python3 -m http.server 8765 --bind 127.0.0.1) >"$out/http.log" 2>&1 & http=$!
sleep 1
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Bc=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
"$B/producer" --url http://127.0.0.1:8765/remote.html --socket "$out/frames/$A.sock" --size 1280x720 --exit-after ${PRODUCER_SECONDS:-20} >"$out/producer-a.log" 2>&1 & pa=$!
"$B/producer" --url http://127.0.0.1:8765/remote2.html --socket "$out/frames/$Bc.sock" --size 400x300 --exit-after ${PRODUCER_SECONDS:-20} >"$out/producer-b.log" 2>&1 & pb=$!
sleep 2
"$B/consumer" --url http://127.0.0.1:8765/trusted.html --frames-dir "$out/frames" --plugin-dir "$B/plugins" --out "$out/composited.ppm" --exit-after ${CONSUMER_SECONDS:-12} >"$out/consumer.log" 2>&1 & pc=$!
if [ -n "${KILL_A_AFTER:-}" ]; then sleep "$KILL_A_AFTER"; kill -9 $pa; echo "killed producer a" >>"$out/consumer.log"; fi
wait $pc; kill $pa $pb $http 2>/dev/null; wait 2>/dev/null
echo "== producer a"; tail -5 "$out/producer-a.log"; echo "== producer b"; tail -3 "$out/producer-b.log"; echo "== consumer"; grep -v "^$" "$out/consumer.log" | tail -30
