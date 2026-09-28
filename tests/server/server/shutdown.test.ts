// test_native_server.py, bounded shutdown in one process: new calls, new tabs and page or private input are
// refused once shutdown begins, act_steps and waits stop with shutdown, cleanup finalizes idle tabs and bounds
// hung or busy ones, and a tab without confirmed finalization keeps its cleanup marker.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageExpectation, Step } from "../../../src/server/args";
import type { HostConnection } from "../../../src/server/host-connection";
import { claim, Pin, release } from "../../../src/server/pool/registry";
import { Shutdown } from "../../../src/server/runtime/shutdown";
import type { Tab } from "../../../src/server/tabs";
import { monotonic } from "../../../src/server/time";
import { removeTempRoots } from "../support/temp";
import {
  Chrome, connectionOf, deferred, FakeConnection, filePage, fixture, gate, meta, refusal, running, setConnect, stepsPage, tabFixture, text,
  type Fixture
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoots();
});

const AFTER_INPUT = "observe; do not replay";
const BEFORE_INPUT = "choose from final.actions; do not replay completed steps";
const P1 = "https://deploy-preview-1--reapdirect.netlify.app/login";
const P2 = "https://deploy-preview-2--reapdirect.netlify.app/login";
const OTHER = "https://other.example/";
const SECRET = "synthetic-shutdown-secret";

async function shared(shutdown = new Shutdown()) {
  const f = fixture({ shutdown, extraEnv: { FAST_CHROME_MAX_CONTROLLERS: "1" } });
  await running(f.sockets, "isolated-1");
  const one = await claim("ses_one", { site: P1, ctx: f.ctx });
  const two = await claim("ses_two", { site: P2, ctx: f.ctx });
  const chromes = new Map([[one.socket, new Chrome([P1, P2, OTHER])], [f.userSocket, new Chrome([P1, OTHER], 500)]]);
  setConnect(f.server, (socket) => (chromes.get(socket) as Chrome).connect());
  return { ...f, one, two, chrome: chromes.get(one.socket) as Chrome };
}

function markers(f: Fixture): string[] {
  const directory = path.join(f.ctx.registry, "isolated-1");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^tab-.*\.json$/.test(name)) : [];
}

/** Resolves when cleanup starts its bounded wait for the tab's busy flag (WatchedLock). */
function watchCleanup(tab: Tab): Promise<void> {
  const waited = deferred();
  const acquireBy = tab.operation.acquireBy.bind(tab.operation);
  tab.operation.acquireBy = (deadline: number) => {
    waited.resolve();
    return acquireBy(deadline);
  };
  return waited.promise;
}

describe("shutdown", () => {
  const STOPS_ACT_STEPS_BEFORE_CASES = [true, false];
  it.each(STOPS_ACT_STEPS_BEFORE_CASES)("stops act_steps before further input (expect %s)", async (withExpect) => {
    const f = fixture();
    const tab = tabFixture(f);
    const conn = connectionOf(tab);
    const raw = stepsPage([["click", "Continue"], ["click", "Next"]]);
    conn.returnValue = raw;
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = (method: string) => {
      if (method === "actPage") {
        f.shutdown.begin(); // shutdown begins while the first action is in flight
        return { status: "executed" };
      }
      return raw;
    };
    const first = new Step({ label: "Continue", ...(withExpect ? { expect: new PageExpectation({ text: "never" }), timeout_ms: 15000 } : {}) });
    const started = monotonic();
    const result = await f.server.actSteps({ tab_id: "1", steps: [first, new Step({ label: "Next" })], snapshot_id: observed.snapshot_id }, meta());
    expect(monotonic() - started).toBeLessThan(1);
    expect(conn.methods().filter((method) => method === "actPage")).toHaveLength(1);
    if (withExpect) {
      expect(result.stopped).toEqual({ i: 0, label: "Continue", reason: "shutdown", dispatched: true, action_id: "0", outcome: "executed", next: AFTER_INPUT });
      expect(result.final).toBeNull();
    } else {
      expect(result.stopped).toEqual({ i: 1, label: "Next", reason: "shutdown", dispatched: false, next: BEFORE_INPUT });
      expect((result.final as { snapshot_id: string }).snapshot_id).toBe(tab.snapshot?.[0]);
    }
  });

  it("refuses new calls, new tabs and new input", async () => {
    const f = fixture();
    const tab = tabFixture(f);
    const conn = connectionOf(tab);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    f.shutdown.begin();
    const refused = await f.server.callTool("observe", { tab_id: "1" }, meta());
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe("Error executing tool observe: fast-chrome-shutting-down");
    const created = new FakeConnection();
    setConnect(f.server, () => created);
    expect(await refusal(f.server.openTab({ url: "https://example.test/" }, meta()))).toBe("fast-chrome-shutting-down");
    expect(created.calls).toEqual([]);
    expect([...f.server.registry.tabs.keys()]).toEqual(["1"]);
    expect(await refusal(f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta()))).toBe("fast-chrome-shutting-down");
    expect((await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ text: "never" }) }, meta())).outcome).toBe("shutdown");
    expect(conn.methods()).toEqual(["observePage"]);
  });

  const SENDS_NO_CREATE_OR_CASES = ["open_tab", "claim_tab"];
  it.each(SENDS_NO_CREATE_OR_CASES)("sends no create or claim when shutdown begins during a new tab's pin and marker write (%s)", async (tool) => {
    const s = await shared();
    const directory = path.join(s.ctx.registry, "isolated-1");
    const written: boolean[] = [];
    const beginTab = Pin.prototype.beginTab;
    vi.spyOn(Pin.prototype, "beginTab").mockImplementation(async function (this: Pin, site?: string | null) {
      const gated = await beginTab.call(this, site);
      written.push(fs.existsSync(path.join(directory, this.marker as string)));
      s.shutdown.begin();
      return gated;
    });
    const attempt = tool === "open_tab" ? s.server.openTab({ url: P1 }, meta("ses_one")) : s.server.claimTab({ tab_id: "isolated-1:10" }, meta("ses_one"));
    expect(await refusal(attempt)).toBe("fast-chrome-shutting-down");
    expect(written).toEqual([true]);
    expect(markers(s)).toEqual([]);
    expect(s.chrome.calls).toEqual(tool === "open_tab" ? [] : ["getUserTabs"]);
    expect(s.server.registry.tabs.size).toBe(0);
    // Neither a pin nor a marker is left behind, so the lease releases at once.
    expect((await release("ses_one", s.one.lease_id, s.ctx)).released).toBe(true);
  });

  it("finalizes idle tabs at cleanup and bounds hung or busy ones", async () => {
    class Hung implements HostConnection {
      alive = true;
      calls: string[] = [];
      closed = deferred();
      async call(method: string): Promise<unknown> {
        this.calls.push(method);
        await Promise.race([this.closed.promise, new Promise((resolve) => setTimeout(resolve, 5000))]);
        throw gate("opchrome-outcome-unknown");
      }
      close(): void {
        this.closed.resolve();
      }
    }
    const f = fixture();
    const idleConnection = new FakeConnection();
    idleConnection.sideEffect = (method: string) => (method === "finalizeTabs" ? { closedOrReleased: true } : []);
    const hungConnection = new Hung();
    const busyConnection = new FakeConnection();
    const idle = f.server.newTab("ses_one", idleConnection, 1, "https://example.test", true);
    const hung = f.server.newTab("ses_one", hungConnection, 2, "https://example.test", true);
    const busy = f.server.newTab("ses_two", busyConnection, 3, "https://example.test", true);
    const pins = new Map<string, { confirmed: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
    for (const item of [idle, hung, busy]) {
      const pin = { confirmed: vi.fn(), close: vi.fn() };
      pins.set(item.key, pin);
      item.controllerPin = pin as unknown as Pin;
      f.server.registry.tabs.set(item.key, item);
    }
    busy.operation.tryAcquire(); // its body is still running
    const started = monotonic();
    try {
      await f.server.releaseAll(started + 0.3);
    } finally {
      busy.operation.release();
    }
    const elapsed = monotonic() - started;
    expect(elapsed).toBeGreaterThanOrEqual(0.3);
    expect(elapsed).toBeLessThan(1);
    expect(f.server.registry.tabs.size).toBe(0);
    expect(pins.get("1")?.confirmed).toHaveBeenCalledTimes(1);
    for (const key of ["2", "3"]) {
      expect(pins.get(key)?.confirmed).not.toHaveBeenCalled();
      expect(pins.get(key)?.close).toHaveBeenCalledTimes(1);
    }
    expect(hungConnection.calls).toEqual(["finalizeTabs"]);
    expect(hungConnection.closed.settled()).toBe(true);
    expect(busyConnection.calls).toEqual([]);
    expect(busyConnection.closed).toBeGreaterThan(0);
  });

  it("refuses tab input once shutdown begins but still reads and cleans up", async () => {
    const f = fixture();
    const tab = tabFixture(f);
    const conn = connectionOf(tab);
    f.shutdown.begin();
    for (const method of ["navigatePage", "actPage", "uploadFile", "privateFill", "submitPrivate"]) {
      expect(() => tab.call(method)).toThrow("fast-chrome-shutting-down");
    }
    expect(conn.calls).toEqual([]);
    // Reads and cleanup still go out: observation, the private-field readback, capture and recording stop.
    for (const [method, params] of [["observePage", { controlsOnly: false }], ["observeDocument", {}], ["capturePage", {}], ["recordingState", { active: false }]] as const) {
      await tab.call(method, params);
    }
    expect(conn.methods()).toEqual(["observePage", "observeDocument", "capturePage", "recordingState"]);
    conn.sideEffect = (method: string) => (method === "finalizeTabs" ? { closedOrReleased: true } : []);
    const pin = { confirmed: vi.fn(), close: vi.fn() };
    tab.controllerPin = pin as unknown as Pin;
    expect((await f.server.finalize(tab, false)).release_confirmed).toBe(true);
    expect(conn.methods().slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(pin.confirmed).toHaveBeenCalledTimes(1);
  });

  it("sends no input from navigate and upload bodies already running when shutdown begins", async () => {
    const f = fixture();
    const tab = tabFixture(f);
    const conn = connectionOf(tab);
    const pdf = path.join(f.root, "invoice.pdf");
    fs.writeFileSync(pdf, "%PDF-x");
    conn.returnValue = filePage();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const validated = f.server.validatedPdf;
    f.server.validatedPdf = (value) => {
      f.shutdown.begin(); // shutdown begins while the upload body validates its file
      return validated(value);
    };
    // A refusal before dispatch is a gate, not an unknown receipt.
    expect(await refusal(f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: pdf }, meta()))).toBe("fast-chrome-shutting-down");
    expect(await refusal(f.server.navigate({ tab_id: "1", url: "https://example.test/next" }, meta()))).toBe("fast-chrome-shutting-down");
    expect(conn.methods()).toEqual(["observePage"]);
  });

  const SENDS_NO_FURTHER_PRIVATE_CASES = [["vault", "grace"], ["vault", "deadline"], ["fill", "grace"], ["fill", "deadline"]];
  it.each(SENDS_NO_FURTHER_PRIVATE_CASES)(
    "sends no further private input when shutdown begins during the %s step (%s)", async (stage, settle) => {
      const shutdown = new Shutdown(settle === "grace" ? 2.5 : 0.3);
      const s = await shared(shutdown);
      const handle = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
      const tab = s.server.registry.get(handle) as Tab;
      const snapshotId = (await s.server.observe({ tab_id: handle }, meta("ses_one"))).snapshot_id;
      const connection = connectionOf(tab);
      const chrome = connection.sideEffect as (method: string, params: any) => unknown;
      const calls: Array<[string, any]> = [];
      const entered = deferred();
      const resume = deferred();
      const closed = deferred();
      connection.onClose = () => {
        connection.alive = false;
        closed.resolve();
      };
      connection.sideEffect = async (method: string, params: any) => {
        calls.push([method, params]);
        if (closed.settled()) throw gate("opchrome-outcome-unknown"); // as a real connection does once cleanup closed it
        if (method === "observeDocument") return { origin: tab.origin, url: params.expectedUrl, token: "fill-token", documentId: "document-1" };
        if (method === "preparePrivateSubmit") return { status: "prepared", submitToken: "submit-token", documentId: "document-1", expiresInMs: 90000 };
        if (method === "privateFill" && stage === "fill") {
          entered.resolve();
          if (settle === "deadline") {
            await closed.promise; // never answered: cleanup cuts it off
            throw gate("opchrome-outcome-unknown");
          }
          await resume.promise;
        }
        if (method === "privateFill") return { status: "filled" };
        if (method === "submitPrivate") return { status: "executed" };
        return chrome(method, params);
      };
      s.server.readField = async () => {
        if (stage === "vault") {
          entered.resolve();
          await resume.promise;
        }
        return SECRET;
      };
      const waited = watchCleanup(tab);
      const transfer = s.server.paste1PasswordField({
        tab_id: handle, expected_url: P1, expected_email: "synthetic@example.test", field: "password", selector: "#password",
        username_selector: "#email", snapshot_id: snapshotId, submit_action_id: "0"
      }, meta("ses_one"));
      let cleanup: Promise<void>;
      let began: number;
      try {
        await entered.promise;
        began = calls.length;
        shutdown.begin();
        cleanup = s.server.cleanup(shutdown.deadline as number);
        await waited; // cleanup is waiting for the busy tab
        if (settle === "deadline") {
          await cleanup;
          expect(closed.settled()).toBe(true);
        }
      } finally {
        resume.resolve();
      }
      const result = await transfer;
      await cleanup;
      expect(s.server.registry.tabs.size).toBe(0);
      const sent = calls.map(([method]) => method);
      const after = calls.slice(began).map(([method]) => method);
      expect(sent).not.toContain("submitPrivate");
      expect(result.retry).toBe(false);
      expect(result.tab_id).toBe(handle);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(calls.filter(([method]) => method !== "privateFill"))).not.toContain(SECRET);
      if (stage === "vault") {
        // Nothing private was sent, so the refusal is a clean block and records no attempt.
        expect(sent).not.toContain("privateFill");
        expect(tab.privateAttempts.size).toBe(0);
        expect(result.outcome).toBe("blocked");
        expect(result.reason).toBe("fast-chrome-shutting-down");
      } else {
        // The fill went out before shutdown: its outcome stays unknown, it is never replayed, and nothing submits.
        expect(sent.filter((method) => method === "privateFill")).toHaveLength(1);
        expect(tab.privateAttempts.has("document-1\u0000password")).toBe(true);
        expect(result).toEqual({ outcome: "unknown", tab_id: handle, retry: false });
      }
      if (settle === "grace") {
        // Nothing follows the returned step, not even a readback; cleanup then finalizes the tab and removes its marker.
        expect(after).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
        expect(markers(s)).toEqual([]);
      } else {
        // Cut off at the deadline: no finalization, and the marker stays for operator inspection.
        expect(after).toEqual([]);
        expect(markers(s)).toHaveLength(1);
      }
    });

  const STOPS_A_TRANSFER_BEFORE_CASES = ["one-time password", "password"];
  it.each(STOPS_A_TRANSFER_BEFORE_CASES)("stops a transfer before its next step when shutdown begins during a %s field read", async (field) => {
    const s = await shared();
    const handle = (await s.server.openTab({ url: P1 }, meta("ses_one"))).tab_id as string;
    const tab = s.server.registry.get(handle) as Tab;
    const snapshotId = (await s.server.observe({ tab_id: handle }, meta("ses_one"))).snapshot_id;
    const connection = connectionOf(tab);
    const chrome = connection.sideEffect as (method: string, params: any) => unknown;
    const calls: string[] = [];
    const entered = deferred();
    const resume = deferred();
    const closed = deferred();
    connection.onClose = () => {
      connection.alive = false;
      closed.resolve();
    };
    connection.sideEffect = async (method: string, params: any) => {
      calls.push(method);
      if (closed.settled()) throw gate("opchrome-outcome-unknown");
      if (method === "observeDocument") {
        if (!entered.settled()) {
          entered.resolve();
          await resume.promise;
        }
        if (field === "one-time password") throw gate("opchrome-private-fields-unavailable"); // the OTP field has not appeared yet
        return { origin: tab.origin, url: params.expectedUrl, token: "fill-token", documentId: "document-1" };
      }
      if (method === "preparePrivateSubmit") return { status: "prepared", submitToken: "submit-token", documentId: "document-1", expiresInMs: 90000 };
      return chrome(method, params);
    };
    const vault = vi.fn(async () => SECRET);
    s.server.readField = vault;
    const waited = watchCleanup(tab);
    const extra = field === "one-time password" ? { selector: "#otp" } : { selector: "#password", username_selector: "#email", snapshot_id: snapshotId, submit_action_id: "0" };
    const transfer = s.server.paste1PasswordField({ tab_id: handle, expected_url: P1, expected_email: "synthetic@example.test", field, ...extra }, meta("ses_one"));
    let cleanup: Promise<void>;
    let began: number;
    let started: number;
    try {
      await entered.promise;
      began = calls.length;
      started = monotonic();
      s.shutdown.begin();
      cleanup = s.server.cleanup(s.shutdown.deadline as number);
      await waited; // cleanup is waiting for the busy tab
    } finally {
      resume.resolve();
    }
    const result = await transfer;
    await cleanup;
    const elapsed = monotonic() - started;
    expect(elapsed).toBeLessThan(1);
    expect(s.server.registry.tabs.size).toBe(0);
    expect(result).toEqual({ outcome: "blocked", tab_id: handle, reason: "fast-chrome-shutting-down", retry: false });
    // The read in flight settled, and nothing followed it: no further poll, no submit preparation, no vault read.
    expect(calls.slice(began)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(markers(s)).toEqual([]);
    expect(calls).not.toContain("preparePrivateSubmit");
    expect(calls).not.toContain("privateFill");
    expect(tab.privateAttempts.size).toBe(0);
    expect(vault).not.toHaveBeenCalled();
  });
});

