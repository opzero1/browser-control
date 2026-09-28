# Developer Setup

## Local extension install

1. Run `pnpm install && pnpm run build`, or download `browser-control-extension.zip` from the latest GitHub Release and unzip it.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `dist/extension` or the unzipped folder.
6. Copy the extension ID that Chrome shows.

The manifest has no `key` field, so Chrome derives the unpacked ID from the folder's absolute path. Loading the same folder always gives the same ID; moving it gives a new one.

## Native host

From a local checkout:

```sh
pnpm install
pnpm run install-native-host -- --extension-id <your-extension-id>
```

Open the extension popup and click **Reload host** after you install the native host.

The installer copies the host into `hosts/skill-<digest>/` under the state root (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`) and writes the wrapper `hosts/skill/browser-control-host`, which runs that copy with the Node that ran the installer. It then writes `com.opzero.chrome.json` into Chrome's per-user `NativeMessagingHosts` directory, pointing at that wrapper, so Chrome never depends on `dist/` or the skill directory. It refuses to replace a manifest that points at another host unless you pass `--force`. It saves the extension ID to `dist/scripts/extension-id.json` so follow-up checks can run without `--extension-id`. Pass `--socket-path <path>` to give the host a private socket other than `~/.opzero-chrome/default.sock`.

The host and client read these variables. They replaced the `OPZERO_CHROME_*` names, which are no longer read:

| Variable | Use |
| --- | --- |
| `BROWSER_CONTROL_HOST_SOCKET` | Unix socket path. Default `~/.opzero-chrome/default.sock`. The installer's `--socket-path` writes it into the wrapper. |
| `BROWSER_CONTROL_HOST_TRANSPORT` | `tcp` selects the loopback TCP transport, which Windows always uses. |
| `BROWSER_CONTROL_HOST_PORT` | TCP port. Default `17365`. |
| `BROWSER_CONTROL_HOST_TOKEN_FILE` | File that holds the TCP connection token. |
| `BROWSER_CONTROL_REQUEST_TIMEOUT_MS` | Host request timeout. Default `30000`. |
| `BROWSER_CONTROL_EXTENSION_ID` | Extension ID for the installer and checks, in place of `--extension-id`. |
| `BROWSER_CONTROL_USER_DATA_DIR`, `BROWSER_CONTROL_PREFERENCES_PATH` | Chrome profile that `check-extension` inspects. |

For a disposable Chrome for Testing profile, write the host manifest to `<user-data-dir>/NativeMessagingHosts/` instead, so the default Chrome profile keeps its own host. `store/capture/launch.sh` shows the full sequence.

## Host controls

The popup has three controls:

- **Reload host** closes the native port and opens a new one. Chrome restarts the host process, and every connected agent session ends.
- **Pause host** disconnects the host, stops the reconnect and heartbeat alarms, and ends every session. The paused state is stored and survives service worker and browser restarts.
- **Resume host** clears the paused state and reconnects.

The popup shows **Connecting** until the host sends its first message, because `connectNative` returns a port even when no host is installed. A host that does not answer within 15 seconds, or that fails the 30-second heartbeat, is dropped. When the host exits or is dropped, the extension shows **Disconnected** and its reconnect alarm reconnects within 30 seconds.

Every Unix host startup holds the lock file `<socket>.lock`, from its first look at the socket path until its own socket is listening. The lock holds the owner's process ID. A new host treats it as stale only if that process is dead, or if the lock is older than five minutes, which only happens when a process ID has been reused. While the lock is held, the host removes a socket left by a crashed host only if a connection to it is refused. At shutdown it removes the socket only if it is still the one it bound. A host that cannot take the lock exits, and the extension retries within 30 seconds.

Known limits of this lock: Node.js has no crash-released file lock, so ownership rests on the lock file. Two hosts can still both believe they own the endpoint in three rare cases. The first is an orphaned lock left by an interrupted start, combined with three hosts starting at once. The second is the same orphaned lock, two hosts starting at once, and the filesystem reusing the freed inode. The third is a host suspended for more than five minutes mid-start. A single Chrome profile cannot reach any of these. Use one Chrome profile per socket path.

## Verify

```sh
pnpm run check
pnpm run check-native-host -- --extension-id <your-extension-id> --json
pnpm run check-extension -- --extension-id <your-extension-id> --json
pnpm run client -- ping
pnpm run client -- getInfo
```

To also run the headless-browser private-input tests, point `BROWSER_CONTROL_SYNTHETIC_CHROME` at a Chrome for Testing binary:

```sh
BROWSER_CONTROL_SYNTHETIC_CHROME="/path/to/Google Chrome for Testing" pnpm exec vitest run tests/security/private-input.browser.test.ts
```
