# Electron/Chromium conformance image: runs the Player Runtime conformance
# fixtures under Linux Electron and a virtual framebuffer, so Chromium
# screenshots are compared in plain sRGB against the WPE headless run.
#
#   docker build -t tilecast-conformance-electron apps/player-linux/conformance
FROM debian:sid
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm xvfb xauth ffmpeg fonts-dejavu-core ca-certificates \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libgtk-3-0t64 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libasound2t64 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*
# The Linux Electron binary matching apps/player-linux/package.json.
ARG ELECTRON_VERSION=39.8.5
RUN mkdir /opt/electron && cd /opt/electron && npm init -y >/dev/null \
    && npm install --no-audit --no-fund --ignore-scripts electron@${ELECTRON_VERSION} >/dev/null \
    && node node_modules/electron/install.js
ENV TILECAST_ELECTRON=/opt/electron/node_modules/.bin/electron
