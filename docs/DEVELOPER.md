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

The installer writes `com.opzero.chrome.json` into Chrome's per-user `NativeMessagingHosts` directory, and it saves the extension ID to `dist/scripts/extension-id.json` so follow-up checks can run without `--extension-id`. Pass `--socket-path <path>` to give the host a private socket other than `~/.opzero-chrome/default.sock`.

For a disposable Chrome for Testing profile, write the host manifest to `<user-data-dir>/NativeMessagingHosts/` instead, so the default Chrome profile keeps its own host. `store/capture/launch.sh` shows the full sequence.

## Host controls

The popup has three controls:

- **Reload host** closes the native port and opens a new one. Chrome restarts the host process, and every connected agent session ends.
- **Pause host** disconnects the host, stops the reconnect and heartbeat alarms, and ends every session. The paused state is stored and survives service worker and browser restarts.
- **Resume host** clears the paused state and reconnects.

The popup shows **Connecting** until the host sends its first message, because `connectNative` returns a port even when no host is installed. A host that does not answer within 15 seconds, or that fails the 30-second heartbeat, is dropped. When the host exits or is dropped, the extension shows **Disconnected** and its reconnect alarm reconnects within 30 seconds.

The host removes a stale socket left by a crashed host only when a connection to it is refused. It does this under the exclusive lock file `<socket>.lock`, so two hosts cannot both replace the endpoint. At shutdown it removes the socket only if the socket is still the one it bound.

## Verify

```sh
pnpm run check
pnpm run check-native-host -- --extension-id <your-extension-id> --json
pnpm run check-extension -- --extension-id <your-extension-id> --json
pnpm run client -- ping
pnpm run client -- getInfo
```

To also run the headless-browser private-input tests, point `OPZERO_SYNTHETIC_CHROME` at a Chrome for Testing binary:

```sh
OPZERO_SYNTHETIC_CHROME="/path/to/Google Chrome for Testing" pnpm exec vitest run tests/security/private-input.browser.test.ts
```
