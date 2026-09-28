# Private parity

Each line maps one Python test function to the vitest test with the same intent. Parametrized Python tests
map to one `it.each` test whose cases are the same inputs; Python subtests become a loop inside one test.
`scripts/check-parity.mjs` checks this file.

Test doubles follow the Python tests: synthetic `/bin/sh` clipboard guardians stand in for the Swift
guardian, `FakeCua` (tests/server/private/fake-cua.ts) stands in for Cua Driver, and a synthetic host
connection stands in for the extension. Python's asyncio cancellation is an AbortSignal: `task.cancel()`
becomes `controller.abort()`, and `asyncio.wait_for` on a read becomes `withDeadline`. Monkeypatched module
constants become `VAULT_TIMING`, and the patched `time.monotonic` becomes a `vi.mock` of `src/server/time`.
Synthetic URLs, emails and window titles replace the Reap and Direct ones.

## test_clipboard_guard.py -> private/clipboard-guard.ts (5 functions, 6 of 6 cases)

test_clipboard_guard.py::test_cancellation_waits_for_restore_after_body_mutation -> tests/server/private/clipboard-guard.test.ts::waits for the restore after a cancellation during the body, then rethrows it
test_clipboard_guard.py::test_body_error_is_preserved_when_restore_succeeds -> tests/server/private/clipboard-guard.test.ts::keeps the body's own error when the restore succeeds
test_clipboard_guard.py::test_restore_failure_prevents_secret_return -> tests/server/private/clipboard-guard.test.ts::never returns the body's value when the restore fails
test_clipboard_guard.py::test_missing_binary_is_unavailable -> tests/server/private/clipboard-guard.test.ts::refuses a missing binary as unavailable before the body
test_clipboard_guard.py::test_untrusted_binary_refuses_before_body -> tests/server/private/clipboard-guard.test.ts::refuses an untrusted %s binary before the body

Added: the other trust cases (group- or other-writable, not executable, a directory), an unready or silent
guardian, the 64-byte line limit, the 3 s start and restore bounds with the guardian killed, a nonzero exit, a
closed guardian input (no uncaught EPIPE), cancellation during the start, a body that ignores cancellation,
and `buildClipboardGuard`. The Swift build test compiles with `xcrun swiftc` and is skipped explicitly
(`it.skipIf`) without xcrun; it never runs the compiled guardian, so the real pasteboard is never touched.

## test_onepassword.py -> private/onepassword.ts, private/cua-mcp.ts (40 functions, 42 of 42 cases)

test_onepassword.py::test_sync_vault_source_runs_inside_mcp_event_loop -> tests/server/private/onepassword.test.ts::reads the vault inside an MCP tool call without blocking the event loop
test_onepassword.py::test_locked_vault_refuses_without_clipboard_access -> tests/server/private/onepassword.test.ts::refuses a locked vault without touching the clipboard
test_onepassword.py::test_main_window_ignores_offscreen_menu_and_utility_windows -> tests/server/private/onepassword.test.ts::picks the one on-screen window and ignores offscreen menus and utility windows
test_onepassword.py::test_ordinary_window_selects_frontmost_of_multiple_chrome_windows -> tests/server/private/onepassword.test.ts::selects the frontmost of several ordinary windows
test_onepassword.py::test_account_mismatch_restores_clipboard -> tests/server/private/onepassword.test.ts::restores the clipboard after an account mismatch
test_onepassword.py::test_ambiguous_field_restores_clipboard -> tests/server/private/onepassword.test.ts::restores the clipboard after an ambiguous field
test_onepassword.py::test_flat_real_projection_selects_only_bracketed_copy_controls -> tests/server/private/onepassword.test.ts::uses only the bracketed copy controls of the flat projection
test_onepassword.py::test_flat_projection_rejects_duplicate_or_cross_field_regions -> tests/server/private/onepassword.test.ts::rejects a flat region with %s
test_onepassword.py::test_ambiguous_account_target_refuses_before_clipboard_access -> tests/server/private/onepassword.test.ts::refuses an ambiguous account target before touching the clipboard
test_onepassword.py::test_search_without_unique_matching_result_fails_closed -> tests/server/private/onepassword.test.ts::fails closed when a search has no unique matching result
test_onepassword.py::test_rich_clipboard_items_restore_with_exact_bytes_and_values -> tests/server/private/onepassword.test.ts::restores exact rich clipboard items and values
test_onepassword.py::test_success_restores_clipboard_and_returns_only_secret -> tests/server/private/onepassword.test.ts::restores the clipboard on success and returns only the secret
test_onepassword.py::test_failure_during_second_copy_restores_clipboard -> tests/server/private/onepassword.test.ts::restores the clipboard after a failure during the second copy
test_onepassword.py::test_restore_failure_masks_value_with_static_error -> tests/server/private/onepassword.test.ts::masks the value with a static error when the restore fails
test_onepassword.py::test_guard_start_failure_translates_without_clipboard_mutation -> tests/server/private/onepassword.test.ts::translates a guard start failure without touching the clipboard
test_onepassword.py::test_cancellation_after_secret_copy_restores_before_propagating -> tests/server/private/onepassword.test.ts::restores the clipboard before a cancellation after the secret copy propagates
test_onepassword.py::test_selected_item_switch_between_secret_and_recheck_returns_no_wrong_password -> tests/server/private/onepassword.test.ts::returns no wrong password when the selected item switches between the secret and the recheck
test_onepassword.py::test_unverifiable_search_write_uses_verify_and_fresh_snapshot_without_replay -> tests/server/private/onepassword.test.ts::verifies an unverifiable search write with a fresh snapshot and never replays it
test_onepassword.py::test_unverifiable_result_click_uses_fresh_snapshot_without_replay -> tests/server/private/onepassword.test.ts::confirms an unverifiable result click with a fresh snapshot and never replays it
test_onepassword.py::test_actual_menu_result_matches_unique_account_and_excludes_show_all -> tests/server/private/onepassword.test.ts::matches the unique menu result and excludes Show all matching items
test_onepassword.py::test_delayed_menu_result_is_polled_then_selected_without_replay -> tests/server/private/onepassword.test.ts::polls a delayed menu result, then selects it once
test_onepassword.py::test_foreground_search_and_focused_input_are_explicitly_gated -> tests/server/private/onepassword.test.ts::gates the foreground search and focused input on explicit permission
test_onepassword.py::test_matching_selected_detail_bypasses_search_and_foreground_actions -> tests/server/private/onepassword.test.ts::skips search and foreground actions when the selected detail already matches
test_onepassword.py::test_cold_search_clears_placeholder_then_types_and_presses_enter -> tests/server/private/onepassword.test.ts::clears the %s placeholder, types, then presses return in a cold search
test_onepassword.py::test_cold_search_selects_unique_result_when_enter_leaves_suggestions_open -> tests/server/private/onepassword.test.ts::selects the unique result when return leaves the suggestions open
test_onepassword.py::test_show_all_child_is_not_an_account_result -> tests/server/private/onepassword.test.ts::does not treat a child of Show all matching items as an account result
test_onepassword.py::test_foreground_search_recovers_when_background_query_does_not_stick -> tests/server/private/onepassword.test.ts::recovers with a foreground search when the background query does not stick
test_onepassword.py::test_cold_search_recovers_when_background_clear_does_not_stick -> tests/server/private/onepassword.test.ts::recovers in a cold search when the background clear does not stick
test_onepassword.py::test_cold_search_stops_when_old_query_does_not_clear -> tests/server/private/onepassword.test.ts::stops a cold search when the old query does not clear
test_onepassword.py::test_foreground_search_requires_exact_selected_detail_and_restores_prior_app -> tests/server/private/onepassword.test.ts::requires the exact selected detail after a foreground search and restores the prior app
test_onepassword.py::test_unverified_exact_vault_focus_blocks_input_and_attempts_restore -> tests/server/private/onepassword.test.ts::blocks input when the exact vault focus is unverified and still attempts the restore
test_onepassword.py::test_search_waits_for_transient_duplicate_results_to_settle -> tests/server/private/onepassword.test.ts::waits for transient duplicate results to settle
test_onepassword.py::test_persistent_duplicate_results_remain_blocked -> tests/server/private/onepassword.test.ts::keeps persistent duplicate results blocked
test_onepassword.py::test_composite_menu_result_does_not_match_email_suffix -> tests/server/private/onepassword.test.ts::does not match a composite menu result that only ends with the email
test_onepassword.py::test_deadline_cancellation_restores_through_guard -> tests/server/private/onepassword.test.ts::restores through the guard when the deadline cancels a read
test_onepassword.py::test_static_error_sanitizes_transport_exception -> tests/server/private/onepassword.test.ts::sanitizes an arbitrary transport exception to a static error
test_onepassword.py::test_invalid_inputs_have_no_native_effect -> tests/server/private/onepassword.test.ts::has no native effect for invalid inputs
test_onepassword.py::test_public_api_passes_explicit_foreground_search_permission -> tests/server/private/onepassword.test.ts::passes the explicit foreground search permission through the public API
test_onepassword.py::test_vault_error_rejects_arbitrary_public_code -> tests/server/private/onepassword.test.ts::maps an arbitrary code to operation-failed
test_onepassword.py::test_mcp_context_preserves_body_vault_error_outside_transport_group -> tests/server/private/onepassword.test.ts::keeps a body VaultError apart from the transport and closes the connection after the body

Adapted: Python patched `_run` to observe the permission flag and the sanitizing; the ports inject a
synthetic `CuaCaller` through `VaultDeps` instead, so the flag is observed by the foreground calls it allows,
and the arbitrary exception comes from the driver.

Added: the bounded vault lock (`vault-busy` at the deadline without opening the vault, serialized reads in
one process, unsafe lock files), the production dependencies under the state root, Python `str()`/hash semantics for
accessibility values, a cyclic tree, and `tests/server/private/cua-mcp.test.ts`, which reads through a real
MCP stdio subprocess (`tests/server/support/child-private.ts` as `cua-driver mcp`): error, unstructured and
exit results are `transport-unavailable`; a hung handshake and a hung call are bounded by the read deadline,
with the clipboard restored first; `CUA_DRIVER` never falls back; a separate process prints no private text
and the driver's stderr is discarded.

## test_private_input.py -> private/private-input.ts (21 functions and 3 subtest blocks; 20 ported, 1 not ported)

test_private_input.py::PrivateInputTests::test_preview_password_uses_owned_connection_without_exposing_value -> tests/server/private/private-input.test.ts::fills and submits through the owned connection without exposing the value
test_private_input.py::PrivateInputTests::test_initially_disabled_submit_is_prepared_before_private_fill -> tests/server/private/private-input.test.ts::prepares an initially disabled submit before the private fill
test_private_input.py::PrivateInputTests::test_wrong_exact_url_and_recording_refuse_before_vault_read -> tests/server/private/private-input.test.ts::refuses a wrong exact URL and a running recording before the vault read
test_private_input.py::PrivateInputTests::test_document_change_during_vault_read_does_not_fill -> tests/server/private/private-input.test.ts::does not fill after a document change during the vault read
test_private_input.py::PrivateInputTests::test_url_change_during_vault_read_does_not_fill -> tests/server/private/private-input.test.ts::does not fill after a URL change during the vault read
test_private_input.py::PrivateInputTests::test_unknown_submit_is_not_retried_or_reflected -> tests/server/private/private-input.test.ts::never retries or reflects an unknown submit
test_private_input.py::PrivateInputTests::test_otp_requires_account_binding_and_runs_only_once -> tests/server/private/private-input.test.ts::requires the account binding for an OTP and runs it only once
test_private_input.py::PrivateInputTests::test_old_extension_without_exact_url_contract_is_rejected -> tests/server/private/private-input.test.ts::rejects an old extension without the exact-URL contract
test_private_input.py::PrivateInputTests::test_original_submit_is_bound_before_vault_read_without_label_reauthorization -> tests/server/private/private-input.test.ts::binds the original submit before the vault read without reauthorizing by label
test_private_input.py::PrivateInputTests::test_same_label_replacement_during_vault_read_is_not_reauthorized -> tests/server/private/private-input.test.ts::does not reauthorize a same-label replacement during the vault read
test_private_input.py::PrivateInputTests::test_invalid_submit_capability_refuses_before_vault_read -> tests/server/private/private-input.test.ts::refuses an invalid submit capability before the vault read
test_private_input.py::PrivateInputTests::test_expired_submit_capability_refuses_before_private_fill -> tests/server/private/private-input.test.ts::refuses an expired submit capability before the private fill
test_private_input.py::PrivateInputTests::test_private_fill_unknown_is_one_use_and_does_not_submit -> tests/server/private/private-input.test.ts::treats an unknown private fill as one use and never submits
test_private_input.py::PrivateInputTests::test_cross_document_otp_refuses_before_source_read -> tests/server/private/private-input.test.ts::refuses a cross-document OTP before the source read
test_private_input.py::PrivateInputTests::test_host_protocol_not_ready_is_known_no_fill -> tests/server/private/private-input.test.ts::reports a host protocol not-ready fill as a known no-fill
test_private_input.py::PrivateInputTests::test_shutdown_during_vault_read_sends_no_private_input -> tests/server/private/private-input.test.ts::sends no private input after shutdown begins during the vault read
test_private_input.py::PrivateInputTests::test_shutdown_ends_the_otp_field_wait_before_another_read -> tests/server/private/private-input.test.ts::ends the OTP field wait at shutdown before another read
test_private_input.py::PrivateInputTests::test_shutdown_before_the_submit_is_prepared_sends_and_consumes_nothing -> tests/server/private/private-input.test.ts::sends and consumes nothing when shutdown begins before the submit is prepared
test_private_input.py::PrivateInputTests::test_shutdown_during_private_fill_is_unknown_and_never_submits -> tests/server/private/private-input.test.ts::reports shutdown during the private fill as unknown and never submits
test_private_input.py::PrivateInputTests::test_extension_refusal_to_bind_submit_refuses_before_private_dispatch -> tests/server/private/private-input.test.ts::refuses before any private dispatch when the extension will not bind the submit
test_private_input.py::PoolBindingTests::test_account_requires_exact_owned_lease -> not ported: direct-pool removed (C6; Q2 drops lease_id and the pool-account branch, so no lease is read, held or matched). Tab ownership stays the session guard; see "tab ownership without the account-pool lease (C6)" in tests/server/private/private-input.test.ts.

Replaced guard: the Python setUp patched `account_claim` to a no-op; the port has no `account_claim`. Its
session check (`ses_other` could not use another session's lease) becomes an ownership check in `paste`:
`PasteRequest.session` must equal `tab.owner`, or the transfer is refused with `fast-chrome-tab-not-owned`
before any host call, request validation or vault read. The added tests cover a foreign session on the
password step and on the OTP step after the owner bound the account, an empty, missing or non-string session,
ownership before request validation, and a successful owner transfer with any account and no lease.

Added: request validation with Python's `\s`, code-point selector lengths, the password-step requirements, OTP
auto-submit, an invalid source value, the `FAST_CHROME_ALLOW_LOOPBACK=1` exception on `http` loopback only,
the OTP field poll, and no wait on the password step.

## Deviations and integration notes

Each item is a change from the Python behavior that C6, Q2 or the platform requires; the error codes, limits
and fixed statuses are otherwise Python's.

- P1 (C6, Q2) `PasteRequest` has no `leaseId` and gains `session`, the caller's identity. `paste` refuses
  `fast-chrome-tab-not-owned` unless it equals `tab.owner`, before any host call, request validation or vault
  read. The server's `hold()` refuses a foreign session first, as Python's `managed()` did, so the tool result
  is unchanged; the check keeps ownership as the session guard now that no lease binds the account.
- P2 Opening `cua-driver mcp` (spawn and MCP initialize) is bounded by the read's 60 s deadline and fails as
  `transport-unavailable`; Python's initialize had no timeout. Closing waits for the driver to exit (at most
  4.5 s, the SDK's end-stdin, SIGTERM, SIGKILL sequence), as Python's `stdio_client` exit did, so the vault
  lock outlives the driver.
- P3 Each MCP call gets the remaining time plus a 0.25 s backstop, so a read that reaches its deadline always
  ends `deadline-exceeded`. Python gave each call exactly the remaining time, which raced `wait_for` and could
  end the same read as `transport-unavailable`.
- P4 A `parent_index` cycle in the accessibility tree is `observation-unavailable`. Python walked it forever
  (a hung worker thread); in Node it would block the event loop.
- P5 The vault lock is `<state>/locks/onepassword.lock` (D16), a SQLite lock with the foundation's file
  checks: a symlinked lock file is a file-system error, and a hard-linked, group- or other-accessible or
  foreign one is `browser-controller-unsafe-registry`. Python followed links and checked nothing. As in
  Python, a lock or state-directory failure other than a busy lock is not a `VaultError`.
- P6 (D13, D20) Python's `type(x) is int` checks (window, pid, z-index, `expiresInMs`) accept a JSON float with
  an integral value, such as `90000.0`, because JS numbers do not keep the distinction. Python's `str()` of a
  non-string accessibility value is reproduced as its repr, with `isprintable` taken from the Unicode C and Z
  categories of the JS engine.
- P7 Python's unused `_satisfied` helper is not ported. `read_field`'s worker thread is not needed: every wait
  is asynchronous, so a read never blocks the event loop.

For the server slice: call `paste(tab, { session, expectedUrl, email, field, selector, usernameSelector,
snapshotId, submitActionId }, source, refuseInput, env)`. The source runs `refuseInput()` and then
`readField(email, field, { env, ...(allowForegroundSearch ? { allow_foreground_search: true } : {}) })`, or
the equivalent `createReadField(env)`. Map a `Gate` or `VaultError` to `blocked` with its code and anything
else to `unknown` with `private-transfer-unconfirmed`. `readField` already turns every `ClipboardError` into
a `VaultError`. `buildClipboardGuard` fails with `clipboard-unavailable` off macOS or without xcrun.
