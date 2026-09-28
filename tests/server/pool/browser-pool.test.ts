// Port of test_browser_pool.py: concurrent processes, distinct allocations, live pins, crash-retained cleanup,
// exact release and registry filesystem checks. "Processes" are real Node children (child-pool.ts) sharing one
// state root, so every lock conflict crosses a process boundary as fcntl.flock did.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROLLERS, operate, Pin } from "../../../src/server/pool/registry";
import { killChildren } from "../support/children";
import { removeTempRoots } from "../support/temp";
import { call, child, gate, journals, pool, registryPath, serialSuite } from "./helpers";

serialSuite();

afterEach(() => {
  killChildren();
  removeTempRoots();
});

const UNSAFE = ["root-symlink", "lock-symlink", "claim-symlink", "lock-hardlink", "root-permissions", "claim-permissions"];

describe("browser pool", () => {
  it("gives concurrent automatic claims distinct, persistent controllers", async () => {
    const target = pool();
    const claims = await Promise.all([0, 1, 2].map((n) => call(target, "operate", { command: "claim", owner: `ses_${n}` })));
    expect(new Set(claims.map((item) => item.controller_id))).toEqual(new Set(CONTROLLERS));
    expect((await call(target, "operate", { command: "claim", owner: "ses_four" })).error).toBe("browser-controller-busy");
    for (const item of claims) {
      expect(await call(target, "operate", { command: "claim", owner: item.owner })).toEqual(item);
      expect((await call(target, "operate", { command: "release", owner: "ses_other", lease: item.lease_id })).error).toBe("browser-controller-lease-not-owned");
      expect((await call(target, "operate", { command: "release", owner: item.owner, lease: item.lease_id })).released).toBe(true);
    }
    expect(journals(target.root)).toEqual([]);
  }, 30000);

  it("has one winner in a same-slot race", async () => {
    const target = pool();
    const claims = await Promise.all([0, 1].map((n) => call(target, "operate", { command: "claim", controller: "isolated-1", owner: `ses_${n}` })));
    expect(claims.filter((item) => "lease_id" in item)).toHaveLength(1);
    expect(claims.filter((item) => item.error === "browser-controller-busy")).toHaveLength(1);
  }, 30000);

  it("keeps a same-owner automatic claim race idempotent", async () => {
    const target = pool();
    const claims = await Promise.all([0, 1, 2].map(() => call(target, "operate", { command: "claim", owner: "ses_one" })));
    expect(claims[1]).toEqual(claims[0]);
    expect(claims[2]).toEqual(claims[0]);
    const status = await operate("status", { ctx: target.ctx }) as { controllers: Array<{ claim: unknown }> };
    expect(status.controllers.filter((row) => row.claim !== null)).toHaveLength(1);
  }, 30000);

  it("refuses release while pinned and keeps other slots available", async () => {
    const target = pool();
    const first = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Record<string, string>;
    const pin = await Pin.open("isolated-1", "ses_one", null, target.ctx);
    try {
      expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: first.lease_id })).error).toBe("browser-controller-pinned");
      expect(await call(target, "operate", { command: "claim", controller: "isolated-1", owner: "ses_one" })).toEqual(first);
      const second = await call(target, "operate", { command: "claim", controller: "isolated-2", owner: "ses_two" });
      expect((await call(target, "operate", { command: "release", owner: "ses_two", lease: second.lease_id })).released).toBe(true);
    } finally {
      pin.close();
    }
    expect((await operate("release", { owner: "ses_one", lease: first.lease_id, ctx: target.ctx }) as { released: boolean }).released).toBe(true);
  }, 30000);

  it("lets explicit setup claims share one owner", async () => {
    const target = pool();
    const claims = [];
    for (const item of CONTROLLERS) claims.push(await operate("claim", { controller: item, owner: "ses_setup", ctx: target.ctx }) as { lease_id: string });
    expect(new Set(claims.map((item) => item.lease_id)).size).toBe(3);
  });

  it("blocks reassignment with a live tab's marker left by a crashed process", async () => {
    const target = pool();
    const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Record<string, string>;
    expect(await child(target, ["begin", "isolated-1", "ses_one", "-"])).toBeNull();
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).error).toBe("browser-controller-cleanup-unconfirmed");
    const status = await operate("status", { ctx: target.ctx }) as { controllers: Array<{ pending_tabs: number }> };
    expect(status.controllers[0].pending_tabs).toBe(1);
  }, 30000);

  it("allows the exact release once cleanup is confirmed", async () => {
    const target = pool();
    const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Record<string, string>;
    const pin = await Pin.open("isolated-1", "ses_one", null, target.ctx);
    await pin.beginTab();
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).error).toBe("browser-controller-pinned");
    pin.confirmed();
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).released).toBe(true);
  }, 30000);

  it.each(UNSAFE)("refuses an unsafe registry: %s", async (kind) => {
    const target = pool();
    await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx });
    const controller = registryPath(target, "isolated-1");
    let ctx = target.ctx;
    if (kind === "root-symlink") {
      const link = path.join(target.root, "link");
      fs.symlinkSync(target.ctx.registry, link);
      ctx = { ...ctx, registry: link };
    } else if (kind.endsWith("symlink")) {
      const original = path.join(controller, kind === "lock-symlink" ? "lease.lock" : "claim.json");
      const saved = path.join(controller, "original");
      fs.renameSync(original, saved);
      fs.symlinkSync(saved, original);
    } else if (kind === "lock-hardlink") {
      fs.linkSync(path.join(controller, "lease.lock"), path.join(controller, "alias"));
    } else if (kind === "root-permissions") {
      fs.chmodSync(controller, 0o755);
    } else {
      fs.chmodSync(path.join(controller, "claim.json"), 0o644);
    }
    expect(await gate(operate("status", { ctx }))).toMatch(/^browser-controller-(unsafe|invalid)-registry$/);
  });

  it("refuses a foreign owner and a wrong lease", async () => {
    const target = pool();
    await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx });
    expect(await gate(Pin.open("isolated-1", "ses_other", null, target.ctx))).toBe("browser-controller-not-owned");
    expect(await gate(operate("release", { owner: "ses_one", lease: "00000000-0000-0000-0000-000000000000", ctx: target.ctx }))).toBe("browser-controller-lease-not-owned");
  });
});
