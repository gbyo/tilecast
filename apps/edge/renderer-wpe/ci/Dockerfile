# Build and headless-test environment for tilecast-renderer-wpe.
# WPE WebKit 2.54 with WPEPlatform (wpe-platform-2.0) from Debian sid.
FROM debian:sid
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config ca-certificates curl \
      libwpewebkit-2.0-dev libjson-glib-dev libglib2.0-dev \
      libgbm-dev libdrm-dev libwayland-dev libxkbcommon-dev libinput-dev libudev-dev \
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav gstreamer1.0-gl \
      mesa-utils libgl1-mesa-dri libegl1 fonts-dejavu-core \
      ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*
