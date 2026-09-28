# Chrome Web Store images

These images come from Browser Control 0.2.1 (commit `9b0fcea`) running unpacked in Chrome for Testing 149.0.7827.55 on macOS. The session was driven through the native host socket with protocol v2, the same way a local agent drives it. The screenshots were not generated or mocked up. The only edits after capture are a crop and a conversion to RGB. The page data is fake: a local demo page on `127.0.0.1` and the public Wikipedia article on web browsers.

| File | Size | What it shows |
| --- | --- | --- |
| `screenshot-1-popup-connected.png` | 1280×800 | The toolbar popup open over an agent session. It shows **Connected**, the Reload host and Pause host buttons, and **Version v0.2.1**. Behind it is the **Browser Control** tab group with the demo form partly filled in. |
| `screenshot-2-agent-filling-form.png` | 1280×800 | The agent session tab group **Browser Control**, which holds the Wikipedia tab and the demo tab. The agent has filled the "Book a demo" form, and its cursor overlay is on **Request demo**. The debugger infobar is the one Chrome shows while the extension is attached. |
| `screenshot-3-deliverable-group.png` | 1280×800 | The finished result. After `finalizeTabs`, the submitted form ("✓ Demo requested") sits in the **✅ Browser Control** deliverable group. The extension closed the Wikipedia tab and detached, so the debugger infobar is gone. |
| `screenshot-4-observing-wikipedia.png` | 1280×800 | The agent observing `en.wikipedia.org/wiki/Web_browser` in its tab group, with the cursor overlay on the article. The page was opened with `?banner=none`, so no fundraising banner appears. |
| `small-promo-440x280.png` | 440×280 | Promo tile with the shipped icon (`src/extension/images/icon-128.png`), the name, a tagline and a real crop of the ✅ tab group from screenshot 3. |
| `marquee-1400x560.png` | 1400×560 | Marquee with the icon, name, tagline, three plain facts and a real crop of screenshot 1 (popup and form). |

All files are PNGs in 24-bit RGB with no alpha. The screenshots have square corners and no padding or borders.

## How the screenshots were made

The scripts are in `store/capture/`. Each one reads its settings from `env.sh`, and every path can be changed through an environment variable (`BC_TMP`, `BC_BUILD`, `CFT_APP`, `CUA`, `NODE`, `BC_DEMO_PORT`).

1. Build a clean worktree of the release commit into `$BC_BUILD` with `pnpm install --frozen-lockfile && pnpm run build`.
2. `serve-demo.sh` serves `demo/index.html`, a fake "Book a demo" page, on `127.0.0.1:$BC_DEMO_PORT`.
3. `launch.sh` does the following:
   - Creates a fresh profile.
   - Writes `NativeMessagingHosts/com.opzero.chrome.json`. The manifest allows only the unpacked ID, which `extension-id.py` derives from the extension path, and it points to a private wrapper that sets `BROWSER_CONTROL_HOST_SOCKET`.
   - Pre-pins the extension.
   - Launches Chrome for Testing in the background with `cua-driver launch_app`, using `creates_new_application_instance`, `--load-extension` and `--disable-extensions-except`. It also passes `--disable-infobars`, which hides the "Chrome for Testing is only for automated testing" bar.

   The launch never activates the app. The script checks that the launched pid is the expected Chrome for Testing binary, because the bundle-ID route can resolve to a different install.
4. `drive.mjs` connects to the private socket, checks `host.info` and `getInfo` for protocol v2, and then runs commands that `cmd.sh` queues. The run used this sequence:
   ```sh
   ./cmd.sh '{"op":"open","tab":"wiki","url":"https://en.wikipedia.org/wiki/Web_browser?banner=none"}'
   ./cmd.sh '{"op":"wait","tab":"wiki","text":"web browser"}'
   ./cmd.sh '{"op":"open","tab":"demo","url":"http://127.0.0.1:8765/"}'
   ./cmd.sh '{"op":"wait","tab":"demo","text":"Book a demo"}'
   ./ax.sh press "Wikipedia - Part of group"; ./cmd.sh '{"op":"move","tab":"wiki","x":372,"y":560}'; ./shot.sh screenshot-4-...png
   ./ax.sh press "Northwind Analytics - Part of group"
   ./cmd.sh '{"op":"fill","tab":"demo","label":"Full name","text":"Jordan Example"}'   # also Company, Role, "What would you like to see?"
   ./cmd.sh '{"op":"click","tab":"demo","label":"11–50"}'
   ./cmd.sh '{"op":"move","tab":"demo","x":990,"y":624}';  ./shot.sh screenshot-2-...png
   ./ax.sh press "AXPopUpButton (Browser Control"; ./shot.sh screenshot-1-...png; ./ax.sh press "AXPopUpButton (Browser Control"
   ./cmd.sh '{"op":"click","tab":"demo","label":"Request demo"}'
   ./cmd.sh '{"op":"wait","tab":"demo","text":"Demo requested"}'
   ./cmd.sh '{"op":"turnEnded"}'
   ./cmd.sh '{"op":"finalize","keep":[{"tab":"demo","status":"deliverable"}]}'
   sleep 5; ./shot.sh screenshot-3-...png
   ```
   `createTab` opens agent tabs in the background, so `ax.sh` selects the tab that should be visible. It presses the tab through a background accessibility action. `ax.sh` also opens the popup the same way.
5. For each screenshot, the window is set to 1300×820 points on a 1× display with `cua-driver set_window_frame`. `shot.sh` captures it with `screencapture -l <window> -o -x`, which doesn't activate the app and includes the popup as a child window. The script then crops the inner 1280×800 rectangle at a 10-pixel inset, which removes the transparent rounded corners without scaling or padding. It also handles a 2× display: it crops a 2560×1600 inset and scales it down, but that path was not used in this run.
6. `cleanup.sh` stops the driver, the Chrome instance (by its recorded pid, and only if that pid has the capture profile) and the demo server. It then deletes the profile, host directory and state.

## How the promo tiles were made

`render-promo.sh` crops the real screenshots and copies the shipped icon into a work directory. `render.mjs` then renders `promo/small.html` and `promo/marquee.html` at their exact CSS size with a headless Chrome for Testing through CDP (`Emulation.setDeviceMetricsOverride` and `Page.captureScreenshot` at scale factor 1). The `--headless --screenshot` flag was not used because it never writes a file in this build. The output is converted to RGB with `ffmpeg`. The tiles never use the word "Chrome" as display text. To use a different icon file, set `ICON`.
