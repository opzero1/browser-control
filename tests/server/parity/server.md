# Server parity

Each line maps one Python test function to the vitest test with the same intent. Parametrized Python tests
map to one `it.each` test whose cases are the same inputs. `scripts/check-parity.mjs` checks this file.

Test doubles follow the Python tests: `FakeConnection` (tests/server/server/helpers.ts) stands in for
`Mock(alive=True)` with the same call log, `return_value` and `side_effect` rules; `Chrome` is the fake
Browser Control endpoint; deferred promises replace `threading.Event` and `Barrier`; a Python monkeypatch of a
module function becomes an assignment on the `BrowserControl` instance (`register`, `validatedPdf`, `paste`,
`readField`, `connect`) or a `vi.spyOn` (`Pin.prototype.beginTab`, `Pin.open`). Python's module-level
`TABS` and `SHUTDOWN` are per-instance (`server.registry`, `server.shutdown`), so each test builds a fresh server
over a private state root. Expected codes are Python's after the D19 rename (`opchrome-*` becomes
`browser-control-*`); `FAST_CHROME_UNSHARED_SITES=reap.global` keeps the Python unshared-site intent (C5).

## test_native_server.py -> app.ts, args.ts, page.ts, tabs.ts, route.ts (110 functions; 102 ported, 8 not ported)

test_native_server.py::test_controller_denies_foreign_session_before_any_page_or_vault_call -> not ported: C8 removes the fixed numbered route (FAST_CHROME_CONTROLLER_ID, controller_operation, claimed_by and browser-controller-not-owned for the entry). A foreign session on a lease tab is refused before any call in tests/server/server/routing.test.ts::refuses another tenant's use of a lease tab before any call or registry write.
test_native_server.py::test_numbered_entry_refusal_creates_no_registry_directory_or_lock -> not ported: C8 removes the fixed numbered route and its read-only claim.json check (fixed_owner).
test_native_server.py::test_numbered_entry_owner_is_refused_an_unknown_tab_before_any_pin -> tests/server/server/routing.test.ts::refuses a lease holder's unknown tab before any pin
test_native_server.py::test_controller_status_reports_only_readiness_and_availability -> not ported: C8; the free, owned and busy `lease` field of status existed only for the fixed route's claim.json entry.
test_native_server.py::test_controller_config_cannot_route_a_lease_to_another_socket -> not ported: C8 removes browser-controller-config-mismatch with the fixed route.
test_native_server.py::test_controller_listing_holds_lease_until_call_returns -> not ported: C8; only the fixed route pinned its claim for tabs() (controller_operation). Lease tab calls pin their lease in tests/server/server/routing.test.ts::pins a lease tab's bound lease for each call.
test_native_server.py::test_controller_tab_pins_between_calls_then_releases_after_confirmed_cleanup -> tests/server/server/routing.test.ts::pins a lease tab between calls and releases the lease after confirmed cleanup
test_native_server.py::test_controller_failed_cleanup_survives_server_lifespan -> tests/server/server/routing.test.ts::keeps a failed cleanup's marker through the server's cleanup
test_native_server.py::test_unknown_create_without_handle_leaves_persistent_cleanup_block -> tests/server/server/routing.test.ts::leaves a persistent cleanup block after an unknown create without a handle
test_native_server.py::test_pre_dispatch_claim_refusal_does_not_leave_cleanup_marker -> tests/server/server/routing.test.ts::leaves no cleanup marker after a claim refused before dispatch
test_native_server.py::test_session_metadata -> tests/server/server/tools.test.ts::reads the session from _meta[%s]
test_native_server.py::test_group_title_uses_label_or_session_fallback -> tests/server/server/tools.test.ts::uses the label or the session fallback
test_native_server.py::test_existing_owned_tab_can_be_renamed_without_reclaim -> tests/server/server/tools.test.ts::renames an existing owned tab without a reclaim
test_native_server.py::test_name_group_requires_exact_extension_readback -> tests/server/server/tools.test.ts::requires the exact extension readback for name_group: %j
test_native_server.py::test_open_names_the_created_group_before_claiming_success -> tests/server/server/tools.test.ts::names the created group before claiming success
test_native_server.py::test_existing_claim_without_label_preserves_confirmed_title -> tests/server/server/tools.test.ts::keeps the confirmed title on an existing claim without a label
test_native_server.py::test_existing_claim_refuses_busy_tab -> tests/server/server/tools.test.ts::refuses an existing claim of a busy tab
test_native_server.py::test_missing_metadata -> tests/server/server/tools.test.ts::falls back to one process session ID when the metadata has none (C7)
test_native_server.py::test_refused_urls -> tests/server/server/tools.test.ts::refuses %j
test_native_server.py::test_exact_origin_and_loopback_opt_in -> tests/server/server/tools.test.ts::returns the exact origin and allows loopback only when opted in
test_native_server.py::test_other_session_cannot_use_tab -> tests/server/server/tools.test.ts::refuses another session's %s before any call
test_native_server.py::test_unknown_input_consumes_token -> tests/server/server/tools.test.ts::consumes the token on an unknown input
test_native_server.py::test_post_action_read_failure_preserves_executed -> tests/server/server/tools.test.ts::keeps executed when the post-action read fails
test_native_server.py::test_action_waits_for_async_public_control -> tests/server/server/tools.test.ts::waits for an asynchronous public control
test_native_server.py::test_action_accepts_same_origin_path_expectation -> tests/server/server/tools.test.ts::accepts a same-origin path expectation
test_native_server.py::test_wait_for_path_is_bound_to_claimed_origin -> tests/server/server/tools.test.ts::binds a wait_for path to the claimed origin
test_native_server.py::test_path_expectation_rejects_ambiguous_urls -> tests/server/server/tools.test.ts::refuses the ambiguous path expectation %j
test_native_server.py::test_action_wait_timeout_does_not_replay_or_return_token -> tests/server/server/tools.test.ts::never replays or returns a token after a wait timeout
test_native_server.py::test_unexecuted_action_with_expect_does_not_wait -> tests/server/server/tools.test.ts::does not wait after an unexecuted action with an expectation
test_native_server.py::test_action_reads_only_allowlisted_status -> tests/server/server/tools.test.ts::reads only the allowlisted action status
test_native_server.py::test_generic_act_refuses_file_action -> tests/server/server/tools.test.ts::refuses a file action through the generic act
test_native_server.py::test_upload_validates_pdf_and_returns_only_safe_metadata -> tests/server/server/tools.test.ts::validates the PDF and returns only safe metadata (padding %d)
test_native_server.py::test_upload_rejects_invalid_local_files_and_consumes_adapter_token -> tests/server/server/tools.test.ts::refuses an invalid %s file and consumes the adapter token
test_native_server.py::test_upload_refuses_recording_and_unknown_is_single_use -> tests/server/server/tools.test.ts::refuses during a recording and treats an unknown upload as single use
test_native_server.py::test_pdf_validation_rejects_other_owner -> tests/server/server/tools.test.ts::refuses a PDF owned by another user
test_native_server.py::test_public_snapshot_discards_unrecognized_values -> tests/server/server/tools.test.ts::discards unrecognized values from the public snapshot
test_native_server.py::test_refused_observation_invalidates_previous_token -> tests/server/server/tools.test.ts::invalidates the previous token on a refused observation
test_native_server.py::test_wait_pending_then_match -> tests/server/server/tools.test.ts::polls a pending page until it matches
test_native_server.py::test_failed_wait_has_no_token -> tests/server/server/tools.test.ts::returns no token from a failed wait: %s
test_native_server.py::test_disabled_action_is_not_ready -> tests/server/server/tools.test.ts::treats a disabled action as not ready
test_native_server.py::test_cross_origin_navigation_has_no_dispatch -> tests/server/server/tools.test.ts::dispatches nothing for a cross-origin navigation
test_native_server.py::test_same_tab_serialized_other_tab_independent -> tests/server/server/tools.test.ts::serializes one tab and leaves another independent
test_native_server.py::test_release_requires_semantic_readback -> tests/server/server/tools.test.ts::requires a semantic readback (created %s, keep_open %s)
test_native_server.py::test_unknown_release_is_never_replayed -> tests/server/server/tools.test.ts::never replays an unknown release
test_native_server.py::test_screenshot_guard_and_private_artifact -> tests/server/server/tools.test.ts::guards the capture and saves a private artifact
test_native_server.py::test_open_observation_failure_retains_handle -> tests/server/server/tools.test.ts::retains the handle after an observation failure while opening
test_native_server.py::test_failed_bind_cleans_created_tab_before_connection_close -> tests/server/server/tools.test.ts::cleans a created tab after a failed bind, before closing the connection
test_native_server.py::test_failed_attach_and_uncertain_cleanup_remain_visible -> tests/server/server/tools.test.ts::keeps a failed attach with uncertain cleanup visible
test_native_server.py::test_foreign_caller_cannot_observe_busy_state -> tests/server/server/tools.test.ts::hides a busy tab's state from a foreign caller
test_native_server.py::test_register_race_cannot_replace_existing_handle -> tests/server/server/tools.test.ts::never lets a register race replace an existing handle
test_native_server.py::test_release_cannot_slip_between_a_calls_lookup_and_its_busy_lock -> tests/server/server/tools.test.ts::takes a call's busy flag in the same step as its lookup, so a release cannot slip in between
test_native_server.py::test_a_call_keeps_operating_on_the_tab_it_locked_when_its_handle_is_replaced -> tests/server/server/tools.test.ts::keeps a call on the tab it locked when its handle is replaced
test_native_server.py::test_setup_publishes_a_new_tab_only_while_it_is_busy -> tests/server/server/tools.test.ts::publishes a new tab only while it is busy (claim %s)
test_native_server.py::test_controls_only_preserves_coverage -> tests/server/server/tools.test.ts::preserves coverage metadata in controls-only mode
test_native_server.py::test_controls_only_survives_automatic_post_action_observation -> tests/server/server/tools.test.ts::survives the automatic post-action observation
test_native_server.py::test_controls_only_survives_action_wait -> tests/server/server/tools.test.ts::survives an action wait (matched %s)
test_native_server.py::test_controls_only_survives_standalone_wait_and_following_action -> tests/server/server/tools.test.ts::survives a standalone wait and the following action
test_native_server.py::test_controls_only_standalone_text_wait_reads_full_and_matches -> tests/server/server/tools.test.ts::reads full for a standalone text wait and matches
test_native_server.py::test_controls_only_text_expectation_reads_full_after_action -> tests/server/server/tools.test.ts::reads full for a text expectation after an action
test_native_server.py::test_existing_claim_keeps_controls_only_preference -> tests/server/server/tools.test.ts::keeps the controls-only preference on an existing claim
test_native_server.py::test_only_observe_resets_controls_only_preference -> tests/server/server/tools.test.ts::resets the controls-only preference only through observe
test_native_server.py::test_metadata_validation_invalidates_token -> tests/server/server/tools.test.ts::invalidates the token when the page metadata fails validation: %s
test_native_server.py::test_act_steps_runs_steps_in_order_from_each_returned_snapshot -> tests/server/server/act-steps.test.ts::runs steps in order from each returned snapshot
test_native_server.py::test_act_steps_unresolved_label_stops_before_dispatch_with_usable_snapshot -> tests/server/server/act-steps.test.ts::stops before dispatch on an unresolved label %j with a usable snapshot
test_native_server.py::test_act_steps_refuses_unsupported_control_before_dispatch -> tests/server/server/act-steps.test.ts::refuses an unsupported control %j before dispatch
test_native_server.py::test_act_steps_disabled_match_stops_before_dispatch_with_usable_snapshot -> tests/server/server/act-steps.test.ts::stops before dispatch on %d disabled matches with a usable snapshot
test_native_server.py::test_act_steps_selects_the_enabled_action_among_disabled_duplicates -> tests/server/server/act-steps.test.ts::selects the enabled action among disabled duplicates
test_native_server.py::test_act_steps_unconfirmed_dispatch_stops_without_replay -> tests/server/server/act-steps.test.ts::stops without replay after an unconfirmed dispatch %#
test_native_server.py::test_act_steps_failed_wait_stops_after_dispatch_without_token -> tests/server/server/act-steps.test.ts::stops after dispatch without a token on a failed wait %#
test_native_server.py::test_act_steps_observation_failure_stops_with_its_gate -> tests/server/server/act-steps.test.ts::stops with the observation's gate when the read after a step fails
test_native_server.py::test_act_steps_budget_stops_before_next_dispatch -> tests/server/server/act-steps.test.ts::stops before the next dispatch once the budget is spent
test_native_server.py::test_act_steps_budget_stops_before_wait_after_dispatch -> tests/server/server/act-steps.test.ts::stops before the wait after a dispatch once the budget is spent
test_native_server.py::test_act_steps_wait_is_capped_by_the_run_budget -> tests/server/server/act-steps.test.ts::caps a step's wait by the run budget
test_native_server.py::test_act_steps_refuses_bad_input_before_any_socket_call -> tests/server/server/act-steps.test.ts::refuses bad input before any socket call %#
test_native_server.py::test_step_model_is_strict_and_bounded -> tests/server/server/act-steps.test.ts::keeps the Step model strict and bounded: %j
test_native_server.py::test_act_steps_requires_the_current_snapshot -> tests/server/server/act-steps.test.ts::requires the current snapshot
test_native_server.py::test_act_steps_refuses_busy_tab_before_any_call -> tests/server/server/act-steps.test.ts::refuses a busy tab before any call
test_native_server.py::test_act_steps_holds_the_tab_busy_for_the_whole_run -> tests/server/server/act-steps.test.ts::holds the tab busy for the whole run
test_native_server.py::test_act_steps_include_text_reads_only_the_final_view_full -> tests/server/server/act-steps.test.ts::reads only the final view full with include_text
test_native_server.py::test_act_steps_text_expectation_reads_full_under_controls_only -> tests/server/server/act-steps.test.ts::reads full for a text expectation under controls-only
test_native_server.py::test_act_steps_accepts_strict_json_steps_through_mcp -> tests/server/server/act-steps.test.ts::accepts strict JSON steps through MCP
test_native_server.py::test_route_prefers_the_fixed_binding_then_the_callers_lease_then_the_users_chrome -> tests/server/server/routing.test.ts::routes to the caller's lease, else the user's Chrome
test_native_server.py::test_open_tab_binds_the_lease_and_later_tools_never_reroute -> tests/server/server/routing.test.ts::binds the lease at open and never reroutes later tools
test_native_server.py::test_lease_tab_tools_pin_the_bound_lease_for_each_call -> tests/server/server/routing.test.ts::pins a lease tab's bound lease for each call
test_native_server.py::test_site_held_by_another_tenant_is_refused_before_any_tab_exists -> tests/server/server/routing.test.ts::refuses a site held by another tenant before any tab exists
test_native_server.py::test_tabs_on_a_lease_route_lists_only_its_sites -> tests/server/server/routing.test.ts::lists only a lease route's own sites
test_native_server.py::test_claim_tab_on_a_lease_route_refuses_other_sites_before_claiming -> tests/server/server/routing.test.ts::refuses to claim another site's tab on a lease route before claiming
test_native_server.py::test_status_reports_only_the_callers_route_and_lease -> tests/server/server/routing.test.ts::reports only the caller's route and lease in status
test_native_server.py::test_captures_are_written_under_the_tabs_own_artifact_root -> tests/server/server/routing.test.ts::writes captures under the tab's own artifact root
test_native_server.py::test_claim_browser_leases_shares_and_starts_only_isolated_profiles -> tests/server/server/routing.test.ts::leases, shares and starts only isolated profiles
test_native_server.py::test_claim_browser_is_refused_on_a_fixed_numbered_entry -> not ported: C8 removes the fixed numbered entry and browser-controller-fixed-entry.
test_native_server.py::test_release_browser_needs_released_tabs_and_ignores_other_tenants -> tests/server/server/routing.test.ts::needs released tabs to release a browser and ignores other tenants
test_native_server.py::test_tool_calls_from_two_sessions_overlap_in_time -> tests/server/server/mcp.test.ts::overlaps tool calls from two sessions in time
test_native_server.py::test_a_running_call_keeps_only_its_own_tab_busy -> tests/server/server/mcp.test.ts::keeps only its own tab busy while a call runs
test_native_server.py::test_a_cancelled_caller_waits_for_the_running_body -> tests/server/server/mcp.test.ts::lets a running body finish after its caller cancels, keeping the tab busy until then
test_native_server.py::test_new_tools_take_no_session_argument_and_accept_json_input -> tests/server/server/mcp.test.ts::takes no session argument and accepts JSON input
test_native_server.py::test_another_tenant_cannot_use_a_lease_tab_before_any_call_or_registry_write -> tests/server/server/routing.test.ts::refuses another tenant's use of a lease tab before any call or registry write
test_native_server.py::test_private_transfer_reports_the_lease_tab_handle -> tests/server/server/routing.test.ts::reports the lease tab handle from the private transfer
test_native_server.py::test_open_tab_refuses_before_dispatch_without_an_incomplete_receipt -> tests/server/server/routing.test.ts::refuses an open before dispatch without an incomplete receipt
test_native_server.py::test_equal_chrome_tab_ids_in_two_chromes_stay_distinct_for_different_owners -> tests/server/server/routing.test.ts::keeps equal Chrome tab IDs in two Chromes distinct for different owners
test_native_server.py::test_a_retained_user_tab_never_stands_in_for_a_leased_tab_with_the_same_id -> tests/server/server/routing.test.ts::never lets a retained user tab stand in for a leased tab with the same ID
test_native_server.py::test_a_running_action_keeps_release_reclaim_and_other_input_off_its_tab -> tests/server/server/routing.test.ts::keeps release, reclaim and other input off a tab while its action runs
test_native_server.py::test_shutdown_stops_act_steps_before_further_input -> tests/server/server/shutdown.test.ts::stops act_steps before further input (expect %s)
test_native_server.py::test_shutdown_refuses_new_calls_new_tabs_and_new_input -> tests/server/server/shutdown.test.ts::refuses new calls, new tabs and new input
test_native_server.py::test_shutdown_during_a_new_tabs_pin_and_marker_write_sends_no_create_or_claim -> tests/server/server/shutdown.test.ts::sends no create or claim when shutdown begins during a new tab's pin and marker write (%s)
test_native_server.py::test_cleanup_finalizes_idle_tabs_and_bounds_hung_or_busy_ones -> tests/server/server/shutdown.test.ts::finalizes idle tabs at cleanup and bounds hung or busy ones
test_native_server.py::test_tab_call_refuses_input_once_shutdown_begins_but_still_reads_and_cleans_up -> tests/server/server/shutdown.test.ts::refuses tab input once shutdown begins but still reads and cleans up
test_native_server.py::test_navigate_and_upload_bodies_already_running_send_no_input_after_shutdown -> tests/server/server/shutdown.test.ts::sends no input from navigate and upload bodies already running when shutdown begins
test_native_server.py::test_shutdown_during_private_transfer_sends_no_further_private_input -> tests/server/server/shutdown.test.ts::sends no further private input when shutdown begins during the %s step (%s)
test_native_server.py::test_shutdown_during_a_private_field_read_stops_the_transfer_before_its_next_step -> tests/server/server/shutdown.test.ts::stops a transfer before its next step when shutdown begins during a %s field read

Adapted (each keeps the Python intent):
- C8: the four numbered-entry cleanup tests run on a lease route, where the tab's lease pin and cleanup marker
  play the claim.json role; the fixed-route halves of `test_route_prefers_...` and of the pin-and-marker
  shutdown test (`kind="fixed"`, 2 of its 4 cases) are dropped.
- C7: `test_missing_metadata` and the anonymous calls in `test_claim_browser_...` and
  `test_new_tools_take_no_session_argument_...` assert the per-process fallback session instead of
  `fast-chrome-session-required`; D9 (a present non-string identity still fails) is asserted too.
- `test_release_cannot_slip_between_...` and `test_a_call_keeps_operating_...` used a pausing lock to open a
  thread race window between lookup and lock. `hold()` is synchronous, so the port asserts the window does not
  exist: the tab is busy as soon as the call returns its promise, and the call keeps the object it locked.
- `test_shutdown_refuses_new_calls_...` cleared and set the shutdown event; the one-way `Shutdown` is begun once,
  after the observation that needs it, and the refusals are asserted in the same order.
- `test_a_cancelled_caller_waits_for_the_running_body` (D11): the TS SDK drops the cancelled response; the port
  asserts the body still runs to completion and keeps its tab busy until then.
- D19: `backend` is `browser-control`, and the D6 receipt `server` is `browser-control`.

Added: the captured Python surfaces in tests/server/server/mcp.test.ts (tools/list and instructions with only the
D19 and Q2 edits, all 136 argument-corpus cases through FastMCP's pre_parse_json and pydantic rules, the result
envelopes, and the 347-case origin corpus with and without `FAST_CHROME_ALLOW_LOOPBACK`), integral float literals
from the wire, the D2 default user artifact root, and the recording tools' wiring (one recording per tab, release
refused while it runs, the receipt, and cleanup stopping it without encoding).

## test_native_stdio.py -> entry.ts, stdio-transport.ts (6 functions, 15 of 15 cases)

test_native_stdio.py::test_sigterm_finalizes_managed_tabs_the_same_way_as_stdin_eof -> tests/server/server/stdio.test.ts::finalizes managed tabs on %s the same way
test_native_stdio.py::test_sigterm_stops_a_running_wait_at_once_then_finalizes -> tests/server/server/stdio.test.ts::stops a running wait at once on SIGTERM, then finalizes
test_native_stdio.py::test_shutdown_during_a_long_act_steps_wait_stops_the_run_without_replay -> tests/server/server/stdio.test.ts::stops a long act_steps wait on %s without replay
test_native_stdio.py::test_cleanup_ends_before_the_parent_kill_and_keeps_unconfirmed_markers -> tests/server/server/stdio.test.ts::ends cleanup before the parent's kill and keeps unconfirmed markers (hang %s, %s)
test_native_stdio.py::test_shutdown_during_private_transfer_sends_no_further_private_input -> tests/server/server/stdio.test.ts::sends no further private input when shutdown begins during the %s step (%s)
test_native_stdio.py::test_shutdown_ends_an_otp_field_wait_so_cleanup_finalizes_its_tab -> tests/server/server/stdio.test.ts::ends an OTP field wait on %s so cleanup finalizes its tab

The child is tests/server/support/child-server.ts, bundled by the global setup and started with Node; it runs
`runStdioServer` with the real app and, for the private cases, the same barrier-file vault as Python's `VAULT`.
"No Traceback" becomes "stderr is empty". The lease socket is `<state>/sockets/isolated-1.sock` (D1) and the
user route reads `BROWSER_CONTROL_HOST_SOCKET` (D19).

## test_private_tool.py -> app.ts paste_1password_field (5 functions, 7 of 7 cases)

test_private_tool.py::test_foreign_owner_cannot_reach_source -> tests/server/server/private-tool.test.ts::keeps a foreign owner from reaching the source
test_private_tool.py::test_busy_tab_refuses_concurrent_transfer -> tests/server/server/private-tool.test.ts::refuses a concurrent transfer on a busy tab
test_private_tool.py::test_other_origin_refuses_before_source -> tests/server/server/private-tool.test.ts::refuses another origin before the source
test_private_tool.py::test_only_fixed_errors_escape -> tests/server/server/private-tool.test.ts::lets only fixed errors escape (%s)
test_private_tool.py::test_foreground_permission_reaches_private_source_only_when_enabled -> tests/server/server/private-tool.test.ts::passes the foreground permission to the private source only when enabled (%s)

Added: the transfer receives the caller's session and public request with no lease (C6, Q2), and its
`refuseInput` refuses once shutdown begins.

## Server deviations

Each is required by C1-C8, the coordinator decisions or the platform; everything else is Python's behavior.

- S1 (Q2) `paste_1password_field` has no `lease_id`: the property is gone from its input schema, the sentence
  "Pool accounts require their owned lease_id." is gone from its description, and a `lease_id` argument is
  ignored like any unknown argument. `fast-chrome-pool-account-mismatch`, `fast-chrome-pool-lease-required` and
  `fast-chrome-pool-lease-unavailable` are unreachable.
- S2 (C7, D9) An absent session identity uses one `ses_<32 hex>` ID per process; a present identity that is not
  a non-empty string still fails with `fast-chrome-session-required`.
- S3 (C8) No fixed route: `route` has kinds `lease` and `user`; `status` has no `lease` field; `claim_browser`
  never raises `browser-controller-fixed-entry`; `tabs` and `open_tab` take no claim.json pin.
- S4 (D19) The user route reads `BROWSER_CONTROL_HOST_SOCKET` (default `~/.opzero-chrome/default.sock`), and
  `OPZERO_CHROME_HOST_SOCKET` is ignored; `status` reports `backend: "browser-control"`; the retired
  `opchrome-*` codes are `browser-control-*`; the instructions say "Browser Control" and "Load browser-control".
- S5 (D2) Without `FAST_CHROME_ARTIFACT_ROOT`, user-route captures go under `<state>/artifacts/user`, created
  0700 on the first capture; Python raised `fast-chrome-private-artifact-root-required`.
- S6 (D10) Validation error text keeps pydantic's first lines (`N validation error(s) for <tool>Arguments`, the
  location, the message and `[type=...`) but drops `input_value`, `input_type` and the help URL.
- S7 (D13) The stdio transport keeps integral float literals (such as `100.0`) in `tools/call` arguments as
  floats, so strict int fields refuse them as Python did; an in-process caller passes plain JS numbers, which
  count as ints.
- S8 (D11) A cancelled call gets no response; its body still runs to completion and its tab stays busy.
- S9 During shutdown a call is refused before argument validation by the stdio entry (the transport is closing
  then); Python validated first. The app itself validates first, then refuses.
