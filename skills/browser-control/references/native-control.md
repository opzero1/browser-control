# Control native apps

Use cua-driver for native apps or Chrome controls that the DOM tools cannot handle. Use Browser Control for supported page content. Prefer an application API, CLI, or filesystem operation when the task does not require a GUI.

## Install and load the cua-driver skill

cua-driver ships its own agent skill, and this skill does not copy it. Install the driver with its upstream installer, then let the driver install the skill version that matches it into the agent skill directories it detects:

```sh
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver skills install
```

Run `cua-driver skills update` after a driver upgrade. Load the `cua-driver` skill and its platform guide (such as `MACOS.md`) before GUI work, and follow its background-first rules. On macOS, the installed driver app also needs Accessibility and Screen Recording permission.

Browser Control uses the same binary for isolated-profile startup and the private vault helper. It resolves the binary from `CUA_DRIVER` (an absolute path to an executable file), then `PATH`, then `~/.local/bin/cua-driver`. Run `npx -y @op1/browser-control doctor` to see which path it found.

## Bind to the exact browser window

For native input in an isolated run, claim with `claim_browser({site: targetUrl, exclusive: true})`. Bind cua-driver to the receipt's exact `pid` and `windows`, then confirm the task tab from fresh state. Never select a Chrome window by bundle name alone. Shared receipts omit native handles; even a shared lease currently alone on its controller is not an exclusive lease.

If a shared run needs native input, finish recordings and release its tabs and browser lease first. Claim an exclusive lease, reopen the target, and verify the signed-in account before continuing. A mode change on an existing lease fails with `browser-controller-lease-mode-mismatch`. The private 1Password helper remains available on shared leases; it binds to the owned tab and serializes vault access.

1. Identify the exact app and window through the driver's documented background route.
2. Read fresh window state before input. Use its `element_token`, or its paired `element_index` and `snapshot_id`.
3. Perform the authorized action without changing the user's foreground app or interrupting typing.
4. Verify the requested result from fresh state. A successful input receipt alone does not prove success.

Follow the driver skill's background accessibility and pixel routes. Coordinate input requires a fresh screenshot of the exact target window. Choose capture content appropriate for the task.

After an error or uncertain input, inspect the result without replaying the action. Avoid concurrent desktop drivers. Do not escalate to foreground delivery without explicit authorization for that focus change.

## Operate an unlabeled custom select

A design-system select can appear in `observe` text but have no identifiable action ID, for example a Material UI Select that renders an anonymous caret button and a menu. The DOM reader labels an anonymous, unique button beside a labeled combobox with the combobox's current label plus `options`, such as **Status Active options**. Use the actual observed label, then select the menu item and read back the new value.

If the reader cannot identify the control, bind cua-driver to that exact Chrome window and tab. Inspect a fresh accessibility state and screenshot for the control and its caret. Click its fresh accessibility target if unambiguous; otherwise use the screenshot-grounded background pixel route. Once the menu is open, choose the observed menu item and read back the selected value. Inspect uncertain outcomes without replaying.

## Attach a PDF in the background

Use `upload_file` with the claimed tab, a fresh `snapshot_id`, the observed `kind: "upload"` action ID, and an absolute PDF path. The tool accepts one current-user-owned, regular PDF with no tool-imposed size cap. The destination app enforces its own limits. Confirm with the user before you upload personal or sensitive files.

Observe the page afterward and confirm the filename or rendered document. If the tool returns `unknown`, inspect without replaying; an app can render the file even when the metadata receipt is unknown. This path uses neither the clipboard nor a native file picker.

## Upload through a macOS file picker

Use this route when the Browser Control tools cannot attach a local file, or for a requested picker test.

1. Open the observed upload control. Discover the current Chrome window and **Open** panel IDs; do not reuse IDs from an earlier run.
   If the DOM action reports `executed` but fresh state shows no dialog or attachment, use a fresh native click on the upload control. Chrome's file picker can require a trusted user gesture. Follow the normal accessibility, pixel, and authorized foreground ladder.
2. Inspect the panel and its parent window. A sheet can expose its accessibility elements under the parent while owning a separate native window.
3. Try the fresh file control through the background route. If cua-driver returns `element_outside_target_window` or `ax_unresolved`, inspect current state and stop background input to that target.
4. Obtain permission for brief foreground selection if the task has not already authorized it. Record the user's foreground app and exact window for restoration.
5. If Chrome is already in front, confirm the intended sheet in a fresh desktop screenshot before desktop input. Otherwise, use a guarded activation of the exact window and require verification. Send `Cmd+Shift+G`.
6. Confirm the **Go to Folder** sheet. Select all retained path text, then type the intended absolute file path. Read back the whole value: typing can append to a previous path.
7. Wait for the matching path suggestion, then press Return. Wait until the intended file is selected and **Open** is enabled. An immediate snapshot can precede this transition.
8. Click the fresh, enabled **Open** control explicitly. Verify that the sheet closes and the filename appears in the application. Return alone did not reliably attach the file.

When changing foreground apps, keep activation, input, and restoration in one awaited batch. If Chrome started in front, confirm it remains the active app. A returned `effect: "unverifiable"` is not proof of selection; verify the next sheet or application state. Stop if the intended foreground target cannot be established.

Native file `AXOpen` and `AXConfirm` returned without selecting the file in testing, and repeating them did not help. The **Go to Folder** path followed by the enabled **Open** button completed the upload.

For a picker open-and-cancel test, verify dismissal independently. Foreground Escape can return `unverifiable` and leave the sheet open; a fresh parent-window read that still exposes **Cancel** and `AXSheet` proves it. Verified activation of the exact **Open** panel followed by a screenshot-grounded desktop **Cancel** click closes it. Confirm that the next parent-window read contains no sheet. Restore the prior foreground window and pointer after authorized foreground handling. An old off-screen **Open** window can remain in the window server's list after dismissal.

## Keep credential transfers private

Ordinary native observations can publish accessibility text and images. They are not private credential channels. Use [1Password session](../../onepassword-session/SKILL.md) for private transfers. Keep passwords, OTPs, and populated credential forms out of tool output and screenshots. The private helper does not authorize public vault snapshots or arbitrary credential entry through cua-driver.
