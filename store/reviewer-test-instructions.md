# Reviewer test instructions: Browser Control 0.2.2

Maintainer note: the public copy of the full steps is `site/support/reviewers/index.html`, served at <https://browser-control.pages.dev/support/reviewers/>. When you change any text from "What you need" to the end of this file, make the same change on that page.

The short form below still links to `/download/chrome-control-skill.zip`, the helper's name before 0.2.2. It is the text in the dashboard's "Additional instructions for reviewers" field, which the Chrome Web Store API cannot change. The website serves the 0.2.2 `browser-control-skill.zip` at that path too, as an alias (see "3. Deploy the website" in `docs/RELEASE.md`), so the short form stays valid without an edit. The full steps use `/download/browser-control-skill.zip`. Once the dashboard field links to that path, the alias can go.

## Short form for the dashboard

Paste this into the "Additional instructions" field (500 characters at most). It is 468 characters with LF line breaks, or 473 if each line break counts as CRLF. It is plain ASCII.

```text
Idle until its local native messaging host is installed (popup: Disconnected). No account or server is needed.
Test on macOS or Linux with Node.js 18+:
1. Download and unzip https://browser-control.pages.dev/download/chrome-control-skill.zip
2. In that folder run: node scripts/install-native-host.js --extension-id dcnjjnecbhipdbngkhjppkckpkellmld
3. Click Reload host in the popup. It shows Connected.
Full steps: https://browser-control.pages.dev/support/reviewers/
```

## What you need

- macOS or Linux, with Google Chrome™ 106 or later (`minimum_chrome_version` in `manifest.json`). Use one Chrome profile with Browser Control turned on. All profiles share one host socket, so a second profile cannot connect at the same time.
- Node.js 18 or later on the `PATH`. Check with `node --version`. The host is a Node.js program.
- `curl` and `unzip`. Both come with macOS. On Debian or Ubuntu: `sudo apt-get install curl unzip`.
- Internet access to `browser-control.pages.dev` (to download the helper and to open the demo page).
- No account, sign-in, API key or server is needed. `ffmpeg` is not needed.
- Windows is not covered by these steps. A host started by Chrome on Windows needs a private token file that the installer does not create.

## Steps

### 1. Install the extension and see the idle state

1. Install Browser Control.
2. Click the Browser Control icon in the toolbar.

Expected: the popup shows **Disconnected** and "Install the native host to connect." It may show **Connecting** for a moment first, and it can also show "Error: Specified native messaging host not found." Nothing else happens. The extension has no network code, so it stays idle until a host exists.

### 2. Download the helper

```sh
mkdir -p ~/browser-control-review
cd ~/browser-control-review
curl -fsSL -o browser-control-skill.zip https://browser-control.pages.dev/download/browser-control-skill.zip
unzip -o browser-control-skill.zip -d helper
cd helper
ls
```

Expected: the folder contains `SKILL.md`, `chunks/`, `native-host/`, `references/` and `scripts/`. Run all later commands in this `helper` folder.

The link downloads `browser-control-skill.zip` for version 0.2.2 from this website. The same file is built from the source at [github.com/opzero1/browser-control](https://github.com/opzero1/browser-control). The short instructions in the store dashboard link to `chrome-control-skill.zip`, the helper's name before 0.2.2. That link downloads the same file.

### 3. Install the native messaging host

```sh
node scripts/install-native-host.js --extension-id dcnjjnecbhipdbngkhjppkckpkellmld
node scripts/check-native-host-manifest.js --json
```

Expected:

- The installer prints `Installed native messaging manifest:` with the manifest path, `Allowed extension origin: chrome-extension://dcnjjnecbhipdbngkhjppkckpkellmld/`, and `Host executable:` with the path of `native-host/browser-control-host`.
- The check prints JSON with `"ok": true` and `"status": "valid"`.

The manifest is written to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opzero.chrome.json` on macOS, or `~/.config/google-chrome/NativeMessagingHosts/com.opzero.chrome.json` on Linux.

### 4. Connect

1. Open the Browser Control popup.
2. Click **Reload host**.

Expected: the popup shows **Connected** and "Connected to the local agent host." If it still shows Disconnected, wait 30 seconds (the extension retries automatically) or click **Reload host** again.

### 5. Check the connection from the command line

```sh
node native-host/client.js ping
node native-host/client.js getInfo
```

Expected:

- `ping` prints `{"jsonrpc":"2.0","id":1,"result":"pong"}`. The answer comes from the extension through the host.
- `getInfo` prints one JSON line with `"version":"0.2.2"`, `"protocolVersion":2`, `"pageProtocolVersion":2` and `"extensionId":"dcnjjnecbhipdbngkhjppkckpkellmld"`.

If `ping` reports `Extension protocol v2 is not ready`, wait a few seconds and run it again. The host checks the extension for up to 10 seconds after it starts.

### 6. List open tabs (read only)

The client accepts request data only on standard input:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"getUserTabs","params":{}}' | node native-host/client.js --stdio
```

Expected: one JSON line whose `result` lists your open tabs with `id`, `title`, `url`, `windowId` and `groupId`. Chrome internal pages, such as `chrome://extensions`, are left out.

### 7. Open and read a tab

Save this file as `review-demo.js` in the `helper` folder:

```js
const os = require("node:os");
const path = require("node:path");
const { ChromeTransport } = require("./native-host/transport.js");

const socket = process.env.BROWSER_CONTROL_HOST_SOCKET || path.join(os.homedir(), ".opzero-chrome", "default.sock");

(async () => {
  const browser = await ChromeTransport.connect(socket);
  try {
    const page = await browser.open("https://browser-control.pages.dev/");
    const snapshot = await browser.waitFor(page, { text: "Browser Control lets an AI agent" }, 15000);
    console.log(JSON.stringify({ url: snapshot.url, title: snapshot.title, text: snapshot.text.slice(0, 200), actions: snapshot.actions }, null, 2));
    console.log("The tab stays open for 20 seconds. Click it in the \"Browser Control\" tab group to watch.");
    await new Promise((resolve) => setTimeout(resolve, 20000));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
```

Then run:

```sh
node review-demo.js
```

Expected:

1. A new background tab opens in a tab group named **Browser Control**.
2. Chrome shows its notice that Browser Control is debugging the browser.
3. The script prints JSON with `"url": "https://browser-control.pages.dev/"`, the page title, the start of the visible text, and an `actions` list with the page's links.
4. After 20 seconds the script ends and the extension closes the tab that it opened. Your own tabs stay as they were.

This uses the same client library (`native-host/transport.js`) that agent tools use. It opens the tab, attaches the debugger, binds the tab to `https://browser-control.pages.dev`, navigates, and reads the page.

### 8. Pause and resume

1. In the popup, click **Pause host**. The popup shows **Paused**, and the button changes to **Resume host**.
2. Run `node native-host/client.js ping`. It fails with `Private client stopped; outcome may be unknown; do not replay`, because pausing stops the host.
3. Click **Resume host**. The popup shows **Connected** again, and `ping` prints `pong`.

### 9. Clean up

1. Remove the extension on `chrome://extensions`.
2. Remove the host manifest and the socket folder:
   - macOS: `rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opzero.chrome.json"`
   - Linux: `rm "$HOME/.config/google-chrome/NativeMessagingHosts/com.opzero.chrome.json"`
   - Both: `rm -r "$HOME/.opzero-chrome" ~/browser-control-review`

## Where to look in the code

| Behavior | Source |
| --- | --- |
| Connection, reconnect and heartbeat | `src/extension/background.ts`, `NativeTransport` |
| Request handlers (`getUserTabs`, `createTab`, `observePage`, `capturePage`, `executeCdp` and others) | `src/extension/background.ts`, the `api` object |
| Page reading and actions | `src/extension/page-control.ts` |
| Private credential fill | `src/extension/private-input.ts` |
| Cursor overlay | `src/extension/content-scripts/opzero-chrome.ts` |
| Native messaging host | `src/native-host/host.ts` |
| Command-line client and client library | `src/native-host/client.ts`, `src/native-host/transport.ts` |
