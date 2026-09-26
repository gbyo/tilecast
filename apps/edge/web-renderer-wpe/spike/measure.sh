#!/bin/sh
# Phase 0 measurements: latency, CPU and RSS per process, fd counts, and a
# 120-cycle create/destroy resource check.
set -u
here=$(cd "$(dirname "$0")" && pwd); B=${SPIKE_BUILD:-/tmp/spike-build}; out=${SPIKE_OUT:-/tmp/spike-out}
mkdir -p "$out/frames"; rm -f "$out"/frames/*
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
(cd "$here/www" && exec python3 -m http.server 8765 --bind 127.0.0.1) >"$out/http.log" 2>&1 & http=$!
sleep 1
snap() { echo "-- $1"; ps -eo pid,ppid,rss,pcpu,etimes,comm | grep -E "producer|consumer|WPEWebProcess|WPENetwork" ; for p in $(pgrep -f WPEWebProcess); do echo "fds $p $(ls /proc/$p/fd | wc -l)"; done; }
page=$1; secs=${2:-12}
"$B/producer" --url http://127.0.0.1:8765/${PRODUCER_PAGE:-remote.html} --socket "$out/frames/$A.sock" --size 1280x720 --stamp --exit-after $((secs+4)) >"$out/producer.log" 2>&1 & pa=$!
sleep 2
"$B/consumer" --url http://127.0.0.1:8765/$page --frames-dir "$out/frames" --plugin-dir "$B/plugins" --out "$out/c.ppm" --exit-after $secs >"$out/consumer.log" 2>&1 & pc=$!
sleep 3; snap start
sleep $((secs-4)); snap end
wait $pc; kill $pa $http 2>/dev/null; wait 2>/dev/null
grep -v ALSA "$out/consumer.log" | grep -E "CONSOLE|consumer:" | tail -12; tail -1 "$out/producer.log"
