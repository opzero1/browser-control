# Packaging parity

The packaging slice owns `src/server/cli.ts` and `src/server/commands/*`: `browser-control install`, `doctor`
(with `--smoke`) and `config`. The Python server has no counterpart for these commands, so this slice maps no
Python test. Python's setup steps were manual (`xcrun swiftc ... -o .clipboard-guard`, the op-chrome install
script, hand-written `opencode.jsonc` entries), and the tests that cover provisioning, the legacy wrappers and
`migrate` belong to the pool slice (`test_browser_start.py`, `test_controller_factory.py`). Mapping them here
too would list them twice, which `scripts/check-parity.mjs` refuses.

Python tests mapped by this slice: 0.

## Packaging tests without a Python counterpart

- tests/server/packaging/install.test.ts: the stable host copy and user wrapper (C2, C3), the user Chrome
  manifest with the store and isolated origins (Q1), the refusal to replace a foreign manifest without
  `--force` and the old path in the report, dry runs that write nothing, the defaults under `HOME`, skill links
  to stable copies, the clipboard-guard build and its verification (mode 0700, Mach-O, owned), cua-driver
  resolution and its install command (C1), the Chrome for Testing bundle check, the MCP snippets, and the port
  of `src/scripts/check-extension-installed.ts` compared with the built script on the same profiles.
- tests/server/packaging/doctor.test.ts: read-only checks with fixed messages before and after install, stale
  and foreign state, the user endpoint handshake against the fake host, and `--smoke` against a fake stdio
  server (`tests/server/support/child-packaging.ts`): a temporary state root, a user-route socket that does
  not exist, `FAST_CHROME_ALLOW_LOOPBACK=1`, one `act_steps` batch on the loopback fixture, release, and reap.
- tests/server/packaging/package.test.ts: `pnpm pack`, extracted to a temporary directory and run offline: the
  file list, the CLI, install writing a host copy and wrapper that exec `process.execPath` and never point into
  the package, the wrapper starting the stable host, doctor accepting it, and `mcp` serving stdio until EOF.

Every packaging test sets `HOME`, the state root and all install targets to temporary directories. Each file
replaces `os.homedir()` with a function that throws, and compares an lstat fingerprint of the real default
install paths before and after the file runs, so a test that wrote a default path fails.
