# DOM control

The server identifies the calling session from MCP request metadata, or from its per-process fallback ID (see [session identity](../SKILL.md#know-your-session-identity)). Each managed tab has a persistent Browser Control connection, and the extension enforces ownership across processes. No tool accepts a session ID argument.

## Choose the browser

For an isolated run, call `claim_browser({site: targetUrl, exclusive?, timeout_seconds?})` in the driving session. Require `ready: true` and retain the browser lease ID. Shared is the default; use an exclusive lease for downloads, native input, or profile-wide settings. See the [browser-pool procedure](browser-pool.md).

New tabs, tab claims, `tabs`, and `status` route to the session's lease. Without a lease they use the user's Chrome. Existing managed tabs keep their original connection, origin, lease, and artifact directory. Claim the browser before opening tabs.

On a lease route, `tabs` filters unclaimed tabs to the lease's cookie sites. `claim_tab` refuses other sites with `fast-chrome-tab-unavailable`; add a site with `claim_browser` first, keeping the lease's `exclusive` value. A foreign managed tab returns `fast-chrome-tab-not-owned`. `open_tab` holds the URL's site before creating a tab and refuses a conflict with `browser-controller-site-conflict`.

Release each tab, then call `release_browser({lease_id})`. Chrome and its profile stay for reuse. A browser lease cannot be released while its tabs, pins, or cleanup records remain.

## Keep to the URL policy

`open_tab` and `navigate` accept HTTPS URLs. When the server's environment sets `FAST_CHROME_ALLOW_LOOPBACK=1`, they also accept `http://localhost` and `http://127.0.0.1`, with any port. Other URLs fail with `fast-chrome-approved-web-url-required`. Each tab is bound to one exact origin: `navigate` stays within it, and another origin needs a new tab.

## Observe and act

- `status()` checks the installed extension and native bridge without reading page content or launching Chrome. It reports `route: "user"` or `"lease"`. An unreachable lease route returns `ready: false` with an error code and the caller's lease details; the user route raises the gate, such as `browser-control-unavailable`.
- `open_tab({url, group_title?})` creates an owned background tab bound to an exact origin and returns page state when ready.
- `tabs()` lists eligible unclaimed tabs and this session's managed tabs. `claim_tab({tab_id, group_title?})` attaches to a task-relevant existing tab without navigating.
- `name_group({tab_id, title})` renames an owned tab's group without changing ownership. Open, new claim, and rename return `group_title_confirmed: true` after Chrome reads back the title. An omitted title on a new tab uses `OpenCode · <session prefix>`. Re-claiming a managed tab keeps its title unless a new one is supplied.
- `observe({tab_id, controls_only?})` returns visible text, action IDs, and a single-use `snapshot_id`.
- `wait_for({tab_id, expect: {url?, text?, action_label?}, timeout_ms?})` waits for all supplied predicates in one fresh snapshot. Supply at least one predicate. URL and action labels match exactly; text is literal public text. An action label must identify one enabled observed action.
- `act({tab_id, snapshot_id, action_id, text?, expect?, timeout_ms?})` executes one observed action and returns the next snapshot. If an async public result is known, `expect` waits for that result before returning a snapshot; a failed wait returns no token and must not replay the action. Only `fill` accepts text. Do not invent action IDs.
- `act_steps({tab_id, steps, snapshot_id?, include_text?, timeout_ms?})` runs 1–10 public steps and returns a compact result. Use exact observed labels, with optional exact `kind` and `role`. Uploads and private input keep their own tools.
- `navigate({tab_id, url})` navigates once within the bound origin and observes.
- `release({tab_id, keep_open?})` closes owned task tabs by default and preserves claimed user tabs. Keep a tab open for a deliverable or while handing control to desktop tools.

An `act` result of `not_executed` requires a fresh observation and a new choice. `unknown` requires inspecting the actual outcome before another action. `executed` with `observation_error` means only the read failed. Never replay an action after a timeout or error. A previous snapshot token cannot execute twice.

An `opened`, `claimed`, or `navigated` result with `observation_error` retains the tab ID. Wait or observe that tab instead of repeating the operation. A broken native connection makes its handles terminal; never reconnect and replay input.

`wait_for` returns `outcome: "matched"` with a fresh `snapshot` and `elapsed_ms`. `timeout`, `ambiguous`, and `read_failed` return no usable token and invalidate the old one. Waiting never sends input. `timeout_ms` (1–15000, default 10000) is a polling budget, not a strict transport deadline; an in-flight browser read can overrun it.

Batch 1–N already-authorized, known steps. Use `act_steps` for up to 10 exact-label steps. In a code-mode client, await operations on a tab in order in one script and stop at the first unexpected state. Use observed public readiness predicates, not sleeps or a disabled submit label. A matched wait supplies the snapshot for the next action; do not insert another observation before consuming it. Catch thrown tool errors without reflecting raw provider messages. Never retry a mutation automatically.

### Run exact-label steps

Each step takes `label`, optional `kind: "fill" | "click"`, optional `role`, public fill `text`, optional `expect`, and optional `timeout_ms`. Labels and roles match exactly. The step's `timeout_ms` bounds its expectation wait to 1–15000 ms, default 10000. The run's `timeout_ms` is 1–60000 ms, default 30000.

Pass `snapshot_id` to require that exact current snapshot. Omit it to use the current snapshot, or take one observation if none exists. Bounds, kind and text agreement, the expectation URL policy, and a supplied snapshot are checked before any dispatch. Each step then needs exactly one enabled matching action.

Read the result before sending another input:

- `completed` records zero-based step indices, labels, action IDs, outcomes, and durations. It includes `wait: "matched"` only for steps with an expectation.
- `stopped: null` means every step completed. `final` contains URL, title, mode, coverage flags, a snapshot ID, and enabled actions as `id:label` strings.
- A pre-dispatch stop (`no_match`, `disabled`, `ambiguous`, `upload_excluded`, `text_required`, `invalid_public_input`, or `budget_exhausted`) keeps the current `final.snapshot_id`. Choose from `final.actions`; do not replay completed steps.
- `disabled` means the matching control is present but disabled, so `final.actions` omits it. Call `wait_for` with `expect: {action_label: label}` until it enables, then resend the remaining steps.
- A post-dispatch stop (`not_executed`, `unknown`, `wait_timeout`, `wait_ambiguous`, `wait_read_failed`, `observation_failed`, or `budget_exhausted`) sets `dispatched: true` and `final: null`. It includes the action ID and any known outcome or error. Observe; do not replay.

The tab stays busy for the whole run. The budget is checked before each dispatch and each wait. One in-flight browser call can overrun it, plus the single follow-up observation for a step without `expect`.

### Choose the read mode

Only `observe({controls_only})` changes the tab's preference. `observe({controls_only: true})` omits body text; `observe({controls_only: false})` restores full output. Re-claiming a managed tab preserves the preference.

Text expectations in `act`, `act_steps`, and `wait_for` read the full page and match against it. Under a controls-only preference, ordinary payloads still return `text: ""`, `mode: "controls-only"`, and `truncation.text: false`. The matched snapshot stays usable.

`act_steps({include_text: true})` forces its last step's read to full. Its `final` includes text and reports `mode: "full"` only when the last read was full. A stop before the first dispatch may still hold a controls-only snapshot. Without included text, `final` follows the preference and omits the `text` truncation flag. `include_text` never resets the preference.

### Know what the reader covers

The reader covers visible controls in the main document and open shadow roots. Inaccessible surfaces, such as iframes, frames, objects, embeds, and closed shadow roots, appear as partial-coverage metadata rather than blocking the page. Canvas, HTML-native select menus, nested scrolling, and arbitrary keyboard widgets need native control when the observed actions cannot operate them. Do not guess a selector or bypass private-input quarantine with desktop capture.

The extension exposes action IDs for visible ARIA options, menu items, checkboxes, and radios, plus native checkbox and radio inputs. Use the observed IDs and verify the resulting selection. Checked state is not part of the public action record, so use a guarded screenshot when text does not establish the result. `upload_file` attaches an owned local PDF through an observed public upload action; verify the filename or preview afterward. Use native control for a requested picker test or an upload mechanism outside that supported path.

When opening a dropdown with a known input or option label, pass that label as `expect.action_label` on `act` or on the step. Without an expectation, the immediate post-click snapshot can precede the popup's controls. In practice, a fresh observation exposed a combobox's search input and options that the immediate snapshot omitted.

## Credentials

Password and OTP controls are excluded from ordinary observations. Private input quarantines the document until cross-document navigation. Recognized populated credential fields and previously private selectors also block capture. Never pass secrets to `act` or `act_steps`.

Use [1Password session](../../onepassword-session/SKILL.md) for `paste_1password_field`. Stop recording and keep the existing tab claim. The private helper copies the selected account's field through cua-driver and supplies it to the extension over the same owned connection. Its arguments contain only public identity, the exact URL, selectors, and an optional observed submit action. Never replay uncertain input.

Private input blocks ordinary observations until a full navigation. Use `tabs()` for URL-only progress. If observation remains blocked on the intended protected route, reload that exact URL with `navigate`, then confirm the page loads. Do not release and reclaim to clear a private-input block.

## Installation

The user's Chrome runs the Web Store extension, which reaches the native host `com.opzero.chrome` through the manifest that `npx -y @op1/browser-control install` writes. That host listens on the owner-only socket `~/.opzero-chrome/default.sock`; the server connects there unless `BROWSER_CONTROL_HOST_SOCKET` names another. The pool provisions isolated Chrome for Testing profiles with their own extension copy, manifest, and socket under the state root. Only `claim_browser` can launch an isolated profile through MCP; page tools never launch or reconnect a browser. Use `status()` to check protocol compatibility and `doctor` for the installation. See [setup](setup.md).
