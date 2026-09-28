# Browser Control

Browser Control connects an AI agent to Chrome through an MCP server, a Chrome extension, and a native messaging host. It provides observed page actions, tab ownership, screenshots, and isolated Chrome for Testing leases.

## Install

The npm package requires Node.js 24 or later on macOS or Linux. Isolated browser leases and private 1Password transfer require macOS and a separately installed cua-driver.

1. Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/dcnjjnecbhipdbngkhjppkckpkellmld).
2. Install the native host:

   ```sh
   npx -y @op1/browser-control install
   ```

3. Open the extension popup and click **Reload host**.
4. Print the configuration for your MCP client:

   ```sh
   npx -y @op1/browser-control config claude
   ```

   Replace `claude` with `opencode`, `codex`, or `cursor` for another client. Add the printed configuration to that client.
5. Check the installation:

   ```sh
   npx -y @op1/browser-control doctor
   ```

The server command is `npx -y @op1/browser-control mcp`. Installation stores stable copies under `~/.local/state/browser-control`. Set `BROWSER_CONTROL_STATE_DIR` to use another directory. To install the three bundled skills, pass `--skills-dir <your-client-skills-directory>` to `install`; no skills directory is chosen automatically.

See [installation and troubleshooting](docs/server/INSTALL.md) for flags, optional tools, and the isolated smoke check. The generated native-host wrapper uses the Node executable that ran `install`. Rerun `install` after removing or replacing that Node installation.

## Use

Load the [browser-control skill](skills/browser-control/SKILL.md) in your agent. Start with `status` and `tabs`, then claim a tab or open one. Use `act_steps` to batch actions selected from observed controls. Release tabs before releasing a browser lease.

The popup's **Pause host** disconnects the host and ends its agent sessions until **Resume host** is selected. The pause setting survives browser restarts. If the host exits, the extension retries within about 30 seconds.

The [bundled native host scripts](skills/browser-control/references/native-host.md) also support the standalone release-zip installation. Use one installer per Chrome profile because both installers write the same native-messaging manifest.

## Identifiers

| Component | Value |
| --- | --- |
| npm package and CLI | `@op1/browser-control`, `browser-control` |
| Chrome Web Store extension | `dcnjjnecbhipdbngkhjppkckpkellmld` |
| Isolated-profile extension | `mpodnojmjjafgogldgieimgbmfhhknbe` |
| Native messaging host | `com.opzero.chrome` |
| Host and page protocols | Version 2 |

The isolated copy has a public key that fixes its extension ID across paths and upgrades. The Web Store build has no injected key. A manually loaded unpacked build without a key gets an ID derived from its absolute path.

## Develop

```sh
pnpm install
pnpm run check
```

`check` builds the extension, native host, MCP server, and skill, then runs type checks, tests, project checks, and Python parity mapping checks. To include disposable headless-browser tests, set `BROWSER_CONTROL_SYNTHETIC_CHROME` to a Chrome for Testing executable.

Repository guides: [development](https://github.com/opzero1/browser-control/blob/main/docs/DEVELOPER.md) and [release](https://github.com/opzero1/browser-control/blob/main/docs/RELEASE.md).

## Support and privacy

- [Homepage](https://browser-control.pages.dev/)
- [Privacy policy](docs/PRIVACY.md)
- [Support](https://browser-control.pages.dev/support/)
