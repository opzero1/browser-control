# Shared settings for the store capture scripts. Source this file; override any value through the environment.
# BC_TMP must be a private temporary directory. Every path below lives inside it.
: "${BC_TMP:=${TMPDIR:-/tmp}/bc-store-capture}"
BC_TMP=$(mkdir -p "$BC_TMP" && cd "$BC_TMP" && pwd -P)
: "${BC_REPO:=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd -P)}"
# Build tree that holds dist/extension and dist/native-host/host.js (a clean worktree of the release commit).
: "${BC_BUILD:=$BC_TMP/bc-shots-wt}"
: "${BC_PROFILE:=$BC_TMP/bc-shots-profile}"
: "${BC_HOSTDIR:=$BC_TMP/bc-shots-host}"
: "${BC_SOCKET:=$BC_HOSTDIR/bc.sock}"
: "${BC_STATE:=$BC_TMP/bc-shots-state}"
: "${BC_RAW:=$BC_TMP/bc-shots-raw}"
: "${BC_DEMO_PORT:=8765}"
: "${CFT_APP:=$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app}"
: "${CUA:=$HOME/.local/bin/cua-driver}"
: "${NODE:=$(command -v node)}"
BC_EXTENSION="$BC_BUILD/dist/extension"
BC_HOST_JS="$BC_BUILD/dist/native-host/host.js"
BC_ASSETS="$BC_REPO/store/assets"
export BC_TMP BC_REPO BC_BUILD BC_PROFILE BC_HOSTDIR BC_SOCKET BC_STATE BC_RAW BC_DEMO_PORT CFT_APP CUA NODE BC_EXTENSION BC_HOST_JS BC_ASSETS
