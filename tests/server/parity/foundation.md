# Foundation parity

Each line maps one Python test function to the vitest test with the same intent. Parametrized Python tests
map to one `it.each` test whose cases are the same inputs. `scripts/check-parity.mjs` checks this file.

Expected error codes are Python's codes after the D19 rename (`opchrome-*` becomes `browser-control-*`);
the tests state the Python code and translate it with `tests/server/support/renames.ts`.

## test_opchrome.py -> host-connection.ts (78 of 78 cases)

test_opchrome.py::test_persistent_connection_and_independent_host_authorities -> tests/server/foundation/host-connection.test.ts::keeps one persistent connection per open with independent host authorities
test_opchrome.py::test_name_session_is_an_allowlisted_display_method -> tests/server/foundation/host-connection.test.ts::allowlists nameSession as a display method
test_opchrome.py::test_handshake_incompatible -> tests/server/foundation/host-connection.test.ts::refuses an incompatible handshake: $name
test_opchrome.py::test_missing_socket -> tests/server/foundation/host-connection.test.ts::refuses a missing socket as unavailable
test_opchrome.py::test_invalid_timeout -> tests/server/foundation/host-connection.test.ts::refuses an invalid timeout: %s
test_opchrome.py::test_foreign_owner_refused -> tests/server/foundation/host-connection.test.ts::refuses a foreign-owned %s
test_opchrome.py::test_unsafe_endpoint -> tests/server/foundation/host-connection.test.ts::refuses an unsafe endpoint: %s
test_opchrome.py::test_reject_caller_authority -> tests/server/foundation/host-connection.test.ts::rejects caller authority $key (nested: $nested)
test_opchrome.py::test_invalid_request_never_sent -> tests/server/foundation/host-connection.test.ts::never sends an invalid request: $name
test_opchrome.py::test_remote_error_is_redacted_and_notifications_excluded -> tests/server/foundation/host-connection.test.ts::redacts remote errors and skips notifications
test_opchrome.py::test_wrong_or_malformed_response_poisoned_without_replay -> tests/server/foundation/host-connection.test.ts::poisons the connection without replay on $name
test_opchrome.py::test_uncertain_outcome_no_reconnect_or_replay -> tests/server/foundation/host-connection.test.ts::never reconnects or replays an uncertain outcome: %s
test_opchrome.py::test_safe_refusal_diagnostics -> tests/server/foundation/host-connection.test.ts::maps the refusal $message to a safe diagnostic
test_opchrome.py::test_response_byte_bound -> tests/server/foundation/host-connection.test.ts::bounds response bytes
test_opchrome.py::test_production_response_limit -> tests/server/foundation/host-connection.test.ts::bounds an unterminated frame at the production response limit
test_opchrome.py::test_partial_response_eof -> tests/server/foundation/host-connection.test.ts::treats a partial response before EOF as an unknown outcome
test_opchrome.py::test_fragmented_response -> tests/server/foundation/host-connection.test.ts::reassembles a fragmented response
test_opchrome.py::test_concurrent_calls_are_serialized -> tests/server/foundation/host-connection.test.ts::serializes concurrent calls
test_opchrome.py::test_upload_rpc_is_allowlisted -> tests/server/foundation/host-connection.test.ts::allowlists the upload RPC

Adaptations:
- `test_response_byte_bound` lowered the module's RESPONSE_LIMIT with monkeypatch; the port passes
  `{ responseLimit: 1024 }` to `Connection.open`, which exercises the same bound branch.
- `test_invalid_request_never_sent` used `{1: "bad-key"}`; JS object keys are always strings, so the port uses
  a symbol key, the JS value that is not a JSON object key.
- `test_foreign_owner_refused` patched `Path.lstat`; the port spies on `fs.lstatSync` the same way.
- `test_invalid_timeout` keeps `1e30` as the value above the maximum; the maximum is the `setTimeout` limit (D12).

## test_sites.py -> sites.ts (48 of 49 cases)

test_sites.py::test_registrable_domain -> tests/server/foundation/sites.test.ts::maps %s to its registrable domain
test_sites.py::test_wildcard_and_exception_rules -> tests/server/foundation/sites.test.ts::applies wildcard and exception rules to %s
test_sites.py::test_idn_hosts_use_punycode -> tests/server/foundation/sites.test.ts::uses punycode for the IDN host %s
test_sites.py::test_idna_2003_limitation_maps_sharp_s -> tests/server/foundation/sites.test.ts::keeps the IDNA 2003 mapping of sharp s
test_sites.py::test_ip_literals_and_localhost_map_to_the_host -> tests/server/foundation/sites.test.ts::maps the IP literal or localhost %s to the host
test_sites.py::test_case_trailing_dot_and_port_are_ignored -> tests/server/foundation/sites.test.ts::ignores case, a trailing dot and the port in %s
test_sites.py::test_invalid_hosts_are_refused -> tests/server/foundation/sites.test.ts::refuses invalid host #$index
test_sites.py::test_valid_site_accepts_only_canonical_keys -> tests/server/foundation/sites.test.ts::accepts only canonical keys as valid sites
test_sites.py::test_vendored_list_matches_its_pin -> tests/server/foundation/sites.test.ts::vendors a list that matches its pin
test_sites.py::test_tampered_list_is_refused -> tests/server/foundation/sites.test.ts::refuses a tampered or missing list
test_sites.py::test_import_checks_the_hash -> tests/server/foundation/sites.test.ts::checks the hash when the list first loads (D14)
test_sites.py::test_standard_library_only -> tests/server/foundation/sites.test.ts::depends on Node built-ins only

Adaptations:
- `test_import_checks_the_hash` ran `import sites` in a subprocess over a tampered copy. The list now loads on
  first use (D14), so the port points the loader at a tampered copy and checks that the first lookup fails
  with the same gate, and that a failed load is retried instead of cached.
- `test_standard_library_only` ran under two interpreters (2 cases). Its intent is that site code needs no
  third-party packages; the port walks `sites.ts` imports and requires Node built-ins only (1 case).
- The Python site cases keep their Public Suffix List shape with synthetic names: `example.global` under an ICANN
  suffix and `deploy-preview-1704--example.netlify.app` under a private suffix. They test lookups, not the
  retired unshared-site default (C5).

## Foundation tests without a Python counterpart

These cover the design's foundation assertions (sections 3.1, 4.4, 4.6, 4.8 and 4.9):

- tests/server/foundation/python-corpus.test.ts: CPython and Pillow golden corpora (Unicode, IDNA 2003,
  urlsplit, ipaddress, sites, json.dumps and json.loads, pydantic text, JPEG verdicts, b64decode).
- tests/server/foundation/registry-files.test.ts: dir_fd-style registry files and SQLite locks, including
  cross-process conflicts, SIGKILL release, a 20-process race and no leftover journal files.
- tests/server/foundation/captures.test.ts: native_captures.py behavior (the capture cases in
  test_native_server.py stay with the server slice).
- tests/server/foundation/config.test.ts: state paths, C1 cua-driver resolution, C5 unshared sites, C7 session
  fallback and D9, stable host and extension copies, the Q1 extension key and ID, and the D19 host variable.
- tests/server/foundation/runtime.test.ts and entry.test.ts: shutdown, busy flag, mutex, Python rounding, and
  the stdio server's EOF, close, SIGTERM and backstop paths.
