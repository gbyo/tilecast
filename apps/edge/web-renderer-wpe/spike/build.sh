#!/bin/sh
set -e
cd "$(dirname "$0")"; B=${SPIKE_BUILD:-/tmp/spike-build}
mkdir -p $B/plugins
W="$(pkg-config --cflags --libs wpe-webkit-2.0 wpe-platform-2.0 wpe-platform-headless-2.0)"
G="$(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-allocators-1.0)"
cc -O2 -Wall -o $B/producer producer.c $W $G
cc -O2 -Wall -o $B/consumer consumer.c $W $G
cc -O2 -Wall -shared -fPIC -o $B/plugins/libgsttcweb.so gst-tcweb.c $(pkg-config --cflags --libs gstreamer-1.0)
echo built
