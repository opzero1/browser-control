// test_native_server.py, routes and leases: a session's tabs go to its browser lease or else the user's
// Chrome, lease tabs carry controller-prefixed handles and pin their own lease, sites held by another tenant
// are refused before any tab exists, and claim_browser starts only isolated profiles. The fixed numbered
// route is not ported (C8); its cleanup-marker tests run on a lease route instead.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserControl } from "../../../src/server/app";
import { Step } from "../../../src/server/args";
import { claim, leaseFor, operate, release } from "../../../src/server/pool/registry";
import { leaseArtifacts, type StartRuntime, type Window } from "../../../src/server/pool/start";
import { processSessionId } from "../../../src/server/session";
import { monotonic } from "../../../src/server/time";
import type { Tab } from "../../../src/server/tabs";
import { removeTempRoots } from "../support/temp";
import {
  Chrome, connectionOf, deferred, FakeConnection, fixture, gate, meta, page, refusal, running, setConnect, type Fixture
} from "./helpers";

afterEach(() => removeTempRoots());

const P1 = "https://deploy-preview-1--reapdirect.netlify.app/login";
const P2 = "https://deploy-preview-2--reapdirect.netlify.app/login";
const OTHER = "https://other.example/";
const SITE1 = "deploy-preview-1--reapdirect.netlify.app";
const SITE2 = "deploy-preview-2--reapdirect.netlify.app";
const USER_PAGE = "https://user.example/";

interface Shared extends Fixture {
  one: Awaited<ReturnType<typeof claim>>;
  two: Awaited<ReturnType<typeof claim>>;
  chrome: Chrome;
  user: Chrome;
  paths: string[];
}

/** ses_one (P1) and ses_two (P2) share isolated-1; ses_three has no lease and uses the user's Chrome. */
async function shared(): Promise<Shared> {
  const f = fixture({ extraEnv: { FAST_CHROME_MAX_CONTROLLERS: "1" } });
  await running(f.sockets, "isolated-1");
  const one = await claim("ses_one", { site: P1, ctx: f.ctx });
  const two = await claim("ses_two", { site: P2, ctx: f.ctx });
  const chromes = new Map([[one.socket, new Chrome([P1, P2, OTHER])], [f.userSocket, new Chrome([P1, OTHER], 500)]]);
  const paths: string[] = [];
  setConnect(f.server, (socket) => {
    paths.push(socket);
    return (chromes.get(socket) as Chrome).connect();
  });
  return { ...f, one, two, chrome: chromes.get(one.socket) as Chrome, user: chromes.get(f.userSocket) as Chrome, paths };
}

/** The user's Chrome and isolated-1 number their tabs alike: both list tabs 10 and 11 and create 111 first. */
async function twin(): Promise<Fixture & { leased: Chrome; user: Chrome }> {
  const f = fixture({ extraEnv: { FAST_CHROME_MAX_CONTROLLERS: "1" } });
  await running(f.sockets, "isolated-1");
  const leasedSocket = path.join(f.sockets, "isolated-1.sock");
  const chromes = new Map([[leasedSocket, new Chrome([P1, OTHER])], [f.userSocket, new Chrome([USER_PAGE, OTHER])]]);
  setConnect(f.server, (socket) => (chromes.get(socket) as Chrome).connect());
  return { ...f, leased: chromes.get(leasedSocket) as Chrome, user: chromes.get(f.userSocket) as Chrome };
}

async function leaseRow(f: Fixture, owner: string): Promise<any> {
  const rows = (await operate("status", { ctx: f.ctx }) as { controllers: any[] }).controllers;
  return rows.flatMap((row) => row.leases).find((lease: any) => lease.owner === owner);
}

function binding(tab: Tab): unknown[] {
  return [tab.controllerId, tab.leaseId, tab.mode, tab.site, tab.artifactRoot];
}

function markerFiles(f: Fixture, controller = "isolated-1"): string[] {
  const directory = path.join(f.ctx.registry, controller);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^tab-.*\.json$/.test(name)) : [];
}

function registryFiles(root: string): Record<string, [number, number]> {
  const result: Record<string, [number, number]> = {};
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const stats = fs.statSync(file, { bigint: true });
        result[path.relative(root, file)] = [Number(stats.size), Number(stats.mtimeNs)];
      }
    }
  };
  walk(root);
  return result;
}

function closePins(server: BrowserControl): void {
  for (const tab of server.registry.values()) tab.controllerPin?.close();
}

describe("routes", () => {
  it("routes to the caller's lease, else the user's Chrome", async () => {
    const f = fixture({ extraEnv: { BROWSER_CONTROL_HOST_SOCKET: "/fixture/default.sock", FAST_CHROME_ARTIFACT_ROOT: "/fixture/artifacts" } });
    expect(await f.server.route("ses_one")).toEqual({
      kind: "user", socket: "/fixture/default.sock", artifactRoot: "/fixture/artifacts", createArtifactRoot: false, controllerId: null,
      leaseId: null, mode: null, sites: []
    });
    const lease = await claim("ses_one", { site: P1, ctx: f.ctx });
    expect(await f.server.route("ses_one")).toEqual({
      kind: "lease", socket: lease.socket, artifactRoot: path.join(lease.artifacts, lease.lease_id), createArtifactRoot: false,
      controllerId: "isolated-1", leaseId: lease.lease_id, mode: "shared", sites: [SITE1]
    });
    expect((await f.server.route("ses_two")).kind).toBe("user");
    expect((await f.server.route("not-a-pool-id")).kind).toBe("user");
  });

  it("binds the lease at open and never reroutes later tools", async () => {
    const s = await shared();
    try {
      const userTab = (await s.server.openTab({ url: "https://example.test/" }, meta("ses_three"))).tab_id as string;
      const opened = await s.server.openTab({ url: P1, group_title: "agent1 · Preview 1" }, meta("ses_one"));
      expect(opened.outcome).toBe("opened");
      expect(opened.site).toBe(SITE1);
      expect(opened.site_state).toBe("fresh");
      expect(s.paths).toEqual([s.userSocket, s.one.socket]);
      const tab = s.server.registry.get(opened.tab_id as string) as Tab;
      expect(binding(tab)).toEqual(["isolated-1", s.one.lease_id, "shared", SITE1, path.join(s.one.artifacts, s.one.lease_id)]);
      expect(binding(s.server.registry.get(userTab) as Tab)).toEqual([null, null, null, null, path.join(s.root, "artifacts/user")]);
      expect((await leaseRow(s, "ses_one")).sites).toEqual([SITE1]);
      // A new lease for ses_three, or a different user socket, never moves an existing tab.
      await release("ses_two", s.two.lease_id, s.ctx);
      const three = await claim("ses_three", { site: OTHER, ctx: s.ctx });
      s.env.BROWSER_CONTROL_HOST_SOCKET = "/fixture/elsewhere.sock";
      const before = [s.chrome.connections, s.user.connections];
      expect((await s.server.observe({ tab_id: userTab }, meta("ses_three"))).url).toBe("https://example.test/");
      expect((await s.server.observe({ tab_id: opened.tab_id }, meta("ses_one"))).url).toBe(P1);
      expect([s.chrome.connections, s.user.connections]).toEqual(before);
      expect(s.paths).toHaveLength(2);
      expect(s.server.registry.get(userTab)?.leaseId).toBeNull();
      expect(three.controller_id).toBe("isolated-1");
    } finally {
      closePins(s.server);
    }
  });

  it("pins a lease tab's bound lease for each call", async () => {
    const s = await shared();
    try {
      const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
      const tab = s.server.registry.get(opened) as Tab;
      tab.controllerPin?.close();
      tab.controllerPin = null;
      const pinned: Array<string | null> = [];
      connectionOf(tab).sideEffect = async (method: string) => {
        if (method === "observePage") pinned.push(await refusal(release("ses_one", s.one.lease_id, s.ctx)));
        return { ...page(), url: P1 };
      };
      expect((await s.server.observe({ tab_id: opened }, meta("ses_one"))).url).toBe(P1);
      expect(pinned).toEqual(["browser-controller-pinned"]);
      expect(await refusal(s.server.observe({ tab_id: opened }, meta("ses_two")))).toBe("fast-chrome-tab-not-owned");
    } finally {
      closePins(s.server);
    }
  });

  it("refuses a site held by another tenant before any tab exists", async () => {
    const s = await shared();
    try {
      expect((await s.server.openTab({ url: P1 }, meta("ses_one"))).outcome).toBe("opened");
      const calls = s.chrome.calls.length;
      expect(await refusal(s.server.openTab({ url: "https://deploy-preview-1--reapdirect.netlify.app/other" }, meta("ses_two")))).toBe("browser-controller-site-conflict");
      // FAST_CHROME_UNSHARED_SITES=reap.global keeps Python's unshared site (C5).
      expect(await refusal(s.server.openTab({ url: "https://staging.dashboard.reap.global/" }, meta("ses_two")))).toBe("browser-controller-site-conflict");
      expect(s.chrome.calls.slice(calls)).toEqual([]);
      expect(s.chrome.connections).toBe(3);
      expect((await s.server.status({}, meta("ses_two"))).pending_tabs).toBe(0);
      expect((await leaseRow(s, "ses_two")).sites).toEqual([SITE2]);
      const second = await s.server.openTab({ url: "https://deploy-preview-1--reapdirect.netlify.app/next" }, meta("ses_one"));
      expect(second.outcome).toBe("opened");
      expect((await leaseRow(s, "ses_one")).sites).toEqual([SITE1]);
      expect((await s.server.openTab({ url: P2 }, meta("ses_two"))).site_state).toBe("fresh");
    } finally {
      closePins(s.server);
    }
  });

  it("lists only a lease route's own sites", async () => {
    const s = await shared();
    try {
      let listed = (await s.server.tabs({}, meta("ses_two"))).tabs as any[];
      expect(listed.map((row) => row.url)).toEqual([P2]);
      expect(listed[0].managed_by_session).toBe(false);
      const opened = (await s.server.openTab({ url: P2 }, meta("ses_two"))).tab_id;
      listed = (await s.server.tabs({}, meta("ses_two"))).tabs as any[];
      expect(listed.map((row) => [row.url, row.managed_by_session])).toEqual([[P2, false], [P2, true]]);
      expect(listed[1].tab_id).toBe(opened);
      expect(JSON.stringify(listed)).not.toContain("deploy-preview-1");
      expect(((await s.server.tabs({}, meta("ses_one"))).tabs as any[]).map((row) => row.url)).toEqual([P1]);
      expect(((await s.server.tabs({}, meta("ses_three"))).tabs as any[]).map((row) => row.url)).toEqual([P1, OTHER]);
    } finally {
      closePins(s.server);
    }
  });

  it("refuses to claim another site's tab on a lease route before claiming", async () => {
    const s = await shared();
    try {
      const ids = new Map([...s.chrome.user].map(([n, url]) => [url, `isolated-1:${n}`]));
      for (const url of [P1, OTHER]) {
        expect(await refusal(s.server.claimTab({ tab_id: ids.get(url) }, meta("ses_two")))).toBe("fast-chrome-tab-unavailable");
      }
      expect(s.chrome.calls).not.toContain("claimUserTab");
      expect((await s.server.status({}, meta("ses_two"))).pending_tabs).toBe(0);
      const claimed = await s.server.claimTab({ tab_id: ids.get(P2) }, meta("ses_two"));
      expect(claimed.outcome).toBe("claimed");
      expect(claimed.site).toBe(SITE2);
      expect(claimed.site_state).toBe("fresh");
      expect(claimed.tab_id).toBe(ids.get(P2));
      expect(binding(s.server.registry.get(ids.get(P2) as string) as Tab).slice(0, 4)).toEqual(["isolated-1", s.two.lease_id, "shared", SITE2]);
      expect((await s.server.status({}, meta("ses_two"))).pending_tabs).toBe(1);
      expect((await s.server.release({ tab_id: ids.get(P2) }, meta("ses_two"))).release_confirmed).toBe(true);
      expect((await s.server.status({}, meta("ses_two"))).pending_tabs).toBe(0);
    } finally {
      closePins(s.server);
    }
  });

  it("reports only the caller's route and lease in status", async () => {
    const s = await shared();
    try {
      await s.server.openTab({ url: P1 }, meta("ses_one"));
      expect(await s.server.status({}, meta("ses_one"))).toEqual({
        backend: "browser-control", ready: true, protocol: 2, page_protocol: 2, extension_version: "0.2.0", route: "lease",
        controller_id: "isolated-1", lease_id: s.one.lease_id, mode: "shared", sites: [SITE1], pending_tabs: 1
      });
      const two = await s.server.status({}, meta("ses_two"));
      expect(two.lease_id).toBe(s.two.lease_id);
      expect(two.sites).toEqual([SITE2]);
      expect(two.pending_tabs).toBe(0);
      for (const value of ["ses_one", s.one.lease_id, SITE1]) expect(JSON.stringify(two)).not.toContain(value);
      expect(await s.server.status({}, meta("ses_three"))).toEqual({
        backend: "browser-control", ready: true, protocol: 2, page_protocol: 2, extension_version: "0.2.0", route: "user"
      });
      setConnect(s.server, () => { throw gate("opchrome-unavailable"); });
      const stopped = await s.server.status({}, meta("ses_one"));
      expect(stopped.ready).toBe(false);
      expect(stopped.error).toBe("browser-control-unavailable");
      expect(stopped.lease_id).toBe(s.one.lease_id);
      expect(await refusal(s.server.status({}, meta("ses_three")))).toBe("browser-control-unavailable");
    } finally {
      closePins(s.server);
    }
  });

  it("writes captures under the tab's own artifact root", async () => {
    const s = await shared();
    try {
      const userRoot = path.join(s.root, "user-artifacts");
      fs.mkdirSync(userRoot, { mode: 0o700 });
      s.env.FAST_CHROME_ARTIFACT_ROOT = userRoot;
      const leaseRoot = leaseArtifacts(s.one);
      const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id;
      const userTab = (await s.server.openTab({ url: "https://example.test/" }, meta("ses_three"))).tab_id;
      expect((await s.server.screenshot({ tab_id: opened }, meta("ses_one")))[0].type).toBe("image");
      const captured = (root: string) => fs.readdirSync(root).filter((name) => name.startsWith("chrome-capture-") && fs.existsSync(path.join(root, name, "screenshot.jpg")));
      expect(captured(leaseRoot)).toHaveLength(1);
      expect(fs.readdirSync(userRoot)).toEqual([]);
      await s.server.screenshot({ tab_id: userTab }, meta("ses_three"));
      expect(captured(userRoot)).toHaveLength(1);
      const twoRoot = path.join(s.two.artifacts, s.two.lease_id);
      await s.server.openTab({ url: P2 }, meta("ses_two"));
      const twoTab = s.server.registry.values().find((tab) => tab.owner === "ses_two") as Tab;
      expect(await refusal(s.server.screenshot({ tab_id: twoTab.key }, meta("ses_two")))).toBe("fast-chrome-private-artifact-root-required");
      expect(fs.existsSync(twoRoot)).toBe(false);
    } finally {
      closePins(s.server);
    }
  });

  it("refuses another tenant's use of a lease tab before any call or registry write", async () => {
    const actions: Array<(server: BrowserControl, tab: string) => Promise<unknown>> = [
      (server, tab) => server.claimTab({ tab_id: tab }, meta("ses_two")),
      (server, tab) => server.nameGroup({ tab_id: tab, title: "Fixture" }, meta("ses_two")),
      (server, tab) => server.observe({ tab_id: tab }, meta("ses_two")),
      (server, tab) => server.waitFor({ tab_id: tab, expect: null as never }, meta("ses_two")),
      (server, tab) => server.navigate({ tab_id: tab, url: P1 }, meta("ses_two")),
      (server, tab) => server.act({ tab_id: tab, snapshot_id: "snapshot", action_id: "0" }, meta("ses_two")),
      (server, tab) => server.actSteps({ tab_id: tab, steps: [new Step({ label: "Continue" })] }, meta("ses_two")),
      (server, tab) => server.uploadFile({ tab_id: tab, snapshot_id: "snapshot", action_id: "0", path: "/public.pdf" }, meta("ses_two")),
      (server, tab) => server.paste1PasswordField({ tab_id: tab, expected_url: P1, expected_email: "synthetic@example.test", field: "password", selector: "#password" }, meta("ses_two")),
      (server, tab) => server.screenshot({ tab_id: tab }, meta("ses_two")),
      (server, tab) => server.startRecording({ tab_id: tab }, meta("ses_two")),
      (server, tab) => server.stopRecording({ tab_id: tab }, meta("ses_two")),
      (server, tab) => server.release({ tab_id: tab }, meta("ses_two"))
    ];
    for (const action of actions) {
      const s = await shared();
      try {
        const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
        const vault: unknown[] = [];
        s.server.paste = async (...args) => {
          vault.push(args);
          return {};
        };
        const calls = s.chrome.calls.length;
        const connections = s.chrome.connections;
        const files = registryFiles(s.ctx.registry);
        expect(await refusal(action(s.server, opened))).toBe("fast-chrome-tab-not-owned");
        expect(s.chrome.calls.slice(calls)).toEqual([]);
        expect(s.chrome.connections).toBe(connections);
        expect(registryFiles(s.ctx.registry)).toEqual(files);
        expect(vault).toEqual([]);
      } finally {
        closePins(s.server);
      }
    }
  });

  it("reports the lease tab handle from the private transfer", async () => {
    const s = await shared();
    try {
      const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
      const tab = s.server.registry.get(opened) as Tab;
      s.server.paste = async (held) => ({ outcome: "filled", tab_id: String(held.id), retry: false });
      const result = await s.server.paste1PasswordField({
        tab_id: opened, expected_url: P1, expected_email: "synthetic@example.test", field: "one-time password", selector: "#otp"
      }, meta("ses_one"));
      expect(opened).toBe(`isolated-1:${tab.id}`);
      expect(result).toEqual({ outcome: "filled", tab_id: opened, retry: false });
    } finally {
      closePins(s.server);
    }
  });

  it("refuses an open before dispatch without an incomplete receipt", async () => {
    const s = await shared();
    try {
      expect(await refusal(s.server.openTab({ url: P2, group_title: " padded " }, meta("ses_two")))).toBe("fast-chrome-group-title-required");
      expect(s.paths).toEqual([]);
      expect(await refusal(s.server.openTab({ url: P1 }, meta("ses_two")))).toBe("browser-controller-site-conflict");
      expect(s.chrome.calls).toEqual([]);
      expect((await s.server.status({}, meta("ses_two"))).pending_tabs).toBe(0);
    } finally {
      closePins(s.server);
    }
  });
});

describe("lease cleanup markers (ported from the numbered-entry tests, C8)", () => {
  it("pins a lease tab between calls and releases the lease after confirmed cleanup", async () => {
    const s = await shared();
    try {
      const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
      expect(await refusal(release("ses_one", s.one.lease_id, s.ctx))).toBe("browser-controller-pinned");
      expect((await s.server.release({ tab_id: opened }, meta("ses_one"))).release_confirmed).toBe(true);
      expect((await release("ses_one", s.one.lease_id, s.ctx)).released).toBe(true);
    } finally {
      closePins(s.server);
    }
  });

  it("keeps a failed cleanup's marker through the server's cleanup", async () => {
    const s = await shared();
    const opened = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
    connectionOf(s.server.registry.get(opened) as Tab).sideEffect = gate("opchrome-outcome-unknown");
    expect(await refusal(s.server.release({ tab_id: opened }, meta("ses_one")))).toBe("browser-control-outcome-unknown");
    await s.server.cleanup(monotonic() + 2.5);
    expect(s.server.registry.tabs.size).toBe(0);
    expect(markerFiles(s)).toHaveLength(1);
    expect(await refusal(release("ses_one", s.one.lease_id, s.ctx))).toBe("browser-controller-cleanup-unconfirmed");
  });

  it("leaves a persistent cleanup block after an unknown create without a handle", async () => {
    const s = await shared();
    const conn = new FakeConnection();
    conn.alive = false;
    conn.sideEffect = gate("opchrome-outcome-unknown");
    setConnect(s.server, () => conn);
    const result = await s.server.openTab({ url: P1 }, meta("ses_one"));
    expect(result.cleanup).toBe("unconfirmed");
    expect(result.tab_id).toBeNull();
    expect(markerFiles(s)).toHaveLength(1);
    expect(await refusal(release("ses_one", s.one.lease_id, s.ctx))).toBe("browser-controller-cleanup-unconfirmed");
  });

  it("leaves no cleanup marker after a claim refused before dispatch", async () => {
    const s = await shared();
    setConnect(s.server, () => new FakeConnection([]));
    expect(await refusal(s.server.claimTab({ tab_id: "isolated-1:10" }, meta("ses_one")))).toBe("fast-chrome-tab-unavailable");
    expect(markerFiles(s)).toEqual([]);
    expect((await release("ses_one", s.one.lease_id, s.ctx)).released).toBe(true);
  });
});

/** Replaces the startup runtime: one fake background Chrome per controller, no Cua or real profile. */
class FakeRuntime implements StartRuntime {
  pids = new Map<string, number>();
  launches: string[] = [];
  provision(): void {}
  prepare(): void {}
  processes(info: { controller_id: string }): number[] {
    const pid = this.pids.get(info.controller_id);
    return pid === undefined ? [] : [pid];
  }
  probe(info: { controller_id: string }): boolean {
    return this.pids.has(info.controller_id);
  }
  configure(_info: unknown, options: { running: boolean }): Record<string, boolean> {
    return { password_saving_disabled: true, downloads_configured: true, preferences_changed: !options.running };
  }
  async launch(info: { controller_id: string; socket: string }): Promise<void> {
    this.launches.push(info.controller_id);
    this.pids.set(info.controller_id, 4000 + this.launches.length);
    await running(path.dirname(info.socket), info.controller_id);
  }
  windows(pid: number): Window[] {
    return [{ pid, window_id: pid + 1, bounds: { width: 800, height: 600 } }];
  }
}

describe("browser leases", () => {
  it("leases, shares and starts only isolated profiles", async () => {
    const runtime = new FakeRuntime();
    const f = fixture({ startRuntime: () => runtime, extraEnv: { FAST_CHROME_MAX_CONTROLLERS: "1" } });
    const first = await f.server.claimBrowser({ site: P1 }, meta("ses_one"));
    expect([first.controller_id, first.mode, first.sites, first.site_state, first.server]).toEqual(["isolated-1", "shared", [SITE1], "fresh", "browser-control"]);
    expect(first.ready).toBe(true);
    expect(first.launched).toBe(true);
    expect(fs.statSync(first.artifacts as string).isDirectory()).toBe(true);
    for (const key of ["pid", "windows", "downloads", "profile", "socket"]) expect(first).not.toHaveProperty(key);
    const second = await f.server.claimBrowser({ site: P2 }, meta("ses_two"));
    expect(second.controller_id).toBe("isolated-1");
    expect(second.ready).toBe(true);
    expect(second.launched).toBe(false);
    const again = await f.server.claimBrowser({ site: "https://deploy-preview-1--reapdirect.netlify.app/x" }, meta("ses_one"));
    expect(again.lease_id).toBe(first.lease_id);
    expect(again.launched).toBe(false);
    expect(runtime.launches).toEqual(["isolated-1"]);
    expect(await refusal(f.server.claimBrowser({ site: P1 }, meta("ses_two")))).toBe("browser-controller-site-conflict");
    expect(await refusal(f.server.claimBrowser({ exclusive: true }, meta("ses_one")))).toBe("browser-controller-lease-mode-mismatch");
    expect(await refusal(f.server.claimBrowser({ exclusive: true }, meta("ses_three")))).toBe("browser-controller-busy");
    f.env.FAST_CHROME_MAX_CONTROLLERS = "2";
    const exclusive = await f.server.claimBrowser({ exclusive: true }, meta("ses_three"));
    expect(exclusive.controller_id).toBe("isolated-2");
    expect(exclusive.mode).toBe("exclusive");
    expect(exclusive.launched).toBe(true);
    expect(exclusive.pid).toBe(4002);
    expect(exclusive.windows).toBeTruthy();
    expect(exclusive.downloads).toBeTruthy();
    expect((await f.server.route("ses_two")).leaseId).toBe(second.lease_id);
    expect((await f.server.route("ses_three")).mode).toBe("exclusive");
    // C7: without session metadata the call uses the process session, which gets its own lease.
    const anonymous = await f.server.claimBrowser({}, undefined);
    expect(anonymous.ready).toBe(true);
    expect((await leaseFor(processSessionId(), f.ctx))?.lease_id).toBe(anonymous.lease_id);
    await release(processSessionId(), anonymous.lease_id, f.ctx);
  });

  it("needs released tabs to release a browser and ignores other tenants", async () => {
    const s = await shared();
    try {
      const oneTab = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id;
      const twoTab = (await s.server.openTab({ url: P2 }, meta("ses_two"))).tab_id;
      const connections = s.paths.length;
      expect(await refusal(s.server.releaseBrowser({ lease_id: s.one.lease_id }, meta("ses_one")))).toBe("fast-chrome-release-tabs-first");
      for (const name of ["ses_two", "ses_three"]) {
        expect(await refusal(s.server.releaseBrowser({ lease_id: s.one.lease_id }, meta(name)))).toBe("browser-controller-lease-not-owned");
      }
      expect(await refusal(s.server.releaseBrowser({ lease_id: "not-a-lease" }, meta("ses_one")))).toBe("browser-controller-lease-not-owned");
      expect((await leaseRow(s, "ses_one")).lease_id).toBe(s.one.lease_id);
      expect(s.paths).toHaveLength(connections);
      expect((await s.server.release({ tab_id: oneTab }, meta("ses_one"))).release_confirmed).toBe(true);
      expect(await s.server.releaseBrowser({ lease_id: s.one.lease_id }, meta("ses_one"))).toEqual({ controller_id: "isolated-1", released: true, controller_idle: false });
      expect((await s.server.route("ses_one")).kind).toBe("user");
      expect((await s.server.observe({ tab_id: twoTab }, meta("ses_two"))).url).toBe(P2);
      expect((await s.server.release({ tab_id: twoTab }, meta("ses_two"))).release_confirmed).toBe(true);
      expect((await s.server.releaseBrowser({ lease_id: s.two.lease_id }, meta("ses_two"))).controller_idle).toBe(true);
    } finally {
      closePins(s.server);
    }
  });
});

describe("equal Chrome tab IDs", () => {
  it("keeps equal Chrome tab IDs in two Chromes distinct for different owners", async () => {
    const t = await twin();
    try {
      await claim("ses_one", { site: P1, ctx: t.ctx });
      const userTab = await t.server.openTab({ url: "https://example.test/" }, meta("ses_three"));
      const leasedTab = await t.server.openTab({ url: P1 }, meta("ses_one"));
      expect([userTab.outcome, leasedTab.outcome]).toEqual(["opened", "opened"]);
      expect([userTab.tab_id, leasedTab.tab_id]).toEqual(["111", "isolated-1:111"]);
      expect((await t.server.claimTab({ tab_id: "10" }, meta("ses_three"))).outcome).toBe("claimed");
      expect((await t.server.claimTab({ tab_id: "isolated-1:10" }, meta("ses_one"))).outcome).toBe("claimed");
      expect(t.user.calls.filter((method) => method === "claimUserTab")).toHaveLength(1);
      expect(t.leased.calls.filter((method) => method === "claimUserTab")).toHaveLength(1);
      expect(new Set(t.server.registry.tabs.keys())).toEqual(new Set(["111", "10", "isolated-1:111", "isolated-1:10"]));
      for (const [handle, name] of [["111", "ses_one"], ["10", "ses_one"], ["isolated-1:111", "ses_three"], ["isolated-1:10", "ses_three"]]) {
        expect(await refusal(t.server.observe({ tab_id: handle }, meta(name)))).toBe("fast-chrome-tab-not-owned");
      }
      expect((await t.server.observe({ tab_id: "isolated-1:111" }, meta("ses_one"))).url).toBe(P1);
      expect((await t.server.observe({ tab_id: "111" }, meta("ses_three"))).url).toBe("https://example.test/");
      expect(((await t.server.tabs({}, meta("ses_one"))).tabs as any[]).map((row) => row.tab_id)).toEqual(["isolated-1:111", "isolated-1:10"]);
      expect(((await t.server.tabs({}, meta("ses_three"))).tabs as any[]).map((row) => row.tab_id)).toEqual(["11", "111", "10"]);
      const finalized = [t.user.calls.filter((m) => m === "finalizeTabs").length, t.leased.calls.filter((m) => m === "finalizeTabs").length];
      for (const handle of ["isolated-1:111", "isolated-1:10"]) expect((await t.server.release({ tab_id: handle }, meta("ses_one"))).tab_id).toBe(handle);
      expect([t.user.calls.filter((m) => m === "finalizeTabs").length, t.leased.calls.filter((m) => m === "finalizeTabs").length]).toEqual([finalized[0], finalized[1] + 2]);
      expect(new Set(t.server.registry.tabs.keys())).toEqual(new Set(["111", "10"]));
    } finally {
      closePins(t.server);
    }
  });

  it("never lets a retained user tab stand in for a leased tab with the same ID", async () => {
    const t = await twin();
    try {
      const userTab = (await t.server.openTab({ url: "https://example.test/" }, meta("ses_one"))).tab_id as string;
      expect((await t.server.claimTab({ tab_id: "10" }, meta("ses_one"))).outcome).toBe("claimed");
      const lease = await claim("ses_one", { site: P1, ctx: t.ctx });
      const listed = (await t.server.tabs({}, meta("ses_one"))).tabs as any[];
      expect(listed.map((row) => [row.tab_id, row.managed_by_session])).toEqual([["isolated-1:10", false], ["111", true], ["10", true]]);
      const claimed = await t.server.claimTab({ tab_id: "isolated-1:10" }, meta("ses_one"));
      expect(claimed.outcome).toBe("claimed");
      expect(claimed.tab_id).toBe("isolated-1:10");
      expect(claimed.site).toBe(SITE1);
      expect(t.leased.calls.filter((m) => m === "claimUserTab")).toHaveLength(1);
      expect(t.user.calls.filter((m) => m === "claimUserTab")).toHaveLength(1);
      expect(t.server.registry.get("isolated-1:10")?.leaseId).toBe(lease.lease_id);
      expect(t.server.registry.get("10")?.leaseId).toBeNull();
      // The retained user tab keeps its own handle and Chrome after the route changed.
      const reads = t.leased.calls.filter((m) => m === "observePage").length;
      expect((await t.server.claimTab({ tab_id: "10" }, meta("ses_one"))).url).toBe(USER_PAGE);
      expect(t.leased.calls.filter((m) => m === "observePage")).toHaveLength(reads);
      expect(t.leased.calls.filter((m) => m === "claimUserTab")).toHaveLength(1);
      const opened = await t.server.openTab({ url: P1 }, meta("ses_one"));
      expect(opened.outcome).toBe("opened");
      expect(opened.tab_id).toBe("isolated-1:111");
      // Failed cleanup leaves the user tab terminal and changes nothing for the leased tabs.
      connectionOf(t.server.registry.get(userTab) as Tab).sideEffect = gate("opchrome-outcome-unknown");
      expect(await refusal(t.server.release({ tab_id: userTab }, meta("ses_one")))).toBe("browser-control-outcome-unknown");
      expect(await refusal(t.server.observe({ tab_id: userTab }, meta("ses_one")))).toBe("fast-chrome-tab-terminal");
      expect((await t.server.observe({ tab_id: "isolated-1:111" }, meta("ses_one"))).url).toBe(P1);
      for (const handle of ["isolated-1:111", "isolated-1:10", "10"]) {
        expect((await t.server.release({ tab_id: handle }, meta("ses_one"))).release_confirmed).toBe(true);
      }
      expect((await t.server.status({}, meta("ses_one"))).pending_tabs).toBe(0);
      expect((await t.server.releaseBrowser({ lease_id: lease.lease_id }, meta("ses_one"))).released).toBe(true);
      const rows = (await t.server.tabs({}, meta("ses_one"))).tabs as any[];
      expect(rows).toContainEqual({ tab_id: "111", origin: "https://example.test", terminal: true, cleanup: "unconfirmed", managed_by_session: true });
    } finally {
      closePins(t.server);
    }
  });

  it("keeps release, reclaim and other input off a tab while its action runs", async () => {
    const t = await twin();
    try {
      expect((await t.server.claimTab({ tab_id: "10" }, meta("ses_three"))).outcome).toBe("claimed");
      const held = t.server.registry.get("10") as Tab;
      const observed = await t.server.observe({ tab_id: "10" }, meta("ses_three"));
      const connection = connectionOf(held);
      const original = connection.sideEffect as (method: string, params: unknown) => unknown;
      const entered = deferred();
      const finish = deferred();
      connection.sideEffect = async (method: string, params: unknown) => {
        if (method === "actPage") {
          entered.resolve();
          await finish.promise;
        }
        return original(method, params);
      };
      const pending = t.server.act({ tab_id: "10", snapshot_id: observed.snapshot_id, action_id: "0" }, meta("ses_three"));
      try {
        await entered.promise;
        for (const call of [
          () => t.server.release({ tab_id: "10" }, meta("ses_three")),
          () => t.server.claimTab({ tab_id: "10" }, meta("ses_three")),
          () => t.server.actSteps({ tab_id: "10", steps: [new Step({ label: "Continue" })] }, meta("ses_three")),
          () => t.server.observe({ tab_id: "10" }, meta("ses_three"))
        ]) {
          expect(await refusal(call())).toBe("fast-chrome-tab-busy");
        }
      } finally {
        finish.resolve();
      }
      expect((await pending).outcome).toBe("executed");
      expect(t.user.calls.filter((m) => m === "actPage")).toHaveLength(1);
      expect(t.server.registry.get("10")).toBe(held);
      // Once released, the preserved tab is re-claimed as a new object; the old one is never used again.
      expect((await t.server.release({ tab_id: "10" }, meta("ses_three"))).release_confirmed).toBe(true);
      expect((await t.server.claimTab({ tab_id: "10" }, meta("ses_three"))).outcome).toBe("claimed");
      expect(t.server.registry.get("10")).not.toBe(held);
      expect(held.releaseAttempted).toBe(true);
      const used = connection.calls.length;
      expect((await t.server.observe({ tab_id: "10" }, meta("ses_three"))).tab_id).toBe("10");
      expect(connection.calls).toHaveLength(used);
    } finally {
      closePins(t.server);
    }
  });
});

