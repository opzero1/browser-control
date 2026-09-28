#!/usr/bin/env bash
# Stop only the processes this capture started (by recorded pid) and remove the temporary profile and state.
set -uo pipefail
source "$(dirname "$0")/env.sh"
stop() { local file=$1 pid; [ -f "$file" ] || return 0; pid=$(cat "$file"); kill "$pid" 2>/dev/null && for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; kill -0 "$pid" 2>/dev/null && kill -9 "$pid"; rm -f "$file"; }
stop "$BC_STATE/drive.pid"
if [ -f "$BC_STATE/chrome.pid" ]; then
  pid=$(cat "$BC_STATE/chrome.pid")
  case "$(ps -ww -p "$pid" -o command= 2>/dev/null)" in *"--user-data-dir=$BC_PROFILE"*) stop "$BC_STATE/chrome.pid" ;; *) rm -f "$BC_STATE/chrome.pid" ;; esac
fi
stop "$BC_STATE/demo.pid"
[ "${1:-}" = "--keep-state" ] || rm -rf "$BC_PROFILE" "$BC_HOSTDIR" "$BC_STATE"
echo "cleanup done"
