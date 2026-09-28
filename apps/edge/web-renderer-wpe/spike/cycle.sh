#!/bin/sh
# 120 create/destroy cycles of a tcweb surface in the trusted page, with fd
# and RSS of the trusted web process sampled at cycle 20 and at the end, and
# the producer's client count after the page is done.
set -u
here=$(cd "$(dirname "$0")" && pwd); B=${SPIKE_BUILD:-/tmp/spike-build}; out=${SPIKE_OUT:-/tmp/spike-out}
mkdir -p "$out/frames"; rm -f "$out"/frames/*
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
(cd "$here/www" && exec python3 -m http.server 8765 --bind 127.0.0.1) >"$out/http.log" 2>&1 & http=$!
sleep 1
"$B/producer" --url http://127.0.0.1:8765/remote.html --socket "$out/frames/$A.sock" --size 1280x720 --exit-after 110 >"$out/producer.log" 2>&1 & pa=$!
sleep 2
"$B/consumer" --url http://127.0.0.1:8765/cycle.html --frames-dir "$out/frames" --plugin-dir "$B/plugins" --out "$out/c.ppm" --exit-after 100 >"$out/consumer.log" 2>&1 & pc=$!
sleep 3; p=$(pgrep -n WPEWebProcess)
sample() { echo "$1: trusted web process fds=$(ls /proc/$p/fd | wc -l) rss=$(ps -o rss= -p $p | tr -d ' ')KiB threads=$(ls /proc/$p/task | wc -l)"; }
while ! grep -q "cycle: 40" "$out/consumer.log"; do sleep 0.5; done; sample "after 40 cycles"
while ! grep -q "cycle: done" "$out/consumer.log"; do sleep 0.5; done; sleep 3; sample "after 240 cycles"
grep -c "cycle:" "$out/consumer.log"; tail -1 "$out/producer.log"
kill $pc $pa $http 2>/dev/null; wait 2>/dev/null
