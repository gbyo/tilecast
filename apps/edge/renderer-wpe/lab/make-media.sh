#!/usr/bin/env bash
# Writes the two solid-color clips that lab/scenes/video-crossfade.html plays
# into DIR (default: lab/scenes/media). They are generated, not committed:
# H.264 Constrained Baseline, yuv420p, 640x360, 30 fps, 4 s, no audio, in the
# exact palette colors of the scene. The same inputs give the same files.
#
#   make-media.sh [DIR]
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
out=${1:-$here/scenes/media}
mkdir -p "$out"
clip() {
  ffmpeg -loglevel error -y -f lavfi -i "color=c=$2:s=640x360:r=30:d=4" \
    -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 30 -bf 0 \
    -fflags +bitexact -flags:v +bitexact -map_metadata -1 -movflags +faststart \
    "$out/lab-$1.mp4"
}
clip a 0xC8281E
clip b 0x1E5AC8
echo "make-media: wrote $out/lab-a.mp4 and $out/lab-b.mp4"
