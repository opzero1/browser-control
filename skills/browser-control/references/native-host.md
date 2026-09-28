# Native host scripts

This skill ships the Browser Control native host and its scripts next to `SKILL.md`: `native-host/client.js`, `native-host/host.js`, the `native-host/browser-control-host` wrapper, and `scripts/`. They need Node 18 or later and no repo checkout. Run the commands from the skill directory, the one that contains `SKILL.md`, unless an absolute path is clearer.

Use them to check the extension connection, to install or repair the host from the release zip, and for raw client calls. If you use the MCP server, install with `npx -y @op1/browser-control install` instead; see [setup](setup.md). Both installers write the same `com.opzero.chrome` manifest for the user's Chrome, and their hosts listen on different sockets; see [two installers, one manifest](#two-installers-one-manifest).

The safety rules in [SKILL.md](../SKILL.md) apply to every raw client call. If the extension stays unreachable after the checks below, do not fall back to AppleScript, profile-store scraping, cookie inspection, or another browser-control mechanism.

## Extension Checks

On the first Chrome-backed task in a session, try a lightweight extension call:

```sh
node native-host/client.js ping
```

If that fails, wait 2 seconds and retry once. Any non-error response means the native host and extension bridge are responding.

`client.js` connects to `~/.opzero-chrome/default.sock` unless `BROWSER_CONTROL_HOST_SOCKET` names another socket. A host installed with `npx -y @op1/browser-control install` listens on `sockets/user.sock` in the state root instead, the path that `doctor` prints for its `endpoint` check. Set `BROWSER_CONTROL_HOST_SOCKET` to that path for `client.js`. See [two installers, one manifest](#two-installers-one-manifest).

If communication still fails, run these checks:

```sh
node scripts/installed-browsers.js --json
node scripts/chrome-is-running.js --json
node scripts/check-extension-installed.js --json
node scripts/check-native-host-manifest.js --json
```

The extension ID comes from one of these sources:

- `--extension-id <id>`
- `BROWSER_CONTROL_EXTENSION_ID`
- `scripts/extension-id.json`

`scripts/extension-id.json` comes with the build and contains the Chrome Web Store extension ID, `dcnjjnecbhipdbngkhjppkckpkellmld`. No script changes it. For an unpacked local build, read the generated ID from `chrome://extensions` and pass it with `--extension-id` to the installer and to each check, or set `BROWSER_CONTROL_EXTENSION_ID`.

### Chrome Is Not Installed

Tell the user that Browser Control requires Google Chrome or Chromium.

### Chrome Is Not Running

Ask the user before launching Chrome. If they agree, run:

```sh
node scripts/open-chrome-window.js
```

For a non-mutating launch check, use:

```sh
node scripts/open-chrome-window.js --dry-run --json
```

### Extension Is Missing Or Disabled

Tell the user to confirm that the downloaded release extension or locally built `dist/extension` directory is loaded and enabled in `chrome://extensions`.

Do not guess the extension ID. Read it from Chrome's extension manager or from the configured `scripts/extension-id.json`.

### Native Host Manifest Is Missing Or Invalid

If `scripts/extension-id.json` is present, install or repair the native host with:

```sh
node scripts/install-native-host.js --extension-id "$(node -p 'require("./scripts/extension-id.json").extensionId')"
```

If `scripts/extension-id.json` is missing, ask the user for the extension ID shown in `chrome://extensions`, then run:

```sh
node scripts/install-native-host.js --extension-id <id>
```

The installer copies the host into `hosts/skill-<digest>/` under the Browser Control state root (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`), writes the wrapper `hosts/skill/browser-control-host` there with the Node that ran the installer, and points the manifest at that wrapper. Chrome then keeps working if this skill directory moves or is deleted. The installer writes nothing into the skill directory. The host listens on `~/.opzero-chrome/default.sock`, the default of `client.js`, unless you pass `--socket-path` or set `BROWSER_CONTROL_HOST_SOCKET` for the installer.

If the installer reports that the manifest already points at another host, check that host first; it can be the MCP server's host. Pass `--force` only to replace it. Reload the extension in `chrome://extensions` and retry:

```sh
node native-host/client.js ping
```

### Two installers, one manifest

Chrome reads one `com.opzero.chrome.json` manifest for each Chrome user-data directory, shared by all its profiles. Two installers write it:

| Installer | Manifest names | Its host listens on | Allowed extensions |
| --- | --- | --- | --- |
| `npx -y @op1/browser-control install` (MCP server) | `<state>/hosts/user/browser-control-host` | `<state>/sockets/user.sock`, or `BROWSER_CONTROL_HOST_SOCKET` as set for install | The Web Store ID and the isolated-profile ID `mpodnojmjjafgogldgieimgbmfhhknbe` |
| `node scripts/install-native-host.js` (release zip) | `<state>/hosts/skill/browser-control-host` | `~/.opzero-chrome/default.sock`, or `--socket-path` or `BROWSER_CONTROL_HOST_SOCKET` as set for the installer | Only the `--extension-id` given |

`<state>` is `BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`.

- **Owner.** The manifest names one wrapper, so the installer that ran last owns it. Neither installer replaces a manifest that names another host without `--force`. Without it, the second installer exits with status 1 and prints the path the manifest names. Both installers check and replace the manifest while they hold the lock `.com.opzero.chrome.json.lock` beside it, so this holds even when they run at the same time.
- **MCP server.** Its user route connects to `BROWSER_CONTROL_HOST_SOCKET` when set, else to `<state>/sockets/user.sock`. `install` writes that same path into its wrapper. Give install, doctor, and the server the same `BROWSER_CONTROL_STATE_DIR` and `BROWSER_CONTROL_HOST_SOCKET`. While the release zip's installer owns the manifest, Chrome starts the zip's host on its own socket, and the server cannot reach Chrome.
- **Raw clients.** `client.js` connects to `~/.opzero-chrome/default.sock` unless `BROWSER_CONTROL_HOST_SOCKET` names another socket. While the MCP server's installer owns the manifest, set it to `<state>/sockets/user.sock`. Callers of `transport.js` pass the socket to `ChromeTransport.connect` themselves.
- **Doctor.** `npx -y @op1/browser-control doctor` reports a manifest that the zip's installer owns as `FAIL manifest: The Chrome native messaging manifest points at another host. Run browser-control install --force to replace it.` With `--json`, that step has `status: "foreign"` and `previous`, the wrapper the manifest names; `…/hosts/skill/browser-control-host` is the zip's installer. The `endpoint` step shows the socket the server uses. When the MCP server's wrapper exports a socket other than the one in doctor's environment, the `wrapper` step fails as `stale`. `scripts/check-native-host-manifest.js` checks only that the manifest names an existing host and allows the extension ID, so it passes for either installer.

To switch Chrome to the MCP server's host, run `npx -y @op1/browser-control install --force`. To switch back to the zip's host, run `node scripts/install-native-host.js --extension-id <id> --force`. Reload the extension in `chrome://extensions` after each switch.

## Runtime Protocol

The native host exposes newline-delimited JSON-RPC to local clients and forwards requests to the extension through Chrome native messaging.

`client.js` takes only `ping`, `getInfo`, `host.ping` and `host.info` as an argument. Send every other call, and every call with parameters, as one JSON-RPC 2.0 request per line on stdin with `--stdio`. Never pass private values in arguments.

```sh
node native-host/client.js getInfo
echo '{"jsonrpc":"2.0","id":1,"method":"getUserTabs","params":{}}' | node native-host/client.js --stdio
```

Session-scoped calls require both `session_id` and `turn_id`:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"createTab","params":{"session_id":"task","turn_id":"turn-1"}}' | node native-host/client.js --stdio
```

Each `client.js` connection is its own session. A tab must belong to that session before `attach`: create it with `createTab`, or claim it with `claimUserTab`, on the same connection. `client.js` sends every stdin line as soon as it reads it, so requests on one stream run concurrently and can finish in any order.

For a raw sequence such as claim, `attach`, `executeCdp` and `finalizeTabs`, keep one `--stdio` connection open and write each request only after its response arrives. For example, drive `client.js --stdio` from a script that reads stdout.

To open, observe, act on and close pages, use the client library `native-host/transport.js` instead. `ChromeTransport.connect`, `open`, `observe`, `waitFor`, `act` and `close` await each step. The reviewer demo at <https://browser-control.pages.dev/support/reviewers/> shows the pattern. Its pages are bound to an origin, so raw `executeCdp` is not available on them. The MCP server also waits for each response.

## User Tab Claiming

- List claimable tabs with `getUserTabs`.
- Choose the target by visible title, URL, recency, and tab group.
- Claim only tab IDs returned by the current `getUserTabs` response.
- Do not guess tab IDs.
- Claimed tabs move into the active Browser Control tab group and become controllable session tabs.

Example:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"claimUserTab","params":{"session_id":"task","turn_id":"turn-1","tabId":123}}' | node native-host/client.js --stdio
```

## Tab Cleanup

Before ending browser work, call `finalizeTabs`.

Treat finalization as the final browser action for that turn. If more browser work is needed, do it first, then finalize once.

Omit tabs by default. A tab is worth keeping only when the user needs that live page after the turn.

Keep a tab with `status: "deliverable"` when the tab itself is a user-facing output or requested open page. Deliverable tabs move to the shared `✅ Browser Control` tab group.

Keep a tab with `status: "handoff"` only when the task is still in progress and the user or a later turn should continue from the current task tab group.

Example:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"finalizeTabs","params":{"session_id":"task","turn_id":"turn-1","keep":[{"tabId":123,"status":"deliverable"}]}}' | node native-host/client.js --stdio
```

## Cursor Overlay

Use `moveMouse` to render the Browser Control cursor overlay in a session tab:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"moveMouse","params":{"session_id":"task","turn_id":"turn-1","tabId":123,"x":100,"y":200,"waitForArrival":true}}' | node native-host/client.js --stdio
```

The extension injects `content-scripts/opzero-chrome.js` at runtime when the tab belongs to the active session.

## File Uploads

When a raw client call uploads a local file:

- Prefer the page's actual `input[type="file"]` or upload control.
- Use absolute local paths.
- Confirm with the user before uploading personal or sensitive files.
- If Chrome blocks file URL access, ask the user to open `chrome://extensions`, open Browser Control details, and enable file URL access.

## Locator Discipline

When a higher-level browser client is layered on top of this extension, use the same interaction discipline:

- Observe the current page before acting.
- Prefer stable selectors: `data-testid`, stable `data-*`, stable `href`, scoped role/name, scoped text, then scoped CSS.
- Verify ambiguous locators resolve to one element before click, fill, press, or select-like actions.
- After a timeout, strict-mode failure, selector parse error, navigation, modal open/close, or major UI state change, collect fresh page state before retrying.
- Do not retry the same failing locator without fresh state.
- Do not use broad full-page text dumps as an exploratory strategy.

## Supported Extension API

The background service worker exposes:

- `ping`
- `getInfo`
- `getTabs`
- `getUserTabs`
- `createTab`
- `claimUserTab`
- `finalizeTabs`
- `nameSession`
- `attach`
- `detach`
- `executeCdp`
- `moveMouse`
- `turnEnded`
- `executeUnhandledCommand`

The extension forwards these notifications when active:

- `onCDPEvent`
- `onCDPDetach`
- `onControlStopped`
