---
name: onepassword-session
description: "Sign in to a web app in a Browser Control tab with an existing 1Password Login while keeping passwords and OTPs out of agent output. Use for requested browser sign-ins, password and OTP steps, and paste_1password_field."
---

# Use 1Password for sign-in

Reuse a matching authenticated browser session first. Otherwise, transfer the credential privately with the Browser Control tool `paste_1password_field`. The helper reads the field from the unlocked 1Password desktop app through cua-driver, fills the owned tab over its Browser Control connection, and restores the clipboard. It needs macOS, cua-driver, and the clipboard guard that `npx -y @op1/browser-control install` builds.

1. Confirm the account email and the exact login URL from the task. Use the Login item that already exists in the unlocked 1Password desktop app. The helper matches its username before it transfers a field.
2. Claim or open the login tab and keep it claimed through the whole workflow. Stop any recording before credential entry.
3. Submit the password step, then the OTP step if the app asks for one, as described below.
4. Confirm that the app reaches its dashboard or the requested protected page. Reuse that signed-in session for the task.

## Submit the password step

Observe the unpopulated login form. Identify the sign-in action and keep that snapshot. The button may start disabled; the helper supports that readiness transition and still requires an enabled, unchanged target before it submits. Call `paste_1password_field`:

```json
{
  "tab_id": "<owned-tab-id>",
  "expected_url": "https://app.example.com/login",
  "expected_email": "tester@example.com",
  "field": "password",
  "username_selector": "input[name=\"email\"]",
  "selector": "input[name=\"password\"][type=\"password\"]",
  "snapshot_id": "<current-snapshot-id>",
  "submit_action_id": "<observed-sign-in-action-id>",
  "allow_foreground_search": true
}
```

- `expected_url` is the exact URL of the owned tab. Substitute the real login URL; the example is not a default.
- `username_selector` and `selector` are the only CSS selectors any Browser Control tool accepts. Take them from the app's source, its documentation, or the project's verification skill. Do not guess them.
- A wrong selector pair returns `browser-control-private-fields-unavailable` before 1Password is read. Nothing was sent, so correct the pair and call once more.
- The tool checks ownership, the exact URL, the document, and the inputs before it reads 1Password. It fills the email and password privately and submits once. `submitted` proves dispatch, not successful authentication.

Pass `allow_foreground_search: true` only when the user or the task permits a brief foreground search in 1Password. The helper then keeps 1Password in front through the search, and afterward attempts to restore the previous app; restoration is best-effort. Reusing an already selected matching Login needs no search. The search types the account email, selects a unique matching result once, and checks the selected Login's username before copying.

## Complete the OTP step

When the app asks for a one-time password, call the same tool with the same tab, URL, and email:

```json
{
  "tab_id": "<owned-tab-id>",
  "expected_url": "https://app.example.com/login",
  "expected_email": "tester@example.com",
  "field": "one-time password",
  "selector": "input[autocomplete=\"one-time-code\"]"
}
```

The tool waits up to 10 seconds for the input before it reads the current code. It requires the account and document that the password step established. It relies on the app to submit a completed code; do not click **Verify** afterward.

## Handle the outcome

The tool returns a status only, never a credential value or a populated-page observation. Never retry an unknown outcome; inspect the page first.

Private input quarantines its document from public observation and capture. Use `tabs()` for URL-only progress. If quarantine still blocks observation after the protected route appears, reload that exact observed URL with `navigate`, then confirm the page loads. Do not release and reclaim the tab to clear it.

If 1Password is locked while the user is present, ask for one unlock. If the task is unattended, report the blocker. Resolve a missing or ambiguous Login before trying another transfer.

If the helper reports `clipboard-restore-failed`, tell the user that clipboard restoration is unconfirmed, and ask them to copy a harmless value before further clipboard use.

## Keep secrets private

Passwords, OTPs, authenticator seeds, and populated login forms must stay out of chat, tool arguments, logs, files, and screenshots. Never pass them to `act` or `act_steps`. Ordinary cua-driver accessibility reads can expose a visible OTP. Do not inspect Login item details through public snapshots, and do not read the clipboard back to the agent.

Do not change vault auto-lock settings or create a new credential integration as part of an ordinary login.
