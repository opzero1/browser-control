#!/usr/bin/env bash
# Render the promo tiles from promo/*.html with headless Chrome for Testing (via render.mjs) at their exact sizes.
# Inputs: the shipped icon and crops of the real screenshots in store/assets. Output: 24-bit RGB PNGs.
set -euo pipefail
source "$(dirname "$0")/env.sh"
: "${ICON:=$BC_REPO/src/extension/images/icon-128.png}"
work="$BC_RAW/promo"; rm -rf "$work"; mkdir -p "$work"
cp "$(dirname "$0")"/promo/*.html "$work/"
cp "$ICON" "$work/icon.png"
# Real crops: the "✅ Browser Control" tab group from screenshot 3, and the popup and form from screenshot 1.
ffmpeg -v error -y -i "$BC_ASSETS/screenshot-3-deliverable-group.png" -vf "crop=368:28:356:0" "$work/strip.png"
ffmpeg -v error -y -i "$BC_ASSETS/screenshot-1-popup-connected.png" -vf "crop=720:480:560:0" "$work/shot.png"
render() { # name width height output
  "$NODE" "$(dirname "$0")/render.mjs" "$CFT_APP/Contents/MacOS/Google Chrome for Testing" "$work/$1.html" "$2" "$3" "$work/$1.png"
  ffmpeg -v error -y -i "$work/$1.png" -vf "format=rgb24" -frames:v 1 "$4"
  sips -g pixelWidth -g pixelHeight -g hasAlpha "$4" | tail -3
}
render small 440 280 "$BC_ASSETS/small-promo-440x280.png"
render marquee 1400 560 "$BC_ASSETS/marquee-1400x560.png"
