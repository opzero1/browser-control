// The SQLite locks that replace fcntl.flock (design 4.4), proven across real processes on the pool's own
// operations: concurrent claims, a pin holder that crashes, and releases racing pins.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDirectory } from "../../../src/server/fs-private";
import { lockNow } from "../../../src/server/lock";
import { claim, leaseFor, operate, Pin, release } from "../../../src/server/pool/registry";
import { killChildren, startChild } from "../support/children";
import { removeTempRoots } from "../support/temp";
import { call, journals, P1, P2, pool, rows, withEnv, serialSuite } from "./helpers";

serialSuite();

afterEach(() => {
  killChildren();
  removeTempRoots();
});

const MODES = ["exclusive", "shared"];

describe("cross-process pool locks", () => {
  it("keeps a held lock for other processes while this process opens and closes the same lock file", async () => {
    const target = pool();
    const dir = openDirectory(path.join(target.ctx.registry, "isolated-1"));
    const held = lockNow(dir, "lease.lock", false);
    // A second holder in this process: closing its file must not drop the first holder's POSIX lock.
    lockNow(dir, "lease.lock", false).release();
    const writer = startChild("child-foundation", ["lock", dir.path, "lease.lock", "exclusive", "exit"]);
    expect(await writer.line()).toBe("busy browser-controller-pinned");
    held.release();
    const after = startChild("child-foundation", ["lock", dir.path, "lease.lock", "exclusive", "exit"]);
    expect(await after.line()).toBe("held");
  }, 20000);

  it("keeps a pin's lock for other processes while this process reads the same controller", async () => {
    const target = pool();
    const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Record<string, string>;
    const pin = await Pin.open("isolated-1", "ses_one", null, target.ctx);
    try {
      await operate("status", { ctx: target.ctx });
      await leaseFor("ses_one", target.ctx);
      (await Pin.open("isolated-1", "ses_one", null, target.ctx)).close();
      expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).error).toBe("browser-controller-pinned");
      expect(await gate(release("ses_one", claimed.lease_id, target.ctx))).toBe("browser-controller-pinned");
    } finally {
      pin.close();
    }
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).released).toBe(true);
  }, 20000);

  it("frees a killed pin holder's lock and keeps its cleanup marker", async () => {
    const target = pool();
    const claimed = await operate("claim", { controller: "isolated-1", owner: "ses_one", ctx: target.ctx }) as Record<string, string>;
    const holder = startChild("child-pool", ["begin", "isolated-1", "ses_one", "-", "-", "kill"], target.env as NodeJS.ProcessEnv);
    expect(JSON.parse(await holder.line(10000))).toBeNull();
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).error).toBe("browser-controller-pinned");
    holder.process.kill("SIGKILL");
    expect(await holder.exited).toBe("SIGKILL");
    // The lock died with the process; the marker did not.
    expect((await call(target, "operate", { command: "release", owner: "ses_one", lease: claimed.lease_id })).error).toBe("browser-controller-cleanup-unconfirmed");
    expect((await rows(target))["isolated-1"].pending_tabs).toBe(1);
    expect(journals(target.root)).toEqual([]);
  }, 20000);

  it.each(MODES)("resolves each release racing a %s pin to exactly one outcome", async (mode) => {
    const target = pool();
    const barrier = path.join(target.root, "barrier");
    for (let round = 0; round < 6; round += 1) {
      const owner = `ses_race${round}`;
      const lease = await claim(owner, { controller: "isolated-1", exclusive: mode === "exclusive", site: mode === "shared" ? P1 : null, ctx: target.ctx });
      const holder = startChild("child-pool", ["hold", "isolated-1", owner, mode === "shared" ? lease.lease_id : "-", barrier], target.env as NodeJS.ProcessEnv);
      const released = call(target, "release", { owner, lease_id: lease.lease_id });
      const [pinned, outcome] = await Promise.all([holder.line(10000).then((line) => JSON.parse(line)), released]);
      if (pinned.held) {
        expect(outcome).toEqual({ error: "browser-controller-pinned" });
      } else {
        expect(pinned).toEqual({ error: "browser-controller-not-owned" });
        expect(outcome).toEqual({ controller_id: "isolated-1", released: true, controller_idle: true });
      }
      fs.writeFileSync(barrier, "");
      expect(await holder.exited).toBe(0);
      fs.rmSync(barrier);
      if (pinned.held) expect((await release(owner, lease.lease_id, target.ctx)).released).toBe(true);
    }
    expect(journals(target.root)).toEqual([]);
  }, 60000);

  it("allocates distinct controllers to many racing processes", async () => {
    const target = withEnv(pool(), { FAST_CHROME_MAX_CONTROLLERS: "8" });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, n) => call(target, "claim", { owner: `ses_${n}`, site: n % 2 ? P2 : P1, exclusive: true })));
    const granted = claims.filter((item) => item.lease_id);
    expect(new Set(granted.map((item) => item.controller_id)).size).toBe(8);
    expect(claims.filter((item) => item.error === "browser-controller-busy")).toHaveLength(2);
    expect(journals(target.root)).toEqual([]);
    // Sequential: a concurrent release's scan holds each controller's lease.lock shared for a moment, and an
    // exclusive release refuses a held lock at once (browser-controller-pinned), as it did with LOCK_NB.
    for (const item of granted) expect((await release(item.owner, item.lease_id, target.ctx)).released).toBe(true);
  }, 60000);
});

async function gate(body: Promise<unknown>): Promise<string | null> {
  try {
    await body;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
}
