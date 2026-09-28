#!/usr/bin/env bash
# Provision a fresh Chrome for Testing profile with a private native host, then launch it in the
# background through cua-driver so the frontmost app does not change. Prints the Chrome pid.
set -euo pipefail
source "$(dirname "$0")/env.sh"

[ -f "$BC_EXTENSION/manifest.json" ] || { echo "missing $BC_EXTENSION; build the release commit first" >&2; exit 1; }
[ ! -e "$BC_PROFILE" ] || { echo "profile $BC_PROFILE already exists; run cleanup.sh" >&2; exit 1; }
umask 077
mkdir -p "$BC_PROFILE/NativeMessagingHosts" "$BC_HOSTDIR" "$BC_STATE" "$BC_RAW"
chmod 700 "$BC_PROFILE" "$BC_HOSTDIR" "$BC_STATE" "$BC_RAW"
# The host removes a stale socket itself; never delete one that may be live.

EXT_ID=$(python3 "$(dirname "$0")/extension-id.py" "$BC_EXTENSION")
echo "$EXT_ID" > "$BC_STATE/extension-id"

# Wrapper and manifest follow the same shape as a normal install, but point at a private socket.
cat > "$BC_HOSTDIR/host" <<EOF
#!/bin/sh
export OPZERO_CHROME_HOST_SOCKET='$BC_SOCKET'
exec '$NODE' '$BC_HOST_JS'
EOF
chmod 700 "$BC_HOSTDIR/host"
cat > "$BC_PROFILE/NativeMessagingHosts/com.opzero.chrome.json" <<EOF
{
  "name": "com.opzero.chrome",
  "description": "Browser Control store capture host",
  "type": "stdio",
  "path": "$BC_HOSTDIR/host",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
chmod 600 "$BC_PROFILE/NativeMessagingHosts/com.opzero.chrome.json"

# Chrome reads these preferences on first start: show the bookmarks bar off, no sign-in promos.
mkdir -p "$BC_PROFILE/Default"
cat > "$BC_PROFILE/Default/Preferences" <<EOF
{"bookmark_bar":{"show_on_all_tabs":false},"browser":{"has_seen_welcome_page":true},"signin":{"allowed":false},
 "extensions":{"pinned_extensions":["$EXT_ID"],"ui":{"developer_mode":false}},"session":{"restore_on_startup":5}}
EOF

# The bundle-id route picks whichever Chrome for Testing LaunchServices prefers. Check the pid's binary afterwards.
ARGS=$(python3 - <<EOF
import json
print(json.dumps({"bundle_id": "com.google.chrome.for.testing", "creates_new_application_instance": True,
  "additional_arguments": ["--user-data-dir=$BC_PROFILE", "--no-first-run", "--no-default-browser-check",
    "--load-extension=$BC_EXTENSION", "--disable-extensions-except=$BC_EXTENSION",
    "--disable-features=SigninInterception,ChromeWhatsNewUI", "--hide-crash-restore-bubble", "--disable-infobars"]}))
EOF
)
RESULT=$("$CUA" launch_app "$ARGS")
echo "$RESULT" > "$BC_STATE/launch.json"
PID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])' <<<"$RESULT")
SUPPRESSED=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("self_activation_suppressed"))' <<<"$RESULT")
COMMAND=$(ps -ww -p "$PID" -o command=)
case "$COMMAND" in
  "$CFT_APP/Contents/MacOS/Google Chrome for Testing"*"--user-data-dir=$BC_PROFILE"*) ;;
  *) echo "launched pid $PID is not the expected Chrome for Testing: $COMMAND" >&2; kill "$PID" 2>/dev/null || true; exit 2 ;;
esac
echo "$PID" > "$BC_STATE/chrome.pid"
echo "pid=$PID extension=$EXT_ID self_activation_suppressed=$SUPPRESSED"
