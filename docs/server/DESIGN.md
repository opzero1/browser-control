# Browser Control MCP server: TypeScript port of fast-chrome

Status: design, ready to implement. Base: `9b0fcea558505eb966f50c9df8111fa92a147b74` (Browser Control 0.2.x extension, `src/shared/page-protocol.ts`, `src/shared/rpc.ts`, `src/native-host/transport.ts`).
Reference: the fast-chrome Python server (read-only). `NATIVE.md` describes the behavior. The `test_*.py` files specify it.
Product: npm package `@op1/browser-control`, bin `browser-control`, started as `npx -y @op1/browser-control mcp`. Node is the only runtime requirement. cua-driver is installed separately.

Names that the retired "opchrome" and "op-chrome" identifiers used are updated in place for D19; see Coordinator decisions, Q3. The Coordinator decisions section at the end is authoritative where it differs from the body.

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Language style | Plain TypeScript with async/await. No Effect in `src/server/**`. The existing scripts keep Effect. |
| MCP SDK | `@modelcontextprotocol/sdk` 1.30.x, using the low-level `Server` and `Client`. Tool JSON Schemas come verbatim from a capture of the Python server. |
| Session identity | `_meta["ai.opencode/sessionID"] \|\| _meta["sessionID"]`. When both are absent, use one `ses_<32 hex>` ID per process. |
| Concurrency | Single event loop. A tab's busy flag is set synchronously inside the lookup. Bodies are never aborted. |
| Cross-process locks | One `node:sqlite` database per lock name, with the same file names as the Python `*.lock` files. A shared lock is a read transaction; an exclusive lock is `BEGIN EXCLUSIVE`. `busy_timeout=0` plus async polling. |
| Registry storage | Unchanged JSON files (`claim.json`, `startup.json`, `tab-*.json`, `leases/lease-*.json`, `sites-seen.json`, `reap.json`), written atomically and fsynced. |
| Pillow replacement | Pure-TS JPEG marker walk ported from Pillow 12.3 `JpegImagePlugin._open`, checked against captured Pillow verdicts. |
| Subprocesses | cua-driver CLI through `execFile` (SIGKILL on timeout). cua-driver MCP through SDK `StdioClientTransport` with `stderr: "ignore"`. Clipboard guard through `spawn` with fixed-line pipes. |
| Shutdown | One `Shutdown` object, started by stdin `end`/`close` or SIGTERM. Cleanup is bounded at 2.5 s. A backstop timer forces `process.exit(0)`. |
| Node | `engines.node >= 24` (node:sqlite without a flag, JSON.parse source-text access). |
| State | `BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`. |
| Packaging | The server and a self-contained native host are bundled into `dist/server/*.js` with every JS dependency included. The npm package has no runtime `dependencies`. |

## 1. Parity contract

These must match Python exactly: the 18 tool names (`status`, `tabs`, `claim_browser`, `release_browser`, `open_tab`, `claim_tab`, `name_group`, `observe`, `wait_for`, `navigate`, `act`, `act_steps`, `upload_file`, `screenshot`, `start_recording`, `stop_recording`, `release`, `paste_1password_field`), their input schemas, result shapes, error-code strings, limits, timeouts, byte bounds, native protocol 2, page protocol 2, the privacy guards, the HTTPS policy with `FAST_CHROME_ALLOW_LOOPBACK=1`, and the shutdown ordering. The server keeps every `FAST_CHROME_*` env name. D19 renames the `opchrome-*` error codes, `OPZERO_CHROME_HOST_SOCKET`, the "op-chrome" text and the `chrome-control` skill name.

### 1.1 Intended changes (from the brief)
C1 cua-driver resolution: `CUA_DRIVER`, then `PATH`, then `~/.local/bin/cua-driver`. C2 wrappers exec `process.execPath`. C3 the package ships the extension dist, native host, PSL (sha256-pinned) and Swift source. Chrome manifests point only at stable, versioned copies under the state root. C4 one state root. C5 `FAST_CHROME_UNSHARED_SITES`, default empty (no organization's site is hardcoded any more). C6 no account-pool lease for the private transfer. C7 a fallback session ID. C8 not ported: `migrate`, `legacy_host`, the static `op-chrome-host-isolated-N` wrappers, the `FAST_CHROME_CONTROLLER_ID` fixed route (route kind `fixed`, `controller_metadata`, `fixed_owner`, `controller_operation`, `claimed_by`, `browser-controller-fixed-entry`, `browser-controller-config-mismatch`), the account pool's isolated host wrapper, and code that exists only for one organization's deployment or its test-account pool.

### 1.2 Other deviations (each is required by C1-C8 or by the platform)
- D1 Controller sockets move from `~/.opzero-chrome/<id>.sock` to `<state>/sockets/<id>.sock` (C4, test isolation). A path over 103 bytes raises the existing `browser-controller-unsafe-path`. The user-route socket variable is `BROWSER_CONTROL_HOST_SOCKET` (D19); its default is `<state>/sockets/user.sock` (`statePaths(env).userSocket`, fix round 2), so the user route follows `BROWSER_CONTROL_STATE_DIR` like every other runtime path and two state roots never share an endpoint. `install` writes that path into the user wrapper, and `dist/server/native-host.js` defaults to it when started without the variable (`native-host-socket.ts`), so this package's host never creates `~/.opzero-chrome`. Python and the standalone `host.ts` default to `~/.opzero-chrome/default.sock`; that default remains only for the release zip's host. A long state root makes every controller socket path exceed the limit, so `claim_browser` fails closed with `browser-controller-unsafe-path`; the default root fits (follow-up F2).
- D2 User-route artifacts: `FAST_CHROME_ARTIFACT_ROOT` when set, with Python's existing-and-private checks. Otherwise `<state>/artifacts/user`, created 0700 on demand. Python raised `fast-chrome-private-artifact-root-required` when the variable was unset.
- D3 `FAST_CHROME_NODE` is removed (C2). The Python checks (absolute, regular file, executable) now apply to `process.execPath` and still raise `browser-controller-node-unavailable`.
- D4 Isolated profiles load the extension from `<state>/extensions/<version>-<digest12>/`, not from the npx cache. The extension ID and `allowed_origins` depend on Q1 (section 10).
- D5 `provision` accepts only the generated wrapper path. Its `host_manifest` result is `created` or `generated`, because `legacy` and `migrated` came from the C8 code.
- D6 The `server` field in metadata and receipts is `"browser-control"` for every controller. `serverInfo.name` is also `"browser-control"`. Python used `fast-chrome-isolated-N` for the retired numbered entries and `fast-chrome` elsewhere. Both values come from one constant `SERVER_NAME`.
- D7 `paste_1password_field` keeps `lease_id` in its schema. A non-null value raises `fast-chrome-pool-account-mismatch`, which is Python's behavior for emails outside the pool. The sentence "Pool accounts require their owned lease_id." is removed from the tool description. `fast-chrome-pool-lease-required` and `fast-chrome-pool-lease-unavailable` become unreachable. (Superseded by Q2.)
- D8 New error codes: `browser-controller-invalid-unshared-sites` (an entry in `FAST_CHROME_UNSHARED_SITES` that is not a valid registrable site; the server fails closed) and `browser-control-invalid-state-dir` (a relative `BROWSER_CONTROL_STATE_DIR`).
- D9 A present but non-string or empty identity still raises `fast-chrome-session-required`. Only an absent identity (`undefined` or `null` after `||`) uses the fallback.
- D10 The error text for schema validation failures approximates pydantic (`Error executing tool <name>: ...`), but the message bodies differ. What is preserved: `isError: true` and no dispatch. Gate error text is identical: `Error executing tool <name>: <code>`, as captured. The text keeps pydantic's count, location, message and `[type=...]`, and omits `input_value`, `input_type` and the help URL, so it never echoes an argument value. Accepted deviation (coordinator decision, fix round 1); `tests/server/server/mcp.test.ts` compares the kept prefix.
- D11 On `notifications/cancelled`, the TS SDK sends no response (which the MCP spec allows), while Python replied "Request cancelled". Body semantics are identical.
- D12 The upper bound on the Connection timeout is 2,147,483.647 s (the `setTimeout` limit) instead of `threading.TIMEOUT_MAX`.
- D13 In JSON text, JS prints the float `1.0` as `1` (result text and wire). `structuredContent` and parsed values are JSON-equal.
- D14 The PSL loads lazily on first use. A missing or mismatched list fails the calling tool with the same gate instead of failing at import.
- D15 The operator CLI is `browser-control pool <status|claim|ensure|release|reap|reset>` and has no `migrate`.
- D16 The clipboard-guard binary is `<state>/bin/clipboard-guard-<sha12 of swift source>`, built by `browser-control install`. The 1Password lock is `<state>/locks/onepassword.lock`.
- D17 Stdin is read the same way for pipes, sockets and TTYs.
- D18 The server supports macOS and Linux (the user route). `claim_browser` keeps Python's darwin-only `browser-controller-platform-unsupported`. Windows is unsupported.
- D19 The "opchrome" and "op-chrome" names are retired (Q3): the fifteen `opchrome-*` error codes become `browser-control-*` with the same suffix; `OPZERO_CHROME_HOST_SOCKET` becomes `BROWSER_CONTROL_HOST_SOCKET` (read by the server, exported by generated wrappers); the wrapper file `op-chrome-host` becomes `browser-control-host`; "op-chrome" becomes "Browser Control" in the MCP instructions and the `status` description; "Load chrome-control" becomes "Load browser-control" in the instructions; `status` reports `backend: "browser-control"`. Outside the server, the installable skill, host, client and scripts are renamed on `afif/browser-control-rename` (Q4). The native messaging host name `com.opzero.chrome` stays, because the published extension connects to it; the standalone host's default socket `~/.opzero-chrome/default.sock` stays in `host.ts`, but the server's user route defaults under the state root (D1).
- D20 JS number and object limits beyond D13: integers outside ±2^53 lose precision, and JS objects list integer-like keys (`"2"`, `"10"`) before other keys, where Python dicts keep insertion order. No protocol or result object uses such keys or values; Chrome Preferences are parsed losslessly into ordered Maps. A JS number cannot keep an integral float literal (`2.0`) apart from an integer. At the native-host boundary the parser records float literals and `isPyInt(container, key)` reads them, so protocolVersion `2.0`, a response id or error code such as `1.0`, a tab id `5.0`, an observed pageProtocolVersion `2.0` and a submit lifetime `90000.0` are refused as Python's `type(value) is int` refused them. Registry files (`tab-*.json` and `reap.json` pids) and cua-driver CLI output (`list_apps` pids, `list_windows` window IDs) keep the distinction the same way since fix round 2. Only the vault reader's cua-driver MCP output, which the SDK client parses with `JSON.parse`, still counts an integral float literal as an int (follow-up F3, private P6).

Approved deviations, confirmed in fix round 1 (the round-0 audit asked to revert them; the coordinator kept each). Comparisons with the captured Python output apply them through `tests/server/support/renames.ts`, so those comparisons show parity modulo these renames, not literal parity:
- The fifteen `opchrome-*` error codes are `browser-control-*`, and the server and stable host ignore `OPZERO_CHROME_HOST_SOCKET` (D19; user decision Q3, a deliberate clean break that matches the merged host rename, Q4).
- Isolated profiles load the extension as `mpodnojmjjafgogldgieimgbmfhhknbe`, not `pncpgnbanebkeopjghjleodgmphmmmcp` (D4; coordinator decision Q1). Chrome derived the old ID from the Python server's install path; an extension shipped in the package and copied under the state root cannot keep it.
- `serverInfo.name`, the `server` field of metadata and receipts, and `status.backend` are `browser-control`; the wrapper file is `browser-control-host`; the instructions say "Load browser-control" in place of "Load chrome-control" (D6, D19).
- Validation error text omits `input_value`, `input_type` and the help URL, so it never echoes an argument value (D10).

## 2. Repository layout

```
src/server/
  cli.ts                 bin entry: mcp | install | doctor | config | pool | --version   (packaging; foundation stub)
  entry.ts               runStdioServer(options)                                        (foundation)
  app.ts                 createApp(options): App  (tools, tab registry, cleanup)        (server; foundation stub)
  gate.ts  config.ts  assets.ts  stable-copy.ts  session.ts                             (foundation)
  host-connection.ts  sites.ts  captures.ts  jpeg.ts                                    (foundation)
  native-host-entry.ts  native-host-socket.ts  dist/server/native-host.js entry (D1)     (foundation)
  state-paths.ts         the state root and the user socket, free of other server modules
  fs-private.ts  lock.ts  pystr.ts  pyjson.ts  urlsplit.ts  ipaddress.ts  time.ts       (foundation)
  unicode/idna2003.ts unicode/idna2003-tables.ts unicode/casefold-table.ts             (foundation; tables generated)
  runtime/shutdown.ts  runtime/busy.ts  runtime/mutex.ts                                (foundation)
  pool/registry.ts pool/preferences.ts pool/start.ts pool/provision.ts pool/cua-cli.ts pool/operator.ts  (pool; operator.ts stub by foundation)
  private/clipboard-guard.ts private/onepassword.ts private/cua-mcp.ts private/private-input.ts         (private; clipboard-guard.ts stub by foundation)
  tools/*.ts  tabs.ts  route.ts  page.ts  args.ts  tool-definitions.ts                   (server)
  commands/install.ts commands/doctor.ts commands/config.ts                              (packaging)
data/public_suffix_list.dat        vendored PSL, sha256 257b298daca42f6d8ec964e238c2a55518e14f09d3117917ec8acee6f188503e
data/README.md                     provenance: fetched 2026-09-26, VERSION 2026-09-24_13-26-36_UTC, COMMIT a179a48c...
native/clipboard-guard/clipboard_guard.swift   verbatim copy of the reference source
tests/server/<slice>/**            vitest ports
tests/server/support/**            fake host, fake connection, temp roots, stdio harness, child builds, JPEG fixtures
tests/server/fixtures/**           capture-python.py and captured python-*.json fixtures
tests/server/parity/<slice>.md     test mapping; python-inventory.json
docs/server/DESIGN.md              this file
skills/browser-control/**          generic docs (skills slice); after Q4 also the renamed installable skill
vite.server.config.ts              server bundles (foundation)
scripts/check-parity.mjs           parity checker (foundation)
```

Reasons: `src/server` keeps the server apart from the extension and the native host. Tests follow `tests/<area>`. `data/` and `native/` hold non-TS assets that ship in the package. Generated Unicode tables are TS modules, so they get bundled and need no runtime file I/O.

### 2.1 Build
- The existing `vite.node.config.ts` (target node18, shared chunks) stays **unchanged**. `build.mjs` copies `dist/native-host` into the committed installable skill (`skills/chrome-control/` at the base, `skills/browser-control/` after Q4), so any change to that output would dirty the tree that the extension-publishing thread owns.
- New `vite.server.config.ts`: target `node24`, CJS, `ssr.noExternal: true` (bundles the MCP SDK, zod, ajv and cross-spawn), externals `/^node:/`, no code splitting. It builds one entry per run, selected by env `BROWSER_CONTROL_SERVER_ENTRY` (the same pattern as the extension build):
  - `cli` gives `dist/server/cli.js`, with `#!/usr/bin/env node` banner and chmod 755.
  - `native-host` gives `dist/server/native-host.js`, a self-contained bundle of `src/server/native-host-entry.ts`. It first sets `BROWSER_CONTROL_HOST_SOCKET` to `<state>/sockets/user.sock` when it is unset (`native-host-socket.ts`, D1), then loads `src/native-host/host.ts` unchanged. This is the file `ensureStableHost` copies.
- `build.mjs` adds the two `vite build --config vite.server.config.ts` runs after the node build, then chmods `cli.js`.
- `tsconfig.json` already includes `src/**/*.ts` and `vite*.config.ts`. Tests stay outside `tsc`, as today.
- `vitest.config.ts` adds `globalSetup: ["tests/server/support/global-setup.ts"]`, which bundles `tests/server/support/child-*.ts` into a temp dir (see section 7).
- `pnpm run check` becomes `build && typecheck && test && node scripts/check-project.js && node scripts/check-parity.mjs --complete`.
- `check-project.js` adds these checks: `dist/server/cli.js` exists with a shebang and exec bit, `dist/server/native-host.js` exists, `data/public_suffix_list.dat` matches its sha256, the Swift source exists, `docs/server/DESIGN.md` exists, and package.json has `bin` and `files`.
- `check-parity.mjs` checks every present `tests/server/parity/*.md`. `--complete`, which `pnpm run check` passes since fix round 1, requires every inventory entry. "not ported" is accepted only for the approved removals the script lists (migrate and `legacy_host`, the fixed route, and the account pool's lease), and the reason must cite C8 or C6. A title declared with `.skip` or `.todo`, or in a file that uses `describe.skip`, `describe.todo` or `.only`, does not count. A parametrized Python test must map to an `it.each` test, except the three listed in `CASES_IN_ONE_TEST`: two iterate the Python case table inside one test, and `test_standard_library_only` is the approved merge of its two interpreter cases.
- CI (`.github/workflows/check.yml`) runs Node 24. Foundation makes that one-line change.

### 2.2 package.json (set up by foundation)
`name: "@op1/browser-control"`, `bin: {"browser-control": "dist/server/cli.js"}`, `engines: {"node": ">=24"}`, `publishConfig: {"access": "public"}`. The version is left to the publishing thread. `effect` and `@effect/platform-node` move to devDependencies, because the bundles include them. `@modelcontextprotocol/sdk@~1.30.1` and `zod@^4` are added as devDependencies. Runtime `dependencies` is `{}`. `files`: `["dist/server/", "dist/extension/", "data/public_suffix_list.dat", "data/README.md", "native/clipboard-guard/", "skills/browser-control/", "README.md", "docs/PRIVACY.md"]`. Reason for bundling: a cold `npx -y` fetches a single tarball, and the packaging test can run the packed tarball offline.

## 3. Module map and public interfaces

| Python | TypeScript | Slice |
|---|---|---|
| opchrome.py | gate.ts, host-connection.ts, runtime/mutex.ts | foundation |
| sites.py | sites.ts, urlsplit.ts, ipaddress.ts, unicode/* | foundation |
| native_captures.py | captures.ts, jpeg.ts, runtime/busy.ts | foundation |
| (new) | config.ts, assets.ts, stable-copy.ts, session.ts, fs-private.ts, lock.ts, pystr.ts, pyjson.ts, time.ts, runtime/shutdown.ts, entry.ts | foundation |
| browser_pool.py | pool/registry.ts, pool/operator.ts | pool |
| browser_preferences.py | pool/preferences.ts | pool |
| browser_start.py | pool/start.ts, pool/provision.ts, pool/cua-cli.ts | pool |
| clipboard_guard.py/.swift | private/clipboard-guard.ts, native/clipboard-guard/clipboard_guard.swift | private |
| onepassword.py | private/onepassword.ts, private/cua-mcp.ts | private |
| private_input.py | private/private-input.ts | private |
| native_server.py | app.ts, tabs.ts, route.ts, page.ts, args.ts, tool-definitions.ts, tools/*.ts | server |
| (new) | cli.ts, commands/* | packaging |

Port rule: port each Python function in the same order, keeping the name in camelCase. Each module keeps Python's ordering of checks, sends and gates.

### 3.1 Foundation interfaces

```ts
// gate.ts
export class Gate extends Error { readonly code: string; constructor(code: string); }   // message === code
export function isGate(error: unknown, code?: string): error is Gate;

// time.ts
export function monotonic(): number;                       // seconds, performance.now()/1000
export function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export function pyRound(value: number, digits?: number): number;   // Python round(): half-to-even
export function utcStamp(): string;                         // %Y-%m-%dT%H:%M:%SZ

// pystr.ts  (Python str semantics; Python len() counts code points)
export function pyLen(s: string): number;  export function pySlice(s: string, end: number): string;
export function utf16Len(s: string): number;
export function pyStrip(s: string): string; export function pyIsSpace(ch: string): boolean;
export function pyIsAlnum(ch: string): boolean; export function casefold(s: string): string;

// pyjson.ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };
export function parseStrictJson(text: string): JsonValue;          // duplicate keys throw (Python _object hook)
export function parseLosslessJson(text: string): JsonValue;        // keeps number source text (Preferences)
export function pyDumps(value: unknown, options?: { separators?: [string, string]; indent?: number; ensureAscii?: boolean; allowNan?: boolean }): string;

// urlsplit.ts / ipaddress.ts: ported from the reference venv's CPython urllib.parse and ipaddress
export interface SplitResult { scheme: string; netloc: string; path: string; query: string; fragment: string;
  readonly username: string | null; readonly password: string | null; readonly hostname: string | null; readonly port: number | null /* throws RangeError like ValueError */ }
export function urlsplit(url: string): SplitResult;
export function ipAddressString(value: string): string | null;     // str(ipaddress.ip_address(v)) or null
export function idnaEncode(host: string): string;                  // str.encode("idna") (IDNA 2003); throws on error

// fs-private.ts: Python's dir_fd model as verified path handles; sync I/O
export interface PrivateDir { readonly path: string; readonly dev: number; readonly ino: number }
export class FsError extends Error { readonly errno: string }      // what the fixedErrors wrapper maps
export function openDirectory(path: string): PrivateDir;           // mkdir 0700 per component, refuse symlinks, check owner/mode
export function existingDirectory(path: string): PrivateDir | null;
export function childDirectory(dir: PrivateDir, name: string): PrivateDir;
export function checkFileStats(stats: import("node:fs").Stats): void; // regular, uid, mode&077==0, nlink==1, else unsafe-registry
export function readJson(dir: PrivateDir, name: string, limit?: number): JsonValue | null;  // default 32768
export function writeJson(dir: PrivateDir, name: string, value: unknown): void;           // .write-<uuid>, fsync, rename, fsync dir
export function removeFile(dir: PrivateDir, name: string): void;
export function readPrivate(dir: PrivateDir, name: string, limit?: number, code?: string): Buffer | null;
export function writePrivate(dir: PrivateDir, name: string, data: Uint8Array, mode: number, prefix?: string): void;
export function fixedErrors<T>(body: () => T, code?: string): T;   // FsError|TypeError|SyntaxError -> Gate(code ?? "browser-controller-invalid-registry")
export function fixedErrorsAsync<T>(body: () => Promise<T>, code?: string): Promise<T>;

// lock.ts
export interface HeldLock { readonly name: string; release(): void }
export function lockNow(dir: PrivateDir, name: string, exclusive: boolean): HeldLock;          // busy -> Gate("browser-controller-pinned")
export function lockWait(dir: PrivateDir, name: string, exclusive: boolean): Promise<HeldLock>; // Python blocking flock
export function lockUntil(dir: PrivateDir, name: string, deadline: number, code?: string): Promise<HeldLock>; // default browser-controller-startup-timeout

// runtime/busy.ts and runtime/mutex.ts
export class BusyFlag { tryAcquire(): boolean; release(): void; acquireBy(deadline: number): Promise<boolean>; get busy(): boolean }
export class AsyncMutex { acquire(timeoutMs: number): Promise<(() => void) | null> }   // FIFO

// runtime/shutdown.ts
export const SHUTDOWN_SECONDS = 2.5;
export class Shutdown { get isSet(): boolean; get deadline(): number | null; begin(): void; refuseInput(): void; /* Gate fast-chrome-shutting-down */
  wait(ms: number): Promise<void>; /* resolves early on begin, like Event.wait */ onBegin(listener: () => void): () => void }

// session.ts
export const SESSION_META_KEYS: readonly ["ai.opencode/sessionID", "sessionID"];
export function processSessionId(): string;          // "ses_" + 32 lowercase hex, created lazily once per process
export function sessionFromMeta(meta: unknown): string;

// config.ts
export type Env = Readonly<Record<string, string | undefined>>;
export const PACKAGE_NAME = "@op1/browser-control", BIN_NAME = "browser-control", SERVER_NAME = "browser-control";
export const NATIVE_HOST_NAME = "com.opzero.chrome", STORE_EXTENSION_ID = "dcnjjnecbhipdbngkhjppkckpkellmld";
export interface StatePaths { root: string; registry: string; controllers: string; sockets: string; hosts: string; extensions: string; artifacts: string; userArtifacts: string; locks: string; bin: string }
export function statePaths(env?: Env): StatePaths;   // root/pool/registry, root/pool/controllers, root/sockets, root/hosts, root/extensions, root/artifacts, root/artifacts/user, root/locks, root/bin
export function userSocket(env?: Env): string;
export function userArtifactRoot(env?: Env): { root: string; explicit: boolean };
export function allowLoopback(env?: Env): boolean;   // === "1"
export function unsharedSites(env?: Env): ReadonlySet<string>;
export function envLimit(name: string, fallback: number, cap: number, env?: Env): number;   // regex -?\d{1,4}, clamp 1..cap
export function whichExecutable(name: string, env?: Env): string | null;  // absolute PATH entries only
export function resolveCuaDriver(env?: Env): string | null;  // CUA_DRIVER (absolute, regular, executable; else null, no fallback) -> PATH -> ~/.local/bin/cua-driver
export function nodeExecutable(): string;            // process.execPath checked; Gate browser-controller-node-unavailable

// assets.ts
export interface PackageAssets { root: string; extensionDir: string; nativeHost: string; publicSuffixList: string; clipboardGuardSource: string; version: string }
export function packageAssets(): PackageAssets;      // from __dirname: dist/server -> ../..; src/server -> ../.. in tests

// stable-copy.ts
export interface StableHost { dir: string; hostScript: string; version: string; digest: string }
export function ensureStableHost(env?: Env, assets?: PackageAssets): Promise<StableHost>;   // <hosts>/<version>-<sha12>/native-host.js; tmp dir, fsync, rename; idempotent; verifies the digest
export function publishTree(parent: PrivateDir, name: string, files: ReadonlyMap<string, Uint8Array>): Promise<string>;   // under <parent>/.publish.lock: recheck, stage, move a damaged copy aside, rename; never touches a valid copy
export interface StableExtension { dir: string; id: string; origin: string }
export function ensureStableExtension(env?: Env, assets?: PackageAssets): Promise<StableExtension>;  // <extensions>/<version>-<sha12>/ (see Q1)
export function unpackedExtensionId(absolutePath: string): string;   // Chrome rule; same as store/capture/extension-id.py
export function hostWrapper(socket: string, hostScript: string, node: string): string;  // Python host_wrapper text; Gate browser-controller-unsafe-path
export function clipboardGuardBinary(env?: Env, assets?: PackageAssets): string;         // <bin>/clipboard-guard-<sha12(source)>

// host-connection.ts
export const REQUEST_LIMIT = 1048576, RESPONSE_LIMIT = 67108864, DEFAULT_TIMEOUT_SECONDS = 35;
export type HostMethod = "host.info" | "getInfo" | "getTabs" | "getUserTabs" | "createTab" | "claimUserTab" | "attach" | "bindPage" | "navigatePage" | "observePage" | "actPage" | "uploadFile" | "capturePage" | "recordingState" | "finalizeTabs" | "nameSession" | "observeDocument" | "privateFill" | "preparePrivateSubmit" | "submitPrivate";
export const METHODS: ReadonlySet<string>; export const AUTHORITY_KEYS: ReadonlySet<string>;
export interface HostConnection { readonly alive: boolean; call(method: string, params?: JsonObject | null): Promise<unknown>; close(): void }
export class Connection implements HostConnection { static open(socketPath: string, timeoutSeconds?: number): Promise<Connection>; }
export type Connect = (socketPath: string, timeoutSeconds?: number) => Promise<HostConnection>;

// sites.ts
export const PSL_SHA256 = "257b298daca42f6d8ec964e238c2a55518e14f09d3117917ec8acee6f188503e";
export interface SuffixRules { rules: ReadonlySet<string>; wildcards: ReadonlySet<string>; exceptions: ReadonlySet<string> }
export function loadPublicSuffixList(file?: string, expected?: string): SuffixRules;
export function ipLiteral(value: string): string | null; export function asciiHost(value: unknown): string;
export function cookieSite(value: unknown): string; export function validSite(value: unknown): boolean;

// captures.ts / jpeg.ts
export interface CaptureTab { call(method: "capturePage" | "recordingState", params?: JsonObject): Promise<unknown>; readonly operation: BusyFlag }
export function inspectJpeg(data: Uint8Array): { width: number; height: number } | null;
export function strictBase64(text: unknown): Buffer | null;   // b64decode(validate=True)
export function captureDirectory(root: string): string;       // mkdtemp chrome-capture-*; Gate fast-chrome-private-artifact-root-required
export function jpeg(tab: CaptureTab): Promise<Buffer>;       // Gate fast-chrome-invalid-image
export function saveExclusive(file: string, data: Uint8Array): void;   // O_EXCL, fchmod 0600
export interface RecordingReceipt { path: string | null; directory: string; seconds: number; frames: { file: string; seconds: number; sha256: string }[]; sample_fps: number; error: string | null; kind: "timestamped-jpeg-sampled-video"; decode_verified: boolean; playback_verified: false }
export interface RecordingDeps { ffmpeg: () => string | null; run: (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<void> }
export class Recording { static start(tab: CaptureTab, fps: unknown, maxSeconds: unknown, root: string, deps?: RecordingDeps): Promise<Recording>; readonly directory: string; stop(options?: { encode?: boolean }): Promise<RecordingReceipt> }

// entry.ts
export interface StdioServerOptions { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; env?: Env; shutdownSeconds?: number; installSignalHandlers?: boolean; exit?: (code: number) => void; app?: (options: AppOptions) => App }
export function runStdioServer(options?: StdioServerOptions): Promise<number>;

// app.ts: the contract; foundation ships a stub with zero tools, the server slice owns it
export interface AppOptions { env: Env; shutdown: Shutdown; connect?: Connect; readField?: ReadField }
export interface App { readonly serverInfo: { name: string; version: string }; readonly instructions: string;
  listTools(): import("@modelcontextprotocol/sdk/types.js").Tool[];
  callTool(name: string, args: unknown, meta: unknown): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>;
  cleanup(deadline: number): Promise<void> }
export function createApp(options: AppOptions): App;
```

Connection port notes. Validate `timeoutSeconds` (finite, >0, <=2147483.647) or raise `browser-control-invalid-request`. The socket parent must be a directory owned by the uid with mode&077 == 0. The endpoint must be a socket owned by the uid with mode&077 == 0. On any failure raise `browser-control-unavailable`. Then handshake with `host.info` (protocolVersion 2, extensionProtocol `ready`) and `getInfo` (protocolVersion 2, pageProtocolVersion 2), or raise `browser-control-protocol-mismatch`. For each call, the deadline covers the lock wait, send and read. A lock timeout closes the connection and raises `browser-control-outcome-unknown`. The request is encoded with `pyDumps` (ensure_ascii, compact separators) and must be at most `REQUEST_LIMIT` bytes. Received bytes are counted from the leftover buffer and capped at `RESPONSE_LIMIT`. Decode with a fatal UTF-8 decoder and `parseStrictJson`. Keep the exact notification, id and error rules and the message-to-gate table from opchrome.py. Transport or parse errors close the connection and raise `browser-control-outcome-unknown`.

### 3.2 Pool interfaces
```ts
export const CONTROLLERS: readonly ["isolated-1", "isolated-2", "isolated-3"]; export const HARD_CAP = 8, MAX_LEASE_SITES = 16, MAX_SEEN_SITES = 256;
export interface PoolContext { registry: string; controllers: string; sockets: string; env: Env }
export function poolContext(env?: Env): PoolContext;
export interface ControllerMetadata { controller_id: string; server: string; socket: string; profile: string; downloads: string; artifacts: string; host: string }
export function metadata(controller: unknown, ctx?: PoolContext): ControllerMetadata;
export function controllerNumber(controller: unknown): number;
export function maxControllers(env?: Env): number; export function maxTenants(env?: Env): number;
export function validOwner(owner: unknown): asserts owner is string;
export function validUuid(value: unknown): boolean;
export function siteKey(site: unknown): string | null;
export type LeaseMode = "shared" | "exclusive"; export type SiteState = "fresh" | "previously-used";
export interface Lease { owner: string; lease_id: string; mode: LeaseMode; sites: string[]; created: string | null }
export interface Grant extends ControllerMetadata { owner: string; lease_id: string; mode: LeaseMode; sites: string[]; site_state: SiteState | null }
export interface LeaseRoute extends ControllerMetadata { owner: string; lease_id: string; mode: LeaseMode; sites: string[] }  // artifacts = <artifacts>/<lease_id>
export function claim(owner: string, options?: { site?: string | null; exclusive?: boolean; controller?: string | null; ctx?: PoolContext }): Promise<Grant>;
export function leaseFor(owner: string, ctx?: PoolContext): Promise<LeaseRoute | null>;
export function release(owner: string, leaseId: unknown, ctx?: PoolContext): Promise<{ controller_id: string; released: true; controller_idle: boolean }>;
export function operate(command: "status" | "claim" | "release", args?: { controller?: string | null; owner?: string; lease?: string; ctx?: PoolContext }): Promise<unknown>;
export function markers(dir: PrivateDir): { owner: string; lease_id: string; pid: number }[];
export function locked<T>(controller: string, ctx: PoolContext, exclusive: boolean, body: (dir: PrivateDir) => T | Promise<T>): Promise<T>;
export class Pin { static open(controller: string, owner: string, leaseId?: string | null, ctx?: PoolContext): Promise<Pin>;
  readonly controller: string; readonly leaseId: string; readonly mode: LeaseMode; readonly directory: PrivateDir;
  beginTab(site?: string | null): Promise<{ site: string; site_state: SiteState } | null>; confirmed(): void; close(): void }
export function endpointState(info: ControllerMetadata): Promise<"absent" | "stale" | "live">;
export function clearStaleEndpoint(info: ControllerMetadata): Promise<"absent" | "removed" | "live">;
export interface ReapHost { processes(info: ControllerMetadata): Promise<number[]>; userTabs(info: ControllerMetadata): Promise<unknown[] | null>; terminate(pid: number): void; alive(pid: number): boolean }
export function reap(controller?: string | null, options?: { dryRun?: boolean; ctx?: PoolContext; host?: ReapHost; waitSeconds?: number }): Promise<unknown>;
export function reset(controller: string, options: { confirm: boolean; ctx?: PoolContext; host?: ReapHost }): Promise<unknown>;
// preferences.ts
export function disablePasswordSaving(profile: string, options: { running: boolean }): { password_saving_disabled: true; preferences_changed: boolean };
export function applyPreferences(profile: string, downloads: string, options: { running: boolean }): { password_saving_disabled: true; downloads_configured: true; preferences_changed: boolean };
// start.ts / provision.ts / cua-cli.ts
export const BUNDLE = "com.google.chrome.for.testing", MANIFEST = "com.opzero.chrome.json";
export function hasProfile(command: string, profile: string): boolean;
export function launchArguments(info: ControllerMetadata, extensionDir: string): JsonObject;
export function provision(info: ControllerMetadata, deps: { host: StableHost; extension: StableExtension; node: string }): { host_manifest: "created" | "generated" };
export interface StartRuntime { provision(info: Grant): unknown; prepare(info: Grant): void; processes(info: Grant): Promise<number[]>; probe(info: Grant): Promise<boolean>; launch(info: Grant): Promise<unknown>; configure(info: Grant, o: { running: boolean }): Record<string, boolean>; windows(pid: number): Promise<{ pid: number; window_id: number; bounds: unknown }[]> }
export function cuaCli(cua: string, name: string, args: JsonObject, timeoutMs: number): Promise<Record<string, unknown>>;  // cua-unavailable / cua-refused
export function ensure(controller: string | null, owner: string, options?: { timeout?: unknown; site?: string | null; exclusive?: boolean; ctx?: PoolContext; runtime?: StartRuntime }): Promise<Record<string, unknown>>;
// operator.ts (foundation stub; pool owns it)
export function runPoolCommand(argv: readonly string[], io?: { stdout: NodeJS.WritableStream; env?: Env }): Promise<number>;
```
Unshared rule: `add_site` and `joinable` read `unsharedSites(ctx.env)` in place of `UNSHARED_SITES`. The ported tests set `FAST_CHROME_UNSHARED_SITES=example.global` so they keep their intent.

### 3.3 Private interfaces
```ts
// clipboard-guard.ts
export const START_SECONDS = 3, RESTORE_SECONDS = 3;
export class ClipboardError extends Error { readonly code: "clipboard-unavailable" | "clipboard-restore-failed" }
export function withPreservedClipboard<T>(body: () => Promise<T>, options?: { binary?: string; signal?: AbortSignal }): Promise<T>;
export function buildClipboardGuard(env?: Env, assets?: PackageAssets): Promise<{ path: string; built: boolean }>;  // xcrun swiftc -O -framework AppKit, chmod 700, atomic rename
// onepassword.ts
export const ERROR_CODES: ReadonlySet<string>;
export class VaultError extends Error { readonly code: string }     // unknown codes become operation-failed
export type VaultField = "username" | "password" | "one-time password";
export interface CuaCaller { call(name: string, args: JsonObject, options?: { deadline?: number }): Promise<Record<string, unknown>> }
export interface VaultDeps { openCua(deadline: number, signal: AbortSignal): Promise<{ cua: CuaCaller; close(): Promise<void> }>; lockDir: PrivateDir; clipboard: typeof withPreservedClipboard }
export type ReadField = (email: string, field: VaultField, options?: { allow_foreground_search: true }) => Promise<string>;
export function readField(email: string, field: VaultField, options?: { allow_foreground_search?: boolean; deps?: VaultDeps }): Promise<string>;
// private-input.ts
export interface PrivateTab { readonly id: number; readonly origin: string; readonly owner: string; readonly connection: HostConnection;
  snapshot: readonly [string, string] | null; page: { actions: readonly { id: string; kind: string }[] } | null; recording: unknown | null;
  privateAttempts: Set<string>; privateIdentity: readonly [string, string] | null; call(method: string, params?: JsonObject): Promise<unknown> }
export interface PasteRequest { expectedUrl: string; email: unknown; field: unknown; selector: unknown; usernameSelector: unknown; snapshotId: unknown; submitActionId: unknown; leaseId: unknown }
export function paste(tab: PrivateTab, request: PasteRequest, source: (email: string, field: VaultField) => Promise<string>, refuseInput: () => void, env?: Env): Promise<Record<string, unknown>>;
```
`account_claim` reduces to `if (leaseId != null) throw new Gate("fast-chrome-pool-account-mismatch")`. The private-attempt key is `documentId + "\u0000" + field`. `value` is overwritten in `finally`, but JS strings are immutable, so the guarantee is only that the value is never returned, logged, or placed in an error.

### 3.4 Server (native_server.py)
`app.ts` builds a per-instance `ServerState`: a `TabRegistry` (a Map keyed by handle) with synchronous `hold(tabId, session, claimable)`, `register(tab)` and `drain()`, plus the `Shutdown` and the deps (`connect`, `readField`, pool, captures). There are no module globals, so each test creates a fresh app, replacing Python's monkeypatched `TABS`. The `Tab` class holds Python's fields plus `operation: BusyFlag`. `tab.call` refuses `INPUT_METHODS` after shutdown. `Route` has kinds `"lease" | "user"` only. Tool bodies are ported function by function: `snapshot`, `observeAfter`, `finalize`, `waitForTab` (using `shutdown.wait`), `actOnce`, `finalPage`, `stepAction`, `validatedPdf`, `failedSetup`, `beginRouteTab`, `claimRouteTab`, `releaseAll`. `tool-definitions.ts` is the captured `tools/list` output, with the D7 and D19 description edits. `args.ts` reproduces the FastMCP argument pipeline: pre-parse JSON for non-str params, lax pydantic coercion for lax fields (bool strings and ints, numeric strings to int), strict rules for `Field(strict=True)` fields and for the `Step` and `PageExpectation` models (extra forbidden), constraints, the `PageExpectation` validator (which raises a Gate inside validation), and defaults. All of this is checked against the captured argument table.

Result envelope, as captured from Python. A dict result becomes `content: [{type: "text", text: pyDumps(result, {indent: 2})}]`, plus `structuredContent` if the capture shows one. A Gate becomes `{isError: true, content: [{type: "text", text: "Error executing tool <name>: <code>"}]}`. `screenshot` returns `[image(jpeg base64), text("Saved screenshot: <path>")]`.

## 4. Runtime choices

### 4.1 MCP SDK
Use `@modelcontextprotocol/sdk` 1.30.x (the reference pins Python mcp 1.30.0). Use the low-level `Server` (`@modelcontextprotocol/sdk/server/index.js`) with `StdioServerTransport`. Register handlers with `setRequestHandler(ListToolsRequestSchema, …)` and `setRequestHandler(CallToolRequestSchema, async (request, extra) => app.callTool(request.params.name, request.params.arguments, request.params._meta))`. `_meta` passes through the SDK schema, and the same object is available as `extra._meta`. The high-level `McpServer.registerTool` is not used, because generating schemas from zod cannot match the pydantic schemas byte for byte. The server declares only the capability `{tools: {listChanged: false}}` and sets `instructions` verbatim. The private vault uses `Client` plus `StdioClientTransport({command: cua, args: ["mcp"], stderr: "ignore"})` and `callTool(params, undefined, {timeout, signal})`. The call requires `!isError` and an object `structuredContent`; anything else raises `transport-unavailable`.

### 4.2 Plain TypeScript, not Effect
The reference is imperative code with exact ordering (refuse input just before a send, a pin before a marker, and so on). Effect fiber interruption conflicts with "a running body is never aborted". A 1:1 port keeps the ported tests readable. `host.ts` itself is plain Node. Effect stays in `src/scripts`.

### 4.3 Concurrency
- Every tool body is an async function on one event loop. A long wait awaits a timer or socket, so tabs stay independent.
- `hold()` is synchronous: lookup, owner check, terminal check and `operation.tryAcquire()` happen with no `await` in between. Run-to-completion makes this one atomic step, and it returns the exact `Tab` object. `managed()` reads the tab that the wrapper passed in. There is no second lookup (this replaces the `HELD` ContextVar).
- A new tab is created with its flag held (`bound_tab`) before `register()` publishes it, and its setup releases the flag in `finally`.
- Cancellation: the handler ignores `extra.signal`, the body runs to completion, and the tab stays busy until then. Python's shielded `threaded` wrapper had the same effect.
- Registry, fs and SQLite calls are synchronous and microsecond-scale. The only awaits inside critical sections are lock acquisition, which polls without blocking.
- The recording sampler is an async loop that uses `operation.tryAcquire()` and skips busy intervals.
- `Connection` serializes its calls with `AsyncMutex`, which mirrors `_lock.acquire(timeout)`.

### 4.4 Crash-safe cross-process lock (replaces fcntl.flock)
- Each Python lock file (`allocation.lock`, `registry.lock`, `lease.lock`, `startup.lock`, `leases/lease-<id>.lock`, and the 1Password lock) becomes a zero-byte SQLite database with the same name. Pre-create it with `fs.openSync(O_RDWR|O_CREAT|O_NOFOLLOW, 0o600)`. Run `check_file` (regular, uid, mode&077 == 0, nlink == 1) and record dev and ino. Open `new DatabaseSync(path)` with `PRAGMA busy_timeout=0`. Re-lstat afterwards, and raise `browser-controller-unsafe-registry` if dev or ino differ.
- Shared lock: `BEGIN DEFERRED; SELECT count(*) FROM sqlite_schema;` holds SQLITE SHARED. Exclusive lock: `BEGIN EXCLUSIVE`. Release: `ROLLBACK` and `close()`. The databases are never written, so no journal is left behind.
- `SQLITE_BUSY` maps to `browser-controller-pinned` in `lockNow`. `lockWait` polls every 10 ms. `lockUntil` polls every 50 ms until the deadline. The 1Password lock polls every 50 ms and raises `vault-busy`.
- Crash safety: POSIX advisory locks are released when the process exits, including on SIGKILL. Markers are separate JSON files and survive a crash, as the reference requires.
- Two connections in one process conflict correctly, because SQLite's unix VFS tracks locks per inode. So an in-process Pin blocks an in-process release, as the Python tests expect.
- Nothing ever waits synchronously on a lock, because that would block stdin, SIGTERM and other tabs.
- If node:sqlite prints an `ExperimentalWarning`, `lock.ts` filters that one warning, so stderr stays clean.
- Rejected alternatives: mkdir/pidfile locks (not crash-safe without stale detection), native flock addons (break the "Node only" requirement), a lock daemon (a second process). The installers' shared lock is the one exception; see Installer race round.

### 4.5 Registry storage
Keep the JSON files and their key sets unchanged. They can be inspected by hand, the tests pin their formats, and crash-retained markers are plain files. Writes use `pyDumps` with Python's default separators and ensure_ascii. Only the locks move to SQLite.

### 4.6 Pillow replacement
`inspectJpeg` ports Pillow 12.3 `JpegImagePlugin` from the reference venv (read-only): accept only a `FF D8 FF` prefix, walk the known MARKER table with the same fill-byte handling, parse SOF (layers 1, 3 or 4, else invalid), and stop at SOS. A missing SOF is invalid. `jpeg()` then requires `strictBase64` to succeed, at most 24 MiB, a JPEG, and width × height ≤ 25,000,000. Otherwise it raises `fast-chrome-invalid-image`. Pillow's JPEG `verify()` is a no-op, so the marker walk is the whole check. A captured table of Pillow verdicts pins the behavior. Recording still uses `ffmpeg` from PATH (optional: without it, `fast-chrome-ffmpeg-required`).

### 4.7 Subprocesses
- cua-driver CLI (browser_start): `execFile(cua, [name, JSON.stringify(args)], {timeout: remainingMs, killSignal: "SIGKILL", maxBuffer: 16 MiB})`. Spawn failure, non-zero exit, timeout or bad JSON raises `browser-controller-cua-unavailable`. An `error` key or `effect: "refused"` raises `browser-controller-cua-refused`. When no cua-driver resolves, `prepare` raises `browser-controller-startup-not-installed`.
- `/bin/ps` (`-ww -p <pid> -o command=` and `-ww -axo pid=,command=`) uses the same timeouts and gates as Python.
- cua-driver MCP (vault): opened per read, closed in `finally`, stderr ignored, default SDK env. Aborting the 60 s deadline cancels the in-flight `callTool` through its signal. `withDeadline` aborts, waits for the body to settle (the clipboard is restored first), then raises `deadline-exceeded`.
- Clipboard guard: before spawning, check the binary is a regular file owned by the uid, `mode & 022 == 0`, and executable. Spawn with `stdio: ["pipe", "pipe", "ignore"]`. Require the first line within 3 s, capped at 64 bytes, to be exactly `ready\n`. Restore by writing `restore\n` and ending stdin, then require `restored\n` and exit code 0 within 3 s. On failure, kill with SIGKILL and raise `clipboard-restore-failed`. `withPreservedClipboard` always awaits the restore before it rethrows or resolves (the equivalent of `_shield_to_completion`). An abort during start finishes the start, restores, then throws.

### 4.8 Bounded shutdown
`runStdioServer` wires `stdin.on("end" | "close")` and `process.on("SIGTERM")` to one `begin()`. The first signal sets `deadline = monotonic() + 2.5`. The sequence after that:
1. New `tools/call` requests get `fast-chrome-shutting-down`.
2. Stop reading stdin.
3. `await app.cleanup(deadline)`. This is `releaseAll`: drain the registry, then for each tab in parallel `operation.acquireBy(deadline)`, stop any recording without encoding, and `finalize(keep_open=!created, deadline)`.
4. At the deadline, close every connection.
5. Allow 0.2 s of grace, then close the pins of settled tabs.
6. Flush stdout, then `exit(0)`.

The stdin and SIGTERM listeners stay registered until exit, so the parent's SIGTERM that follows EOF during cleanup reaches the idempotent `begin()` rather than Node's default action (fix round 1). A backstop `setTimeout(exit(0), 2.5 s + 0.3 s)` guards against stuck handles. Running bodies see `refuseInput()` or `shutdown.wait()`. Waits return `shutdown`, and `act_steps` stops with reason `shutdown`. The exit code is 0 for EOF and for SIGTERM.

### 4.9 Python-semantics helpers
These are needed for exact parity:
- Python `len` and slicing count code points (`pyLen`, `pySlice`); the group title uses UTF-16 length.
- `str.strip`, `isspace`, `isalnum` and `casefold` follow Python.
- `urlsplit` and its `hostname` and `port` properties are ported from the venv's CPython.
- `str.encode("idna")` is IDNA 2003: nameprep B.1 and B.2 tables, NFKC, prohibition and bidi checks, label length 1-63, and punycode. Its tables are generated from the venv's `stringprep`.
- `ipaddress` string forms, `uuid4().hex` (`randomUUID` without dashes), `valid_uuid` (canonical lowercase 8-4-4-4-12), and `round` half-to-even.
- `json.dumps` defaults (ensure_ascii, `", "` and `": "` separators).
- Preferences are parsed losslessly, so Chrome's integers above 2^53 survive a rewrite.

## 5. Naming and config snippets
Package `@op1/browser-control`, bin `browser-control`, state `~/.local/state/browser-control`, recommended MCP key `browser-control`, `serverInfo.name` `browser-control` (D6). These stay unchanged: all `FAST_CHROME_*` env names, the native host name `com.opzero.chrome`, every error code other than the D19 `opchrome-*` renames, and the default group title `OpenCode · <8 chars>` (a parity string; renaming it would be a new deviation). D19 renames `OPZERO_CHROME_HOST_SOCKET` to `BROWSER_CONTROL_HOST_SOCKET` and the wrapper file `op-chrome-host` to `browser-control-host`. The MCP `instructions` stay verbatim apart from the D19 text changes, so they say "Load browser-control".

```jsonc
// OpenCode opencode.jsonc
"mcp": { "browser-control": { "type": "local", "command": ["npx", "-y", "@op1/browser-control", "mcp"], "enabled": true } }
// Claude Code .mcp.json / Cursor ~/.cursor/mcp.json
{ "mcpServers": { "browser-control": { "command": "npx", "args": ["-y", "@op1/browser-control", "mcp"] } } }
```
```toml
# Codex ~/.codex/config.toml (claim_browser can take up to 120 s)
[mcp_servers.browser-control]
command = "npx"
args = ["-y", "@op1/browser-control", "mcp"]
tool_timeout_sec = 150
```
CLI:
- `browser-control mcp`: runs the stdio server.
- `browser-control install [--state-dir <dir>] [--chrome-manifest-dir <dir>] [--skills-dir <dir>]... [--dry-run] [--force] [--json]` (as built by the packaging slice; see `docs/server/INSTALL.md`): runs `ensureStableHost`, writes the user wrapper `<state>/hosts/user/browser-control-host`, and writes the user Chrome manifest (allowed origins: the Web Store ID and the isolated ID, Q1). On darwin with the Xcode tools, it builds the clipboard guard. With `--skills-dir`, it links the shipped skills to stable copies under `<state>/skills`; there is no default skills directory (C4). It then prints the snippets.
- `browser-control doctor [--smoke] [--json]` and the install directory options: read-only checks of Node ≥ 24, state root permissions, the stable host and wrapper and manifest target, the user endpoint handshake, cua-driver resolution, the Chrome for Testing bundle, the clipboard guard's trust, and ffmpeg (optional).
- `browser-control config <opencode|claude|codex|cursor>`: prints the matching snippet.
- `browser-control pool …`: the operator CLI.

`mcp` never writes the user's Chrome manifests. Only `install` does. Isolated-profile manifests are written by `provision` during `ensure`.

## 6. Constants that must match (enforced by tests)
- Connection: 35 s default, 1 MiB request, 64 MiB response, 65536-byte reads.
- Observation: snapshot ≤ 200; ≤ 100 actions; URL ≤ 8192; title ≤ 200; text ≤ 12000; id ≤ 100; label ≤ 160; role ≤ 80; ≤ 100 opaque surfaces with IDs `opaque-<i>` and kinds iframe, frame, object, embed, closed-shadow-root.
- Waits: `timeout_ms` 1..15000 (default 10000), polled every 50 ms. `act_steps`: 1..10 steps, 1..60000 ms (default 30000), step wait default 10000. Expectation URL ≤ 8192, text and action_label ≤ 2000, fill text ≤ 2000.
- Release: finalize readback within 2 s, polled every 50 ms. Shutdown: 2.5 s plus 0.2 s grace.
- `claim_browser` timeout: (0, 120], default 30. Controllers: default 3, cap 8. Tenants: default 3, cap 16. Limit syntax `-?\d{1,4}`. ≤ 16 sites per lease. ≤ 256 seen sites.
- File size limits: registry JSON 32768, sites-seen 131072, preferences 32 MiB, manifest and wrapper 65536.
- Endpoint probe 1 s. `pool reap` waits 10 s, polling every 0.1 s. `ensure` polls every 0.2 s. Probe timeout is min(1, remaining/3). User-tab lookup 5 s. `ps` 10 s. Windows must be on screen and at least 400 × 300.
- JPEG ≤ 24 MiB and ≤ 25 M px. Recording: fps 1..15, max_seconds 1..60, ≤ 100 MiB, 36 s join, ffmpeg 60 s per call.
- Vault: 60 s total; search 2 s; poll 0.05 s; selection 5 s; background deadlines at /4 and /10; 20 copy polls. Clipboard: 3 s start, 3 s restore, 64-byte line. Private input: OTP wait 10 s polled every 0.1 s; submit margin 5 s; legacy lifetime 30000 ms; lifetime ≤ 120000 ms; value ≤ 16384; selector ≤ 1024.
- Group title ≤ 80 UTF-16 units. Tab handle `[1-9][0-9]{0,15}`, prefixed with `<controller>:` on lease routes.

## 7. Test-porting approach
- Parity files: `tests/server/parity/<slice>.md` has one line per Python test function, either `test_x.py::test_name -> tests/server/<slice>/<file>.test.ts::<exact it() title>` or `test_x.py::test_name -> not ported: <reason citing C8/C6 or a D-number>`. `python-inventory.json` is built once by foundation from a read-only AST scan (`python3 -B`): function names, parametrize counts, and subtests. `scripts/check-parity.mjs` checks each entry appears exactly once and that each named TS test exists and runs (it matches `it(`, `test(`, `it.each(` titles; see section 2.1 for the removal and case rules). Parametrized tests become `it.each`, and subtests become loops inside one test.
- Tests adapted for a deviation keep their intent and cite the D-number: fixed-route tests become "not ported" (C8), unshared-site tests set `FAST_CHROME_UNSHARED_SITES=example.global`, pool-lease transfer tests become "not ported" (C6) except the non-null `lease_id` mismatch test, which stays, and missing-session tests assert the fallback.
- Golden capture (foundation, run once, commit its outputs): `tests/server/fixtures/capture-python.py` runs with the reference venv's Python using `-B`, `PYTHONDONTWRITEBYTECODE=1`, `HOME=<temp>`, cwd = temp, and `browser_pool.DEFAULT_ROOT`, `BASE_ROOT` and `SOCKET_ROOT` patched to temp paths **before any call**. It never touches the real home directory's state or configuration. It writes:
  - `python-tools.json`: `tools/list`, server name and instructions from an in-memory session.
  - `python-call-shapes.json`: success, Gate, validation-error and screenshot envelopes, using a fake connection.
  - `python-arguments.json`: accept or reject results and normalized values for a per-tool argument corpus.
  - `python-urls.json`: `origin`, `ascii_host` and `cookie_site` over a URL and host corpus, covering Unicode, IDNA edge cases, IPs, ports, userinfo and brackets.
  - `python-jpeg.json`: Pillow verdicts on synthetic byte strings.
  - `python-json.json`: `json.dumps` byte forms.
  - Generated Unicode tables in `src/server/unicode/*-table.ts`.
  The capture is regenerated only when the reference changes.
- Fake native host: `tests/server/support/fake-host.ts` ports `test_opchrome.Host`. It listens with `net.createServer` on a real Unix socket (parent 0700, socket 0600), logs `requests: [authority, request][]`, and supports handler overrides, a hung method (never answered), and custom host or extension info.
- Fake connection: `tests/server/support/fake-connection.ts` is a scripted `HostConnection` (a `vi.fn` call log with a side-effect queue that accepts values, errors or deferred promises), replacing `Mock(alive=True)`. `Deferred` helpers replace `threading.Event` and `Barrier` in the concurrency tests.
- Temp roots: `tests/server/support/temp.ts` creates `mkdtemp("fc-")` under `realpath(TMPDIR)`, chmods it 0700, and asserts socket paths ≤ 103 bytes. The workflow's TMPDIR `/private/var/folders/km/…/T/opencode` gives about 97 bytes for `<root>/sockets/isolated-1.sock`. Each test sets `BROWSER_CONTROL_STATE_DIR` through an explicit `env`/`PoolContext`, never through the real home.
- Real stdio subprocess tests: `global-setup.ts` uses the vite programmatic `build()` to bundle every `tests/server/support/child-<slice>.ts` into a temp `children/` dir. `child-server.ts` calls `runStdioServer({env, app})` with injected fakes (a vault fake that uses barrier files, like `VAULT`). `mcp-stdio.ts` ports the `Stdio` class: line queue, `initialize` with protocol `2025-06-18`, `call(name, args)` with `_meta`, and `stop("eof" | "sigterm")` returning the exit code and elapsed time. Assertions: exit 0, elapsed < 2 s or < 5 s as in Python, the last three host methods are `finalizeTabs`, `getTabs`, `getUserTabs`, no `observePage` after `finalizeTabs`, and stderr is empty.
- Multi-process lock tests: `child-pool.ts` exposes `operate`, `claim`, a Pin with `beginTab` then exit, and a Pin that holds until a barrier file. Races spawn N children with `Promise.all` (the equivalent of ThreadPoolExecutor). Crash tests end a child with `process.exit` and with `SIGKILL`, then assert the marker is kept and the lock is free. In-process tests assert that an in-process Pin makes an in-process `release` return `pinned`. The unsafe-registry cases (root symlink, lock symlink, claim symlink, lock hardlink, root and claim permissions) run against the SQLite lock files.
- Clipboard tests use synthetic `/bin/sh` guardian scripts in temp dirs (ready or never-ready, restore success or failure, slow restore, non-trusted modes), injected with `binary`. Vault tests use an in-process `CuaCaller` with synthetic AX payloads. No test starts the real 1Password or cua-driver. A secret canary: every private test scans results, thrown errors and captured stdout and stderr for the synthetic value.
- Only synthetic values are used, and temp dirs are removed in `afterEach`.

## 8. Slices, file ownership, sequencing
Adjusted boundaries:
- Foundation also ports `test_opchrome.py` and `test_sites.py`, and writes unit tests for captures and JPEG handling. The capture-related cases in `test_native_server.py` stay with the server slice.
- Foundation creates stubs with final signatures. Each stub is owned by exactly one later slice, and no other slice edits it: `src/server/app.ts` (server), `src/server/cli.ts` (packaging), `src/server/pool/operator.ts` (pool), `src/server/private/clipboard-guard.ts` (private).

Waves:
1. foundation.
2. pool, private and skills in parallel.
3. server and packaging in parallel. Server needs the real Pin, lease routing and `paste`. Packaging needs `runPoolCommand` and `buildClipboardGuard`.

If the runner starts server in wave 2 anyway, it must code against section 3 and leave lease and private integration tests pending until the merge. Its step would then be incomplete.

Shared files (package.json, lockfile, tsconfig, vitest config, vite configs, build.mjs, check-project.js, check-parity.mjs, CI, .gitignore) are set up by foundation with every dependency pre-added (`@modelcontextprotocol/sdk`, `zod`). A later slice that truly needs a new dependency adds it in a dedicated commit that touches only package.json and the lockfile, and rebuilds the lockfile on conflict.

## 9. Top risks and verification
1. Tool schemas and envelopes drift from FastMCP/pydantic. Verify with a deep-equal of `tools/list` against `python-tools.json` (only the D7/Q2 and D19 fields differ), the argument corpus, and envelope fixtures, through both an in-memory `Client` and the real stdio child.
2. URL, host and IDNA parity (urlsplit, IDNA 2003, ipaddress formats, code-point lengths). Verify with the `python-urls.json` corpus of at least 300 cases, plus a ported test_sites.
3. SQLite locks differ from flock (in-process conflicts, crash release, journal side effects, event-loop blocking). Verify with multi-process race tests, SIGKILL crash tests, in-process pinned tests, a check that no `*-journal` files remain after the suite, and a 20-child stress run.
4. Shutdown exceeds 2.5 s or exits non-zero (open handles, a hung endpoint, child processes). Verify with ported stdio tests for EOF, SIGTERM, a hung wait, a hung endpoint (exit before 4 s, marker kept), and a private transfer interrupted during the vault read, the OTP wait and the fill. The backstop timer is covered by a test.
5. Extension ID and `allowed_origins` for isolated profiles (Q1). Verify with a unit test of `unpackedExtensionId` against extension-id.py, a doctor check, and one live check in a temp Chrome for Testing profile (temp state dir, synthetic page) that the handshake reaches `extensionProtocol: ready`.
6. Bundling and packaging (a CJS bundle of the SDK, bin exec bit, asset resolution from `__dirname`, the `files` list). Verify with a packaging test: `pnpm pack`, extract to temp, run `node package/dist/server/cli.js mcp` offline with a fake host (initialize, `tools/list`, status), and assert that the stable host copy and wrapper exec `process.execPath` and never point into the tarball or npx dir.
7. Private data leaks or ordering drift (an input sent after shutdown, a missed restore). Verify with ported test_private_input, test_private_tool, test_onepassword and test_clipboard_guard, plus the canary scans, abort-path tests, and fake-host method logs asserting no `privateFill` or `submitPrivate` after refusal.
8. Concurrency semantics (an `await` sneaking into hold/register, busy leaks, recording contention). Verify with ported concurrency tests using deferred calls, a lint-style test that `hold` and `register` are synchronous (they return non-Promise values), and busy-flag leak assertions after every tool test.
9. JSON and number formatting (ensure_ascii, float text, lossless Preferences). Verify with `python-json.json`, and a Preferences round-trip test with an integer above 2^53.
10. Slices collide during parallel work. Verify with the ownership table, stubs, per-slice parity files, and `check-parity --complete` at integration.

## 10. Open question (blocking the pool slice)
Q1. The ID `pncpgnbanebkeopjghjleodgmphmmmcp` comes from Chrome's unpacked-ID rule applied to the Python server's install path (SHA-256 of the absolute path; see `store/capture/extension-id.py`). The repo manifest has no `key`. Once the extension ships in the package (C3), that ID cannot be preserved. Options:
- (a) **Recommended default.** Commit a public key (`data/isolated-extension-key.pub`) and inject it as `"key"` into the isolated copy only. That gives one new fixed ID that does not depend on paths or versions, so manifests never change across upgrades.
- (b) Compute the ID at runtime from `<state>/extensions/<version>-<digest>`. The ID then changes per install and per upgrade, and `provision` would have to rewrite manifests, which the parity rules forbid for existing manifests.
- (c) Inject the Web Store public key, so isolated profiles use `dcnjjnecbhipdbngkhjppkckpkellmld`. This needs the key from the publishing thread.

The Web Store build never carries a `key`.

## Coordinator decisions

Q1: choose (a). The coordinator verified the premise: sha256 of the Python server's absolute install path of `op-chrome/dist/extension` maps exactly to pncpgnbanebkeopjghjleodgmphmmmcp, and that manifest has no key. Implementation: generate one RSA-2048 keypair once, and commit only the public key (base64 DER SubjectPublicKeyInfo) as a repo constant. Do not commit or keep the private key; it is not needed for unpacked loading. Inject that key only into the isolated-profile copy of the extension under the state root. Never put it in src/extension/manifest.json or in the Web Store package. Compute the resulting fixed extension ID with a test that recomputes it from the key, and use that ID wherever the design used pncpgnbanebkeopjghjleodgmphmmmcp: per-profile manifests, allowed_origins, install, doctor and docs. install writes allowed_origins for the store ID dcnjjnecbhipdbngkhjppkckpkellmld plus this new ID. Record the ID change as a deviation.

As implemented by foundation: the public key is the constant `ISOLATED_EXTENSION_KEY` in `src/server/config.ts` (a repo constant rather than `data/isolated-extension-key.pub`). Its extension ID is `ISOLATED_EXTENSION_ID = "mpodnojmjjafgogldgieimgbmfhhknbe"`, and `tests/server/foundation/config.test.ts` recomputes it from the key. The private key was never written to disk. `ensureStableExtension` injects the key only into `<state>/extensions/<version>-<sha12>/manifest.json`; a test checks that `src/extension/manifest.json` has no key, and `scripts/check-project.js` checks that `dist/extension/manifest.json` has none. Deviation: isolated profiles use `mpodnojmjjafgogldgieimgbmfhhknbe` in place of `pncpgnbanebkeopjghjleodgmphmmmcp`.

Q2 (coordinator decision on the pool removal): paste_1password_field drops the account-pool-only lease_id argument and the fast-chrome-pool-account-mismatch path entirely. Do not keep a parameter that can only error. Record this as a schema deviation, and keep every other guard and fixed status. This supersedes D7 and the `account_claim` note in section 3.3: `PasteRequest` has no `leaseId`, and `paste` has no pool-account branch.

Q3 (user decision, 2026-09-28): retire the "opchrome" and "op-chrome" names everywhere they are ours to change, and record each rename as deviation D19:
- Module and types: `src/server/opchrome.ts` is `src/server/host-connection.ts`; `OpchromeConnection` is `HostConnection`; `OpchromeMethod` is `HostMethod`. `Connection` and `Connect` keep their names.
- Error codes: `opchrome-X` is `browser-control-X` for all fifteen codes: `outcome-unknown`, `private-page`, `unavailable`, `page-not-ready`, `operation-refused`, `invalid-request`, `protocol-mismatch`, `private-fields-unavailable`, `private-quarantine`, `unsupported-page`, `unsupported-shadow-root`, `restored-private-selector`, `populated-private-input`, `invalid-private-selectors`, `embedded-surface`. Python checks that name these codes (for example browser_start's probe set) use the new strings.
- Text: "Control Chrome through op-chrome observed DOM actions." becomes "Control Chrome through Browser Control observed DOM actions." in the MCP instructions; "its op-chrome endpoint" becomes "its Browser Control endpoint" in the `status` description; `status` returns `backend: "browser-control"` (`BACKEND_NAME`).
- Wrapper and environment: `op-chrome-host` is `browser-control-host` (`HOST_WRAPPER_NAME`); `OPZERO_CHROME_HOST_SOCKET` is `BROWSER_CONTROL_HOST_SOCKET` (`HOST_SOCKET_ENV`) for the server's user route and for generated wrappers. The retired variable is ignored by the server and by the stable native host. `src/native-host/host.ts` is unchanged; `native-host-env.ts` maps the new variable for it inside `dist/server/native-host.js` only.
- Kept: `com.opzero.chrome` (the published extension connects to it), `~/.opzero-chrome/default.sock` (the default of the existing native host), the `fast-chrome-*` codes, and the `FAST_CHROME_*` variables.
- Comparisons with captured Python output apply these renames through `tests/server/support/renames.ts`; the fixtures stay verbatim.

Q4 (user decision, 2026-09-28): rename the remaining stale names outside the server as well, on a separate branch `afif/browser-control-rename` created from `afif/chrome-web-store-release` (commits `b844f3f` and `b90b3a6`), with no fallback for the old variables:
- The installable skill `skills/chrome-control` is `skills/browser-control` (`name: browser-control`); its zip is `browser-control-skill.zip`; the installer script is `scripts/install-browser-control-skill.sh`, installing into OpenCode's global skills directory; the host wrapper is `native-host/browser-control-host` (and `.cmd`); the host reports `name: "browser-control-native-host"`.
- `OPZERO_CHROME_HOST_SOCKET`, `_HOST_TRANSPORT`, `_HOST_PORT`, `_HOST_TOKEN_FILE`, `_REQUEST_TIMEOUT_MS`, `_EXTENSION_ID`, `_USER_DATA_DIR` and `_PREFERENCES_PATH`, and `OPZERO_EXTENSION_ENTRY`, `_EXTENSION_EMPTY`, `OPZERO_TEST_TMPDIR` and `OPZERO_SYNTHETIC_CHROME` become the same names with the `BROWSER_CONTROL_` prefix. The Release workflow reads the repository variable `BROWSER_CONTROL_EXTENSION_ID`, which has to be created in GitHub settings.
- Kept: `com.opzero.chrome`, `~/.opzero-chrome/default.sock`, the Windows `AppData\Local\opzero-chrome` manifest folder, and the extension's own names (`content-scripts/opzero-chrome.js`, `__opzero*` page globals, `data-opzero-*` markers). `store/*.md` and `site/` still describe the 0.2.1 submission under review; `docs/RELEASE.md` ("Renamed helper") lists what to change when the renamed helper ships.
- One skill (user decision): the installable skill and the skills slice's MCP skill are one `browser-control` skill. On the rename branch, the host-script guidance lives in `skills/browser-control/references/native-host.md`, and `SKILL.md` has only a "Use the bundled host scripts" section. `build.mjs` copies `references/` into the zipped skill, so the release zip and the npm package both ship the whole skill, including the bundled native host and scripts.
- Merge recipe, verified by a trial merge of `afif/ts-server`, then `afif/browser-control-rename`, then `afif/ts-server-skills` (`ab6ccaf`), after which `pnpm run check` passed with 344 tests:
  1. `scripts/build.mjs` conflicts: keep the server-bundle block from `afif/ts-server` and the `browser-control-host` wrapper line from the rename branch.
  2. `skills/browser-control/SKILL.md` conflicts (add/add): take the skills slice's file and insert the rename branch's "## Use the bundled host scripts" section before "## Choose the needed reference".
  3. In that `SKILL.md` description, change "load chrome-control" to "load browser-control", to match the D19 instructions.
  4. Delete `src/server/native-host-env.ts` and its import in `native-host-entry.ts`, because `host.ts` then reads `BROWSER_CONTROL_HOST_SOCKET` itself.
- Both install paths write the user Chrome's `com.opzero.chrome` manifest: `npx -y @op1/browser-control install` and the skill's `scripts/install-native-host.js`. `references/native-host.md` says to use one per Chrome profile.

## Integration (afif/ts-server)

- The packaging slice's first default skills directory lay inside an agent client's configuration. C4 forbids writing there, so `install` and `doctor` link and check skills only in directories given with `--skills-dir`; without it they report one `skills` step with status `skipped`.
- The package ships the three skills the skills slice wrote (`browser-control`, `onepassword-session`, which `browser-control` links to, and `create-verification-skill`) and `docs/server/INSTALL.md`, in addition to the section 2.2 `files`.
- `install`, `doctor` and the smoke check use the server's modules for paths and trust: `stableHostPlan`, `publishTree` and `treeMatches` (stable-copy.ts), `MANIFEST`, `ISOLATED_EXTENSION_ORIGIN` and `SOCKET_PATH_LIMIT` (pool/provision.ts), `BUNDLE` (pool/start.ts), `metadata` (pool/registry.ts), `guardianTrusted` (private/clipboard-guard.ts), `runProcess` (pool/cua-cli.ts) and the SDK's `StdioClientTransport`.
- Test fixtures name synthetic sites (`example.global`, `deploy-preview-N--example.netlify.app`) in place of organization-specific ones. `python-urls.json` was regenerated from the reference with `CAPTURE_ONLY=urls`; it equals the previous capture with the names substituted.

## Residual-risk follow-up

- Merged `afif/browser-control-rename` at `8d7fd8a`, including its native-host startup recovery fixes and extension version 0.2.2. The npm package keeps its bin, files, Node 24 requirement, and public publication metadata. Nothing was published.
- Completed Q4: removed `native-host-env.ts`; the native host now reads `BROWSER_CONTROL_HOST_SOCKET` directly. Install and doctor read `BROWSER_CONTROL_USER_DATA_DIR` and `BROWSER_CONTROL_PREFERENCES_PATH`, with no fallback to their retired names. Smoke tests strip retired settings instead of forwarding them.
- Replaced the shipped README with npm setup instructions, the fixed isolated extension ID, and Node upgrade guidance. The forbidden-reference scan now includes the README.
- Added `tests/server/packaging/live-browser.test.ts`. With `BROWSER_CONTROL_SYNTHETIC_CHROME` set on macOS, it provisions only a disposable profile and stable copies, checks Chrome's actual extension ID, requires `extensionProtocol: ready` and both version-2 protocols, then drives a loopback form through the built MCP CLI and verifies the submitted text. Chrome and the temporary state are removed after the test.
- The macOS browser CI job installs Chrome for Testing and runs both the live native-messaging test and the private-input browser suite. These tests use synthetic values and do not access a vault.
- The headless transport test does not exercise cua-driver's GUI launch or focus-preservation behavior. `doctor --smoke` is the separate check for that path.

## Fix round 1

- Shutdown: the SIGTERM listener stays registered until exit (section 4.8). `tests/server/server/stdio.test.ts` sends EOF, then SIGTERM 2 s later while `finalizeTabs` is still being answered, and requires exit 0 with the finalization read back and the marker removed.
- Stable copies: `publishTree` is async and serialized by an exclusive `<parent>/.publish.lock`. It checks the target again under the lock and never deletes or replaces a copy that matches; a damaged copy is moved aside with one rename before the new one is renamed in. Tests race six publisher processes and hold the lock from another process.
- Native-host integers: see D20. The tests send `2.0`, `2e0`, `3.0`, `-32000.0`, `5.0` and `90000.0` verbatim through a real `Connection`.
- Parity gate: see section 2.1. `tests/server/foundation/check-parity.test.ts` runs the script on synthetic trees.
- Docs: `references/setup.md` and `INSTALL.md` name `~/.opzero-chrome/default.sock` as the one path outside the state root (D1).

Follow-ups:
- F1 `claim_browser` readiness requires a controller window that is on screen and at least 400 × 300, as Python does. When the current macOS Space shows a fullscreen app, Chrome for Testing can open its window on another Space, so the claim ends with `browser-controller-cua-unavailable` at its deadline, and `release_browser` then refuses with `browser-controller-startup-unconfirmed`. The readiness rule is unchanged in this round.
- F2 Controller sockets are `<state>/sockets/<controller>.sock` (D1). A state root longer than about 80 bytes exceeds the 103-byte socket path limit, so every claim fails closed with `browser-controller-unsafe-path`. The default state root fits.
- F3 Narrowed in fix round 2: only the vault reader's cua-driver MCP output still accepts an integral float literal where Python required an int (D20).

## Fix round 2

- Stdio input: `StdioTransport` has no line bound, as Python's stdin reader has none (the SDK's `ReadBuffer` closed the transport after 10 MiB, which stopped all requests without starting cleanup). A stdin read error closes the transport, and `Server.onclose` starts the same `Shutdown` as EOF and SIGTERM. Tests: an 11 MiB line through the real stdio child with a managed isolated tab, then EOF finalizes it; in process, a split 11 MiB line, and a read error that ends through the bounded cleanup.
- User socket and C4: see D1. `userSocket` and the wrapper default to `<state>/sockets/user.sock`, and the stable host defaults to it too. A server started with only the retired `OPZERO_CHROME_HOST_SOCKET` therefore reaches no Chrome outside its state root.
- The release zip's installer (`src/scripts/install-native-host.ts`, shipped in `skills/browser-control/scripts/`) now keeps the same guarantees as `browser-control install`: it publishes the host and the chunks it requires as `<state>/hosts/skill-<sha12>/`, writes `<state>/hosts/skill/browser-control-host` with single-quoted literals and `process.execPath` (C2; an apostrophe or control character is refused), points the manifest there (C3), and refuses to replace a manifest that names another host unless `--force` is given. Without `--socket-path`, its host keeps the standalone default `~/.opzero-chrome/default.sock`, which `client.js` uses. Tests in `tests/acceptance/distribution.test.ts` start the installed wrapper after deleting the skill, and with `$(...)` and backticks in the socket and state paths.
- Registry and cua-driver integers: see D20.
- Kept, with the evidence recorded in the round's notes: the D19 renames (the user approved them on 2026-09-28 after being told they contradict the brief's rule on error codes, then asked for more renames) and the isolated extension ID (Q1: Chrome derived `pncpgnbanebkeopjghjleodgmphmmmcp` from the SHA-256 of the Python server's install path of `op-chrome/dist/extension` under the agent client's configuration, which C3 and C4 exclude).


## Pre-PR round

- Merged `origin/main` at `e35cda1` (PR #3). Its tree equals `8d7fd8a`, which this branch already contained, so the merge changed no file.
- Orphaned leases: `claim_browser` receipts have no `owner` field. `pool status` lists every lease with its `owner` and `lease_id`, so the skill tells operators to match the receipt's `lease_id` there and pass that owner to `pool release`. The receipt is unchanged.
- The release zip's installer writes nothing into the directory it runs from. It used to rewrite `scripts/extension-id.json` there, which changed the content-addressed skill copy under `<state>/skills/` and made doctor report it stale. That file is a build output; the two check scripts read it only as a fallback after `--extension-id` and `BROWSER_CONTROL_EXTENSION_ID`.
- `references/native-host.md` and `INSTALL.md` describe both `com.opzero.chrome` installers: the last one run owns the manifest, the zip's host keeps `~/.opzero-chrome/default.sock` (D1), and doctor reports the zip's manifest as `manifest: foreign` with `previous` naming `<state>/hosts/skill/browser-control-host`. Doctor was not changed.
- `release.yml` and `chrome-web-store.yml` run Node 24, like `check.yml`, because both run `pnpm run check`.
- `docs/RELEASE.md` lists the reviewer steps and privacy text to refresh before the next release; `store/` and `site/` still describe the deployed 0.2.2 helper.
- Two tests waited on timing rather than state. `tests/security/host.test.ts` now waits for the host to remove `<socket>.lock` (it does so once listening) before connecting. The hung-call test in `tests/server/private/cua-mcp.test.ts` gives the read 4 s, so the deadline falls inside the hung call even under load.

## Installer race round

- One lock for both `com.opzero.chrome` installers, `src/shared/install-lock.ts`. The release zip's installer runs on Node 18, which has no `node:sqlite`, and the manifest lock must exclude that installer, so this lock is the section 4.4 exception: a directory lock with stale detection. The lock is a directory that holds one entry named `<pid>-<uuid>`. An installer takes it by renaming a directory that already holds its entry into place, so a held lock is never empty, and an empty lock directory is never held and may be removed. A waiter removes an entry only when `kill(pid, 0)` fails with `ESRCH`. Entry names are unique, so removing a stale entry never releases a live holder. An entry it cannot attribute is never removed. After 10 s the waiter gives up and names the lock and its live holder. The server's registry, pool and publication locks stay SQLite (section 4.4).
- The zip installer's host copy: publications into `<state>/hosts` are serialized by `<state>/hosts/.skill-publish.lock`, and the target is checked again under it, as `publishTree` does (fix round 1). A copy is moved aside only after it was read and differs; an unexpected read error fails the install and moves nothing. If the new copy cannot be renamed in, the old copy is put back, and it is deleted only once the new copy is in place. The wrapper is written only after its copy is verified.
- The manifest: both installers take `<manifest dir>/.com.opzero.chrome.json.lock` around "classify the existing manifest, then replace it", and classify it again under the lock. Each keeps its unlocked check first, so a manifest that already names another host is still refused before anything is written (the zip installer), and a dry run or a current manifest writes nothing, not even the lock (`browser-control install`). The refusal messages and `--force` are unchanged. `browser-control install` reports a lock that stays held as `manifest: locked` with the lock's path.
- Tests (`tests/acceptance/installer-races.test.ts`) run the built installers as real processes: eight zip installers at once on one state root, some of them killed with SIGKILL; the zip installer and `browser-control install` on one absent manifest, both held at the manifest lock after their first check and also started freely; and lock holders killed with SIGKILL. Against the previous installers, the concurrent zip runs moved a published copy aside and failed with `Could not verify the native host copy`, and both installers reported success for one manifest.
- `install` and `config` print `BROWSER_CONTROL_HOST_SOCKET` in the server environment when it differs from `<state>/sockets/user.sock`, because install wrote that socket into the user wrapper (D1).
- Doctor reports a wrapper that differs from the expected one only in its socket as `wrapper: socket-mismatch`, with `previous` set to the wrapper's socket, in place of `stale`.
- `references/browser-pool.md` names `pool reap [controller] [--dry-run]`.
- Residual risk: a SIGKILL between the two renames that replace a damaged copy leaves its name empty until the next install, while the displaced copy remains beside it. A lock whose holder died is held for as long as another process reuses that pid; the installer then stops after 10 s and names the lock to remove. A killed installer can leave a `.tmp` directory beside a lock or copy.

## Install lock trust round

- `src/shared/install-lock.ts` checks the file system before it creates or deletes anything. The parent must be a directory owned by the current uid that group and others cannot write, unless it has the sticky bit. The lock path is `lstat`ed: a symlink, a non-directory, a lock owned by another uid, or a group- or world-writable lock is refused with `InstallLockUnsafe` (`browser-controller-unsafe-install-lock`), which names the path. `browser-control install` reports it as `manifest: fail / unsafe-lock`.
- The lock directory's `dev` and `ino` are recorded when it is created or first checked, and verified again before each stale entry is deleted, before `rmdir`, and at release. Only regular files named exactly `<pid>-<uuid>` are deleted. A changed identity during cleanup deletes nothing and restarts the check; at release it deletes nothing and throws.
- A missing manifest directory is created with mode `0o755`, so a umask of 002 cannot make the installers refuse their own directory.
- The checks use Node 18 APIs only and share no code with `fs-private.ts`, so the zip installer bundle gains no chunk.
- Tests: 18 acceptance tests cover a symlinked lock (the outside file survives), a writable, sticky or foreign parent, a foreign or writable lock, an identity change during cleanup and at release, and a two-waiter stale cleanup ordered through an injected `readdir`. 15 of them fail against the previous lock. The built zip installer also ran on Node 18.20.8.
- Residual risk: only the lock and its immediate parent were checked, and the parent was followed if it was a symlink. The staging directory was removed recursively through its path. A user who could write to a directory above the parent could therefore rename that parent and replace it with a symlink, and the recursive removal then deleted the directory the symlink led to. That user could also use the window between each identity check and its delete. The install lock ancestor round closes both. Node has no `unlinkat`, so the window remains, but once every ancestor is trusted, only the same uid or root can use it. A group-writable NativeMessagingHosts directory made by another installer is now refused until `chmod g-w`. Windows skips the owner and mode checks.
- The `act` wait-timeout test scripts twenty `Loading` pages instead of one. A 1 ms deadline can allow a second poll, which previously ran out of scripted responses; the assertions are unchanged.

## Install lock ancestor round

- Trusted ancestors: `src/shared/install-lock.ts` resolves the lock's parent with `realpath`, then `lstat`s every directory from `/` down to it. Each must be a directory owned by the current uid or by root, and must not be group- or world-writable unless it has the sticky bit. This is OpenSSH's `safe_path` rule, with an exception for sticky directories such as `/tmp`. If a directory fails, `InstallLockUnsafe` names the first one at fault, and nothing is created. The parent may now be owned by root. The lock directory itself must still be owned by the current uid.
- An acquisition works only in the resolved real path, so changing a symlink in the given path afterwards redirects nothing. The parent's `dev` and `ino` are recorded when it is checked. They are verified again before the staging directory is made, after it is made, before and after the rename, before each stale entry or emptied lock is removed, and at release. If the parent changed, acquisition and release throw `InstallLockUnsafe` with the message that the directory was replaced, and nothing is removed.
- Bounded cleanup: the lock code removes nothing recursively. The staging directory holds one entry, `<pid>-<uuid>`. The identities of both are recorded when they are made; the entry's comes from `fstat`. Cleanup runs only if the rename did not take the staging directory. It `lstat`s the entry and unlinks it only if it still matches. It then `rmdir`s the staging directory only if that still matches, and `rmdir` fails if anything else is inside. On the first mismatch or failure, cleanup removes nothing more. A leftover staging directory is harmless. Release removes its entry and the lock directory the same way, through `removeCreated`.
- The zip installer's publication works in the real `hosts` path that `.skill-publish.lock` checked. It writes the new copy to `<hosts>/.tmp-<uuid>/copy`, moves a copy that differs to `<hosts>/.tmp-<uuid>/old`, and renames the new copy into place. If that rename fails, it puts the old copy back and removes the files and directories it wrote one at a time, each only while its identity matches. The displaced copy may hold anything, so it is the only tree removed recursively. That removal happens only once the new copy is in place, and only after both `hosts` and the staging directory match the identities that were recorded. `replaceFile` removes its temporary file only when the rename fails, and only while it is still the file it wrote.
- Tests: `tests/acceptance/installer-races.test.ts` has 11 new tests; 39 tests in the file in total.
  - The auditor's substitution: `readdir` is injected so that the other user's renames run once the staging directory exists and the held lock is found. The renames are made by the test's own uid.
  - A directory renamed to the staging name.
  - A staging directory that holds another entry.
  - An ancestor with mode `0770`, `0707` or `0777`, which is refused, and then accepted once the sticky bit is set.
  - An ancestor owned by another uid, which is refused, or by root, which is accepted; both uids are injected through `lstat`.
  - A symlink whose target is under a world-writable directory. It is refused. Once that directory is `0755`, the lock checks exactly the resolved chain and keeps working there after the symlink is repointed.
  - A temporary directory reached through macOS `/var`.
  - A read-only check of the real macOS home and `NativeMessagingHosts`.
  - A host copy replaced by a symlink.
- Fail-before and pass-after: against the previous lock, 15 tests fail. Eight are new behavior tests; the three substitution tests fail because the substituted directory was deleted. Five are existing tests that changed with the rule: the refusal message for a directory, and the foreign-parent test, which now injects `lstat`. Two new normal-location tests fail only because they use the new `lock.directory` and `checkDirectory`. The symlinked-copy test passes on both, and guards the one recursive removal left. The built zip installer ran on Node 18.20.8 with state and manifests reached through `/var`. It replaced a damaged copy and refused a `0777` ancestor, then accepted that ancestor once it had the sticky bit. It also refused a state root under a `0770` directory.
- Residual risk: each installer still reads and writes the manifest through the path it was given, not the lock's resolved directory. That write creates a temporary file and renames it, and removes nothing recursively. Refused: a home directory or state root under a group-writable directory without the sticky bit, for example a `0775` home with a user-private group; fix it with `chmod g-w`. A killed installer can leave `<hosts>/.tmp-<uuid>`, holding the displaced copy if it was killed between the two renames. Windows checks only the kind and identity of each directory.

## Install path canonicalization round

- Threat model, as the independent auditor fixed it: another uid controls a symlink or a directory somewhere in a path the caller supplied. Both installers now write only through real paths that were checked from `/` down, so repointing such a symlink afterwards changes neither the manifest that is written nor what Chrome runs.
- The manifest is written in the lock's directory. After both installers acquire the manifest lock, they build `<lock.directory.path>/com.opzero.chrome.json` and use it for the classification under the lock, the temporary file, the rename, and the cleanup. Before the lock, the given path is used only to create a missing manifest directory and for the unlocked pre-check, which only reads. After it, the given path appears only in messages and in the check below. Just before the rename, `stillResolves` in `src/shared/install-lock.ts` checks two things: the locked directory still has the `dev` and `ino` it had when the lock checked it, and the given directory still resolves to it. If either check fails, the installer renames nothing and removes only its temporary file, through `removeCreated`, while that file still matches. The zip installer exits 1 with `The native messaging manifest directory <dir> no longer resolves to <real path>, so no manifest was written.` `browser-control install` reports `manifest: fail / moved`.
- The zip installer's state root is used by its real path. `stateDirectory` creates the root with mode `0700` and resolves it with `checkDirectory`, which applies the lock's ancestor rule to every directory from `/` down. The resolved root must be private. `hosts` and `hosts/skill` are made in the resolved root, and each must be a private directory, not a symlink. This check runs on every install before the copy is checked. Previously, only the publish lock applied the ancestor rule, and a matching copy skipped that lock. The wrapper's path, the host path it execs, `manifest.path`, and the printed paths are all under the real root. A state root given through a symlink is now accepted if the resolved path passes the rule, and it is recorded by its real path; macOS `/var` becomes `/private/var`. Before this round, a symlink as the last component was refused, and a symlink above it was recorded as given. The publish lock must report the same path and identity as `hosts`, and the copy is verified again while `hosts` keeps its identity.
- `browser-control install` already recorded real paths through `fs-private`. `walk` in `src/server/fs-private.ts` `lstat`s every component from `/` and refuses a symlink with `ELOOP`. `openDirectory` uses it for the state root in `stateStep`, for `hosts` in `ensureStableHost`, and for `hosts/user` (through `childDirectory`) when the wrapper is written. `publishTree` in `src/server/stable-copy.ts` returns `path.join(verified(parent), name)`, which is the host path in the wrapper. A `--state-dir` given through a symlink is therefore refused (`state: fail / unsafe`, code `ELOOP`), not resolved. The missing part was the ancestor rule: `walk` checks owner and mode only on the last directory. `stateStep` now runs `checkDirectory(root)` and requires the result to equal `root`. Otherwise it reports `state: fail / unsafe-ancestor` with the first directory at fault, and no host, wrapper or manifest step runs.
- Node: both wrappers exec `process.execPath`. Node resolves the symlinks in that path.
- Tests: 9 new tests.
  - `tests/acceptance/installer-races.test.ts` has 5 new tests; 44 tests in the file in total. For each installer, a preloaded hook (`tests/server/support/child-retarget-manifest.ts`) repoints the manifest directory's symlink from `a` to `b` when the installer opens its temporary manifest, which is after it has classified the manifest under the lock. `b` holds a foreign manifest. The tests check that the foreign manifest survives unchanged, that the temporary file was made in `a`, that the installer refuses, and that `a` is left empty. For the zip installer, a state root given through a symlink above it or to it is recorded by its real path, on the first run and on the matching-copy run. After the symlink is repointed at another user's tree, the manifest and the wrapper are unchanged and name only real paths. A state root whose symlink leads under a `0777` directory is refused, both before a copy exists and once one is in place.
  - `tests/server/packaging/install.test.ts` has 4 new tests. A `--state-dir` through a symlink is refused with `ELOOP` and nothing is written. A state directory under a `0777`, `0770` or `0707` directory is refused, then accepted once that directory has the sticky bit; the wrapper and manifest then name only real paths.
  - Three tests in `tests/acceptance/distribution.test.ts` expect the zip installer's paths under the real path of the temporary directory, which macOS reaches through `/var`.
- Fail-before and pass-after: against `25dc747`, 8 of the 9 new tests fail. Both retargeting tests fail because the foreign manifest in `b` was overwritten without `--force`. The zip installer recorded `link/state/...`, refused a symlink as the last component, and refused the `0777` case through the publish lock only when it had to publish. The three npm ancestor cases were accepted. The `ELOOP` test passes on both, because it records the existing `fs-private` behavior. The built zip installer ran on Node 18.20.8.
- Accepted limitations, as the auditor fixed them:
  - Mutations by the same uid or by root.
  - Strict refusal of a group-writable directory without the sticky bit. This now applies to the state root of both installers as well, for example a `0775` `~/.local` under a user-private group; fix it with `chmod g-w`.
  - Timeouts when another process reuses a dead holder's pid.
  - Leftovers after a SIGKILL, and the gap during the replacement of a damaged copy.
  - Windows, where only the kind and identity of each directory are checked.
- Residual risk: a socket path given with `--socket-path` or `BROWSER_CONTROL_HOST_SOCKET` is written into the wrapper as given. It is not executed, and the host refuses a socket directory that is not private when it starts, but the directories above it are not checked. The default sockets are `<state>/sockets/user.sock` under the checked state root for `browser-control install`, and `~/.opzero-chrome/default.sock`, which the zip's host derives from `HOME` when it starts. The check before the rename and the rename itself are two steps. If the symlink is repointed between them, the new manifest is still written in the locked directory and never in the new target. The zip installer creates the state root with `mkdir -p` before it checks the root, so a refused root can leave empty private directories behind.
