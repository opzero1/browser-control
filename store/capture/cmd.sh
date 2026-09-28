#!/usr/bin/env bash
# Queue one JSON command for drive.mjs and print its result. Usage: cmd.sh '{"op":"wait","tab":"demo","text":"Book"}'
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$BC_STATE/cmd" "$BC_STATE/out"
name=$(python3 -c 'import time; print(time.time_ns())').json
printf '%s' "$1" > "$BC_STATE/cmd/.$name"
mv "$BC_STATE/cmd/.$name" "$BC_STATE/cmd/$name"
for _ in $(seq 1 400); do
  if [ -f "$BC_STATE/out/$name" ]; then cat "$BC_STATE/out/$name"; echo; grep -q '"ok": true' "$BC_STATE/out/$name"; exit $?; fi
  sleep 0.1
done
echo "no result for $name" >&2; exit 1
