#!/usr/bin/env bash
# Serve the fake "Book a demo" page on 127.0.0.1 only. Writes the server pid to $BC_STATE/demo.pid.
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$BC_STATE"
python3 -m http.server "$BC_DEMO_PORT" --bind 127.0.0.1 --directory "$(dirname "$0")/demo" >"$BC_STATE/demo.log" 2>&1 &
echo $! > "$BC_STATE/demo.pid"
sleep 0.5
curl -fsS "http://127.0.0.1:$BC_DEMO_PORT/" | grep -q "Book a demo" && echo "demo server pid $(cat "$BC_STATE/demo.pid") on 127.0.0.1:$BC_DEMO_PORT"
