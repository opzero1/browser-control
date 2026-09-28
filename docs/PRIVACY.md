# Browser Control privacy policy

Effective date: September 28, 2026

This policy explains how the Browser Control extension for Google Chrome™ ("the extension") and its local helper program, the native messaging host ("the host"), handle data. The Browser Control maintainers ("we") publish both as open-source software at <https://github.com/opzero1/browser-control>.

The same policy is published at <https://browser-control.pages.dev/privacy/>.

## Summary

- Browser Control connects your browser tabs to an AI agent that you run on your own computer.
- It works only after you install the host on the same computer. Without the host, the extension is idle.
- The extension sends data only to the host. The host sends it only to the local agent software that connects to it.
- We do not collect any data. The extension and the host send nothing to us or to any server that we run. We do not sell data, show ads, use analytics or load remote code.

## How data moves

1. **Extension to host.** The extension talks to the host through Chrome native messaging, over the standard input and output of a local process. Chrome starts the host, named `com.opzero.chrome`, only if you installed it. The host's manifest allows only the extension ID that you gave the installer. For the Chrome Web Store version, that ID is `dcnjjnecbhipdbngkhjppkckpkellmld`.
2. **Host to your local agent.** The host accepts connections only on a private endpoint on your computer. By default this is a Unix socket at `~/.opzero-chrome/default.sock`, in a folder that is restricted to your user account. On Windows, or if you configure it, the host listens on the loopback address `127.0.0.1` and requires a secret token that it reads from a private file. The host does not accept connections from other computers.
3. **Separate sessions.** Each connection to the host gets its own session. The answer to a request goes back only to the connection that sent it. Events from a tab go only to the connection whose session owns that tab. A notice that control stopped goes to every connection.
4. **Your local agent.** The agent is separate software that you choose and run. We do not make it, and we do not control what it does with data. For example, an AI agent can send page text or screenshots to the provider of its AI model. Check the privacy terms of your agent and of any service that it uses.
5. **Websites.** When your agent navigates, clicks, submits a form or attaches a file, Chrome sends the resulting requests to the website, the same as if you did it yourself. A file attached to an upload field goes to that website when the form is submitted.

## Data the extension handles

The extension handles data only when your local agent asks for it. "Agent tabs" are the tabs that the agent opened and the tabs that it claimed from your open tabs. The extension puts agent tabs in a labeled tab group.

| Data | When | Why |
| --- | --- | --- |
| Tab details: tab and window IDs, position, URL, title, whether the tab is active, and its tab group | The agent lists your open tabs (Chrome's internal pages are left out), opens a tab or claims a tab. | So that the agent can choose a tab and work in it. |
| Page content from agent tabs: URL, title, visible text (up to 12,000 characters) and the labels of up to 100 buttons, links and form fields | The agent reads a page. | So that the agent can understand the page and choose an action. Page readings never include what is typed in form fields. They leave out password fields, one-time-code fields and the labels of those fields. |
| Screenshots of agent tabs (JPEG images) | The agent asks for a screenshot or a short recording. | So that the agent can see the page. |
| Clicks and typed text | The agent clicks a control or types into a field that it found on the page (up to 2,000 characters for each field). | To carry out the task. |
| Chrome DevTools Protocol results and events for agent tabs | The agent attaches the debugger to one of its tabs and sends DevTools Protocol commands. | For advanced automation. Depending on the commands and the events that the agent turns on, this can include the page structure, the results of scripts that the agent runs in the page, the addresses of pages and resources that the tab loads, other network activity and page events, and the page's cookies. |
| Sign-in values, such as a user name or email address, a password or a one-time code | A local program on your computer asks the host to fill sign-in fields on a verified HTTPS page. | To sign in without putting the values in page readings. See [Private credential fill](#private-credential-fill). |
| Path, name and size of a local PDF file | The agent attaches a local PDF to an upload field. | To attach the file. The extension gives the file path to Chrome. It does not read the contents of the file. |

Browser Control handles personally identifiable information in two ways: the user name or email address that a local program fills through private credential fill, and the names, addresses and other details that your agent types into forms for you. Pages that you ask the agent to work on can also contain other personal information, such as messages, financial or health details, or your location. Browser Control does not look for, extract or keep these kinds of data separately. It handles them only as part of the website content described above: page text, screenshots and DevTools Protocol results from agent tabs.

## How the data is used

The extension uses data only to carry out the requests of the local agent that you connect, and to show the connection status in its popup. Data is not used for advertising, for profiles, to decide creditworthiness or for lending, or for any purpose unrelated to that single purpose.

## What is stored on your computer

### In the extension's storage

The extension keeps a small amount of state in `chrome.storage.local`:

| Key | Contents |
| --- | --- |
| `NATIVE_HOST_STATUS` | Connection state, host name, time of the last check, reconnect count and the last connection error message. |
| `NATIVE_HOST_PAUSED` | Whether you paused the host. |
| `TAB_GROUPS` | Agent session IDs, tab group IDs, tab IDs and group titles. |
| `extensionInstanceId` | A random ID created on first use. It is shared only with the local host and with local programs that ask the host for the extension's details. |
| `PRIVATE_CAPTURE_QUARANTINE:<tab ID>` | After a private fill: the page's document ID and the CSS selectors of the filled fields. It never contains the filled values. |

In `chrome.storage.session`, which Chrome clears when the browser closes, the key `opChromePendingUpdateVersion` holds the version number of an extension update that waits until agent work ends.

These entries stay in Chrome until you remove the extension. The extension does not store page content, screenshots, tab URLs or titles, or sign-in values.

### Files on your computer

- **Installer.** The host installer writes a native messaging host manifest named `com.opzero.chrome.json`:
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/`
  - Windows: `%USERPROFILE%\AppData\Local\opzero-chrome\`, plus the registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opzero.chrome`

  It also writes a launcher script in the `native-host` folder and the file `scripts/extension-id.json` inside the helper folder that you unpacked.
- **Host.** The host creates the private folder `~/.opzero-chrome` and a socket file in it, which it deletes when it stops. While it starts, it also holds a small lock file next to the socket that contains only its process ID, and it deletes the lock as soon as the socket is ready. The host keeps no log files. The only messages that it writes to its error output are fixed text with no user data.
- **Screenshots.** The host passes screenshots to the requesting client in memory. It does not save them. The agent decides whether to keep them.
- **Recordings.** When your agent asks for a short recording, the client library in the helper folder (`native-host/transport.js`) saves JPEG frames, a `frames.ffconcat` list, a `capture.json` summary with the time and SHA-256 hash of each frame and, if `ffmpeg` is installed, a `recording.mp4` file. It puts them in a new `tab-video-` folder inside a private folder that your agent tooling chooses, with access restricted to your user account. A recording lasts at most 60 seconds (30 seconds by default) and stops at 100 MB. The files stay until you delete them.

## Private credential fill

Some agents use a separate local program on your computer to sign in to a site without showing the password to the AI agent. Browser Control supports this as follows:

- The program sends the values to the host, and the host passes them to the extension. The extension sets the values directly on the fields that it verified. It returns only whether the fill succeeded.
- The extension and the host do not store, log or repeat the values. The host replaces the extension's answer with a status of "filled" or "not filled", and errors use a fixed message. The command-line client accepts values only through standard input, never as command arguments. The values are held in memory only while they pass through.
- A fill happens only on an HTTPS page, or on a loopback address with explicit opt-in. The page must be on the exact site that the agent bound, in the top frame. Each field must be visible, enabled and match exactly one element. The fill must happen within 30 seconds of that check.
- After a fill, the extension refuses screenshots, recordings, page readings and actions on that page, except the prepared sign-in submit button. It also refuses raw DevTools Protocol commands for that tab. DevTools Protocol events that the agent turned on before the fill can still report activity in that tab.

## What we do not do

- We do not collect data. We run no server for Browser Control, and neither the extension nor the host sends data to us.
- We do not sell or transfer user data to third parties. Data leaves your computer only if the local agent that you run sends it, or when a website receives what your agent submits to it.
- We do not show ads, use analytics or track you.
- The extension does not use remote code. All of its code is in the extension package, and its pages can load scripts only from the extension itself.
- We do not use or transfer user data to decide creditworthiness or for lending.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Your controls

- **Pause host** in the popup disconnects the host, stops every agent session and detaches the debugger from agent tabs. It stays paused, also after Chrome restarts, until you click **Resume host**.
- **Reload host** in the popup restarts the connection to the host.
- Agent tabs are in a labeled tab group. While the extension uses the debugger in a tab, Chrome shows a notice that the extension is debugging the browser.

## Deleting data and uninstalling

We hold no data about you, so there is nothing for us to delete. To remove everything that Browser Control stored on your computer:

1. Remove the extension on the `chrome://extensions` page. Chrome deletes the extension's storage.
2. Delete the `com.opzero.chrome.json` host manifest from the folder listed above for your system. On Windows, also delete the registry key: `reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opzero.chrome" /f`
3. Delete the helper folder that you unpacked.
4. Delete the `~/.opzero-chrome` folder.
5. Delete any `tab-video-` recording folders in the folder that your agent tooling uses.
6. Remove any data that your agent kept, as described by that agent.

## Children

Browser Control is a tool for developers. It is not directed to children. We do not collect data from anyone, including children.

## Changes to this policy

When this policy changes, we publish the new version on the website and in `docs/PRIVACY.md` in the repository, and we update the effective date. The repository history keeps every earlier version.

## Contact

For questions about this policy, open an issue at <https://github.com/opzero1/browser-control/issues>. Do not include personal data, passwords or tokens in an issue. To report a security problem, follow the steps at <https://browser-control.pages.dev/support/#security>.

Google Chrome is a trademark of Google LLC.
