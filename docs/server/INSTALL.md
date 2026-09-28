# Install the Browser Control MCP server

The `@op1/browser-control` package runs the Browser Control MCP server and sets up what it needs on your
machine. Node.js is the only runtime requirement. MCP clients start the server with
`npx -y @op1/browser-control mcp`.

## Requirements

- Node.js 24 or newer.
- Google Chrome with the [Browser Control extension](https://chromewebstore.google.com/detail/dcnjjnecbhipdbngkhjppkckpkellmld)
  installed and enabled.
- For isolated browsers (`claim_browser`) and the private 1Password transfer, macOS with:
  - cua-driver, installed with its upstream installer:

    ```sh
    /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
    ```

  - Chrome for Testing, registered with macOS under the bundle ID `com.google.chrome.for.testing`. For example,
    install it with `npx @puppeteer/browsers install chrome@stable --path ~/Applications/ChromeForTesting`,
    then open the app once.
  - The Xcode Command Line Tools (`xcode-select --install`), to build the clipboard guard.
- Optional: `ffmpeg` on `PATH`. Without it, `start_recording` is refused.

The server resolves cua-driver from `CUA_DRIVER`, then `PATH`, then `~/.local/bin/cua-driver`.

## Set up the machine

```sh
npx -y @op1/browser-control install
```

Install is idempotent. Run it again after each upgrade. It does these steps:

1. Copies the native host to `<state>/hosts/<version>-<digest>/native-host.js`.
2. Writes the wrapper `<state>/hosts/user/browser-control-host`. The wrapper runs that copy with the Node.js
   that ran install.
3. Writes the Chrome native messaging manifest `com.opzero.chrome.json`. The manifest points at the wrapper and
   allows the extension IDs `dcnjjnecbhipdbngkhjppkckpkellmld` (Chrome Web Store) and
   `mpodnojmjjafgogldgieimgbmfhhknbe` (the copy that isolated profiles load).
4. Checks that Chrome has the extension, that cua-driver resolves, and that Chrome for Testing is registered.
5. On macOS, builds the clipboard guard with `xcrun swiftc` into `<state>/bin/`, with mode 0700, and verifies it.
6. With `--skills-dir`, copies the bundled skills (`browser-control`, `onepassword-session` and
   `create-verification-skill`) to `<state>/skills/` and links them into each given skills directory.
7. Prints the MCP configuration for OpenCode, Claude Code and Codex.

Chrome manifests and skill links point only at copies under the state directory, never into the npx cache.

`<state>` is `BROWSER_CONTROL_STATE_DIR`, by default `~/.local/state/browser-control`. The state directory
also holds the isolated profiles, the pool registry, every native-host socket, locks and artifacts.

The user's Chrome follows the state root too: the wrapper starts its native host on `<state>/sockets/user.sock`,
and the server connects there, even when `BROWSER_CONTROL_STATE_DIR` is set to another directory. Two state
roots never share an endpoint. To use another socket, set `BROWSER_CONTROL_HOST_SOCKET` to the same path for
`install` and for the server.

### Options

| Option | Effect |
|---|---|
| `--state-dir <dir>` | Use this state directory. Give the server the same directory (the printed configuration includes it). |
| `--chrome-manifest-dir <dir>` | Write the manifest here. The default is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` on macOS and `~/.config/google-chrome/NativeMessagingHosts` on Linux. |
| `--skills-dir <dir>` | Link the skills here. Repeat it for more directories, for example `~/.claude/skills` or `~/.agents/skills`. There is no default: without this option, install links no skill. |
| `--dry-run` | Report what install would do and write nothing. |
| `--force` | Replace a manifest or skill link that belongs to another host or skill. The report names the old path. A real directory is never removed. |
| `--json` | Print the report as JSON. |

Without `--force`, install never replaces a `com.opzero.chrome.json` manifest that points at another host. It
reports the path that manifest names and exits with status 1.

### The release zip's installer

The Browser Control helper zip ships its own installer, `scripts/install-native-host.js`. It writes the same
`com.opzero.chrome.json` manifest, so Chrome starts only one of the two hosts:

| Installer | Manifest names | Its host listens on |
|---|---|---|
| `npx -y @op1/browser-control install` | `<state>/hosts/user/browser-control-host` | `<state>/sockets/user.sock`, or `BROWSER_CONTROL_HOST_SOCKET` as set for install |
| `node scripts/install-native-host.js` (zip) | `<state>/hosts/skill/browser-control-host` | `~/.opzero-chrome/default.sock`, or `--socket-path` or `BROWSER_CONTROL_HOST_SOCKET` as set for it |

- The installer that ran last owns the manifest. Neither replaces a manifest that names another host without
  `--force`.
- The server's user route connects to `BROWSER_CONTROL_HOST_SOCKET` when it is set, else to
  `<state>/sockets/user.sock`. Install writes the same path into its wrapper, so run install, doctor and the
  server with the same `BROWSER_CONTROL_STATE_DIR` and `BROWSER_CONTROL_HOST_SOCKET`.
- While the zip's installer owns the manifest, the server cannot reach your Chrome. Doctor reports
  `FAIL manifest` with status `foreign`, and `previous` names `<state>/hosts/skill/browser-control-host`. Its
  `endpoint` line shows the socket that the server uses.
- The zip's `client.js` connects to `~/.opzero-chrome/default.sock`. To use it with this package's host, set
  `BROWSER_CONTROL_HOST_SOCKET=<state>/sockets/user.sock`.

Run `npx -y @op1/browser-control install --force` to give the manifest back to the server's host, then reload
the extension in `chrome://extensions`.

## Configure the MCP client

Print a snippet with `npx -y @op1/browser-control config <opencode|claude|codex|cursor>`.

OpenCode (`opencode.jsonc`):

```json
{
  "mcp": {
    "browser-control": {
      "type": "local",
      "command": ["npx", "-y", "@op1/browser-control", "mcp"],
      "enabled": true
    }
  }
}
```

Claude Code (`.mcp.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "npx",
      "args": ["-y", "@op1/browser-control", "mcp"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.browser-control]
command = "npx"
args = ["-y", "@op1/browser-control", "mcp"]
tool_timeout_sec = 150
```

`claim_browser` can take up to 120 seconds. If your client limits tool calls to a shorter time, raise its
limit for this server.

The server identifies the calling session from the MCP request metadata (`ai.opencode/sessionID` or
`sessionID`). A client that sends neither gets one session per server process.

## Check the setup

```sh
npx -y @op1/browser-control doctor
```

Doctor reads the same locations as install and changes nothing. It accepts `--state-dir`,
`--chrome-manifest-dir`, `--skills-dir` and `--json`. It checks skill links only in the directories given
with `--skills-dir`. Each line starts with `ok`, `warn` or `FAIL`, and names
the command that fixes the problem. Doctor exits with status 1 when a line is `FAIL`. Warnings cover optional
parts: a closed Chrome, cua-driver, Chrome for Testing, the clipboard guard, skills and ffmpeg.

`doctor --smoke` also runs one isolated end-to-end check:

1. Starts the server with a temporary state directory, and a user-route socket
   (`BROWSER_CONTROL_HOST_SOCKET`) that does not exist, so your Chrome is never reached.
2. Serves a loopback page with `FAST_CHROME_ALLOW_LOOPBACK=1`.
3. Claims an isolated browser, opens the page, runs one `act_steps` batch, and releases the tab and the lease.
4. Stops the temporary Chrome for Testing profile with `browser-control pool reap` and removes the temporary
   directory.

If the temporary browser cannot be confirmed stopped, doctor keeps the directory and prints the `pool reap`
command to run.

## Environment

| Variable | Meaning |
|---|---|
| `BROWSER_CONTROL_STATE_DIR` | Absolute state directory. Default `~/.local/state/browser-control`. |
| `BROWSER_CONTROL_HOST_SOCKET` | The user route's native host socket. Default `<state>/sockets/user.sock`. |
| `BROWSER_CONTROL_USER_DATA_DIR` | Chrome user-data directory for the read-only extension check in install and doctor. |
| `BROWSER_CONTROL_PREFERENCES_PATH` | Exact Preferences file for that check. Takes precedence over the user-data directory. |
| `CUA_DRIVER` | Absolute path to cua-driver. |
| `FAST_CHROME_ALLOW_LOOPBACK` | `1` allows HTTP on `127.0.0.1` and `localhost`, for synthetic checks only. |
| `FAST_CHROME_UNSHARED_SITES` | Comma-separated registrable domains whose leases never share an isolated browser. Default none. |
| `FAST_CHROME_ARTIFACT_ROOT` | A private directory for the user route's screenshots and recordings. Default `<state>/artifacts/user`. |
| `FAST_CHROME_MAX_CONTROLLERS`, `FAST_CHROME_MAX_TENANTS` | Pool limits. |

## Upgrade and remove

After `npx` fetches a new version, run `install` again. It copies the new host, points the wrapper and the
skill links at the new copies, and leaves the manifest unchanged. Older copies stay under
`<state>/hosts` for a Chrome that still runs them.

The wrapper pins the absolute Node executable that ran `install`. Rerun `install` before removing that Node
installation, using the replacement Node executable.

To remove the setup, delete the `com.opzero.chrome.json` manifest if it names
`<state>/hosts/user/browser-control-host`, delete the skill links, then delete the state directory.
