# Tilecast Edge release builder (docs/tilecast-edge-next.md, M7 "Production
# WPE delivery").
#
# Production screens run Debian stable (13, trixie). Debian stable ships WPE
# WebKit 2.48 without WPEPlatform, so a release carries its own WPE WebKit
# 2.54 build, compiled here against trixie's own GLib, GStreamer, Mesa,
# libsoup and libwpe. Nothing else is taken from a newer distribution.
#
# Every input is pinned: the base image by digest, the package archive by a
# snapshot.debian.org timestamp, and the WPE WebKit source by SHA-256
# (build-wpe.sh). The build configuration mirrors Debian's own wpewebkit
# 2.54.0-2 package (clang, PORT=WPE, Release, bubblewrap sandbox).
#
#   docker build -t tilecast-edge-release-builder -f apps/edge/release/Dockerfile.builder apps/edge/release
FROM debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
ARG SNAPSHOT=20260920T000000Z
ENV DEBIAN_FRONTEND=noninteractive SOURCE_DATE_EPOCH=1789862400
# Plain HTTP: the base image has no CA bundle for apt's HTTPS. apt verifies the
# signed InRelease with debian-archive-keyring and every package by its hash.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${SNAPSHOT} trixie main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${SNAPSHOT} trixie-updates main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${SNAPSHOT} trixie-security main" \
      > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils zstd git build-essential clang cmake ninja-build pkg-config gperf ruby perl python3 \
      unifdef bubblewrap xdg-dbus-proxy libseccomp-dev \
      flite1-dev libatk-bridge2.0-dev libatk1.0-dev libavif-dev libcairo2-dev libenchant-2-dev libepoxy-dev \
      libgbm-dev libdrm-dev libgcrypt20-dev libgstreamer-plugins-bad1.0-dev libgstreamer-plugins-base1.0-dev \
      libgstreamer1.0-dev libharfbuzz-dev libhyphen-dev libicu-dev libinput-dev libudev-dev libjpeg-dev libjxl-dev \
      liblcms2-dev libopenjp2-7-dev libsoup-3.0-dev libsqlite3-dev libsystemd-dev libtasn1-6-dev libwayland-dev \
      libwebp-dev libwpe-1.0-dev libwpebackend-fdo-1.0-dev libxkbcommon-dev libxml2-utils libxslt1-dev \
      wayland-protocols libjson-glib-dev libglib2.0-dev libwireplumber-0.5-dev ffmpeg openssl jq \
    && rm -rf /var/lib/apt/lists/*
# The Rust toolchain named by apps/edge/rust-toolchain.toml.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal --default-toolchain none \
    && rm /tmp/rustup.sh
