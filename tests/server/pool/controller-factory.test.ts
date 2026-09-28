// Port of test_controller_factory.py: shared and exclusive allocation, limits, site conflicts, release,
// lifecycle gates (reap and reset), legacy record compatibility and the operator CLI.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { userArtifactRoot } from "../../../src/server/config";
import { captureDirectory } from "../../../src/server/captures";
import { openDirectory, writeJson } from "../../../src/server/fs-private";
import { provision } from "../../../src/server/pool/provision";
import {
  claim as poolClaim, leaseFor, MAX_LEASE_SITES, MAX_SEEN_SITES, maxControllers, maxTenants, metadata, operate, Pin, reap as poolReap, release,
  reset, slot, type ControllerMetadata, type ReapHost
} from "../../../src/server/pool/registry";
import { killChildren, startChild } from "../support/children";
import { removeTempRoots, testEnv } from "../support/temp";
import { call, child, closeServer, gate, listen, P1, P2, P3, pool, registryPath, rows, running, serialSuite, STAGING, syntheticAssets, tempDir, withEnv, type Pool } from "./helpers";

serialSuite();

afterEach(() => {
  vi.restoreAllMocks();
  killChildren();
  removeTempRoots();
});

function claim(target: Pool, owner: string, options: { site?: string | null; exclusive?: boolean; controller?: string | null } = {}) {
  return poolClaim(owner, { ...options, ctx: target.ctx });
}

/** FAST_CHROME_UNSHARED_SITES=example.global keeps the unshared-site tests' intent (C5: the default is none). */
const UNSHARED = { FAST_CHROME_UNSHARED_SITES: "example.global" };

describe("allocation", () => {
  it("gives concurrent shared claims their own Chrome first", async () => {
    const target = pool();
    const claims = await Promise.all([P1, P2, P3].map((site, n) => call(target, "claim", { owner: `ses_${n}`, site })));
    expect(new Set(claims.map((item) => item.controller_id))).toEqual(new Set(["isolated-1", "isolated-2", "isolated-3"]));
    expect(claims.every((item) => item.mode === "shared" && item.site_state === "fresh")).toBe(true);
    expect(Object.values(await rows(target)).every((row) => row.claim === null)).toBe(true);
    expect((await call(target, "claim", { owner: "ses_four", site: P1 })).error).toBe("browser-controller-busy");
  }, 30000);

  it("keeps same-owner concurrent shared claims idempotent", async () => {
    const target = pool();
    const claims = await Promise.all([0, 1, 2].map(() => call(target, "claim", { owner: "ses_one", site: P1 })));
    expect(claims[1]).toEqual(claims[0]);
    expect(claims[2]).toEqual(claims[0]);
    expect(Object.values(await rows(target)).reduce((total, row) => total + row.leases.length, 0)).toBe(1);
  }, 30000);

  it("retries a lock file create that races another process", async () => {
    const target = pool();
    // macOS can fail O_CREAT with ENOENT while another process creates the same name.
    const real = fs.openSync;
    const failures: string[] = [];
    let limit = 2;
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
      if (path.basename(String(file)) === "allocation.lock" && typeof flags === "number" && flags & fs.constants.O_CREAT && failures.length < limit) {
        failures.push(String(file));
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
      return real(file, flags, mode);
    }) as typeof fs.openSync);
    expect((await claim(target, "ses_one", { site: P1 })).controller_id).toBe("isolated-1");
    expect(failures).toHaveLength(2);
    failures.length = 0;
    limit = 3;
    // An existing lock file is never reopened (lock.ts), so the create path needs the file to be missing again.
    fs.rmSync(path.join(target.ctx.registry, "allocation.lock"));
    expect(await gate(claim(target, "ses_two", { site: P2 }))).toBe("browser-controller-invalid-registry");
  });

  it("defaults, clamps and rejects the limits", async () => {
    const target = pool();
    expect(maxControllers(target.env)).toBe(3);
    expect(maxTenants(target.env)).toBe(3);
    for (const [value, expected] of [["20", 8], ["0", 1], ["-5", 1], ["2", 2], [" ", 3]] as const) {
      expect(maxControllers({ ...target.env, FAST_CHROME_MAX_CONTROLLERS: value })).toBe(expected);
    }
    expect(await gate(claim(withEnv(target, { FAST_CHROME_MAX_CONTROLLERS: "three" }), "ses_one"))).toBe("browser-controller-invalid-limit");
  });

  it("caps controllers at eight", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "20" });
    const claims = [];
    for (let n = 0; n < 8; n += 1) claims.push(await claim(target, `ses_${n}`, { exclusive: true }));
    expect(claims.map((item) => item.controller_id)).toEqual(Array.from({ length: 8 }, (_, n) => `isolated-${n + 1}`));
    // D6: one server name for every controller.
    expect(claims[4].server).toBe("browser-control");
    expect(claims[0].server).toBe("browser-control");
    expect(await gate(claim(target, "ses_nine", { exclusive: true }))).toBe("browser-controller-busy");
    expect(await gate(() => metadata("isolated-9", target.ctx))).toBe("browser-controller-unknown");
  });

  it("caps new controllers and explicit claims at the limit", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "2" });
    await claim(target, "ses_one", { site: P1 });
    await claim(target, "ses_two", { site: P2 });
    expect(await gate(claim(target, "ses_three", { site: P3 }))).toBe("browser-controller-busy");
    expect(await gate(claim(target, "ses_three", { exclusive: true, controller: "isolated-3" }))).toBe("browser-controller-over-limit");
    expect(fs.existsSync(registryPath(target, "isolated-3"))).toBe(false);
  });

  it("reuses an idle controller before a new one, running ones first", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "4" });
    const [first, second] = [await claim(target, "ses_0", { exclusive: true }), await claim(target, "ses_1", { exclusive: true })];
    await claim(target, "ses_2", { exclusive: true });
    for (const item of [first, second]) expect((await release(item.owner, item.lease_id, target.ctx)).controller_idle).toBe(true);
    await running(target, "isolated-2");
    expect((await claim(target, "ses_d", { site: P1 })).controller_id).toBe("isolated-2");
    expect((await claim(target, "ses_e", { exclusive: true })).controller_id).toBe("isolated-1");
    expect(fs.existsSync(registryPath(target, "isolated-4"))).toBe(false);
    expect((await claim(target, "ses_f", { exclusive: true })).controller_id).toBe("isolated-4");
  });

  it("packs shared claims only at the limit and respects the tenant cap", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "2", FAST_CHROME_MAX_TENANTS: "2" });
    expect((await claim(target, "ses_a", { site: P1 })).controller_id).toBe("isolated-1");
    expect((await claim(target, "ses_b", { site: P2 })).controller_id).toBe("isolated-2");
    expect(await gate(claim(target, "ses_c", { site: P3 }))).toBe("browser-controller-busy");
    await running(target, "isolated-1", "isolated-2");
    expect((await claim(target, "ses_c", { site: P3 })).controller_id).toBe("isolated-1");
    expect((await claim(target, "ses_d")).controller_id).toBe("isolated-2");
    expect(await gate(claim(target, "ses_e", { site: "https://example.com/" }))).toBe("browser-controller-busy");
    expect(Object.values(await rows(target)).slice(0, 2).map((row) => row.leases.length)).toEqual([2, 2]);
  });

  it("sends a same-site claim to another controller", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "2" });
    await running(target, "isolated-1", "isolated-2");
    expect((await claim(target, "ses_a", { site: P1 })).controller_id).toBe("isolated-1");
    expect((await claim(target, "ses_b", { site: P2 })).controller_id).toBe("isolated-2");
    expect((await claim(target, "ses_c", { site: P1 })).controller_id).toBe("isolated-2");
    expect((await claim(target, "ses_d", { site: P2 })).controller_id).toBe("isolated-1");
    expect(await gate(claim(target, "ses_e", { site: P1 }))).toBe("browser-controller-busy");
    expect(await gate(claim(target, "ses_e", { site: P1, controller: "isolated-1" }))).toBe("browser-controller-site-conflict");
  });

  it("blocks sharing both ways with an exclusive lease", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const exclusive = await claim(target, "ses_a", { exclusive: true });
    expect(await gate(claim(target, "ses_b", { site: P1 }))).toBe("browser-controller-busy");
    await release("ses_a", exclusive.lease_id, target.ctx);
    await claim(target, "ses_b", { site: P1 });
    expect(await gate(claim(target, "ses_c", { exclusive: true }))).toBe("browser-controller-busy");
  });

  it("never shares an unshared-site lease in either direction", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1", ...UNSHARED });
    await running(target, "isolated-1");
    const staging = await claim(target, "ses_a", { site: STAGING });
    expect(staging.sites).toEqual(["example.global"]);
    expect(staging.mode).toBe("shared");
    expect(await gate(claim(target, "ses_b", { site: P1 }))).toBe("browser-controller-busy");
    expect(await gate(claim(target, "ses_b"))).toBe("browser-controller-busy");
    await release("ses_a", staging.lease_id, target.ctx);
    await claim(target, "ses_b", { site: P1 });
    expect(await gate(claim(target, "ses_c", { site: "https://dashboard.example.global/" }))).toBe("browser-controller-busy");
  });

  it("refuses a shared tenant adding an unshared site beside another tenant", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1", ...UNSHARED });
    await running(target, "isolated-1");
    const first = await claim(target, "ses_a", { site: P1 });
    const second = await claim(target, "ses_b", { site: P2 });
    let pin = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    try {
      expect(await gate(pin.beginTab(STAGING))).toBe("browser-controller-site-conflict");
      expect(pin.marker).toBeNull();
    } finally {
      pin.close();
    }
    expect(await gate(claim(target, "ses_b", { site: STAGING }))).toBe("browser-controller-site-conflict");
    expect((await rows(target))["isolated-1"].pending_tabs).toBe(0);
    await release("ses_a", first.lease_id, target.ctx);
    pin = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    try {
      expect(await pin.beginTab(STAGING)).toEqual({ site: "example.global", site_state: "fresh" });
      pin.confirmed();
    } finally {
      pin.close();
    }
    expect(await gate(claim(target, "ses_c", { site: P3 }))).toBe("browser-controller-busy");
  });

  it("disables sharing with one tenant", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1", FAST_CHROME_MAX_TENANTS: "1" });
    await running(target, "isolated-1");
    await claim(target, "ses_a", { site: P1 });
    expect(await gate(claim(target, "ses_b", { site: P2 }))).toBe("browser-controller-busy");
  });
});

describe("unshared sites (C5, D8)", () => {
  it("shares every site when FAST_CHROME_UNSHARED_SITES is unset", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    await claim(target, "ses_a", { site: STAGING });
    expect((await claim(target, "ses_b", { site: P1 })).controller_id).toBe("isolated-1");
  });

  it("fails closed on an invalid FAST_CHROME_UNSHARED_SITES entry", async () => {
    const target = withEnv(pool(), { FAST_CHROME_UNSHARED_SITES: "example.global, dashboard.example.global" });
    expect(await gate(claim(target, "ses_a", { site: P1 }))).toBe("browser-controller-invalid-unshared-sites");
    expect(await gate(claim(target, "ses_a", { exclusive: true }))).toBe("browser-controller-invalid-unshared-sites");
  });
});

describe("site gates and pins", () => {
  it("refuses the same site before writing a marker", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const first = await claim(target, "ses_a");
    const second = await claim(target, "ses_b");
    let pin = await Pin.open("isolated-1", "ses_a", first.lease_id, target.ctx);
    try {
      expect(await pin.beginTab("https://a.example.com/")).toEqual({ site: "example.com", site_state: "fresh" });
    } finally {
      pin.close();
    }
    pin = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    try {
      expect(await gate(pin.beginTab("https://b.example.com/"))).toBe("browser-controller-site-conflict");
      expect((await pin.beginTab("https://example.org/"))?.site).toBe("example.org");
    } finally {
      pin.close();
    }
    const leases = Object.fromEntries((await rows(target))["isolated-1"].leases.map((lease: { owner: string; sites: string[] }) => [lease.owner, lease.sites]));
    expect(leases).toEqual({ ses_a: ["example.com"], ses_b: ["example.org"] });
    expect((await rows(target))["isolated-1"].pending_tabs).toBe(2);
  });

  it("has one winner among concurrent same-site gates", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const leases = [await claim(target, "ses_0"), await claim(target, "ses_1")];
    const results = await Promise.all(leases.map((lease) => child(target, ["begin", "isolated-1", lease.owner, lease.lease_id, "https://shared.example.net/"])));
    expect(results.map((result) => String(result?.error ?? null)).sort()).toEqual(["browser-controller-site-conflict", "null"]);
    expect((await rows(target))["isolated-1"].pending_tabs).toBe(1);
  }, 30000);

  it("lets a tenant release while another tenant has a live tab", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const first = await claim(target, "ses_a", { site: P1 });
    const second = await claim(target, "ses_b", { site: P2 });
    const pin = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    await pin.beginTab(P2);
    expect(await call(target, "release", { owner: "ses_a", lease_id: first.lease_id })).toEqual({ controller_id: "isolated-1", released: true, controller_idle: false });
    expect((await call(target, "release", { owner: "ses_b", lease_id: second.lease_id })).error).toBe("browser-controller-pinned");
    pin.confirmed();
    expect((await call(target, "release", { owner: "ses_b", lease_id: second.lease_id })).controller_idle).toBe(true);
  }, 30000);

  it("keeps a marker after a crash", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const first = await claim(target, "ses_a", { site: P1 });
    const second = await claim(target, "ses_b", { site: P2 });
    await child(target, ["begin", "isolated-1", "ses_b", second.lease_id, "https://deploy-preview-2--example.netlify.app/next"]);
    expect((await call(target, "release", { owner: "ses_b", lease_id: second.lease_id })).error).toBe("browser-controller-cleanup-unconfirmed");
    expect((await call(target, "release", { owner: "ses_a", lease_id: first.lease_id })).released).toBe(true);
    const row = (await rows(target))["isolated-1"];
    expect(row.pending_tabs).toBe(1);
    expect(row.leases.map((lease: { owner: string }) => lease.owner)).toEqual(["ses_b"]);
  }, 30000);

  it("refuses a foreign owner, a wrong lease and a mode mismatch", async () => {
    const target = pool();
    const shared = await claim(target, "ses_a", { site: P1 });
    expect(await gate(Pin.open(shared.controller_id, "ses_other", shared.lease_id, target.ctx))).toBe("browser-controller-not-owned");
    expect(await gate(Pin.open(shared.controller_id, "ses_a", "00000000-0000-0000-0000-000000000000", target.ctx))).toBe("browser-controller-not-owned");
    expect(await gate(Pin.open(shared.controller_id, "ses_a", null, target.ctx))).toBe("browser-controller-not-owned");
    expect(await gate(release("ses_other", shared.lease_id, target.ctx))).toBe("browser-controller-lease-not-owned");
    expect(await gate(operate("claim", { owner: "ses_a", ctx: target.ctx }))).toBe("browser-controller-lease-mode-mismatch");
    const exclusive = await operate("claim", { owner: "ses_b", ctx: target.ctx });
    expect(await gate(claim(target, "ses_b", { site: P2 }))).toBe("browser-controller-lease-mode-mismatch");
    expect(await claim(target, "ses_a", { site: P1 })).toEqual(shared);
    expect(await operate("claim", { owner: "ses_b", ctx: target.ctx })).toEqual(exclusive);
  });

  it("returns the single lease with per-lease artifacts", async () => {
    const target = pool();
    expect(await leaseFor("ses_a", target.ctx)).toBeNull();
    const shared = await claim(target, "ses_a", { site: P1 });
    const found = await leaseFor("ses_a", target.ctx);
    expect(found?.lease_id).toBe(shared.lease_id);
    expect(found?.mode).toBe("shared");
    expect(found?.sites).toEqual(["deploy-preview-1--example.netlify.app"]);
    expect(found?.artifacts).toBe(path.join(target.ctx.controllers, "isolated-1/artifacts", shared.lease_id));
    expect(fs.existsSync(found?.artifacts as string)).toBe(false);
    for (const controller of ["isolated-2", "isolated-3"]) await operate("claim", { controller, owner: "ses_setup", ctx: target.ctx });
    expect(await gate(leaseFor("ses_setup", target.ctx))).toBe("browser-controller-lease-ambiguous");
  });

  it("blocks only its own release with a shared pin", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const first = await claim(target, "ses_a", { site: P1 });
    const second = await claim(target, "ses_b", { site: P2 });
    const pin = await Pin.open("isolated-1", "ses_a", first.lease_id, target.ctx);
    try {
      expect((await call(target, "release", { owner: "ses_a", lease_id: first.lease_id })).error).toBe("browser-controller-pinned");
      expect((await call(target, "release", { owner: "ses_b", lease_id: second.lease_id })).released).toBe(true);
    } finally {
      pin.close();
    }
    expect((await release("ses_a", first.lease_id, target.ctx)).controller_idle).toBe(true);
  }, 30000);

  it("reports previously-used sites after release", async () => {
    const target = pool();
    const first = await claim(target, "ses_a", { site: P1 });
    expect(first.site_state).toBe("fresh");
    let pin = await Pin.open("isolated-1", "ses_a", first.lease_id, target.ctx);
    expect((await pin.beginTab(P1))?.site_state).toBe("fresh");
    pin.confirmed();
    await release("ses_a", first.lease_id, target.ctx);
    const second = await claim(target, "ses_b", { site: P1 });
    expect(second.controller_id).toBe("isolated-1");
    expect(second.site_state).toBe("previously-used");
    expect((await claim(target, "ses_b")).site_state).toBe("previously-used");
    pin = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    try {
      expect((await pin.beginTab(P2))?.site_state).toBe("fresh");
    } finally {
      pin.close();
    }
  });

  it("marks overflowing site history incomplete and limits a lease's sites", async () => {
    const target = pool();
    const lease = await claim(target, "ses_a");
    const sites: Record<string, null> = {};
    for (let n = 0; n < MAX_SEEN_SITES; n += 1) sites[`site${n}.example`] = null;
    writeJson(openDirectory(registryPath(target, "isolated-1")), "sites-seen.json", { complete: true, sites });
    let pin = await Pin.open("isolated-1", "ses_a", lease.lease_id, target.ctx);
    expect((await pin.beginTab("https://new.example.com/"))?.site_state).toBe("previously-used");
    pin.confirmed();
    expect(JSON.parse(fs.readFileSync(path.join(registryPath(target, "isolated-1"), "sites-seen.json"), "utf8")).complete).toBe(false);
    for (let n = 0; n < MAX_LEASE_SITES - 1; n += 1) {
      pin = await Pin.open("isolated-1", "ses_a", lease.lease_id, target.ctx);
      await pin.beginTab(`https://s${n}.example/`);
      pin.confirmed();
    }
    pin = await Pin.open("isolated-1", "ses_a", lease.lease_id, target.ctx);
    try {
      expect(await gate(pin.beginTab("https://one-too-many.example/"))).toBe("browser-controller-site-limit");
    } finally {
      pin.close();
    }
  });
});

describe("status and record formats", () => {
  it("lists the default and discovered controllers", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "5" });
    for (let n = 0; n < 4; n += 1) await claim(target, `ses_${n}`, { exclusive: true });
    for (const name of ["isolated-7", "isolated-9", "isolated-0", "isolated-01", "other"]) fs.mkdirSync(path.join(target.ctx.registry, name), { mode: 0o700 });
    const result = await operate("status", { ctx: target.ctx }) as { controllers: Array<Record<string, any>>; max_controllers: number; max_tenants: number };
    expect(result.controllers.map((row) => row.controller_id)).toEqual(["isolated-1", "isolated-2", "isolated-3", "isolated-4", "isolated-7"]);
    expect(result.max_controllers).toBe(5);
    expect(result.max_tenants).toBe(3);
    const row = result.controllers[3];
    for (const key of ["claim", "pending_tabs", "pending_startup", "leases", "reaping", "socket_present"]) expect(row).toHaveProperty(key);
    expect(row.claim.owner).toBe("ses_3");
    expect(row.leases[0].mode).toBe("exclusive");
  });

  it("refuses a marker or reap pid written as a float literal, as Python's type() is int check does (D20)", async () => {
    const target = pool();
    const directory = registryPath(target, "isolated-1");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lease = "00000000-0000-4000-8000-000000000001";
    const marker = (pid: string) => `{"owner": "ses_one", "lease_id": "${lease}", "pid": ${pid}}`;
    const reapRecord = (pid: string) => `{"pid": ${pid}, "started": "2026-01-01T00:00:00Z"}`;
    const cases: Array<[string, string, string | null]> = [
      ["tab-a.json", marker("123"), null], ["tab-a.json", marker("123.0"), "browser-controller-invalid-state"],
      ["tab-a.json", marker("1.23e2"), "browser-controller-invalid-state"], ["tab-a.json", marker("true"), "browser-controller-invalid-state"],
      ["reap.json", reapRecord("7"), null], ["reap.json", reapRecord("7.0"), "browser-controller-invalid-state"],
      ["reap.json", reapRecord("7E0"), "browser-controller-invalid-state"]
    ];
    for (const [name, text, expected] of cases) {
      fs.writeFileSync(path.join(directory, name), text, { mode: 0o600 });
      expect(await gate(operate("status", { ctx: target.ctx })), text).toBe(expected);
      fs.rmSync(path.join(directory, name));
    }
  });

  it("keeps the legacy record formats byte-identical", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    await running(target, "isolated-1");
    const exclusive = await operate("claim", { controller: "isolated-1", owner: "ses_x", ctx: target.ctx }) as { lease_id: string };
    const folder = registryPath(target, "isolated-1");
    expect(fs.readFileSync(path.join(folder, "claim.json"), "utf8")).toBe(`{"owner": "ses_x", "lease_id": "${exclusive.lease_id}"}\n`);
    const pin = await Pin.open("isolated-1", "ses_x", null, target.ctx);
    try {
      await pin.beginTab();
      const marker = JSON.parse(fs.readFileSync(path.join(folder, pin.marker as string), "utf8"));
      expect(Object.keys(marker).sort()).toEqual(["lease_id", "owner", "pid"]);
      expect(marker.lease_id).toBe(exclusive.lease_id);
      pin.confirmed();
    } finally {
      pin.close();
    }
    await release("ses_x", exclusive.lease_id, target.ctx);
    expect(fs.readFileSync(path.join(folder, "claim.json"), "utf8")).toBe("null\n");
    const startup = `{"owner": "ses_old", "lease_id": "11111111-1111-1111-1111-111111111111"}\n`;
    fs.writeFileSync(path.join(folder, "startup.json"), startup);
    fs.chmodSync(path.join(folder, "startup.json"), 0o600);
    const snapshot = () => Object.fromEntries(["claim.json", "startup.json"].map((name) => [name, fs.readFileSync(path.join(folder, name), "utf8")]));
    const before = snapshot();
    expect(await gate(claim(target, "ses_a", { site: P1 }))).toBe("browser-controller-busy");
    expect(await gate(claim(target, "ses_a", { site: P1, controller: "isolated-1" }))).toBe("browser-controller-startup-unconfirmed");
    expect(snapshot()).toEqual(before);
    fs.writeFileSync(path.join(folder, "startup.json"), "null\n");
    const first = await claim(target, "ses_a", { site: P1 });
    const second = await claim(target, "ses_b", { site: P2, controller: "isolated-1" });
    const tab = await Pin.open("isolated-1", "ses_b", second.lease_id, target.ctx);
    await tab.beginTab(P2);
    tab.confirmed();
    for (const lease of [first, second]) await release(lease.owner, lease.lease_id, target.ctx);
    expect(fs.readFileSync(path.join(folder, "claim.json"), "utf8")).toBe(before["claim.json"]);
    expect(await gate(Pin.open("isolated-1", "ses_a", null, target.ctx))).toBe("browser-controller-not-owned");
    expect(fs.readdirSync(folder).filter((name) => name.startsWith("tab-"))).toEqual([]);
  });

  it("creates no profile or artifact directories on claim", async () => {
    const target = pool();
    await claim(target, "ses_a", { site: P1 });
    await operate("claim", { owner: "ses_b", ctx: target.ctx });
    expect(fs.existsSync(target.ctx.controllers)).toBe(false);
  });
});

/** The fake process and endpoint host of the reap tests. */
class Host implements ReapHost {
  pids: number[];
  tabs: unknown[];
  exits: boolean;
  terminated: number[] = [];

  constructor(pids: number[] = [], tabs: unknown[] = [], exits = true) {
    this.pids = [...pids];
    this.tabs = [...tabs];
    this.exits = exits;
  }

  async processes(_info: ControllerMetadata) {
    return [...this.pids];
  }

  async userTabs(_info: ControllerMetadata) {
    return this.pids.length ? [...this.tabs] : null;
  }

  terminate(pid: number) {
    this.terminated.push(pid);
    if (this.exits) this.pids.splice(this.pids.indexOf(pid), 1);
  }

  alive(pid: number) {
    return this.pids.includes(pid);
  }
}

function reap(target: Pool, host: ReapHost, options: { controller?: string; dryRun?: boolean } = {}) {
  return poolReap(options.controller ?? "isolated-1", { ctx: target.ctx, host, waitSeconds: 0.3, dryRun: options.dryRun });
}

describe("reap", () => {
  it("is refused while a lease, marker, pin or startup record exists", async () => {
    const target = pool();
    const lease = await claim(target, "ses_a", { site: P1 });
    const host = new Host([4242]);
    expect(await gate(reap(target, host))).toBe("browser-controller-busy");
    await release("ses_a", lease.lease_id, target.ctx);
    const folder = openDirectory(registryPath(target, "isolated-1"));
    const marker = "tab-00000000-0000-0000-0000-000000000001.json";
    writeJson(folder, marker, { owner: "ses_a", lease_id: lease.lease_id, pid: 1 });
    expect(await gate(reap(target, host))).toBe("browser-controller-cleanup-unconfirmed");
    fs.unlinkSync(path.join(folder.path, marker));
    writeJson(folder, "startup.json", { owner: "ses_a", lease_id: lease.lease_id });
    expect(await gate(reap(target, host))).toBe("browser-controller-startup-unconfirmed");
    writeJson(folder, "startup.json", null);
    await slot("isolated-1", target.ctx, false, async () => {
      expect(await gate(reap(target, host))).toBe("browser-controller-pinned");
    });
    expect(host.terminated).toEqual([]);
    expect(fs.existsSync(path.join(folder.path, "reap.json"))).toBe(false);
  });

  it("is refused while an HTTP tab is open", async () => {
    const target = pool();
    const host = new Host([4242], [{ id: 1, url: "chrome://newtab/" }, { id: 2, url: "https://kept.example/" }]);
    expect(await gate(reap(target, host))).toBe("browser-controller-has-tabs");
    expect(host.terminated).toEqual([]);
    expect((await rows(target))["isolated-1"].reaping).toBe(false);
  });

  it("stops a verified idle Chrome and keeps the profile", async () => {
    const target = pool();
    await running(target, "isolated-1");
    const profile = path.join(target.ctx.controllers, "isolated-1/profile");
    fs.mkdirSync(profile, { recursive: true });
    const host = new Host([4242], [{ id: 1, url: "about:blank" }]);
    expect(await reap(target, host, { dryRun: true })).toEqual({ controller_id: "isolated-1", dry_run: true, running: true, pid: 4242 });
    expect(host.terminated).toEqual([]);
    const result = await reap(target, host);
    expect(result.reaped).toBe(true);
    expect(result.pid).toBe(4242);
    expect(host.terminated).toEqual([4242]);
    expect(fs.statSync(profile).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(target.ctx.sockets, "isolated-1.sock"))).toBe(false);
    expect((await rows(target))["isolated-1"].reaping).toBe(false);
  });

  it("keeps an unconfirmed reap's intent and blocks claims until confirmed", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    const host = new Host([4242], [], false);
    expect(await gate(reap(target, host))).toBe("browser-controller-reap-unconfirmed");
    expect((await rows(target))["isolated-1"].reaping).toBe(true);
    expect(await gate(claim(target, "ses_a", { site: P1 }))).toBe("browser-controller-busy");
    host.pids = [];
    expect(await reap(target, host)).toEqual({ controller_id: "isolated-1", reaped: false, pid: null, profile: path.join(target.ctx.controllers, "isolated-1/profile") });
    expect((await claim(target, "ses_a", { site: P1 })).controller_id).toBe("isolated-1");
  });

  it("keeps its intent while the endpoint is still live", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "1" });
    const file = path.join(target.ctx.sockets, "isolated-1.sock");
    const listener = await listen(file);
    try {
      // No matching Chrome process, yet the controller's socket still has a listener.
      expect(await gate(reap(target, new Host()))).toBe("browser-controller-reap-unconfirmed");
      expect((await rows(target))["isolated-1"].reaping).toBe(true);
      expect(await gate(claim(target, "ses_a", { site: P1 }))).toBe("browser-controller-busy");
      // Recovering from the kept intent does not erase it while the endpoint is live.
      expect(await gate(reap(target, new Host()))).toBe("browser-controller-reap-unconfirmed");
      // A refusal before any signal, or a dry run, leaves an earlier intent in place.
      expect(await gate(reap(target, new Host([4242], [{ id: 1, url: "https://kept.example/" }])))).toBe("browser-controller-has-tabs");
      expect((await reap(target, new Host(), { dryRun: true })).running).toBe(false);
      expect((await rows(target))["isolated-1"].reaping).toBe(true);
    } finally {
      // Node unlinks a closed listener's socket; keep a stale file, as a closed Python socket left one.
      fs.linkSync(file, `${file}.kept`);
      await closeServer(listener);
      fs.renameSync(`${file}.kept`, file);
    }
    // The listener is gone: its stale file is removed, the exit is confirmed and the intent is cleared.
    expect(fs.lstatSync(file).isSocket()).toBe(true);
    expect(await reap(target, new Host())).toEqual({ controller_id: "isolated-1", reaped: false, pid: null, profile: path.join(target.ctx.controllers, "isolated-1/profile") });
    expect((await rows(target))["isolated-1"].reaping).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect((await claim(target, "ses_a", { site: P1 })).controller_id).toBe("isolated-1");
  });

  it("excludes other reapers and claims until its exit is confirmed", async () => {
    const base = pool();
    const target = withEnv(base, { FAST_CHROME_MAX_CONTROLLERS: "1" });
    const table = path.join(base.root, "processes.json");
    const paused = path.join(base.root, "paused");
    const go = path.join(base.root, "go");
    fs.writeFileSync(table, JSON.stringify([4242]));
    const env = target.env as NodeJS.ProcessEnv;
    const output = async (process: ReturnType<typeof startChild>) => {
      const line = await process.line(20000);
      expect(await process.exited, process.stderr()).toBe(0);
      return JSON.parse(line);
    };
    const first = startChild("child-pool", ["reaper", table, paused, go, "pause"], env);
    let ensure: ReturnType<typeof startChild>;
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(paused)) {
        expect(Date.now()).toBeLessThan(deadline);
        expect(first.process.exitCode).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The first reap has written its intent and is inspecting with lease.lock held.
      const intent = JSON.parse(fs.readFileSync(path.join(registryPath(target, "isolated-1"), "reap.json"), "utf8"));
      expect(intent.pid).toBe(first.process.pid);
      for (const mode of ["run", "dry-run"]) {
        expect(await output(startChild("child-pool", ["reaper", table, paused, go, mode], env))).toEqual({ error: "browser-controller-pinned", terminated: [] });
      }
      expect(JSON.parse(fs.readFileSync(path.join(registryPath(target, "isolated-1"), "reap.json"), "utf8"))).toEqual(intent);
      ensure = startChild("child-pool", ["ensure", table, P1], env);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(ensure.process.exitCode).toBeNull();
      expect(JSON.parse(fs.readFileSync(table, "utf8"))).toEqual([4242]);
    } finally {
      fs.writeFileSync(go, "");
    }
    const reaped = await output(first);
    expect(reaped.reaped).toBe(true);
    expect(reaped.pid).toBe(4242);
    expect(reaped.terminated).toEqual([4242]);
    const started = await output(ensure);
    expect(started.controller_id).toBe("isolated-1");
    expect(started.ready && started.launched).toBe(true);
    // The Chrome started after the reap is untouched.
    expect(JSON.parse(fs.readFileSync(table, "utf8"))).toEqual([5000]);
    expect((await rows(target))["isolated-1"].reaping).toBe(false);
  }, 60000);

  it("reports each controller when reaping all", async () => {
    const target = pool();
    await claim(target, "ses_a", { exclusive: true });
    const result = await poolReap(null, { ctx: target.ctx, host: new Host(), waitSeconds: 0.3 }) as { controllers: Array<Record<string, unknown>> };
    expect(result.controllers[0]).toEqual({ controller_id: "isolated-1", error: "browser-controller-busy" });
    expect(result.controllers.slice(1).map((row) => row.reaped)).toEqual([false, false]);
  });
});

describe("reset", () => {
  it("needs confirmation and an idle, stopped controller", async () => {
    const target = pool();
    target.ctx.assets = syntheticAssets(target.root);
    const info = metadata("isolated-1", target.ctx);
    const node = path.join(target.root, "node");
    fs.writeFileSync(node, "#!/bin/sh\n", { mode: 0o700 });
    provision(info, { host: { hostScript: path.join(target.root, "host.js") }, extension: { origin: "chrome-extension://mpodnojmjjafgogldgieimgbmfhhknbe/" }, node });
    fs.mkdirSync(path.join(info.profile, "Default"));
    fs.writeFileSync(path.join(info.downloads, "report.csv"), "kept");
    expect(await gate(reset("isolated-1", { confirm: false, ctx: target.ctx, host: new Host() }))).toBe("browser-controller-confirmation-required");
    const lease = await claim(target, "ses_a", { site: P1 });
    expect(await gate(reset("isolated-1", { confirm: true, ctx: target.ctx, host: new Host() }))).toBe("browser-controller-busy");
    await release("ses_a", lease.lease_id, target.ctx);
    expect(await gate(reset("isolated-1", { confirm: true, ctx: target.ctx, host: new Host([4242]) }))).toBe("browser-controller-running");
    const result = await reset("isolated-1", { confirm: true, ctx: target.ctx, host: new Host() });
    expect(result.reset).toBe(true);
    // The profile's manifest went with it, so provisioning creates a new one.
    expect(result.host_manifest).toBe("created");
    expect(fs.existsSync(path.join(info.profile, "Default"))).toBe(false);
    expect(fs.statSync(path.join(info.profile, "NativeMessagingHosts/com.opzero.chrome.json")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(info.downloads, "report.csv"), "utf8")).toBe("kept");
    // C2: the re-provisioned wrapper runs this Node on the stable host copy.
    expect(fs.readFileSync(info.host, "utf8")).toContain(`exec '${process.execPath}' '${path.join(target.root, "hosts")}`);
    expect(JSON.parse(fs.readFileSync(path.join(registryPath(target, "isolated-1"), "sites-seen.json"), "utf8"))).toEqual({ complete: true, sites: {} });
    expect((await claim(target, "ses_b", { site: P1 })).site_state).toBe("fresh");
  });
});

describe("artifacts", () => {
  it("uses the given capture root before the environment (D2)", async () => {
    const root = tempDir();
    const leaseRoot = path.join(root, "lease");
    fs.mkdirSync(leaseRoot, { mode: 0o700 });
    const fallback = path.join(root, "fallback");
    fs.mkdirSync(fallback, { mode: 0o700 });
    const env = testEnv(root, { FAST_CHROME_ARTIFACT_ROOT: fallback });
    expect(path.dirname(captureDirectory(leaseRoot))).toBe(leaseRoot);
    expect(path.dirname(captureDirectory(userArtifactRoot(env).root))).toBe(fallback);
    fs.chmodSync(leaseRoot, 0o755);
    expect(await gate(() => captureDirectory(leaseRoot))).toBe("fast-chrome-private-artifact-root-required");
    // D2: without FAST_CHROME_ARTIFACT_ROOT the user route uses <state>/artifacts/user, created on demand, so an
    // absent root is still refused rather than invented here.
    const unset = testEnv(root);
    expect(userArtifactRoot(unset)).toEqual({ root: path.join(root, "state/artifacts/user"), explicit: false });
    expect(await gate(() => captureDirectory(userArtifactRoot(unset).root))).toBe("fast-chrome-private-artifact-root-required");
  });
});

describe("operator CLI", () => {
  async function cli(home: string, ...args: string[]): Promise<[number | string, string, string]> {
    const env = testEnv(path.dirname(home), { HOME: home, BROWSER_CONTROL_TEST_PSL: packageAssets().publicSuffixList });
    delete env.BROWSER_CONTROL_STATE_DIR;
    const process = startChild("child-pool", ["cli", ...args], env as NodeJS.ProcessEnv);
    let out = "";
    process.process.stdout?.on("data", (chunk) => { out += chunk; });
    const code = await process.exited;
    return [code, out, process.stderr()];
  }

  it("runs its commands and flags on the home state root (C4, D1, D15)", async () => {
    const home = path.join(tempDir(), "home");
    fs.mkdirSync(home, { mode: 0o700 });
    let [code, out] = await cli(home, "claim", "--owner", "ses_cli");
    const lease = JSON.parse(out);
    expect(code).toBe(0);
    expect(lease.controller_id).toBe("isolated-1");
    expect(lease.mode).toBe("exclusive");
    expect(lease.socket).toBe(path.join(home, ".local/state/browser-control/sockets/isolated-1.sock"));
    [code, out] = await cli(home, "status");
    const status = JSON.parse(out);
    expect(code).toBe(0);
    expect(status.controllers.slice(0, 3).map((row: { controller_id: string }) => row.controller_id)).toEqual(["isolated-1", "isolated-2", "isolated-3"]);
    expect(status.controllers[0].claim).toEqual({ owner: "ses_cli", lease_id: lease.lease_id });
    expect((await cli(home, "ensure", "--owner", "ses_cli", "--timeout", "0"))[1].trim()).toBe("{\"error\": \"browser-controller-invalid-timeout\"}");
    expect((await cli(home, "ensure", "--owner", "ses_cli", "--shared", "--exclusive"))[0]).toBe(2);
    expect((await cli(home, "claim", "isolated-9", "--owner", "ses_cli"))[0]).toBe(2);
    expect((await cli(home, "migrate"))[0]).toBe(2);
    [code, out] = await cli(home, "reset", "isolated-2");
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: "browser-controller-confirmation-required" });
    [code, out] = await cli(home, "reap", "isolated-1", "--dry-run");
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: "browser-controller-busy" });
    [code, out] = await cli(home, "release", "--owner", "ses_cli", "--lease", lease.lease_id);
    expect(code).toBe(0);
    expect(JSON.parse(out).released).toBe(true);
    [code, out] = await cli(home, "reap", "isolated-1", "--dry-run");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ controller_id: "isolated-1", dry_run: true, running: false, pid: null });
    // C4: nothing under the retired OpenCode roots or the old socket directory.
    expect(fs.readdirSync(home)).toEqual([".local"]);
    expect(fs.readdirSync(path.join(home, ".local"))).toEqual(["state"]);
    expect(fs.readdirSync(path.join(home, ".local/state"))).toEqual(["browser-control"]);
  }, 60000);
});
