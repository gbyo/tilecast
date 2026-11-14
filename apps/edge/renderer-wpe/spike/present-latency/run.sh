#!/bin/sh
# Stage 4 latency spike (docs/tilecast-edge-airplay.md §5). Run in the
# tilecast-edge-dev image with the repository mounted at /src:
#
#   docker run --rm -v "$PWD:/src" -v tilecast-edge-target:/target \
#     tilecast-edge-dev /src/apps/edge/renderer-wpe/spike/present-latency/run.sh
#
# Measures the delay from the sender to the composited output for a
# synthetic black/white H.264 RTP stream (plus L16 audio) through WebKit and
# the tcpresent source, and through the Electron receiver decode pipeline
# and a minimal decode on the same machine.
set -eu
# Containers without unprivileged user namespaces cannot run WebKit's
# bubblewrap sandbox: run with `docker run --privileged` and SPIKE_SANDBOX=1
# to keep it, as a release does. Without it, the spike turns the sandbox off.
if [ -z "${SPIKE_SANDBOX:-}" ]; then export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1; fi
here=$(cd "$(dirname "$0")" && pwd)
B=${SPIKE_BUILD:-/target/present-spike}
out=${SPIKE_OUT:-$B/out}
seconds=${SPIKE_SECONDS:-44}
mkdir -p "$B" "$out"
cmake -S "$here/../.." -B "$B/renderer" -G Ninja -DTILECAST_ALLOW_UNSANDBOXED_WEBKIT=ON >/dev/null
cmake --build "$B/renderer" --target gsttcmedia >/dev/null
W="$(pkg-config --cflags --libs wpe-webkit-2.0 wpe-platform-2.0 wpe-platform-headless-2.0)"
G="$(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0)"
S="$here/../../src"
# shellcheck disable=SC2086
cc -O2 -Wall -I"$S" -o "$B/consumer" "$here/consumer.c" "$S/present-relay.c" "$S/media-client.c" "$S/validate.c" \
  $W $G $(pkg-config --cflags --libs json-glib-1.0 gio-unix-2.0)
# shellcheck disable=SC2086
cc -O2 -Wall -o "$B/reference" "$here/reference.c" $G
# 20 cycles of one second black, one second white, 1280x720 at 30 fps.
# Baseline, no B-frames, SPS/PPS before every IDR, an AUD before every frame.
if [ ! -f "$B/phases.h264" ]; then
  ffmpeg -loglevel error -y -f lavfi -i "color=c=black:s=1280x720:r=30:d=1" -f lavfi -i "color=c=white:s=1280x720:r=30:d=1" \
    -filter_complex "[0][1]concat=n=2:v=1,loop=loop=21:size=60:start=0" \
    -c:v libx264 -profile:v baseline -tune zerolatency -g 60 -keyint_min 60 -sc_threshold 0 -b:v 4M \
    -x264-params repeat-headers=1 -bsf:v h264_metadata=aud=insert -f h264 "$B/phases.h264"
fi
VCAPS="application/x-rtp,media=video,clock-rate=90000,encoding-name=H264,payload=96"
# The grant server binds its socket in a background thread. A consumer that
# asks for its grant first fails to start the relay, so wait (at most ten
# seconds) for the socket before the consumer starts.
wait_for_socket() {
  for _ in $(seq 100); do
    [ -S "$1" ] && return 0
    sleep 0.1
  done
  echo "run.sh: the grant server did not create $1" >&2
  return 1
}
measure() { # name receiver-command...
  name=$1; shift
  "$@" >"$out/$name.receiver" 2>"$out/$name.stderr" & receiver=$!
  sleep 6
  python3 "$here/sender.py" --video "$B/phases.h264" ${SPIKE_AUDIO:+--audio} >"$out/$name.sender"
  wait $receiver || true
  python3 "$here/analyze.py" "$name" "$out/$name.sender" "$out/$name.receiver"
}
if [ -z "${SPIKE_WEBKIT_ONLY:-}" ]; then
SPIKE_AUDIO='' measure reference-minimal "$B/reference" "$seconds" \
  "udpsrc address=127.0.0.1 port=42000 caps=$VCAPS ! rtph264depay ! h264parse ! avdec_h264 ! videoconvert ! video/x-raw,format=GRAY8 ! appsink name=sink sync=false"
SPIKE_AUDIO='' measure reference-electron "$B/reference" "$seconds" \
  "udpsrc address=127.0.0.1 port=42000 caps=$VCAPS ! rtpjitterbuffer latency=80 drop-on-latency=true ! rtph264depay ! h264parse config-interval=-1 ! avdec_h264 ! videoconvert ! video/x-raw,format=GRAY8 ! appsink name=sink sync=true"
fi
python3 "$here/sender.py" --video /dev/null --media-socket "$out/media-video.sock" --serve-only & grant=$!
wait_for_socket "$out/media-video.sock"
SPIKE_AUDIO='' measure webkit${SPIKE_SANDBOX:+-sandboxed}-video "$B/consumer" --plugin-dir "$B/renderer/gstreamer-1.0" \
  --media-socket "$out/media-video.sock" --muted --seconds "$seconds"
kill $grant
python3 "$here/sender.py" --video /dev/null --audio --media-socket "$out/media-av.sock" --serve-only & grant=$!
wait_for_socket "$out/media-av.sock"
SPIKE_AUDIO=1 measure webkit${SPIKE_SANDBOX:+-sandboxed}-video-audio "$B/consumer" --plugin-dir "$B/renderer/gstreamer-1.0" \
  --media-socket "$out/media-av.sock" --seconds "$seconds"
kill $grant
grep -h "^CONSOLE\|video " "$out"/webkit-*.receiver | sort | uniq -c | sort -rn | head -20 || true
