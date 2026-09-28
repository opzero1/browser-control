#!/usr/bin/env bash
# Capture this capture's own Chrome window without activating it, then crop the inner 1280x800 rectangle.
# The window is sized to 1300x820 points on a 1x display, so a 10-pixel inset on each edge removes the
# macOS rounded-corner transparency without scaling or padding. Output is 24-bit RGB PNG.
# Usage: shot.sh <output.png>
set -euo pipefail
source "$(dirname "$0")/env.sh"
out=$1; W=$(cat "$BC_STATE/window.id"); raw="$BC_RAW/$(basename "$out" .png)-raw.png"
screencapture -l "$W" -o -x "$raw"
size=$(sips -g pixelWidth -g pixelHeight "$raw" | awk '/pixel/{printf "%s ", $2}')
if [ "$size" != "1300 820 " ]; then
  # A Retina display yields 2600x1640; crop the same inset at 2x, then downscale.
  [ "$size" = "2600 1640 " ] || { echo "unexpected capture size $size" >&2; exit 1; }
  ffmpeg -v error -y -i "$raw" -vf "crop=2560:1600:20:20,scale=1280:800:flags=lanczos,format=rgb24" -frames:v 1 "$out"
else
  ffmpeg -v error -y -i "$raw" -vf "crop=1280:800:10:10,format=rgb24" -frames:v 1 "$out"
fi
sips -g pixelWidth -g pixelHeight -g hasAlpha "$out" | tail -3
