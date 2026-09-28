# Pool parity

Each line maps one Python test function to the vitest test with the same intent. Parametrized Python tests
map to one `it.each` test whose cases are the same inputs. `scripts/check-parity.mjs` checks this file.

Every Python fcntl.flock is a SQLite lock (design 4.4), so each "process" in these tests is a real Node child
(`tests/server/support/child-pool.ts`) sharing one private state root. The state root is the test's temp root
(`BROWSER_CONTROL_STATE_DIR`), which holds the registry (`pool/registry`, Python `DEFAULT_ROOT`), controllers
(`pool/controllers`, Python `BASE_ROOT`) and sockets (`sockets`, Python `SOCKET_ROOT`, D1). The fsync-bound pool
suites run one at a time (`serialSuite` in tests/server/pool/helpers.ts takes the pool's own SQLite lock), because
several at once slowed other suites' child processes enough to expose startup races in tests/security/host.test.ts.

## test_browser_pool.py -> registry.ts (14 of 14 cases)

test_browser_pool.py::test_concurrent_automatic_claims_are_distinct_and_persistent -> tests/server/pool/browser-pool.test.ts::gives concurrent automatic claims distinct, persistent controllers
test_browser_pool.py::test_same_slot_race_has_one_winner -> tests/server/pool/browser-pool.test.ts::has one winner in a same-slot race
test_browser_pool.py::test_same_owner_auto_claim_race_is_idempotent -> tests/server/pool/browser-pool.test.ts::keeps a same-owner automatic claim race idempotent
test_browser_pool.py::test_pin_prevents_release_but_other_slots_stay_available -> tests/server/pool/browser-pool.test.ts::refuses release while pinned and keeps other slots available
test_browser_pool.py::test_explicit_setup_claims_can_share_owner -> tests/server/pool/browser-pool.test.ts::lets explicit setup claims share one owner
test_browser_pool.py::test_live_tab_and_crash_marker_block_reassignment -> tests/server/pool/browser-pool.test.ts::blocks reassignment with a live tab's marker left by a crashed process
test_browser_pool.py::test_confirmed_cleanup_allows_exact_release -> tests/server/pool/browser-pool.test.ts::allows the exact release once cleanup is confirmed
test_browser_pool.py::test_unsafe_registry_refused -> tests/server/pool/browser-pool.test.ts::refuses an unsafe registry: %s
test_browser_pool.py::test_foreign_owner_and_wrong_lease_refused -> tests/server/pool/browser-pool.test.ts::refuses a foreign owner and a wrong lease

Adaptations:
- `test_unsafe_registry_refused[root-symlink]` passed a symlinked `root=`; the port passes a PoolContext whose
  `registry` is the symlink. `lock-symlink` and `lock-hardlink` now exercise the SQLite lock files, which are
  lstat'ed and refused before SQLite opens them.

## test_browser_preferences.py -> preferences.ts (20 of 20 cases)

test_browser_preferences.py::test_only_password_saving_preference_changes -> tests/server/pool/preferences.test.ts::changes only the password-saving preference
test_browser_preferences.py::test_new_stopped_profile_gets_password_saving_disabled -> tests/server/pool/preferences.test.ts::disables password saving in a new stopped profile
test_browser_preferences.py::test_running_profile_is_not_rewritten -> tests/server/pool/preferences.test.ts::never rewrites a running profile
test_browser_preferences.py::test_invalid_preferences_are_preserved -> tests/server/pool/preferences.test.ts::preserves invalid preferences: %s
test_browser_preferences.py::test_symlink_preferences_are_not_followed -> tests/server/pool/preferences.test.ts::does not follow a symlinked Preferences file
test_browser_preferences.py::test_cold_profile_gets_password_and_download_keys_and_keeps_the_rest -> tests/server/pool/preferences.test.ts::gives a cold profile the password and download keys and keeps the rest
test_browser_preferences.py::test_new_stopped_profile_gets_all_four_keys -> tests/server/pool/preferences.test.ts::gives a new stopped profile all four keys
test_browser_preferences.py::test_running_profile_is_only_checked -> tests/server/pool/preferences.test.ts::only checks a running profile: %j
test_browser_preferences.py::test_running_profile_without_preferences_is_unconfirmed -> tests/server/pool/preferences.test.ts::reports a running profile without Preferences as unconfirmed
test_browser_preferences.py::test_invalid_download_preferences_are_preserved -> tests/server/pool/preferences.test.ts::preserves invalid download preferences: %s

Adaptations:
- `test_symlink_preferences_are_not_followed` expected an OSError; the port expects `FsError`, the port's OSError.

## test_browser_start.py -> start.ts, provision.ts, cua-cli.ts (36 of 37 cases)

test_browser_start.py::test_cold_start_then_warm_reuse -> tests/server/pool/start.test.ts::starts cold and then reuses the warm Chrome
test_browser_start.py::test_endpoint_loss_during_window_check_cannot_return_ready -> tests/server/pool/start.test.ts::cannot return ready when the endpoint is lost during the window check
test_browser_start.py::test_launch_requires_explicit_focus_preservation -> tests/server/pool/start.test.ts::requires explicit focus preservation at launch: %j
test_browser_start.py::test_enabled_password_saving_blocks_warm_reuse -> tests/server/pool/start.test.ts::blocks warm reuse while password saving is enabled
test_browser_start.py::test_existing_unready_process_is_never_relaunched -> tests/server/pool/start.test.ts::never relaunches an existing unready process
test_browser_start.py::test_unknown_launch_is_not_replayed_and_pins_release -> tests/server/pool/start.test.ts::never replays an unknown launch, and its startup record blocks release
test_browser_start.py::test_ambiguous_identity_refused -> tests/server/pool/start.test.ts::refuses an ambiguous identity: pids %j, ready %s
test_browser_start.py::test_foreign_owner_cannot_launch -> tests/server/pool/start.test.ts::does not let a foreign owner launch
test_browser_start.py::test_concurrent_ensure_waits_for_startup_then_reuses_warm -> tests/server/pool/start.test.ts::makes a concurrent ensure wait for startup and then reuse the warm Chrome
test_browser_start.py::test_startup_lock_wait_is_bounded_by_the_timeout -> tests/server/pool/start.test.ts::bounds the startup lock wait by the timeout
test_browser_start.py::test_profile_matching_is_exact_and_excludes_helpers -> tests/server/pool/start.test.ts::matches the profile exactly and excludes helpers
test_browser_start.py::test_launch_arguments_are_controller_specific -> tests/server/pool/start.test.ts::gives each controller its own launch arguments
test_browser_start.py::test_readiness_windows_exclude_hidden_and_utility_windows -> tests/server/pool/start.test.ts::excludes hidden and utility windows from readiness
test_browser_start.py::test_invalid_timeout_does_not_claim -> tests/server/pool/start.test.ts::refuses an invalid timeout without claiming: %s
test_browser_start.py::test_exclusive_receipt_names_pid_windows_downloads_and_lease_artifacts -> tests/server/pool/start.test.ts::names the pid, windows, downloads and lease artifacts in an exclusive receipt
test_browser_start.py::test_shared_receipt_omits_profile_wide_native_and_download_fields -> tests/server/pool/start.test.ts::omits profile-wide native and download fields from a shared receipt
test_browser_start.py::test_second_tenant_on_other_site_joins_running_shared_chrome_warm -> tests/server/pool/start.test.ts::lets a second tenant on another site join the running shared Chrome warm
test_browser_start.py::test_stale_socket_is_removed_before_launch -> tests/server/pool/start.test.ts::removes a stale socket before launch
test_browser_start.py::test_live_endpoint_without_profile_process_blocks_launch -> tests/server/pool/start.test.ts::blocks launch on a live endpoint without the profile process
test_browser_start.py::test_existing_profile_without_history_reports_previously_used -> tests/server/pool/start.test.ts::reports previously-used for an existing profile without history
test_browser_start.py::test_new_profile_history_starts_complete_before_first_launch -> tests/server/pool/start.test.ts::starts a new profile's history complete before the first launch
test_browser_start.py::test_provision_creates_private_directories_wrapper_and_manifest -> tests/server/pool/start.test.ts::creates private directories, the host wrapper and the manifest
test_browser_start.py::test_provision_requires_an_absolute_executable_node -> tests/server/pool/start.test.ts::requires an absolute executable Node: %s
test_browser_start.py::test_legacy_wrapper_is_accepted_until_migrate -> not ported: the legacy static wrappers and `migrate` are not ported (C8, D5)
test_browser_start.py::test_foreign_manifest_is_refused_and_preserved -> tests/server/pool/start.test.ts::refuses and preserves a foreign manifest: %s %s
test_browser_start.py::test_real_runtime_configures_download_keys -> tests/server/pool/start.test.ts::configures the download keys through the real runtime

Adaptations:
- Receipts and metadata report `server: "browser-control"` for every controller (D6); Python reported
  `fast-chrome-isolated-1` for exclusive receipts of the retired numbered entries.
- `test_launch_arguments_are_controller_specific` checked `--load-extension=<package extension>`; the port loads the
  stable, key-injected copy under `<state>/extensions` (C3, D4), so `launchArguments` takes that directory.
- `test_launch_requires_explicit_focus_preservation` patched `runtime.cua`; the port does the same, after setting the
  stable extension copy that `prepare` would publish.
- `test_provision_creates_private_directories_wrapper_and_manifest` read `FAST_CHROME_NODE`, `OPZERO_CHROME_HOST_SOCKET`
  and `pncpgnbanebkeopjghjleodgmphmmmcp`: the port passes the Node and stable host script as provisioning inputs
  (C2, C3, D3), the wrapper exports `BROWSER_CONTROL_HOST_SOCKET` (D19) and the manifest allows the isolated copy's
  fixed ID `mpodnojmjjafgogldgieimgbmfhhknbe` (Q1).
- `test_provision_requires_an_absolute_executable_node` set `FAST_CHROME_NODE`, which is removed (D3); the port passes
  the same three values as the provisioning Node, which gets the same checks.
- `test_foreign_manifest_is_refused_and_preserved` used `migrate=True` and, for `isolated-4`, the legacy wrapper path;
  without `migrate` (C8) both paths are foreign ones, which provisioning refuses and preserves.
- `test_live_endpoint_without_profile_process_blocks_launch` checks the socket file while its listener is open,
  because Node unlinks a Unix socket when its server closes.

## test_controller_factory.py -> registry.ts, operator.ts (35 of 36 cases)

test_controller_factory.py::test_concurrent_shared_claims_each_get_their_own_chrome_first -> tests/server/pool/controller-factory.test.ts::gives concurrent shared claims their own Chrome first
test_controller_factory.py::test_same_owner_concurrent_shared_claims_are_idempotent -> tests/server/pool/controller-factory.test.ts::keeps same-owner concurrent shared claims idempotent
test_controller_factory.py::test_a_lock_file_create_that_races_another_process_is_retried -> tests/server/pool/controller-factory.test.ts::retries a lock file create that races another process
test_controller_factory.py::test_limits_default_clamp_and_reject -> tests/server/pool/controller-factory.test.ts::defaults, clamps and rejects the limits
test_controller_factory.py::test_hard_cap_is_eight_controllers -> tests/server/pool/controller-factory.test.ts::caps controllers at eight
test_controller_factory.py::test_limit_caps_new_controllers_and_explicit_claims -> tests/server/pool/controller-factory.test.ts::caps new controllers and explicit claims at the limit
test_controller_factory.py::test_idle_controller_is_reused_before_a_new_one_and_running_first -> tests/server/pool/controller-factory.test.ts::reuses an idle controller before a new one, running ones first
test_controller_factory.py::test_shared_claims_pack_only_at_the_limit_and_respect_the_tenant_cap -> tests/server/pool/controller-factory.test.ts::packs shared claims only at the limit and respects the tenant cap
test_controller_factory.py::test_same_site_claim_goes_to_another_controller -> tests/server/pool/controller-factory.test.ts::sends a same-site claim to another controller
test_controller_factory.py::test_exclusive_lease_blocks_sharing_both_ways -> tests/server/pool/controller-factory.test.ts::blocks sharing both ways with an exclusive lease
test_controller_factory.py::test_reap_global_lease_never_shares_in_either_direction -> tests/server/pool/controller-factory.test.ts::never shares an unshared-site lease in either direction
test_controller_factory.py::test_shared_tenant_cannot_add_reap_global_beside_another_tenant -> tests/server/pool/controller-factory.test.ts::refuses a shared tenant adding an unshared site beside another tenant
test_controller_factory.py::test_max_tenants_one_disables_sharing -> tests/server/pool/controller-factory.test.ts::disables sharing with one tenant
test_controller_factory.py::test_site_gate_refuses_same_site_before_writing_a_marker -> tests/server/pool/controller-factory.test.ts::refuses the same site before writing a marker
test_controller_factory.py::test_concurrent_same_site_gates_have_one_winner -> tests/server/pool/controller-factory.test.ts::has one winner among concurrent same-site gates
test_controller_factory.py::test_tenant_releases_while_another_tenant_has_a_live_tab -> tests/server/pool/controller-factory.test.ts::lets a tenant release while another tenant has a live tab
test_controller_factory.py::test_marker_is_kept_after_a_crash -> tests/server/pool/controller-factory.test.ts::keeps a marker after a crash
test_controller_factory.py::test_foreign_owner_wrong_lease_and_mode_mismatch -> tests/server/pool/controller-factory.test.ts::refuses a foreign owner, a wrong lease and a mode mismatch
test_controller_factory.py::test_lease_for_returns_the_single_lease_with_per_lease_artifacts -> tests/server/pool/controller-factory.test.ts::returns the single lease with per-lease artifacts
test_controller_factory.py::test_shared_pin_blocks_only_its_own_release -> tests/server/pool/controller-factory.test.ts::blocks only its own release with a shared pin
test_controller_factory.py::test_sites_seen_reports_previously_used_after_release -> tests/server/pool/controller-factory.test.ts::reports previously-used sites after release
test_controller_factory.py::test_sites_seen_overflow_and_lease_site_limit -> tests/server/pool/controller-factory.test.ts::marks overflowing site history incomplete and limits a lease's sites
test_controller_factory.py::test_status_lists_legacy_and_discovered_controllers -> tests/server/pool/controller-factory.test.ts::lists the default and discovered controllers
test_controller_factory.py::test_legacy_formats_stay_byte_identical -> tests/server/pool/controller-factory.test.ts::keeps the legacy record formats byte-identical
test_controller_factory.py::test_claim_does_not_create_profile_or_artifact_directories -> tests/server/pool/controller-factory.test.ts::creates no profile or artifact directories on claim
test_controller_factory.py::test_reap_refused_while_lease_marker_pin_or_startup_exists -> tests/server/pool/controller-factory.test.ts::is refused while a lease, marker, pin or startup record exists
test_controller_factory.py::test_reap_refused_while_an_http_tab_is_open -> tests/server/pool/controller-factory.test.ts::is refused while an HTTP tab is open
test_controller_factory.py::test_reap_stops_verified_idle_chrome_and_keeps_the_profile -> tests/server/pool/controller-factory.test.ts::stops a verified idle Chrome and keeps the profile
test_controller_factory.py::test_unconfirmed_reap_keeps_intent_and_blocks_claims_until_confirmed -> tests/server/pool/controller-factory.test.ts::keeps an unconfirmed reap's intent and blocks claims until confirmed
test_controller_factory.py::test_reap_keeps_its_intent_while_the_endpoint_is_still_live -> tests/server/pool/controller-factory.test.ts::keeps its intent while the endpoint is still live
test_controller_factory.py::test_a_reap_excludes_other_reapers_and_claims_until_its_exit_is_confirmed -> tests/server/pool/controller-factory.test.ts::excludes other reapers and claims until its exit is confirmed
test_controller_factory.py::test_reap_all_reports_each_controller -> tests/server/pool/controller-factory.test.ts::reports each controller when reaping all
test_controller_factory.py::test_reset_needs_confirmation_and_an_idle_stopped_controller -> tests/server/pool/controller-factory.test.ts::needs confirmation and an idle, stopped controller
test_controller_factory.py::test_migrate_rewrites_only_stopped_legacy_manifests -> not ported: `migrate` and `legacy_host` are not ported (C8, D15)
test_controller_factory.py::test_capture_directory_uses_the_given_root_before_the_environment -> tests/server/pool/controller-factory.test.ts::uses the given capture root before the environment (D2)
test_controller_factory.py::test_cli_commands_and_flags_use_home_paths -> tests/server/pool/controller-factory.test.ts::runs its commands and flags on the home state root (C4, D1, D15)

Adaptations:
- The two unshared-site tests set `FAST_CHROME_UNSHARED_SITES=example.global` (C5: the default is none), and their
  synthetic sites replace the organization-specific ones. New tests cover
  the empty default and the fail-closed `browser-controller-invalid-unshared-sites` (D8).
- `test_hard_cap_is_eight_controllers` expected `fast-chrome` and `fast-chrome-isolated-1`; every controller now
  reports `browser-control` (D6).
- `test_a_lock_file_create_that_races_another_process_is_retried` patched `os.open` for every open of
  `allocation.lock`. The port never reopens an existing lock file (closing any descriptor would drop this process's
  POSIX locks on it; see lock.ts), so it removes the file before the second, failing claim to reach the create path.
- `test_reap_keeps_its_intent_while_the_endpoint_is_still_live` relies on a closed listener leaving its socket file;
  Node unlinks it on close, so the port keeps a hard link and restores the file after the listener closes.
- `test_capture_directory_uses_the_given_root_before_the_environment` tested `native_captures.directory()`, which
  raised without `FAST_CHROME_ARTIFACT_ROOT`. The port checks `captureDirectory` with the root `userArtifactRoot`
  resolves: the explicit variable first, else `<state>/artifacts/user` (D2), and a non-private root is refused.
- `test_cli_commands_and_flags_use_home_paths` ran `python3 browser_pool.py`; the port runs `runPoolCommand` in a child
  process (`browser-control pool`, D15) with only `HOME` set. Sockets are `<state>/sockets/<id>.sock` (D1), and
  nothing is written outside `~/.local/state/browser-control` (C4). `migrate` exits 2 as an invalid choice.

## Pool tests without a Python counterpart

- tests/server/pool/locks.test.ts: the SQLite locks across real processes on the pool's operations: a held lock
  survives another holder in the same process closing its file, a pin survives in-process status and lease reads,
  a SIGKILLed pin holder frees its lock but keeps its marker, releases racing exclusive and shared pins have exactly
  one outcome, ten processes racing for eight controllers, and no journal files.
- tests/server/pool/operator.test.ts: the CLI parser against argparse over a captured corpus
  (`fixtures/python-argparse.json`, from `fixtures/capture-argparse.py`).
- tests/server/pool/preferences.test.ts `lossless Preferences rewrite (design 4.9)`: integers above 2^53, float text
  and key order survive a rewrite; Python's 4300-digit limit and a float that overflows on write are refused.
- tests/server/pool/start.test.ts `provisioning changes (C2, C3, D1, Q1)`: wrappers exec `process.execPath` on the
  stable host copy; the retired unpacked ID is refused; an over-long socket path is `browser-controller-unsafe-path`;
  `prepare` requires cua-driver (C1) and publishes the key-injected stable extension that `launch` loads.
- `tests/server/pool/fixtures/browser-pool.html` is the reference's manual verification page, kept for live checks.
