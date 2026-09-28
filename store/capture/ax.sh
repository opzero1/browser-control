#!/usr/bin/env bash
# Background accessibility actions on this capture's own Chrome window only (never foreground delivery).
#   ax.sh list                 print tab-strip and toolbar elements
#   ax.sh press "<substring>"  press the first element whose line contains the substring
#   ax.sh close "<tab title>"  press the Close button of the tab whose line contains the substring
set -euo pipefail
source "$(dirname "$0")/env.sh"
P=$(cat "$BC_STATE/chrome.pid"); W=$(cat "$BC_STATE/window.id")
S=$("$CUA" get_window_state "{\"pid\":$P,\"window_id\":$W,\"include_screenshot\":false,\"max_elements\":5000}")
printf '%s' "$S" > "$BC_STATE/ax-state.json"
python3 - "$BC_STATE/ax-state.json" "$@" <<'EOF' > "$BC_STATE/ax-target"
import json, re, sys
state = json.load(open(sys.argv[1])); mode = sys.argv[2]; lines = state["tree_markdown"].splitlines()
lines = lines[:next((i for i, l in enumerate(lines) if l.startswith("- [") and "AXMenuBar" in l), len(lines))]
if mode == "list":
    print("\n".join(l for l in lines if re.search(r"AX(RadioButton|TabGroup|PopUpButton|Button)", l)), file=sys.stderr); sys.exit(0)
needle = sys.argv[3]
for i, l in enumerate(lines):
    if needle in l and re.search(r"\[\d+\]", l):
        target = l if mode == "press" else lines[i + 1]
        if mode == "close" and "(Close)" not in target: continue
        print(state["snapshot_id"], re.search(r"\[(\d+)\]", target).group(1)); break
else:
    sys.exit(f"no element for {needle}")
EOF
[ "$1" = "list" ] && exit 0
read -r SID IDX < "$BC_STATE/ax-target"
"$CUA" click "{\"pid\":$P,\"window_id\":$W,\"element_index\":$IDX,\"snapshot_id\":\"$SID\"}" | grep -E '"(effect|mode)"'
