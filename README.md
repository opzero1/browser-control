# Browser Control

Browser Control is a Chrome extension and native messaging host that let an AI agent on your own computer work in your browser tabs. The extension does nothing until you install the local host.

- Homepage: <https://browser-control.pages.dev/>
- Privacy policy: <https://browser-control.pages.dev/privacy/>
- Support: <https://browser-control.pages.dev/support/>

## Identifiers

| What | Value |
| --- | --- |
| Chrome Web Store item ID | `dcnjjnecbhipdbngkhjppkckpkellmld` |
| Native messaging host name | `com.opzero.chrome` |
| Host and page protocol | version 2 |
| Unpacked extension ID | Derived by Chrome from the absolute path of the loaded folder. The manifest has no `key` field. |

Chrome derives an unpacked extension's ID from its folder path, so every checkout or install location has its own ID. For example, the fast-chrome controller loads `~/.config/opencode/mcp/fast-chrome/op-chrome/dist/extension`, which gives the ID `pncpgnbanebkeopjghjleodgmphmmmcp`. The native host manifest must allow the ID of the extension that connects to it.

## Install for users

1. Install Browser Control from the [Chrome Web Store](https://chromewebstore.google.com/detail/dcnjjnecbhipdbngkhjppkckpkellmld).
2. Install the native host. It needs Node.js 18 or later on macOS or Linux:

   ```sh
   mkdir -p ~/.config/opencode/skills/chrome-control
   curl -fsSL https://github.com/opzero1/browser-control/releases/latest/download/chrome-control-skill.zip -o /tmp/chrome-control-skill.zip
   unzip -o /tmp/chrome-control-skill.zip -d ~/.config/opencode/skills/chrome-control
   cd ~/.config/opencode/skills/chrome-control
   node scripts/install-native-host.js --extension-id dcnjjnecbhipdbngkhjppkckpkellmld
   ```

3. Open the Browser Control popup and click **Reload host**. It shows **Connected**.

The popup also has **Pause host**, which disconnects the host and ends every agent session until you click **Resume host**. The pause setting survives browser restarts. If the host exits, the extension reconnects automatically within about 30 seconds.

To install the agent skill with one command instead:

```sh
curl -fsSL https://raw.githubusercontent.com/opzero1/browser-control/main/scripts/install-chrome-control-skill.sh | sh
```

## Verify

```sh
node native-host/client.js ping
node native-host/client.js getInfo
```

`ping` returns `pong` from the extension. `getInfo` reports `protocolVersion: 2`.

## Development

See [docs/DEVELOPER.md](docs/DEVELOPER.md) to load an unpacked build and connect a local host.

```sh
pnpm install
pnpm run check
```

`pnpm run check` builds the extension, native host and installable skill, then runs type checks, tests and the project checks. The headless-browser tests for private input run only when `OPZERO_SYNTHETIC_CHROME` names a Chrome for Testing binary.

## Release

See [docs/RELEASE.md](docs/RELEASE.md). The store listing text is in [store/listing.md](store/listing.md), the store images are in [store/assets](store/assets), and the website is in [site](site).
