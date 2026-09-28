#!/usr/bin/env sh
set -eu

RELEASE_URL="${CHROME_CONTROL_SKILL_URL:-https://github.com/opzero1/browser-control/releases/latest/download/chrome-control-skill.zip}"
INSTALL_DIR="${CHROME_CONTROL_SKILL_DIR:-$HOME/.config/opencode/skills/chrome-control}"
TMP_DIR="$(mktemp -d)"
ZIP_PATH="$TMP_DIR/chrome-control-skill.zip"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install chrome-control" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required to install chrome-control" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
curl -fsSL "$RELEASE_URL" -o "$ZIP_PATH"
unzip -oq "$ZIP_PATH" -d "$INSTALL_DIR"

echo "Installed chrome-control skill to $INSTALL_DIR"
echo "Restart opencode so the new skill is loaded."
