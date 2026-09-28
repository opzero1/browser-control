# Set up Browser Control

## Check the requirements

- Node 24 or later. Node is the only runtime the package needs.
- Google Chrome with the Browser Control extension from the Chrome Web Store (ID `dcnjjnecbhipdbngkhjppkckpkellmld`).
- macOS or Linux for the user's Chrome. Windows is unsupported.
- macOS, Chrome for Testing, and cua-driver for isolated profiles (`claim_browser`) and for 1Password transfer. Install cua-driver with its upstream installer; see [native control](native-control.md#install-and-load-the-cua-driver-skill).
- Optional: FFmpeg on `PATH` for `start_recording` and `stop_recording`.

## Install the native host

```sh
npx -y @op1/browser-control install
```

`install` copies a stable, versioned native host into the state root and writes a wrapper that runs it with the current Node. It writes the Chrome native-messaging manifest for `com.opzero.chrome`, which points at that stable copy and never at the npx cache. The manifest allows the Web Store extension. Pass `--extension-id <id>` (repeatable) to also allow an unpacked build, or `--manifest-path <file>` to write the manifest elsewhere. On macOS with `xcrun`, it also builds the clipboard guard that the private transfer uses.

Reload the extension in `chrome://extensions` after the first install. The `mcp` command never writes Chrome manifests; only `install` does. Isolated-profile manifests are written when `claim_browser` provisions a profile.

## Add the server to your client

`npx -y @op1/browser-control config <opencode|claude|codex|cursor>` prints the matching snippet. The recommended server key is `browser-control`.

```jsonc
// OpenCode opencode.jsonc
"mcp": { "browser-control": { "type": "local", "command": ["npx", "-y", "@op1/browser-control", "mcp"], "enabled": true } }
```

```json
// Claude Code .mcp.json, Cursor ~/.cursor/mcp.json
{ "mcpServers": { "browser-control": { "command": "npx", "args": ["-y", "@op1/browser-control", "mcp"] } } }
```

```toml
# Codex ~/.codex/config.toml (claim_browser can take up to 120 s)
[mcp_servers.browser-control]
command = "npx"
args = ["-y", "@op1/browser-control", "mcp"]
tool_timeout_sec = 150
```

OpenCode sends a session ID with each request. Clients that send none get one random session ID per server process; see [session identity](../SKILL.md#know-your-session-identity).

## Install the skills

The package ships these skills under `skills/`. Copy the `browser-control` and `onepassword-session` directories into your agent's skills directory, such as `~/.config/opencode/skills/` for OpenCode or `~/.claude/skills/` for Claude Code, then restart the client:

```sh
npm pack @op1/browser-control
tar -xzf op1-browser-control-*.tgz package/skills
cp -R package/skills/browser-control package/skills/onepassword-session ~/.claude/skills/
```

## Run doctor

```sh
npx -y @op1/browser-control doctor
npx -y @op1/browser-control doctor --json
```

`doctor` is read-only. It checks the Node version, the state root's permissions, the stable host, its wrapper, and the manifest target, the handshake with the user's Chrome, cua-driver resolution, the Chrome for Testing bundle, the clipboard guard, and FFmpeg (optional).

## Know the state root

Browser Control keeps all its state under one directory: `BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`. The path must be absolute, or the server fails with `browser-control-invalid-state-dir`. It holds the pool registry, the controller profiles, the native-host copies, sockets, artifacts, locks, and the clipboard-guard binary. Do not edit registry files by hand; use the [pool CLI](browser-pool.md#operate-the-pool-from-the-cli).

## Set the environment

Set these in the server's environment through your client's MCP config.

| Variable | Effect |
| --- | --- |
| `BROWSER_CONTROL_STATE_DIR` | The state root. Default `~/.local/state/browser-control`. |
| `BROWSER_CONTROL_HOST_SOCKET` | The user's Chrome endpoint. Default `~/.opzero-chrome/default.sock`. |
| `CUA_DRIVER` | An absolute path to cua-driver. Otherwise `PATH`, then `~/.local/bin/cua-driver`. |
| `FAST_CHROME_ARTIFACT_ROOT` | An existing, private artifact root for tabs without a lease. Default `artifacts/user` in the state root. |
| `FAST_CHROME_ALLOW_LOOPBACK` | `1` also allows `http://localhost` and `http://127.0.0.1` tabs. |
| `FAST_CHROME_MAX_CONTROLLERS` | Isolated controllers, default 3, clamped to 1–8. |
| `FAST_CHROME_MAX_TENANTS` | Shared leases per controller, default 3, clamped to 1–16. |
| `FAST_CHROME_UNSHARED_SITES` | Registrable domains, separated by commas, whose leases never share a controller. Default none. |

## Troubleshoot the connection

On the first browser task in a session, call `status()`. If it fails, wait 2 seconds and retry once. If it still fails, run `doctor` and act on its first failing check:

- **Chrome is not installed:** tell the user that Browser Control requires Google Chrome.
- **Chrome is not running:** ask the user before you launch Chrome. Page tools never launch it.
- **The extension is missing or disabled:** ask the user to install or enable Browser Control in `chrome://extensions`. Do not guess an extension ID; read it from Chrome's extension manager.
- **The manifest or stable host is missing or stale:** run `npx -y @op1/browser-control install` again, reload the extension, and call `status()`.
- **A protocol mismatch** (`browser-control-protocol-mismatch`): update the extension and the package to matching versions.

If communication still fails, report the blocker with the doctor output. Do not fall back to AppleScript, profile-store scraping, cookie inspection, or another browser-control mechanism.
