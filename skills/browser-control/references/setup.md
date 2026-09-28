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

`install` copies a stable, versioned native host into the state root and writes a wrapper that runs it with the current Node. It writes the Chrome native-messaging manifest for `com.opzero.chrome`, which points at that wrapper and never at the npx cache. The manifest allows the Web Store extension and the copy that isolated profiles load (`mpodnojmjjafgogldgieimgbmfhhknbe`). Pass `--chrome-manifest-dir <dir>` to write the manifest elsewhere. Without `--force`, install never replaces a manifest that points at another host. On macOS with the Xcode Command Line Tools, it also builds the clipboard guard that the private transfer uses. `install --dry-run` reports each step and writes nothing.

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

The package ships the `browser-control`, `onepassword-session`, and `create-verification-skill` skills. Link them into your agent's skills directory with `--skills-dir`, repeated for each directory, then restart the client:

```sh
npx -y @op1/browser-control install --skills-dir ~/.claude/skills
```

Use the skills directory that your client documents, such as `~/.claude/skills` for Claude Code or `~/.agents/skills`. Install copies each skill to a versioned directory in the state root and links it there, so an upgrade or an npx cache eviction never breaks the link. It never replaces another skill with the same name without `--force`, and never removes a real directory. Without `--skills-dir`, install links no skill.

## Run doctor

```sh
npx -y @op1/browser-control doctor
npx -y @op1/browser-control doctor --json
```

`doctor` is read-only. It checks the Node version, the state root's permissions, the stable host, its wrapper, and the manifest target, the handshake with the user's Chrome, cua-driver resolution, the Chrome for Testing bundle, the clipboard guard, and FFmpeg (optional). Pass the same `--skills-dir` as install to check the skill links. `doctor --smoke` also runs one end-to-end check in a temporary isolated profile that never reaches the user's Chrome.

## Know the state root

Browser Control keeps its state under one directory: `BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`. The path must be absolute, or the server fails with `browser-control-invalid-state-dir`. It holds the pool registry, the controller profiles, the native-host copies, every native-host socket and its startup lock (the user's Chrome's `sockets/user.sock` and the isolated controllers' sockets), artifacts, locks, and the clipboard-guard binary. Do not edit registry files by hand; use the [pool CLI](browser-pool.md#operate-the-pool-from-the-cli).

The user's Chrome follows the state root too: the wrapper that `install` writes starts its native host on `<state>/sockets/user.sock`, and the server connects there, even when `BROWSER_CONTROL_STATE_DIR` is set to another directory. Two state roots therefore never share an endpoint. To use another socket, set `BROWSER_CONTROL_HOST_SOCKET` to the same path for `install` and for the server; the configuration that `install` prints sets it for the server. `doctor` prints the socket it checks. The release zip's installer writes the same `com.opzero.chrome` manifest for a host on `~/.opzero-chrome/default.sock`. The installer that ran last owns the manifest, and while the zip's installer owns it, `doctor` fails its `manifest` check as `foreign`; see [two installers, one manifest](native-host.md#two-installers-one-manifest).

## Set the environment

Set these in the server's environment through your client's MCP config.

| Variable | Effect |
| --- | --- |
| `BROWSER_CONTROL_STATE_DIR` | The state root. Default `~/.local/state/browser-control`. |
| `BROWSER_CONTROL_HOST_SOCKET` | The user's Chrome endpoint. Default `sockets/user.sock` in the state root. |
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
