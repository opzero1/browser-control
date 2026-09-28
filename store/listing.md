# Chrome Web Store listing: Browser Control 0.2.1

Paste-ready values for every Chrome Web Store developer dashboard field. The values come from an audit of `src/` at extension version 0.2.1, including commit a88821b, which dropped the `history` and `downloads` permissions. The manifest now requests exactly `alarms`, `debugger`, `nativeMessaging`, `scripting`, `storage`, `tabGroups`, `tabs` and the host permission `<all_urls>`. See [Source audit](#source-audit) for the code behind each claim.

Character counts are JavaScript string lengths (UTF-16 code units) of the text inside each block. For every field here that equals the number of Unicode code points. Paste the text inside the block, not the fence.

The public privacy policy is `site/privacy/index.html`, served at <https://browser-control.pages.dev/privacy/>. Its Markdown copy is `docs/PRIVACY.md`. The disclosures below match it. See [Consistency with the privacy policy](#consistency-with-the-privacy-policy).

The site is the Cloudflare Pages project `browser-control` at <https://browser-control.pages.dev/>. The repository is <https://github.com/opzero1/browser-control>.

## Store listing tab

### Item name

15 / 75 characters. The name contains no Google trademark.

```text
Browser Control
```

### Summary

The dashboard shows the summary from the package: the `description` field of `src/extension/manifest.json`. It cannot be edited in the dashboard.

**Recommended: keep the current text.** 108 / 132 characters. It has no trademark, and it already says that the user must install a host. Keeping it avoids a manifest change and a new package.

```text
Connects browser tabs to a local AI agent on your computer through a native messaging host that you install.
```

Optional alternative, only if the manifest is changed anyway. 120 / 132 characters. It also says that the extension is idle without the host.

```text
Lets an AI agent on your own computer work in your tabs. Does nothing until you install its local native messaging host.
```

### Detailed description

2062 / 16,000 characters. Plain text. No testimonials, and no site list. Keyword check: no word other than common function words appears five or more times. The most frequent terms are "host" and "extension" (4 each); "Chrome", "tab", "agent", "AI", "helper", "page", "install", "control" and "software" (3 each). It names five brands: Google Chrome™, GitHub, Node.js, macOS and Linux. Chrome appears in the "Google Chrome™" compatibility form, so the last line is the trademark attribution. The count includes that line.

```text
Browser Control lets an AI agent that you run on your own computer do work in Google Chrome™ for you. The extension talks to a small helper program, called a native messaging host, that you install on the same machine. Your agent sends requests to the helper, and the extension carries them out.

It does nothing on its own. Until the helper is installed, it stays idle and its popup shows "Disconnected".

WHO IT IS FOR
Developers and people who use AI coding assistants or their own scripts, and who want that software to work in a real window they can watch.

WHAT IT CAN DO WHEN ASKED
• List your open tabs, or open new ones in the background
• Keep its work in a labeled tab group, apart from yours
• Read the visible text of a page and the buttons, links and fields on it
• Click, type into form fields and attach a local PDF
• Capture screenshots and short recordings
• Send DevTools Protocol commands for advanced automation

SETUP
1. Add this extension.
2. Download the host program from the project on GitHub and run its installer. It needs Node.js 18 or later on macOS or Linux. Other systems need extra manual configuration.
3. Open the popup and check that it shows "Connected".

YOU STAY IN CONTROL
• Pause or reload the link from the popup at any time. Pausing ends every session.
• While the debugger is attached, Chrome displays a notice.
• At cleanup, it closes only the tabs it opened and hands back the ones it borrowed.

PRIVACY
Data goes only to the host on your computer, and from there to the software you connect. Nothing is sent to the maintainers or to any server of theirs. No ads, no analytics, no remote code. Your agent is separate software, so check how it, and any AI service it uses, handles data.

Sign-in values sent by a local tool are filled straight into verified HTTPS fields. Neither the extension nor the host stores or logs them, and screenshots and page reading are blocked on that page afterwards.

Source code and issue tracker: https://github.com/opzero1/browser-control

Google Chrome is a trademark of Google LLC.
```

### Category

**Developer Tools** (in the Productivity group). The users are developers who run local AI coding agents or scripts, and the core feature is a DevTools Protocol bridge.

### Language

**English**

### Graphic assets

| Asset | Requirement | Source or status |
| --- | --- | --- |
| Store icon | 128 x 128 PNG | `src/extension/images/icon-128.png` (verified 128 x 128 RGBA). The same file is `site/icon.png`. |
| Screenshots | 1 to 5, 1280 x 800 (or 640 x 400), showing the real user experience | TODO(coordinator). Another worker added four 1280 x 800 candidates in `store/assets/`. This change did not review them. Check that each one shows real extension behavior, and that the captions follow the keyword and brand limits. Suggested shots, all from a real session: (1) the popup showing **Connected**; (2) an agent tab in the "Browser Control" tab group with the agent cursor on the page and the Chrome debugging notice visible; (3) the popup after **Pause host**, showing **Paused** and the **Resume host** button; (4) the "✅ Browser Control" group with a kept result tab; (5) the popup showing **Disconnected** with the "Install the native host to connect." hint. Do not stage screens that the extension cannot produce. |
| Small promo tile | 440 x 280 PNG or JPEG | TODO(coordinator). Not produced by this change. |
| Marquee promo tile | 1400 x 560, optional | Not needed. |

### Additional fields

| Field | Value |
| --- | --- |
| Official URL / homepage URL | `https://browser-control.pages.dev/` |
| Support URL | `https://browser-control.pages.dev/support/` |
| Mature content | No |

### Additional instructions for reviewers

The dashboard field holds 500 characters at most. This text is 468 characters with LF line breaks, or 473 if each line break counts as CRLF. It is plain ASCII. It is copied from `store/reviewer-test-instructions.md`, and it links to the full steps on <https://browser-control.pages.dev/support/reviewers/>.

```text
Idle until its local native messaging host is installed (popup: Disconnected). No account or server is needed.
Test on macOS or Linux with Node.js 18+:
1. Download and unzip https://browser-control.pages.dev/download/chrome-control-skill.zip
2. In that folder run: node scripts/install-native-host.js --extension-id dcnjjnecbhipdbngkhjppkckpkellmld
3. Click Reload host in the popup. It shows Connected.
Full steps: https://browser-control.pages.dev/support/reviewers/
```

## Privacy tab

### Single purpose description

489 / 1,000 characters.

```text
Browser Control lets an AI agent that the user runs on their own computer operate the user's browser tabs, through a native messaging host that the user installs locally. At the agent's request it lists, opens and groups tabs, reads page content, clicks and fills controls, attaches a local PDF, captures screenshots and short recordings, and relays DevTools Protocol commands to the agent's own tabs. It does nothing until the local host is installed, and it sends data only to that host.
```

### Permission justifications

One field for each permission in `src/extension/manifest.json`. Each is 1,000 characters or less.

#### `alarms`

572 / 1,000 characters.

```text
Keeps the connection to the user's locally installed native messaging host working. The service worker (background.ts, NativeTransport.scheduleAlarms) creates two alarms that fire every 30 seconds. The reconnect alarm calls chrome.runtime.connectNative again if the host is not connected and the user has not paused it. The heartbeat alarm pings the host; if the ping fails or times out, all agent sessions are stopped, so control never continues over a dead connection. When the user clicks Pause host in the popup, both alarms are cleared. Alarms never contact a server.
```

#### `debugger`

862 / 1,000 characters.

```text
Core feature: the user's local AI agent drives its tabs through the Chrome DevTools Protocol. The extension attaches chrome.debugger only to tabs in the agent's session (tabs it opened or claimed). Bundled code sends Page.navigate (stay within the site the agent bound), Page.captureScreenshot (JPEG screenshots and short recordings), DOM.getDocument, DOM.querySelectorAll and DOM.setFileInputFiles (attach a local PDF to an upload field), and Runtime.evaluate with a bundled script (draw the agent cursor if the content script is blocked). The executeCdp request relays other commands from the local agent to its own attached tabs. Target.* and Browser.* commands are refused, and raw commands are refused on origin-bound and privately filled tabs. Events from those tabs go back only to the same local session. Chrome shows its debugging notice while attached.
```

#### `nativeMessaging`

592 / 1,000 characters.

```text
This is the extension's only communication channel. The service worker calls chrome.runtime.connectNative("com.opzero.chrome") to reach a helper program that the user installs on their own computer. The helper's manifest allows only this extension's ID. The helper accepts requests from the user's local AI agent over a private Unix socket (or an authenticated loopback TCP port) and relays them to the extension as JSON-RPC messages; the extension returns results the same way. Without the helper the extension does nothing, and its popup shows Disconnected. No data goes to a remote server.
```

#### `scripting`

759 / 1,000 characters.

```text
Runs functions that ship in the package, in the isolated world of the top frame of tabs in the agent's session. They read the page URL, title, visible text and up to 100 clickable or fillable controls (observe); click or fill a control the agent chose from that list (act); verify a file input before a PDF upload; fill sign-in fields with values from a local helper without exposing them in page readings (private fill); and check that no filled password or one-time-code field is on the page before a screenshot. The service worker also injects the bundled content script content-scripts/opzero-chrome.js to draw the agent's cursor, so the user can see where the agent acts. Nothing is injected into tabs outside the agent's session, and no code is fetched.
```

#### `storage`

714 / 1,000 characters.

```text
Stores small connection and session state in chrome.storage.local: the native host status shown in the popup (NATIVE_HOST_STATUS), whether the user paused the host (NATIVE_HOST_PAUSED), agent tab-group bookkeeping with session IDs, group IDs, tab IDs and group titles (TAB_GROUPS), a random extension instance ID (extensionInstanceId), and after a private fill a per-tab marker with the document ID and the CSS selectors of the filled fields, never the values (PRIVATE_CAPTURE_QUARANTINE:<tabId>). chrome.storage.session holds the version of a pending update (opChromePendingUpdateVersion) so that the update waits until agent work ends. No page content, screenshots, tab URLs or titles, or credentials are stored.
```

#### `tabGroups`

494 / 1,000 characters.

```text
Keeps the agent's work visible and separate from the user's own tabs. Every tab the agent opens or claims goes into a tab group for that agent session, titled "Browser Control" by default or with a name the agent sets. Tabs the agent keeps as results move to a shared "✅ Browser Control" group. The extension uses chrome.tabGroups.get and chrome.tabGroups.update to set the title, color and collapsed state, and collapses the group when the session ends. It only updates groups that it created.
```

#### `tabs`

692 / 1,000 characters.

```text
Lets the user's local agent see and use tabs. getUserTabs calls chrome.tabs.query and returns the ID, URL, title, window, position and group of the user's open tabs, leaving out Chrome internal pages, so the agent can pick one to claim. createTab opens an inactive blank tab in a normal window, and claimUserTab adds a tab the agent picked to its session. The extension also groups and ungroups agent tabs, messages its cursor overlay (chrome.tabs.sendMessage), and, when the agent finishes (finalizeTabs), closes only tabs the agent opened. It listens to chrome.tabs.onUpdated, onRemoved and onReplaced to cancel stale actions after a navigation or when a tab closes. Tab data is not stored.
```

### Host permission justification

For `host_permissions: ["<all_urls>"]`. The last sentence also covers `web_accessible_resources`, which has no separate field. 810 / 1,000 characters.

```text
The user decides which websites their local agent works on, so the sites cannot be listed in advance. Host access is needed to run the bundled page functions with chrome.scripting.executeScript in tabs in the agent's session (read visible text and controls, click, fill, prepare a PDF upload, private fill, and the privacy check before screenshots), and to inject the cursor overlay content script. Access is used only in tabs the agent opened or claimed, never in the user's other tabs, and Chrome internal pages are refused. Before the typed page functions run, the agent must bind the tab to one exact HTTPS origin (or a loopback address with explicit opt-in), and navigation outside that origin is refused. The web-accessible resource images/cursor-chat.svg is only the cursor image that the overlay shows.
```

### Remote code

Answer: **No, I am not using remote code.**

Justification, 856 / 1,000 characters:

```text
No. Every script the extension runs is in the package: background.js, popup.js, content-scripts/opzero-chrome.js, and page functions bundled in background.js and injected with chrome.scripting.executeScript({ func }). The extension loads no script from any URL, has no script tag that points outside the package, and never passes strings to eval() or new Function(). Its extension pages use the CSP script-src 'self'. The minified Effect library in the bundles has object methods named eval; they are ordinary methods, not the global eval. For completeness: the executeCdp request can relay a DevTools Protocol command, such as Runtime.evaluate, from the user's own local agent to a page in that agent's tab. That input comes from software on the user's device over native messaging, not from a remote server, and it runs in the page, not in the extension.
```

### Data usage

Google: "Extensions are required to disclose how they handle user data, even when data is processed or stored locally." Browser Control collects nothing for its maintainers, but it reads the data below and passes it to the native messaging host on the same computer. Local handling counts, so the checked categories are the ones that the code handles, even though the data never leaves the device through the extension.

| Category | Mark | Reason (from the audit) |
| --- | --- | --- |
| Personally identifiable information | Unchecked | No code collects or extracts names, addresses, email addresses or ID numbers. Such details can appear by chance on a page that the agent reads. They are then handled only as Website content, and the privacy policy says so. |
| Health information | Unchecked | No code reads health data. Health details that appear on a page are handled only as Website content. |
| Financial and payment information | Unchecked | No code reads payment, card or transaction data. Financial details that appear on a page are handled only as Website content. |
| Authentication information | **Checked** | Private fill passes passwords and one-time codes from a local program into verified sign-in fields, without storing or logging them (`privateFill`, `background.ts:972-998`; `private-input.ts:25-56`). The `executeCdp` relay (`background.ts:906-926`) can return the cookies of agent tabs. |
| Personal communications | Unchecked | No code reads mail, chat or messaging data. Messages that are visible on a page are handled only as Website content. |
| Location | Unchecked | No code uses geolocation or looks up IP addresses. Location details that a page shows are handled only as Website content. |
| Web history | **Checked** | `getUserTabs` (`background.ts:791-800`) returns the URLs and titles of the user's open tabs. `getTabs`, `createTab` and `claimUserTab` return the URL and title of agent tabs. DevTools events from agent tabs can carry the addresses of pages that the tab loads. |
| User activity | **Checked** | Network and other DevTools events from agent tabs go to the owning local session when the local agent turns those DevTools domains on (`onCDPEvent`, `background.ts:1314-1317`). The extension's own code does not listen to the user's clicks, keystrokes or scrolling. |
| Website content | **Checked** | Visible text, title and control labels (`observePage`), screenshots and recording frames (`capturePage`), and DevTools results (`executeCdp`) from agent tabs. This also covers any personal, health, financial, communication or location details that appear on those pages. |

### Certifications

Check all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

They are true because the extension sends data only to the host on the user's device (`chrome.runtime.connectNative`), has no network code, and uses data only to carry out the local agent's requests.

### Privacy policy URL

`https://browser-control.pages.dev/privacy/`

## Consistency with the privacy policy

| Listing disclosure | Privacy policy section |
| --- | --- |
| Authentication information (checked) | Table row "Sign-in values", and the section "Private credential fill". Cookies: table row "Chrome DevTools Protocol results and events". |
| Web history (checked) | Table row "Tab details". Page addresses: table row "Chrome DevTools Protocol results and events". |
| User activity (checked) | Table row "Chrome DevTools Protocol results and events" ("other network activity and page events") |
| Website content (checked) | Table rows "Page content", "Screenshots" and "Chrome DevTools Protocol results and events", and the paragraph after the table |
| Personally identifiable, health, financial, personal communications and location (unchecked) | The paragraph after the table: such details are handled "only as part of the website content described above" |
| Storage justification keys | "In the extension's storage": the same five `chrome.storage.local` keys and one `chrome.storage.session` key |
| Remote code: No | "What we do not do", the remote code bullet |
| Certifications | "What we do not do", and the Limited Use sentence |
| Single purpose | "How the data is used" |

## Source audit

### Permissions

Line numbers refer to the files at extension version 0.2.1, after commit a88821b.

| Permission | Code (file:line) | User-facing feature | Verdict |
| --- | --- | --- | --- |
| `alarms` | `background.ts:391-394` create; `451-452` clear; `1387-1393` `onAlarm` | Automatic reconnect every 30 s, and a heartbeat that stops sessions when the host dies | Keep |
| `debugger` | `background.ts:890` attach; `893`, `1201` detach; `915` `getTargets`; `1118` `sendCommand`; `1314-1317` `onEvent`; `1319-1323` `onDetach` | Navigate, screenshots and recordings, PDF upload, cursor fallback, raw DevTools relay | Keep. It is the core feature. Expect in-depth review. |
| `nativeMessaging` | `background.ts:484` `connectNative("com.opzero.chrome")` | The only channel to the local host | Keep |
| `scripting` | `background.ts:592-595` (`pageControl`), `957-959` (`observePrivateFields`), `993-996` (`fillPrivateFields`), `1223-1227` (content script file) | Observe, act, upload preparation, private fill, cursor overlay | Keep |
| `storage` | `background.ts:136-140` helpers; writes at `240`, `254-265`, `406`, `475`, `991`; `1398` (session); `popup.ts:61`, `79` | Popup status, pause setting, group bookkeeping, private-fill quarantine | Keep |
| `tabGroups` | `background.ts:274-280`, `290-294`, `306-312`, `320-324`, `358`, `876-877` | Labeled agent tab groups and the "✅ Browser Control" group | Keep |
| `tabs` | `background.ts:794` (`query`), `807` (`create`), `784`, `812`, `820`, `827` (`get`), `854` (`remove`), `275`, `288`, `307`, `319` (`group`), `349` (`ungroup`), `1208` (`sendMessage`), `1325-1354` (events, used only to invalidate stale state; nothing is sent to the host) | List and claim tabs, create and close agent tabs, cursor messages | Keep for now. With `<all_urls>`, web-page URLs and titles are readable without `tabs`, but `isControllableUrl` (`background.ts:212-216`) treats a missing URL as controllable. Dropping `tabs` needs that code fixed first, or `chrome://` tabs become claimable. |
| `host_permissions: <all_urls>` | Needed by every `scripting.executeScript` call above, and by the content script injection | Work on any site that the user chooses | Keep, with justification. Possible narrowing: `https://*/*` plus loopback. The typed page API already requires HTTPS or loopback (`background.ts:707`), but the raw path and the cursor overlay also work on plain HTTP. |
| `web_accessible_resources: images/cursor-chat.svg` on `<all_urls>` | `content-scripts/opzero-chrome.ts:81` | The agent cursor image | Keep or drop. Any site can probe the file to detect the extension. A CSS fallback already exists (`opzero-chrome.ts:82-87`). Consider `use_dynamic_url: true`. |

Other APIs that need no permission: `chrome.windows.getCurrent` and `getAll` (`background.ts:367-369`), `chrome.runtime` messaging, reload and update events, and `chrome.dom.openOrClosedShadowRoot` (`page-control.ts:28`, `72`).

The extension sends the host only three kinds of notification: `onControlStopped` (`background.ts:1252`), `onCDPEvent` (`1316`) and `onCDPDetach` (`1322`).

### Chrome DevTools Protocol methods sent through `chrome.debugger`

| Method | Code | Feature |
| --- | --- | --- |
| `DOM.getDocument`, `DOM.querySelectorAll`, `DOM.setFileInputFiles` | `background.ts:660`, `662`, `671` | `uploadFile`: attach a local PDF to the file input that the agent chose |
| `Page.navigate` | `background.ts:718` | `navigatePage`: same-origin navigation only |
| `Page.captureScreenshot` (JPEG, quality 80) | `background.ts:759` | `capturePage`: screenshots and recording frames |
| `Runtime.evaluate` (bundled expression) | `background.ts:1189-1193` | Cursor fallback when the content script is unavailable |
| Any method from the local agent, except `Target.*` and `Browser.*` | `background.ts:906-926` | `executeCdp` raw relay. Refused on origin-bound tabs (`911`) and after a private fill (`912-913`). `Target.getTargets` is answered by `chrome.debugger.getTargets`, filtered to the session's tabs (`914-917`). |
| All events from attached session tabs | `background.ts:1314-1317` | Forwarded as `onCDPEvent` to the owning session only (`host.ts:87-93`) |

### Data flows

Extension (`background.ts`) → Chrome native messaging (stdio, 4-byte length-prefixed JSON, 1 MB limit toward the extension) → host (`host.ts`) → private Unix socket `~/.opzero-chrome/default.sock` (folder mode 700, socket mode 600), or loopback TCP `127.0.0.1:17365` with a token file → local client (`client.ts` or `transport.ts`) → the user's agent.

| Data | Source in code | Leaves the device? |
| --- | --- | --- |
| Tab URL, title, IDs, group | `tabInfo`, `background.ts:218-232`; `getTabs` (`780-789`), `getUserTabs` (`791-800`), `createTab`, `claimUserTab` | Only if the local agent sends it |
| Page text, title, control labels | `page-control.ts:217-236` | Only if the local agent sends it |
| Screenshots and recording frames | `background.ts:754-762`; recordings written by `transport.ts:165-211` | Only if the local agent sends it |
| Raw DevTools results and events | `background.ts:906-926`, `1314-1317` | Only if the local agent sends it |
| Private-fill values | `background.ts:972-998`, `private-input.ts:25-56`; the host reduces the reply at `host.ts:66-69` | Typed into the page. The site receives them when the form is submitted. |
| Uploaded PDF | Path only, `background.ts:671`. The extension never reads the bytes. `transport.ts:134-136` reads 5 bytes to check the signature. | To the website, when the page submits the form |
| Agent-typed text and clicks | `page-control.ts:259-277` | To the website, as normal browsing |

**Remote transmission:** none by the extension. `src/extension` and `src/shared` contain no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` or `importScripts`, and neither do the built bundles in `dist/extension` (rebuilt after a88821b). The only external URL in the extension is the user-clicked "Docs" link in `popup.html:42`. The URLs in the bundles are Effect error-message strings. The extension CSP is `script-src 'self'; connect-src 'self'`. The host, client and transport use only local `net` sockets. Chrome itself contacts websites when the agent navigates or submits.

## Review risks

1. **In-depth review is likely.** The item requests `debugger`, `<all_urls>` and `tabs`. Google names `<all_urls>` and `tabs` as causes of longer review.
2. **Raw DevTools relay.** `executeCdp` (`background.ts:906-926`) forwards any method except `Target.*` and `Browser.*`, including `Runtime.evaluate`, `Network.getCookies` and `Storage.*`. A reviewer can treat this as executing code that is not in the package, or as broad data access. The remote-code justification discloses it. To remove the risk, change the code to an allowlist, or block `Runtime.evaluate`, `Runtime.compileScript`, `Page.addScriptToEvaluateOnNewDocument` and cookie and storage methods.
3. **Minified bundles.** `dist/extension/*.js` are minified IIFE bundles of about 190 to 245 KB. Google allows minification, but reviewers must be able to understand the code. Static scanners may flag six `eval(` matches per bundle. They are Effect `Micro` object methods named `eval`, not the global `eval`. Consider `build.minify: false` for the store package, and point reviewers to the public source.
4. **Stale docs outside this change.** `README.md` and `docs/DEVELOPER.md` are current. `scripts/install-chrome-control-skill.sh` still downloads from `opzero1/op-chrome`. `skills/chrome-control/SKILL.md` still says "Opzero Chrome", documents the removed `getUserHistory` call and the `onDownloadChange` notification, and shows `client.js` commands with JSON arguments that `client.ts:13-15` rejects. That file ships inside `chrome-control-skill.zip`, which reviewers download.
5. **Leftover host routing.** `host.ts` still accepts `host.subscribeProfileEvents` and routes `onDownloadChange` to subscribed clients (`host.ts:90`, `135-138`), but the extension no longer sends that notification. The code is unreachable and not part of the extension package. A reviewer who reads the host source may still ask about it.
6. **Windows.** A host started by Chrome on Windows exits unless `OPZERO_CHROME_HOST_TOKEN_FILE` is set (`host.ts:199-206`), and the installer never sets it. `transport.ts:37-40` supports only Unix sockets. Do not claim Windows support. The listing says "Other systems need extra manual configuration".
7. **One profile at a time.** All profiles share one socket, and a second host exits when the socket exists (`host.ts:213`). A reviewer with several profiles sees Disconnected in all but one. The reviewer steps say to use one profile.
8. **Quarantine keys are never removed.** No code removes the `PRIVATE_CAPTURE_QUARANTINE:<tabId>` keys, so they build up. Tab IDs restart after a browser restart, so a new tab can inherit an old marker, and `executeCdp` then refuses that tab (`background.ts:912-913`). The policy says that these entries stay until uninstall.
9. **DevTools events after a private fill.** If a client turned on a domain such as `Network` before it bound the page, later events, such as a form post, still reach that local session (`background.ts:1314-1317`). The policy states this.
10. **Functionality not visible without the host.** Without the host, reviewers see only a Disconnected popup. The reviewer instructions above and <https://browser-control.pages.dev/support/reviewers/> cover this.
11. **Private vulnerability reporting.** The support page sends security reports to `https://github.com/opzero1/browser-control/security/advisories/new`. That form works only if private vulnerability reporting is turned on in the repository settings.
