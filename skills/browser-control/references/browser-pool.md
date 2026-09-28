# Use an isolated browser controller

`claim_browser` leases a Chrome for Testing controller to the calling session. Each controller has its own profile and native-host socket under the state root. A controller can host shared leases on different cookie sites, or one exclusive lease.

Isolated controllers need macOS (elsewhere `claim_browser` fails with `browser-controller-platform-unsupported`), Chrome for Testing (bundle `com.google.chrome.for.testing`), and cua-driver. The server resolves cua-driver from `CUA_DRIVER`, then `PATH`, then `~/.local/bin/cua-driver`; when none resolves, startup fails with `browser-controller-startup-not-installed`. `doctor` checks all three.

## Claim in the driving session

Discover the tool signatures, then call `claim_browser` with the task's actual URL:

```json
{ "site": "https://app.example.com" }
```

The owner comes from MCP request metadata or the server's per-process fallback ID; do not pass a session ID. Each agent session claims its own lease. A coordinator's lease does not transfer to a worker.

`claim_browser({site?, exclusive?, timeout_seconds?})` defaults to shared mode and a 30-second startup budget. The timeout must be greater than zero and at most 120 seconds, so set your client's tool timeout above that (Codex: `tool_timeout_sec = 150`). The call reuses the session's lease, provisions the profile, and may launch isolated Chrome through cua-driver with background activation suppressed. It never launches the user's Chrome.

Require `ready: true` before opening tabs. Retain `controller_id`, `lease_id`, `mode`, `sites`, `site_state`, and `artifacts`. The receipt does not include the owner; `pool status` shows it (see [release an orphaned lease](#release-an-orphaned-lease)). `launched` distinguishes cold startup from reuse; `elapsed_seconds` measures setup. Successful receipts also confirm `password_saving_disabled` and `downloads_configured`.

Use `exclusive: true` for downloads, native input, profile-wide settings, or extension reloads. Exclusive receipts add `pid`, `windows`, `downloads`, `profile`, and `socket`. Shared receipts omit those fields.

Repeat a claim with the same mode to reuse it or add a site. A mode change fails with `browser-controller-lease-mode-mismatch`. To change modes, release tabs and the browser lease first, then claim again. Keep one browser lease per driving session; several explicit CLI leases for one owner make automatic routing fail with `browser-controller-lease-ambiguous`.

## Allocate own Chrome first

The pool prefers an idle controller, with socket-present controllers first, then creates one under the limit. Only when no idle or new controller is available does a shared claim join a running shared controller. Allocation treats a socket file as running; readiness still needs a live handshake and an on-screen window.

- `FAST_CHROME_MAX_CONTROLLERS` defaults to 3 and is clamped to 1–8.
- `FAST_CHROME_MAX_TENANTS` defaults to 3 and is clamped to 1–16. Set it to 1 to disable sharing.
- Non-integer limits fail with `browser-controller-invalid-limit`.
- If no controller fits, the claim fails with `browser-controller-busy`. Wait for a confirmed release.

Automatic claims use controller numbers up to the limit and skip controllers with pending cleanup, startup, or stop records. Lowering the limit does not hide existing controllers from status or cleanup.

`status()` through MCP reports only the caller's route and lease. An unreachable leased endpoint returns `ready: false` with its error and lease details. Inspect that result before you call `claim_browser` again. Existing tab handles never reconnect or move to a new lease.

## Hold cookie sites for the whole lease

`site` accepts a URL or host. The site key is the registrable domain under the vendored, hash-pinned Public Suffix List, including private rules. Distinct hosts under a private suffix, such as two preview hosts on one hosting provider, are distinct sites. Hosts under one registrable domain, such as `app.example.com` and `login.example.com`, share the site `example.com`. Ports are ignored. IP addresses and `localhost` use the host itself.

`claim_browser({site})` and `open_tab({url})` add sites, up to 16 per lease. A site stays held until release, even after its tabs close. Another tenant cannot hold the same site on that controller. A new same-site claim needs another controller; adding a conflicting site to an existing lease fails with `browser-controller-site-conflict`.

**Unshared sites never share.** `FAST_CHROME_UNSHARED_SITES` lists registrable domains, separated by commas, that must not share a controller; the default is none. A lease that holds such a site cannot join other tenants, and no tenant can join its controller, even when its receipt says `mode: "shared"`. Adding such a site while another tenant is present fails with `browser-controller-site-conflict`. An entry that is not a valid registrable site makes the server fail closed with `browser-controller-invalid-unshared-sites`. Request an exclusive lease if the run also needs downloads or native input.

On a lease route, `tabs()` lists unclaimed tabs only on the lease's sites, plus the caller's managed tabs. `claim_tab` cannot add a site; call `claim_browser` with that site and the same `exclusive` value first. Every managed tab stays bound to its original connection and exact origin. Sharing does not isolate the extension: a pause, control stop, or reload can disconnect all tenants.

## Check reused sign-in state

Read `site_state` on claim and open receipts. `fresh` means the recorded history has no earlier lease for that site. Repeated opens by its first lease stay fresh. `previously-used` means an earlier lease used it or the profile's history is incomplete. An existing profile without history is treated as previously used.

With `site` supplied, the receipt describes that site. Otherwise it summarizes the lease's held sites, or returns `null` when there are none. Site history is bounded to 256 entries; after overflow, unrecorded sites count as previously used. Release keeps cookies and sign-in state.

When `site_state` is `previously-used`, confirm through the app's own UI that the signed-in account is the one the task needs. If it differs, sign out through the app and sign in with the intended account. If identity cannot be confirmed, stop before account-dependent actions. Never inspect profile storage to identify the account.

## Keep the run isolated

1. Keep authentication, actions, and evidence in the claimed process and profile.
2. Record the lease's `artifacts` directory. Captures go under it as `chrome-capture-*` directories. For downloads, use an exclusive lease and inspect only its returned `downloads` directory.
3. For native input, use an exclusive lease and bind the receipt's exact PID and window to the observed task tab. Never choose a window from the bundle name alone.
4. Separate profiles isolate browser state, but runs that share a test account or workspace can still change shared backend data. Use distinct test accounts for concurrent runs when the app allows it.
5. Coordinate foreground and clipboard operations across workers. The private vault helper serializes its own reads and works on shared leases. Arbitrary native input requires exclusive use.

## Release after tab cleanup

Finish recordings and release every owned tab with `release`. Require confirmed tab cleanup, then call `release_browser`:

```json
{ "lease_id": "<lease_id from the claim receipt>" }
```

Require `released: true`, then release any account reservation your project uses. `controller_idle` reports registry availability, not whether Chrome exited. Release keeps Chrome, its profile, downloads, and artifacts for reuse. Kept deliverable tabs remain open.

Leases have no expiry or automatic takeover. Live tabs, pins, and unconfirmed cleanup or startup block release. A shared lease can release while another tenant has live tabs. Retain ownership after uncertain cleanup; do not delete registry files or release another running session's lease.

## Handle startup failures

Each controller keeps its profile, downloads, artifacts, and a generated `browser-control-host` wrapper under the state root (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`). The wrapper selects the socket `<state root>/sockets/<controller_id>.sock`. Read the exact paths from an exclusive receipt instead of building them.

Startup serializes per controller. Cold startup turns password saving off, sets the download directory, disables the download prompt, and enables directory upgrade. Warm startup only checks these settings. Inspect `browser-controller-password-saving-enabled` or `browser-controller-download-settings-mismatch`; do not edit the running profile.

After allocation, setup failures return `ready: false`, `error`, and `lease_retained: true`. Inspect the code and the current app state through `cua-driver`. A running but unready profile is not restarted. A stale socket with no listener is removed before a cold launch; a live endpoint without the expected process blocks launch.

An ambiguous launch leaves `pending_startup: true` in pool status and blocks release. A later `claim_browser` with the same mode can confirm a subsequently ready process and clear that record. It cannot replay an unconfirmed launch. Retain the lease for operator inspection if readiness remains unknown.

## Operate the pool from the CLI

The operator CLI is `npx -y @op1/browser-control pool <command>`. It shows every controller, owner, and lease, while `status()` through MCP shows only the caller's own:

```sh
npx -y @op1/browser-control pool status
npx -y @op1/browser-control pool ensure --owner <session-id>
npx -y @op1/browser-control pool release --owner <session-id> --lease <lease-id>
npx -y @op1/browser-control pool reap isolated-1 --dry-run
npx -y @op1/browser-control pool reset isolated-1 --confirm
```

- CLI `ensure` defaults to exclusive; `--shared` opts in. CLI `claim` is exclusive and ownership-only.
- CLI `release` works after tab cleanup. Use it for a lease left behind by a restarted server process; see [release an orphaned lease](#release-an-orphaned-lease).
- `pool reap [controller] [--dry-run]` stops an idle controller's Chrome; without a controller it tries each one and reports each result. It requires no leases, pins, cleanup markers, startup record, or open HTTP(S) tabs; kept deliverables block it. It sends SIGTERM only to the exact profile process and verifies exit. `--dry-run` reads tabs and processes without writing an intent or sending a signal. If exit is unconfirmed, its record remains and blocks allocation until a later `pool reap` confirms cleanup. It keeps the profile.
- `reset --confirm` requires an idle, stopped controller and no live endpoint. It deletes and re-provisions only the profile and site history; downloads and artifacts remain.

Neither stopping nor resetting runs automatically.

### Release an orphaned lease

A lease outlives the server process that claimed it. When that process used its fallback `ses_…` ID, a restarted server has a new owner and cannot release the old lease. The `claim_browser` receipt has no owner field, so recover the owner from the registry:

1. Run the CLI with the same state root as the server (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`):

   ```sh
   npx -y @op1/browser-control pool status
   ```

2. In `controllers[].leases`, find the entry whose `lease_id` equals the receipt's `lease_id`. Read its `owner`. Shared and exclusive leases are both listed there.
3. Confirm that no running session still uses the lease. Then release it:

   ```sh
   npx -y @op1/browser-control pool release --owner <owner from pool status> --lease <lease_id from the receipt>
   ```

4. Require `released: true`. A different owner fails with `browser-controller-lease-not-owned`.
