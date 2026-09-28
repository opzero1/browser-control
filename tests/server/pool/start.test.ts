// Port of test_browser_start.py: provisioning, serialized startup, retained ownership after an ambiguous
// launch, exact profile matching and the receipts. Profiles, wrappers and sockets live under a private state
// root, never under the real ~/.local/state/browser-control.
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_SOCKET_ENV, ISOLATED_EXTENSION_ID } from "../../../src/server/config";
import { openDirectory } from "../../../src/server/fs-private";
import { Gate } from "../../../src/server/gate";
import { lockNow } from "../../../src/server/lock";
import { ISOLATED_EXTENSION_ORIGIN, provision, provisionDeps, type ProvisionDeps } from "../../../src/server/pool/provision";
import { claim, CONTROLLERS, metadata, operate, readClaim, slot, type Grant } from "../../../src/server/pool/registry";
import { BUNDLE, ensure, hasProfile, launchArguments, Runtime, type StartRuntime, type Window } from "../../../src/server/pool/start";
import { monotonic, sleep } from "../../../src/server/time";
import { killChildren } from "../support/children";
import { removeTempRoots } from "../support/temp";
import { closeServer, deferred, gate, listen, pool, staleSocket, STAGING, syntheticAssets, withEnv, type Pool, serialSuite } from "./helpers";

serialSuite();

afterEach(() => {
  killChildren();
  removeTempRoots();
});

const FOCUS_REPLIES: Array<Record<string, unknown>> = [{}, { self_activation_suppressed: null }, { self_activation_suppressed: false }];
const AMBIGUOUS: Array<[number[], boolean, string]> = [[[1, 2], true, "process-ambiguous"], [[], true, "process-unconfirmed"]];
const INVALID_TIMEOUTS: unknown[] = [0, -1, 121, NaN, Infinity, true];
const NODES = ["node", "/nonexistent/node", "not-executable"];
const FOREIGN_MANIFESTS: Array<[string, string]> = [["isolated-4", "legacy"], ["isolated-1", "/tmp/other-host"]];

class FakeRuntime implements StartRuntime {
  pids: number[];
  ready: boolean;
  launches = 0;

  constructor(pids: number[] = [], ready = false) {
    this.pids = [...pids];
    this.ready = ready;
  }

  provision() {}
  prepare() {}
  processes(): number[] | Promise<number[]> {
    return this.pids;
  }
  probe(): boolean | Promise<boolean> {
    return this.ready;
  }
  configure(_info: Grant, { running }: { running: boolean }): Record<string, boolean> {
    return { password_saving_disabled: true, preferences_changed: !running };
  }
  launch(_info: Grant): unknown {
    this.launches += 1;
    this.pids = [123];
    this.ready = true;
    return undefined;
  }
  windows(pid: number): Window[] | Promise<Window[]> {
    return [{ pid, window_id: 456 } as Window];
  }
}

/** Launch also starts a listening host socket, as the real native host does. */
class Hosted extends FakeRuntime {
  readonly endpoints: net.Server[] = [];

  override async launch(info: Grant) {
    super.launch(info);
    this.endpoints.push(await listen(info.socket));
  }

  async close() {
    for (const endpoint of this.endpoints) await closeServer(endpoint);
  }
}

function start(target: Pool, runtime: StartRuntime, options: { controller?: string | null; owner?: string; timeout?: unknown; site?: string | null; exclusive?: boolean } = {}) {
  return ensure(options.controller ?? null, options.owner ?? "ses_one", { timeout: options.timeout, site: options.site, exclusive: options.exclusive, ctx: target.ctx, runtime });
}

function fakeNode(root: string): string {
  const program = path.join(root, "node");
  fs.writeFileSync(program, "#!/bin/sh\n");
  fs.chmodSync(program, 0o700);
  return program;
}

function deps(root: string, node = fakeNode(root)): ProvisionDeps {
  return { host: { hostScript: path.join(root, "hosts/0.0.0-test-000000000000/native-host.js") }, extension: { origin: ISOLATED_EXTENSION_ORIGIN }, node };
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function mtime(file: string): bigint {
  return fs.statSync(file, { bigint: true }).mtimeNs;
}

describe("ensure", () => {
  it("starts cold and then reuses the warm Chrome", async () => {
    const target = pool();
    const runtime = new FakeRuntime();
    const first = await start(target, runtime);
    const second = await start(target, runtime);
    expect(first.ready && first.launched).toBe(true);
    expect(first.password_saving_disabled && first.preferences_changed).toBe(true);
    expect(second.ready).toBe(true);
    expect(second.launched).toBe(false);
    expect(first.lease_id).toBe(second.lease_id);
    expect([first.pid, second.pid]).toEqual([123, 123]);
    expect(runtime.launches).toBe(1);
    expect((await operate("release", { owner: "ses_one", lease: first.lease_id, ctx: target.ctx }) as { released: boolean }).released).toBe(true);
  });

  it("cannot return ready when the endpoint is lost during the window check", async () => {
    const target = pool();
    class Disconnects extends FakeRuntime {
      override windows(pid: number) {
        this.ready = false;
        return super.windows(pid);
      }
    }
    const runtime = new Disconnects([123], true);
    const result = await start(target, runtime, { timeout: 0.01 });
    expect(result.error).toBe("browser-controller-startup-timeout");
    expect(result.ready).toBe(false);
    expect(runtime.launches).toBe(0);
  });

  it.each(FOCUS_REPLIES)("requires explicit focus preservation at launch: %j", async (reply) => {
    const target = pool();
    const runtime = new Runtime(0, target.env);
    runtime.extension = { dir: path.join(target.root, "extension") };
    runtime.cua = async () => reply;
    expect(await gate(runtime.launch(metadata("isolated-1", target.ctx) as Grant))).toBe("browser-controller-focus-not-preserved");
  });

  it("blocks warm reuse while password saving is enabled", async () => {
    const target = pool();
    class Enabled extends FakeRuntime {
      override configure(_info: Grant, { running }: { running: boolean }): Record<string, boolean> {
        expect(running).toBe(true);
        throw new Gate("browser-controller-password-saving-enabled");
      }
    }
    const runtime = new Enabled([123], true);
    const result = await start(target, runtime);
    expect(result.error).toBe("browser-controller-password-saving-enabled");
    expect(result.ready).toBe(false);
    expect(runtime.launches).toBe(0);
  });

  it("never relaunches an existing unready process", async () => {
    const target = pool();
    const runtime = new FakeRuntime([123]);
    const result = await start(target, runtime, { timeout: 0.01 });
    expect(result.error).toBe("browser-controller-startup-timeout");
    expect(result.lease_retained).toBe(true);
    expect(runtime.launches).toBe(0);
  });

  it("never replays an unknown launch, and its startup record blocks release", async () => {
    const target = pool();
    class Unknown extends FakeRuntime {
      override launch(): unknown {
        this.launches += 1;
        throw new Gate("browser-controller-cua-unavailable");
      }
    }
    const runtime = new Unknown();
    const first = await start(target, runtime);
    const second = await start(target, runtime);
    expect(first.error).toBe("browser-controller-cua-unavailable");
    expect(second.error).toBe("browser-controller-startup-unconfirmed");
    expect(runtime.launches).toBe(1);
    expect(await gate(operate("release", { owner: "ses_one", lease: first.lease_id, ctx: target.ctx }))).toBe("browser-controller-startup-unconfirmed");
    runtime.pids = [123];
    runtime.ready = true;
    const recovered = await start(target, runtime);
    expect(recovered.ready).toBe(true);
    expect(recovered.launched).toBe(false);
    expect((await operate("release", { owner: "ses_one", lease: first.lease_id, ctx: target.ctx }) as { released: boolean }).released).toBe(true);
  });

  it.each(AMBIGUOUS)("refuses an ambiguous identity: pids %j, ready %s", async (pids, ready, error) => {
    const target = pool();
    const runtime = new FakeRuntime([...pids], ready);
    const result = await start(target, runtime);
    expect(result.error).toBe(`browser-controller-${error}`);
    expect(runtime.launches).toBe(0);
  });

  it("does not let a foreign owner launch", async () => {
    const target = pool();
    await operate("claim", { controller: "isolated-1", owner: "ses_other", ctx: target.ctx });
    const runtime = new FakeRuntime();
    expect(await gate(start(target, runtime, { controller: "isolated-1" }))).toBe("browser-controller-busy");
    expect(runtime.launches).toBe(0);
  });

  it("makes a concurrent ensure wait for startup and then reuse the warm Chrome", async () => {
    const target = pool();
    const entered = deferred();
    const finish = deferred();
    class Slow extends FakeRuntime {
      override async launch(info: Grant) {
        entered.resolve();
        await finish.promise;
        return super.launch(info);
      }
    }
    const runtime = new Slow();
    const first = start(target, runtime, { controller: "isolated-1" });
    await entered.promise;
    let second: Promise<Record<string, unknown>> | undefined;
    let secondDone = false;
    try {
      second = start(target, runtime, { controller: "isolated-1" });
      void second.then(() => { secondDone = true; });
      const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as { lease_id: string };
      expect(await gate(operate("release", { owner: "ses_one", lease: claimed.lease_id, ctx: target.ctx }))).toBe("browser-controller-pinned");
      await sleep(300);
      expect(secondDone).toBe(false);
    } finally {
      finish.resolve();
    }
    const cold = await first;
    const warm = await (second as Promise<Record<string, unknown>>);
    expect(cold.ready && cold.launched).toBe(true);
    expect(warm.ready).toBe(true);
    expect(warm.launched).toBe(false);
    expect(warm.lease_id).toBe(cold.lease_id);
    expect(runtime.launches).toBe(1);
  });

  it("bounds the startup lock wait by the timeout", async () => {
    const target = pool();
    const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as { lease_id: string };
    let began = 0;
    const result = await slot("isolated-1", target.ctx, false, async (directory) => {
      const held = lockNow(directory, "startup.lock", true);
      try {
        began = monotonic();
        return await start(target, new FakeRuntime(), { controller: "isolated-1", timeout: 0.3 });
      } finally {
        held.release();
      }
    });
    expect(result.error).toBe("browser-controller-startup-timeout");
    expect(result.lease_id).toBe(claimed.lease_id);
    const elapsed = monotonic() - began;
    expect(elapsed).toBeGreaterThanOrEqual(0.25);
    expect(elapsed).toBeLessThan(2);
  });

  it.each(INVALID_TIMEOUTS)("refuses an invalid timeout without claiming: %s", async (timeout) => {
    const target = pool();
    fs.rmSync(target.ctx.sockets, { recursive: true });
    expect(await gate(start(target, new FakeRuntime(), { timeout }))).toBe("browser-controller-invalid-timeout");
    expect(fs.readdirSync(target.root)).toEqual([]);
  });
});

describe("Chrome identity and readiness", () => {
  it("matches the profile exactly and excludes helpers", () => {
    const executable = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    expect(hasProfile(`${executable} --user-data-dir=/a profile --no-first-run`, "/a profile")).toBe(true);
    expect(hasProfile(`${executable} --user-data-dir=/a/profile-extra`, "/a/profile")).toBe(false);
    expect(hasProfile(`${executable} Helper --user-data-dir=/a/profile`, "/a/profile")).toBe(false);
    expect(hasProfile(`${executable} --user-data-dir=/a/profile --user-data-dir=/b`, "/a/profile")).toBe(false);
  });

  it("gives each controller its own launch arguments", () => {
    const target = pool();
    const extension = path.join(target.ctx.registry, "../../extensions/0.0.0-abc");
    for (const controller of CONTROLLERS) {
      const info = metadata(controller, target.ctx);
      const args = launchArguments(info, extension) as { bundle_id: string; creates_new_application_instance: boolean; additional_arguments: string[] };
      expect(args.bundle_id).toBe(BUNDLE);
      expect(args.creates_new_application_instance).toBe(true);
      expect(args.additional_arguments).toContain(`--user-data-dir=${info.profile}`);
      expect(args.additional_arguments).toContain(`--load-extension=${extension}`);
      expect(args.additional_arguments).toContain(`--disable-extensions-except=${extension}`);
    }
  });

  it("excludes hidden and utility windows from readiness", async () => {
    const rows = [
      { pid: 123, window_id: 1, is_on_screen: true, bounds: { width: 1200, height: 900 } },
      { pid: 123, window_id: 2, is_on_screen: false, bounds: { width: 500, height: 500 } },
      { pid: 123, window_id: 3, is_on_screen: true, bounds: { width: 1, height: 1 } }
    ];
    const runtime = new Runtime(0, { HOME: "/nonexistent", PATH: "" });
    runtime.cua = async () => ({ windows: rows });
    expect((await runtime.windows(123)).map((row) => row.window_id)).toEqual([1]);
  });

  it("refuses a cua-driver pid or window ID written as a float literal, as type() is int does (D20)", async () => {
    const target = pool();
    // cua-driver's own JSON text, verbatim: 1.0 and 1e0 are Python floats even though they are integral.
    const cua = path.join(target.root, "cua-driver");
    const bounds = '"is_on_screen": true, "bounds": {"width": 1200, "height": 900}';
    const windows = `{"windows": [{"pid": 123, "window_id": 1.0, ${bounds}}, {"pid": 123, "window_id": 2e0, ${bounds}}, {"pid": 123.0, "window_id": 3, ${bounds}}]}`;
    const apps = (pid: string) => `{"apps": [{"bundle_id": "${BUNDLE}", "running": true, "pid": ${pid}}]}`;
    const script = (pid: string) => `#!/bin/sh\ncase "$1" in\n  list_windows) echo '${windows}' ;;\n  list_apps) echo '${apps(pid)}' ;;\nesac\n`;
    const info = metadata("isolated-1", target.ctx) as Grant;
    // A live pid, so an accepted value reaches ps and matches no profile instead of failing there.
    for (const [pid, expected] of [[`${process.pid}`, null], [`${process.pid}.0`, "browser-controller-process-unconfirmed"],
      [`${process.pid}e0`, "browser-controller-process-unconfirmed"], ["true", "browser-controller-process-unconfirmed"]]) {
      fs.writeFileSync(cua, script(pid as string), { mode: 0o700 });
      const runtime = new Runtime(monotonic() + 5, { ...target.env, CUA_DRIVER: cua, PATH: "/nonexistent" });
      expect(await gate(runtime.processes(info)), pid as string).toBe(expected);
    }
    // A row's pid still matches by value (123.0 == 123 in Python); only the window ID must be an int.
    const runtime = new Runtime(monotonic() + 5, { ...target.env, CUA_DRIVER: cua, PATH: "/nonexistent" });
    expect((await runtime.windows(123)).map((row) => row.window_id)).toEqual([3]);
  });
});

describe("receipts and sharing", () => {
  it("names the pid, windows, downloads and lease artifacts in an exclusive receipt", async () => {
    const target = pool();
    const info = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Grant;
    const artifacts = path.join(info.artifacts, info.lease_id);
    expect(fs.existsSync(artifacts)).toBe(false);
    const result = await start(target, new FakeRuntime());
    expect(result.ready).toBe(true);
    expect(result.mode).toBe("exclusive");
    // D6: every controller reports the one server name.
    expect(result.server).toBe("browser-control");
    expect(result.pid).toBe(123);
    expect(result.windows).toEqual([{ pid: 123, window_id: 456 }]);
    expect(result.downloads).toBe(info.downloads);
    expect(result.artifacts).toBe(artifacts);
    expect(mode(artifacts)).toBe(0o700);
    expect(result.sites).toEqual([]);
    expect(result.site_state).toBeNull();
  });

  it("omits profile-wide native and download fields from a shared receipt", async () => {
    const target = pool();
    const result = await start(target, new FakeRuntime(), { exclusive: false, site: "https://deploy-preview-1704--example.netlify.app/login" });
    expect(result.ready).toBe(true);
    expect(result.mode).toBe("shared");
    expect(result.server).toBe("browser-control");
    expect(result.sites).toEqual(["deploy-preview-1704--example.netlify.app"]);
    expect(result.site_state).toBe("fresh");
    for (const key of ["pid", "windows", "downloads", "profile", "socket"]) expect(result).not.toHaveProperty(key);
    expect(fs.statSync(result.artifacts as string).isDirectory()).toBe(true);
    expect((await claim("ses_one", { ctx: target.ctx })).lease_id).toBe(result.lease_id);
    expect(readClaim(openDirectory(path.join(target.ctx.registry, "isolated-1")))).toBeNull();
  });

  it("lets a second tenant on another site join the running shared Chrome warm", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    const runtime = new Hosted();
    let first: Record<string, unknown>;
    let second: Record<string, unknown>;
    try {
      first = await start(target, runtime, { exclusive: false, site: "https://deploy-preview-1--example.netlify.app/" });
      second = await start(target, runtime, { owner: "ses_two", exclusive: false, site: "https://deploy-preview-2--example.netlify.app/" });
      expect(await gate(start(target, runtime, { owner: "ses_three", exclusive: false, site: "https://deploy-preview-1--example.netlify.app/" }))).toBe("browser-controller-busy");
    } finally {
      await runtime.close();
    }
    expect([first.controller_id, second.controller_id]).toEqual(["isolated-1", "isolated-1"]);
    expect(first.launched).toBe(true);
    expect(second.ready).toBe(true);
    expect(second.launched).toBe(false);
    expect(runtime.launches).toBe(1);
    expect(first.lease_id).not.toBe(second.lease_id);
    expect(first.artifacts).not.toBe(second.artifacts);
  });

  it("removes a stale socket before launch", async () => {
    const target = pool();
    const file = path.join(target.ctx.sockets, "isolated-1.sock");
    await staleSocket(file);
    const runtime = new Hosted();
    try {
      const result = await start(target, runtime);
      expect(result.ready && result.launched).toBe(true);
      expect(runtime.launches).toBe(1);
      expect(fs.lstatSync(file).isSocket()).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("blocks launch on a live endpoint without the profile process", async () => {
    const target = pool();
    const file = path.join(target.ctx.sockets, "isolated-1.sock");
    const endpoint = await listen(file);
    let result: Record<string, unknown>;
    const runtime = new FakeRuntime();
    try {
      result = await start(target, runtime);
      expect(fs.lstatSync(file).isSocket()).toBe(true);
    } finally {
      await closeServer(endpoint);
    }
    expect(result.error).toBe("browser-controller-endpoint-busy");
    expect(runtime.launches).toBe(0);
    expect((await operate("release", { owner: "ses_one", lease: result.lease_id, ctx: target.ctx }) as { released: boolean }).released).toBe(true);
  });

  it("reports previously-used for an existing profile without history", async () => {
    const target = pool();
    const profile = path.join(metadata("isolated-1", target.ctx).profile, "Default");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profile, "Preferences"), "{}");
    const result = await start(target, new FakeRuntime(), { exclusive: false, site: STAGING });
    expect(result.sites).toEqual(["example.global"]);
    expect(result.site_state).toBe("previously-used");
    const seen = JSON.parse(fs.readFileSync(path.join(target.ctx.registry, "isolated-1/sites-seen.json"), "utf8"));
    expect(seen).toEqual({ complete: false, sites: { "example.global": null } });
  });

  it("starts a new profile's history complete before the first launch", async () => {
    const target = pool();
    const result = await start(target, new FakeRuntime(), { exclusive: false });
    expect(result.ready).toBe(true);
    expect(result.site_state).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(target.ctx.registry, "isolated-1/sites-seen.json"), "utf8"))).toEqual({ complete: true, sites: {} });
  });
});

describe("provisioning", () => {
  it("creates private directories, the host wrapper and the manifest", () => {
    const target = pool();
    const given = deps(target.root);
    const info = metadata("isolated-4", target.ctx);
    expect(provision(info, given)).toEqual({ host_manifest: "created" });
    for (const key of ["profile", "downloads", "artifacts"] as const) expect(mode(info[key])).toBe(0o700);
    expect(mode(info.host)).toBe(0o700);
    expect(fs.readFileSync(info.host, "utf8")).toBe(`#!/bin/sh\nexport ${HOST_SOCKET_ENV}='${info.socket}'\nexec '${given.node}' '${given.host.hostScript}'\n`);
    const manifest = path.join(info.profile, "NativeMessagingHosts/com.opzero.chrome.json");
    expect(mode(manifest)).toBe(0o600);
    // Q1: the isolated copy's fixed ID replaces pncpgnbanebkeopjghjleodgmphmmmcp.
    expect(JSON.parse(fs.readFileSync(manifest, "utf8"))).toEqual({
      name: "com.opzero.chrome", description: "Chrome Control isolated controller 4", type: "stdio", path: info.host,
      allowed_origins: [`chrome-extension://${ISOLATED_EXTENSION_ID}/`]
    });
    const before = [mtime(manifest), mtime(info.host)];
    expect(provision(info, given)).toEqual({ host_manifest: "generated" });
    expect([mtime(manifest), mtime(info.host)]).toEqual(before);
  });

  it.each(NODES)("requires an absolute executable Node: %s", async (value) => {
    const target = pool();
    let node = value;
    if (value === "not-executable") {
      node = path.join(target.root, "node");
      fs.writeFileSync(node, "");
      fs.chmodSync(node, 0o600);
    }
    expect(await gate(() => provision(metadata("isolated-1", target.ctx), deps(target.root, node)))).toBe("browser-controller-node-unavailable");
  });

  it.each(FOREIGN_MANIFESTS)("refuses and preserves a foreign manifest: %s %s", async (controller, host) => {
    const target = pool();
    const info = metadata(controller, target.ctx);
    const folder = path.join(info.profile, "NativeMessagingHosts");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, "com.opzero.chrome.json");
    const foreign = host === "legacy" ? path.join(target.root, `op-chrome-host-${controller}`) : host;
    fs.writeFileSync(file, JSON.stringify({ name: "com.opzero.chrome", description: "Chrome Control isolated controller 1", type: "stdio", path: foreign, allowed_origins: [ISOLATED_EXTENSION_ORIGIN] }), { mode: 0o600 });
    const before = fs.readFileSync(file, "utf8");
    expect(await gate(() => provision(info, deps(target.root)))).toBe("browser-controller-host-manifest-mismatch");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("configures the download keys through the real runtime", () => {
    const target = pool();
    const info = { ...metadata("isolated-1", target.ctx), profile: path.join(target.root, "profile"), downloads: path.join(target.root, "dl") } as Grant;
    const result = new Runtime(0, target.env).configure(info, { running: false });
    expect(result.downloads_configured && result.preferences_changed).toBe(true);
    const preferences = JSON.parse(fs.readFileSync(path.join(target.root, "profile/Default/Preferences"), "utf8"));
    expect(preferences.download).toEqual({ default_directory: path.join(target.root, "dl"), prompt_for_download: false, directory_upgrade: true });
  });
});

describe("provisioning changes (C2, C3, D1, Q1)", () => {
  it("execs this Node on the stable host copy under the state root", async () => {
    const target = pool();
    const assets = syntheticAssets(target.root);
    const info = metadata("isolated-2", target.ctx);
    const given = await provisionDeps(target.env, assets);
    expect(given.node).toBe(process.execPath);
    expect(given.host.hostScript.startsWith(path.join(target.root, "hosts") + path.sep)).toBe(true);
    expect(fs.readFileSync(given.host.hostScript, "utf8")).toBe(fs.readFileSync(assets.nativeHost, "utf8"));
    provision(info, given);
    const wrapper = fs.readFileSync(info.host, "utf8");
    expect(wrapper).toBe(`#!/bin/sh\nexport ${HOST_SOCKET_ENV}='${info.socket}'\nexec '${process.execPath}' '${given.host.hostScript}'\n`);
    expect(wrapper).not.toContain(assets.root);
    const manifest = JSON.parse(fs.readFileSync(path.join(info.profile, "NativeMessagingHosts/com.opzero.chrome.json"), "utf8"));
    expect(manifest.path).toBe(info.host);
    expect(manifest.allowed_origins).toEqual(["chrome-extension://mpodnojmjjafgogldgieimgbmfhhknbe/"]);
  });

  it("refuses a manifest that still allows only the retired unpacked extension ID", async () => {
    const target = pool();
    const info = metadata("isolated-1", target.ctx);
    const folder = path.join(info.profile, "NativeMessagingHosts");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, "com.opzero.chrome.json"), JSON.stringify({ name: "com.opzero.chrome", description: "x", type: "stdio", path: info.host, allowed_origins: ["chrome-extension://pncpgnbanebkeopjghjleodgmphmmmcp/"] }), { mode: 0o600 });
    expect(await gate(() => provision(info, deps(target.root)))).toBe("browser-controller-host-manifest-mismatch");
  });

  it("refuses a controller socket path over the sockaddr limit", async () => {
    const target = pool();
    const long = { ...target.ctx, sockets: path.join(target.root, "s".repeat(80)) };
    const info = metadata("isolated-1", long);
    expect(await gate(() => provision(info, deps(target.root)))).toBe("browser-controller-unsafe-path");
    expect(fs.existsSync(info.host)).toBe(false);
  });

  it("prepares only an installed runtime and loads the stable extension copy", async () => {
    const target = pool({ CUA_DRIVER: undefined, PATH: "/nonexistent" });
    const assets = syntheticAssets(target.root);
    const info = { ...metadata("isolated-1", target.ctx), owner: "ses_one", lease_id: "11111111-1111-1111-1111-111111111111", mode: "exclusive", sites: [], site_state: null } as Grant;
    for (const directory of [info.profile, info.downloads, info.artifacts]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "darwin") {
      expect(await gate(new Runtime(monotonic() + 5, target.env, assets).prepare(info))).toBe("browser-controller-platform-unsupported");
      return;
    }
    expect(await gate(new Runtime(monotonic() + 5, target.env, assets).prepare(info))).toBe("browser-controller-startup-not-installed");
    const cua = path.join(target.root, "cua-driver");
    fs.writeFileSync(cua, "#!/bin/sh\necho '{\"self_activation_suppressed\": true}'\n", { mode: 0o700 });
    const runtime = new Runtime(monotonic() + 5, { ...target.env, CUA_DRIVER: cua }, assets);
    await runtime.prepare(info);
    const extension = runtime.extension?.dir as string;
    expect(extension.startsWith(path.join(target.root, "extensions") + path.sep)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8")).key).toBeTruthy();
    expect(await runtime.launch(info)).toEqual({ self_activation_suppressed: true });
    fs.chmodSync(info.downloads, 0o755);
    expect(await gate(runtime.prepare(info))).toBe("browser-controller-unsafe-directory");
  });
});
