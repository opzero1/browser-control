// browser-control doctor: read-only checks with fixed messages, and the --smoke run against a fake server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection } from "../../../src/server/host-connection";
import { doctor, runDoctor } from "../../../src/server/commands/doctor";
import { install } from "../../../src/server/commands/install";
import { parseOptions, type Step } from "../../../src/server/commands/shared";
import { SMOKE_FILL_TEXT, smokeEnv } from "../../../src/server/commands/smoke";
import { clipboardGuardBinary } from "../../../src/server/stable-copy";
import { childPath } from "../support/children";
import { FakeHost } from "../support/fake-host";
import { fakeChromeForTesting, fakeDeps, fakePackage, realDefaultPaths, snapshotTree, writeFile, type FakeDeps } from "../support/packaging";
import { privateTemp, removeTempRoots, socketPath, testEnv } from "../support/temp";

let defaults: Record<string, string>;
const hosts: FakeHost[] = [];

beforeAll(() => {
  defaults = realDefaultPaths();
});

beforeEach(() => {
  vi.spyOn(os, "homedir").mockImplementation(() => {
    throw new Error("the real home directory was used");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  removeTempRoots();
});

afterAll(() => {
  expect(realDefaultPaths()).toEqual(defaults);
});

const INSTALL_FLAGS = ["--state-dir", "--chrome-manifest-dir", "--skills-dir", "--dry-run", "--force", "--json"];
const DOCTOR_FLAGS = ["--state-dir", "--chrome-manifest-dir", "--skills-dir", "--json", "--smoke"];

function setup() {
  const root = privateTemp("pk-");
  const cua = writeFile(path.join(root, "tools/cua-driver"), "#!/bin/sh\nexit 0\n", 0o755);
  const env = testEnv(root, { CUA_DRIVER: cua, BROWSER_CONTROL_STATE_DIR: undefined, BROWSER_CONTROL_HOST_SOCKET: socketPath(root, "user.sock"), PATH: "/nonexistent-bin" });
  fs.mkdirSync(env.HOME as string, { mode: 0o700 });
  const assets = fakePackage(root);
  const flags = ["--state-dir", path.join(root, "state"), "--chrome-manifest-dir", path.join(root, "manifests"), "--skills-dir", path.join(root, "skills")];
  const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });
  return { root, env, assets, flags, deps };
}

function byId(steps: readonly Step[]): Record<string, Step> {
  return Object.fromEntries(steps.map((item) => [item.id, item]));
}

function statuses(steps: readonly Step[]): Record<string, string> {
  return Object.fromEntries(steps.map((item) => [item.id, `${item.level}:${item.status}`]));
}

async function run(argv: string[], env: Record<string, string | undefined>, deps: FakeDeps) {
  return doctor(parseOptions(argv, DOCTOR_FLAGS), env, deps);
}

describe("browser-control doctor", () => {
  it("reports each missing piece with a fixed, actionable message and writes nothing", async () => {
    const { root, env, flags, deps } = setup();
    const before = snapshotTree(root);
    const report = await run(flags, env, deps);
    expect(statuses(report.steps)).toEqual({
      node: "ok:found", state: "fail:missing", manifest: "fail:missing", extension: "fail:profile-missing", endpoint: "warn:unavailable",
      "cua-driver": "ok:found", "chrome-for-testing": "ok:found", ffmpeg: "warn:missing"
    });
    expect(byId(report.steps).state).toMatchObject({ message: "The state directory does not exist. Run browser-control install.", command: "browser-control install" });
    expect(byId(report.steps).manifest.message).toBe("The Chrome native messaging manifest is missing. Run browser-control install.");
    expect(byId(report.steps).ffmpeg.message).toBe("ffmpeg is not on PATH, so start_recording is refused. Screenshots work without it.");
    expect(report.ok).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("passes every check install owns after install, without changing anything", async () => {
    const { root, env, flags, deps } = setup();
    await install(parseOptions(flags, INSTALL_FLAGS), env, deps);
    const before = snapshotTree(root);
    const report = await run(flags, env, deps);
    expect(statuses(report.steps)).toEqual({
      node: "ok:found", state: "ok:private", host: "ok:current", wrapper: "ok:current", manifest: "ok:current", extension: "fail:profile-missing",
      endpoint: "warn:unavailable", "cua-driver": "ok:found", "chrome-for-testing": "ok:found", "clipboard-guard": "ok:trusted",
      "skill:browser-control": "ok:current", ffmpeg: "warn:missing"
    });
    expect(snapshotTree(root)).toEqual(before);
    let printed = "";
    const stdout = new (await import("node:stream")).Writable({ write(chunk, _encoding, done) { printed += String(chunk); done(); } });
    expect(await runDoctor(flags, { stdout, stderr: stdout, env }, deps)).toBe(1);
    expect(printed).toContain("ok   wrapper: The native host wrapper runs this version's host with this Node.js.\n");
    expect(printed).toContain("FAIL extension: No Chrome profile was found. Open Chrome once, then install Browser Control from the Chrome Web Store.\n");
  });

  it("finds a stale wrapper, a changed host copy, a foreign manifest, an untrusted guard and a stale skill link", async () => {
    const { root, env, flags, deps, assets } = setup();
    const installed = await install(parseOptions(flags, INSTALL_FLAGS), env, deps);
    const host = byId(installed.steps).host.path as string;
    fs.chmodSync(host, 0o600);
    fs.appendFileSync(host, "// changed\n");
    fs.writeFileSync(path.join(root, "state/hosts/user/browser-control-host"), "#!/bin/sh\nexec /old/node /old/host.js\n");
    writeFile(path.join(root, "manifests/com.opzero.chrome.json"), JSON.stringify({ name: "com.opzero.chrome", path: "/opt/other-host" }));
    fs.chmodSync(clipboardGuardBinary({ ...env, BROWSER_CONTROL_STATE_DIR: path.join(root, "state") }, assets), 0o755);
    fs.rmSync(path.join(root, "skills/browser-control"));
    fs.symlinkSync(path.join(root, "state/skills/browser-control/0.0.1-000000000000"), path.join(root, "skills/browser-control"));
    const report = byId((await run(flags, env, deps)).steps);
    expect(report.host).toMatchObject({ level: "fail", status: "changed", message: "The native host copy does not match this package. Run browser-control install." });
    expect(report.wrapper).toMatchObject({ level: "fail", status: "stale" });
    expect(report.manifest).toMatchObject({ level: "fail", status: "foreign", previous: "/opt/other-host", command: "browser-control install --force" });
    expect(report["clipboard-guard"]).toMatchObject({ level: "fail", status: "untrusted" });
    expect(report["skill:browser-control"]).toMatchObject({ level: "warn", status: "stale", previous: path.join(root, "state/skills/browser-control/0.0.1-000000000000") });
  });

  it("checks the user endpoint's protocol 2 handshake", async () => {
    const { root, env, flags } = setup();
    const socket = env.BROWSER_CONTROL_HOST_SOCKET as string;
    const deps = { ...fakeDeps(fakePackage(root)), connect: (file: string, timeout?: number) => Connection.open(file, timeout) };
    hosts.push(await FakeHost.start(socket));
    expect(byId((await run(flags, env, deps)).steps).endpoint).toMatchObject({ level: "ok", status: "connected", path: socket });
    await hosts.pop()?.close();
    hosts.push(await FakeHost.start(socket, { extensionInfo: { protocolVersion: 2, pageProtocolVersion: 1 } }));
    expect(byId((await run(flags, env, deps)).steps).endpoint).toMatchObject({ level: "fail", status: "protocol-mismatch", code: "browser-control-protocol-mismatch" });
  });
});

interface SmokeRun {
  report: Awaited<ReturnType<typeof doctor>>; calls: Array<Record<string, any>>; reaps: Array<{ state?: string; controller: string | null }>; base: string; left: string[];
}

const kept: string[] = [];
afterEach(() => {
  for (const dir of kept.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function smokeRun(mode: string, overrides: { reap?: boolean; server?: string[] } = {}): Promise<SmokeRun> {
  const { root, env, flags, deps } = setup();
  const log = path.join(root, "calls.jsonl");
  // The shared private test temp root, so the smoke's socket paths fit like a real run's.
  const base = fs.realpathSync(process.env.OPZERO_TEST_TMPDIR || path.join(os.tmpdir(), "opencode"));
  const earlier = new Set(smokeRoots(base));
  const reaps: SmokeRun["reaps"] = [];
  deps.smoke = {
    server: () => ({ command: process.execPath, args: overrides.server ?? [childPath("child-packaging"), "server", log, mode] }),
    reap: async (serverEnv, controller) => {
      reaps.push({ state: serverEnv.BROWSER_CONTROL_STATE_DIR, controller });
      return overrides.reap ?? true;
    },
    tempBase: () => base
  };
  const parent = { ...env, FAST_CHROME_ARTIFACT_ROOT: "/must/not/pass", FAST_CHROME_UNSHARED_SITES: "example.com", OPZERO_CHROME_HOST_SOCKET: "/home/u/.opzero-chrome/default.sock" };
  const report = await doctor(parseOptions([...flags, "--smoke"], DOCTOR_FLAGS), parent, deps);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const left = smokeRoots(base).filter((name) => !earlier.has(name)).map((name) => path.join(base, name));
  kept.push(...left);
  return { report, calls, reaps, base, left };
}

function smokeRoots(base: string): string[] {
  return fs.readdirSync(base).filter((name) => name.startsWith("bcs-"));
}

function smokeSteps(report: SmokeRun["report"]): Record<string, string> {
  return statuses(report.steps.filter((item) => item.id.startsWith("smoke:")));
}

describe("browser-control doctor --smoke", () => {
  it("claims an isolated browser, runs one act_steps batch on a loopback fixture, releases, and never reaches the user's Chrome", async () => {
    const { report, calls, reaps, base, left } = await smokeRun("ok");
    expect(smokeSteps(report)).toEqual({
      "smoke:server": "ok:started", "smoke:claim_browser": "ok:ready", "smoke:open_tab": "ok:opened", "smoke:act_steps": "ok:completed",
      "smoke:release": "ok:released", "smoke:release_browser": "ok:released", "smoke:cleanup": "ok:removed"
    });
    expect(calls.map((call) => call.tool)).toEqual(["claim_browser", "open_tab", "act_steps", "release", "release_browser"]);
    const state = calls[0].env.state as string;
    expect(state).toMatch(new RegExp(`^${base}/bcs-[^/]+$`));
    expect(Buffer.byteLength(path.join(state, "sockets/isolated-8.sock"))).toBeLessThanOrEqual(103);
    for (const call of calls) {
      expect(call.env).toEqual({ state, socket: path.join(state, "absent/user.sock"), retiredSocket: path.join(state, "absent/user.sock"),
        loopback: "1", artifactRoot: null });
      expect(call.socketExists).toBe(false);
    }
    expect(calls[0].args).toEqual({ timeout_seconds: 60 });
    expect(calls[1].args.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(calls[2].args).toEqual({ tab_id: "isolated-1:7", steps: [
      { label: "Smoke name", kind: "fill", text: SMOKE_FILL_TEXT },
      { label: "Run smoke check", kind: "click", expect: { text: "Smoke check passed" } }
    ] });
    expect(calls[3].args).toEqual({ tab_id: "isolated-1:7" });
    expect(calls[4].args).toEqual({ lease_id: "0123456789abcdef0123456789abcdef" });
    expect(reaps).toEqual([{ state, controller: "isolated-1" }]);
    expect(left).toEqual([]);
    expect(fs.existsSync(state)).toBe(false);
  }, 30000);

  it("stops at a claim that is not ready, releases the retained lease and still stops the browser", async () => {
    const { report, calls, reaps, left } = await smokeRun("claim-fails");
    expect(smokeSteps(report)).toEqual({ "smoke:server": "ok:started", "smoke:claim_browser": "fail:not-ready", "smoke:release_browser": "ok:released", "smoke:cleanup": "ok:removed" });
    expect(byId(report.steps)["smoke:claim_browser"].code).toBe("browser-controller-startup-timeout");
    expect(calls.map((call) => call.tool)).toEqual(["claim_browser", "release_browser"]);
    expect(reaps.map((item) => item.controller)).toEqual(["isolated-1"]);
    expect(left).toEqual([]);
  }, 30000);

  it("reports the stop reason when act_steps does not complete", async () => {
    const { report } = await smokeRun("act-stops");
    expect(byId(report.steps)["smoke:act_steps"]).toMatchObject({ level: "fail", status: "incomplete", code: "missing" });
    expect(smokeSteps(report)).toMatchObject({ "smoke:release": "ok:released", "smoke:release_browser": "ok:released", "smoke:cleanup": "ok:removed" });
  }, 30000);

  it("keeps the temporary state and prints the reap command when the browser is not confirmed stopped", async () => {
    const { report, left } = await smokeRun("ok", { reap: false });
    const cleanup = byId(report.steps)["smoke:cleanup"];
    expect(cleanup).toMatchObject({ level: "fail", status: "kept" });
    expect(left).toHaveLength(1);
    expect(cleanup.path).toBe(left[0]);
    expect(cleanup.command).toBe(`BROWSER_CONTROL_STATE_DIR='${left[0]}' browser-control pool reap`);
  }, 30000);

  it("reports a server that does not list the smoke tools and launches nothing", async () => {
    const { report, reaps, left } = await smokeRun("ok", { server: [childPath("child-packaging"), "empty"] });
    expect(smokeSteps(report)).toEqual({ "smoke:server": "fail:unavailable" });
    expect(reaps).toEqual([]);
    expect(left).toEqual([]);
  }, 30000);

  it("passes only its own settings to the server", () => {
    const env = smokeEnv({ PATH: "/bin", HOME: "/h", CUA_DRIVER: "/c", FAST_CHROME_ARTIFACT_ROOT: "/a", BROWSER_CONTROL_STATE_DIR: "/s", OPZERO_CHROME_EXTENSION_ID: "x", UNSET: undefined },
      "/t/state", "/t/absent/user.sock");
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CUA_DRIVER: "/c", BROWSER_CONTROL_STATE_DIR: "/t/state", BROWSER_CONTROL_HOST_SOCKET: "/t/absent/user.sock",
      OPZERO_CHROME_HOST_SOCKET: "/t/absent/user.sock", FAST_CHROME_ALLOW_LOOPBACK: "1" });
  });
});
