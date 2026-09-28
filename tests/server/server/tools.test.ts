// test_native_server.py, the tab tools on one managed tab: session identity, group titles, the HTTPS origin
// policy, observation, actions, uploads, waits, release, screenshots, setup cleanup, registry races and the
// controls-only preference. A FakeConnection stands in for Mock(alive=True).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PageExpectation } from "../../../src/server/args";
import { origin, validatedGroupTitle, validatedPdf } from "../../../src/server/page";
import { processSessionId, sessionFromMeta } from "../../../src/server/session";
import { Tab } from "../../../src/server/tabs";
import { removeTempRoots } from "../support/temp";
import {
  connectionOf, deferred, FakeConnection, filePage, fixture, gate, JPEG_4X4, meta, modeDispatch, page, refusal, setConnect, tabFixture, type Fixture
} from "./helpers";

afterEach(() => removeTempRoots());

function setup(): { f: Fixture; tab: Tab; conn: FakeConnection } {
  const f = fixture();
  const tab = tabFixture(f);
  return { f, tab, conn: connectionOf(tab) };
}

describe("session identity", () => {
  const READS_THE_SESSION_FROM_CASES = ["sessionID", "ai.opencode/sessionID"];
  it.each(READS_THE_SESSION_FROM_CASES)("reads the session from _meta[%s]", (key) => {
    expect(sessionFromMeta(meta("ses_test", key))).toBe("ses_test");
  });

  it("falls back to one process session ID when the metadata has none (C7)", () => {
    // Python raised fast-chrome-session-required; clients without session metadata now share one ID per process.
    expect(sessionFromMeta(undefined)).toBe(processSessionId());
    expect(sessionFromMeta({})).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(sessionFromMeta(null)).toBe(sessionFromMeta({}));
    // D9: a present identity that is not a non-empty string still fails.
    for (const value of [5, "", ["ses_x"]]) expect(() => sessionFromMeta({ sessionID: value })).toThrow("fast-chrome-session-required");
  });
});

describe("group titles", () => {
  it("uses the label or the session fallback", () => {
    expect(validatedGroupTitle("ses_3689d0e1629a", "agent2 · Preview 1704")).toBe("agent2 · Preview 1704");
    expect(validatedGroupTitle("ses_3689d0e1629a", null)).toBe("OpenCode · 3689d0e1");
    for (const label of ["", "  ", "bad\nlabel", "bad\x85label", "bad\u202elabel", "bad\u200blabel", "bad\u200elabel", "bad\u2060label",
      "bad\ufefflabel", "😀".repeat(41), "x".repeat(81), 123, "bad\ud800label"]) {
      expect(() => validatedGroupTitle("ses_3689d0e1629a", label)).toThrow("fast-chrome-group-title-required");
    }
  });

  it("renames an existing owned tab without a reclaim", async () => {
    const { f, conn } = setup();
    conn.sideEffect = [{ name: "agent2 · Preview 1704", confirmed: true }, page()];
    const result = await f.server.claimTab({ tab_id: "1", group_title: "agent2 · Preview 1704" }, meta());
    expect(result.group_title).toBe("agent2 · Preview 1704");
    expect(result.group_title_confirmed).toBe(true);
    expect(conn.methods()).toEqual(["nameSession", "observePage"]);
  });

  const REQUIRES_THE_EXACT_EXTENSION_CASES = [[{ name: "Wrong title", confirmed: true }], [{ name: "agent2 · Preview 1704", confirmed: false }]];
  it.each(REQUIRES_THE_EXACT_EXTENSION_CASES)(
    "requires the exact extension readback for name_group: %j", async (result) => {
      const { f, conn } = setup();
      conn.returnValue = result;
      expect(await refusal(f.server.nameGroup({ tab_id: "1", title: "agent2 · Preview 1704" }, meta()))).toBe("fast-chrome-group-title-unconfirmed");
    });

  it("names the created group before claiming success", async () => {
    const f = fixture();
    const conn = new FakeConnection();
    conn.sideEffect = [{ id: 1, active: false, url: "about:blank" }, { name: "agent2 · Preview 1704", confirmed: true }, { attached: true },
      { bound: true }, { status: "dispatched" }, page()];
    setConnect(f.server, () => conn);
    const result = await f.server.openTab({ url: "https://example.test/", group_title: "agent2 · Preview 1704" }, meta());
    expect(result.group_title_confirmed).toBe(true);
    expect(conn.methods().slice(0, 2)).toEqual(["createTab", "nameSession"]);
  });

  it("keeps the confirmed title on an existing claim without a label", async () => {
    const { f, tab, conn } = setup();
    tab.groupTitle = "agent2 · Preview 1704";
    const result = await f.server.claimTab({ tab_id: "1" }, meta());
    expect(result.group_title).toBe("agent2 · Preview 1704");
    expect(result.group_title_confirmed).toBe(false);
    expect(conn.methods()).toEqual(["observePage"]);
  });

  it("refuses an existing claim of a busy tab", async () => {
    const { f, tab } = setup();
    tab.operation.tryAcquire();
    expect(await refusal(f.server.claimTab({ tab_id: "1" }, meta()))).toBe("fast-chrome-tab-busy");
  });
});

describe("origin policy", () => {
  const REFUSED_URLS = ["file:///tmp/a", "about:blank", "http://example.test/", "https://u:p@example.test", "https://example.test\\@other.test",
    "https://example.test/\n", "https://"];
  it.each(REFUSED_URLS)("refuses %j", (url) => {
    expect(() => origin(url, {})).toThrow("fast-chrome-approved-web-url-required");
  });

  it("returns the exact origin and allows loopback only when opted in", () => {
    expect(origin("https://EXAMPLE.test:443/path?q=1", {})).toBe("https://example.test");
    expect(() => origin("http://127.0.0.1:8888", {})).toThrow("fast-chrome-approved-web-url-required");
    expect(origin("http://127.0.0.1:8888/", { FAST_CHROME_ALLOW_LOOPBACK: "1" })).toBe("http://127.0.0.1:8888");
  });
});

describe("ownership", () => {
  const FOREIGN_TAB_CALLS = [
    ["observe", (f: Fixture) => f.server.observe({ tab_id: "1" }, meta("other"))],
    ["act_steps", (f: Fixture) => f.server.actSteps({ tab_id: "1", steps: [] }, meta("other"))],
    ["claim_tab", (f: Fixture) => f.server.claimTab({ tab_id: "1" }, meta("other"))],
    ["release", (f: Fixture) => f.server.release({ tab_id: "1" }, meta("other"))],
    ["screenshot", (f: Fixture) => f.server.screenshot({ tab_id: "1" }, meta("other"))]
  ];
  it.each(FOREIGN_TAB_CALLS)("refuses another session's %s before any call", async (_name, call) => {
    const { f, conn } = setup();
    expect(await refusal(call(f))).toBe("fast-chrome-tab-not-owned");
    expect(conn.calls).toEqual([]);
  });

  it("hides a busy tab's state from a foreign caller", async () => {
    const { f, tab } = setup();
    tab.operation.tryAcquire();
    expect(await refusal(f.server.observe({ tab_id: "1" }, meta("other")))).toBe("fast-chrome-tab-not-owned");
  });
});

describe("actions", () => {
  it("consumes the token on an unknown input", async () => {
    const { f, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = gate("opchrome-outcome-unknown");
    const args = { tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" };
    expect((await f.server.act(args, meta())).outcome).toBe("unknown");
    expect(await refusal(f.server.act(args, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(conn.methods()).toEqual(["observePage", "actPage"]);
  });

  it("keeps executed when the post-action read fails", async () => {
    const { f, tab, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [{ status: "executed" }, gate("opchrome-private-page")];
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta());
    expect(result.outcome).toBe("executed");
    expect(result.observation_error).toBe("browser-control-private-page");
    expect(tab.snapshot).toBeNull();
  });

  it("waits for an asynchronous public control", async () => {
    const { f, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [{ status: "executed" }, page("Loading", ["Continue"]), page("Ready", ["Continue", "Recipient"])];
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ action_label: "Recipient" }) }, meta());
    expect(result.outcome).toBe("executed");
    expect(result.wait).toBe("matched");
    expect(result.snapshot_id).toBeTruthy();
    expect((result.actions as Array<{ label: string }>).some((action) => action.label === "Recipient")).toBe(true);
    expect(conn.methods()).toEqual(["observePage", "actPage", "observePage", "observePage"]);
  });

  it("accepts a same-origin path expectation", async () => {
    const { f, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const destination = { ...page(), url: "https://example.test/direct-fe/dashboard" };
    conn.sideEffect = [{ status: "executed" }, destination];
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ url: "/direct-fe/dashboard" }) }, meta());
    expect(result.outcome).toBe("executed");
    expect(result.wait).toBe("matched");
    expect(result.url).toBe(destination.url);
  });

  it("binds a wait_for path to the claimed origin", async () => {
    const { f, conn } = setup();
    conn.returnValue = { ...page(), url: "https://other.test/direct-fe/dashboard" };
    const result = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ url: "/direct-fe/dashboard" }), timeout_ms: 1 }, meta());
    expect(result).toEqual({ outcome: "read_failed", error: "fast-chrome-origin-changed" });
  });

  const REFUSES_THE_AMBIGUOUS_PATH_CASES = ["//other.test/path", "/path\\bad", "/path\nother"];
  it.each(REFUSES_THE_AMBIGUOUS_PATH_CASES)("refuses the ambiguous path expectation %j", (url) => {
    expect(() => new PageExpectation({ url })).toThrow("fast-chrome-approved-web-url-required");
  });

  it("never replays or returns a token after a wait timeout", async () => {
    const { f, tab, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [{ status: "executed" }, page("Loading")];
    const result = await f.server.act({
      tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ text: "Ready later" }), timeout_ms: 1
    }, meta());
    expect(result.outcome).toBe("executed");
    expect(result.wait).toBe("timeout");
    expect(JSON.stringify(result)).not.toContain("snapshot_id");
    expect(tab.snapshot).toBeNull();
    expect(conn.methods().filter((method) => method === "actPage")).toHaveLength(1);
    expect(await refusal(f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
  });

  it("does not wait after an unexecuted action with an expectation", async () => {
    const { f, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [{ status: "not-executed" }];
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ text: "Ready later" }) }, meta());
    expect(result.outcome).toBe("not_executed");
    expect(conn.methods()).toEqual(["observePage", "actPage"]);
  });

  it("reads only the allowlisted action status", async () => {
    const { f, conn } = setup();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.returnValue = { status: "not-executed", reason: "PRIVATE_SENTINEL" };
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta());
    expect(result.outcome).toBe("not_executed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });

  it("refuses a file action through the generic act", async () => {
    const { f, conn } = setup();
    conn.returnValue = filePage();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    expect(await refusal(f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta()))).toBe("fast-chrome-file-action-requires-upload");
    expect(conn.methods()).toEqual(["observePage"]);
  });

  it("dispatches nothing for a cross-origin navigation", async () => {
    const { f, conn } = setup();
    expect(await refusal(f.server.navigate({ tab_id: "1", url: "https://other.test/" }, meta()))).toBe("fast-chrome-origin-change-refused");
    expect(conn.calls).toEqual([]);
  });
});

describe("uploads", () => {
  const VALIDATES_THE_PDF_AND_CASES = [0, 64 * 1024 * 1024];
  it.each(VALIDATES_THE_PDF_AND_CASES)("validates the PDF and returns only safe metadata (padding %d)", async (padding) => {
    const { f, conn } = setup();
    const pdf = path.join(f.root, "invoice.pdf");
    fs.writeFileSync(pdf, "%PDF-1.7\nfixture");
    fs.truncateSync(pdf, fs.statSync(pdf).size + padding);
    conn.sideEffect = [filePage(), { status: "attached" }];
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const result = await f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: pdf }, meta());
    expect(result).toEqual({ status: "attached", name: "invoice.pdf", mime: "application/pdf", size: fs.statSync(pdf).size, retry: false });
    expect(JSON.stringify(result)).not.toContain(pdf);
    const [method, params] = conn.calls[conn.calls.length - 1];
    expect(method).toBe("uploadFile");
    expect(params.path).toBe(pdf);
  });

  const INVALID_PDF_CASES = ["relative", "extension", "magic", "empty", "symlink", "nul"];
  it.each(INVALID_PDF_CASES)("refuses an invalid %s file and consumes the adapter token", async (kind) => {
    const { f, conn } = setup();
    const good = path.join(f.root, "good.pdf");
    fs.writeFileSync(good, "%PDF-x");
    let candidate = good;
    if (kind === "relative") candidate = "good.pdf";
    if (kind === "extension") fs.writeFileSync(candidate = path.join(f.root, "good.txt"), "%PDF-x");
    if (kind === "magic") fs.writeFileSync(candidate = path.join(f.root, "bad.pdf"), "NOPE!");
    if (kind === "empty") fs.writeFileSync(candidate = path.join(f.root, "empty.pdf"), "");
    if (kind === "symlink") fs.symlinkSync(good, candidate = path.join(f.root, "link.pdf"));
    if (kind === "nul") candidate = `${good}\0tail`;
    conn.returnValue = filePage();
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    expect(await refusal(f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: candidate }, meta()))).toBe("fast-chrome-valid-owned-pdf-required");
    expect(await refusal(f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: good }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(conn.methods()).toEqual(["observePage"]);
  });

  it("refuses during a recording and treats an unknown upload as single use", async () => {
    const { f, tab, conn } = setup();
    const pdf = path.join(f.root, "invoice.pdf");
    fs.writeFileSync(pdf, "%PDF-x");
    conn.returnValue = filePage();
    let observed = await f.server.observe({ tab_id: "1" }, meta());
    tab.recording = {} as never;
    expect(await refusal(f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: pdf }, meta()))).toBe("fast-chrome-stop-recording-first");
    tab.recording = null;
    observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = gate("opchrome-outcome-unknown");
    expect(await f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: pdf }, meta())).toEqual({ status: "unknown", retry: false });
    expect(await refusal(f.server.uploadFile({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", path: pdf }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
  });

  it("refuses a PDF owned by another user", () => {
    const f = fixture();
    const pdf = path.join(f.root, "invoice.pdf");
    fs.writeFileSync(pdf, "%PDF-x");
    const real = fs.lstatSync(pdf);
    const lstat = () => ({ mode: real.mode, uid: real.uid + 1, size: real.size, isSymbolicLink: () => false, isFile: () => true });
    expect(() => validatedPdf(pdf, { lstat })).toThrow("fast-chrome-valid-owned-pdf-required");
    expect(validatedPdf(pdf)).toEqual({ path: pdf, name: "invoice.pdf", size: 6 });
  });
});

describe("observation", () => {
  it("discards unrecognized values from the public snapshot", async () => {
    const { f, conn } = setup();
    const raw = page();
    raw.secret = "PRIVATE_SENTINEL";
    raw.actions[0].value = "PRIVATE_SENTINEL";
    conn.returnValue = raw;
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_SENTINEL");
    expect(observed.snapshot_id).not.toBe(raw.snapshot);
  });

  it("invalidates the previous token on a refused observation", async () => {
    const { f, tab, conn } = setup();
    await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = gate("opchrome-private-page");
    expect(await refusal(f.server.observe({ tab_id: "1" }, meta()))).toBe("browser-control-private-page");
    expect(tab.snapshot).toBeNull();
  });

  const INVALIDATES_THE_TOKEN_WHEN_CASES = ["version", "partial", "kind", "extra", "flags", "mode", "disabled", "label", "missing"];
  it.each(INVALIDATES_THE_TOKEN_WHEN_CASES)(
    "invalidates the token when the page metadata fails validation: %s", async (change) => {
      const { f, tab, conn } = setup();
      await f.server.observe({ tab_id: "1" }, meta());
      const raw = page();
      Object.assign(raw, { partial: true, opaqueSurfaces: [{ id: "opaque-0", kind: "iframe" }] });
      if (change === "version") raw.pageProtocolVersion = 1;
      if (change === "partial") raw.partial = false;
      if (change === "kind") raw.opaqueSurfaces[0].kind = "PRIVATE_CANARY";
      if (change === "extra") raw.opaqueSurfaces[0].title = "PRIVATE_CANARY";
      if (change === "flags") raw.truncation.text = 0;
      if (change === "mode") raw.mode = "controls-only";
      if (change === "disabled") raw.actions[0].disabled = 0;
      if (change === "label") raw.actions[0].label = "x".repeat(161);
      if (change === "missing") delete raw.truncation;
      conn.returnValue = raw;
      expect(await refusal(f.server.observe({ tab_id: "1" }, meta()))).toBe("fast-chrome-observation-unavailable");
      expect(tab.snapshot).toBeNull();
      expect(tab.page).toBeNull();
    });
});

describe("waits", () => {
  it("polls a pending page until it matches", async () => {
    const { f, conn } = setup();
    conn.sideEffect = [gate("opchrome-page-not-ready"), page("Loading"), page()];
    const result = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ text: "Ready", action_label: "Continue" }) }, meta());
    expect(result.outcome).toBe("matched");
    expect((result.snapshot as { snapshot_id: string }).snapshot_id).toBeTruthy();
    expect(new Set(conn.methods())).toEqual(new Set(["observePage"]));
  });

  const RETURNS_NO_TOKEN_FROM_CASES = ["timeout", "ambiguous", "read_failed"];
  it.each(RETURNS_NO_TOKEN_FROM_CASES)("returns no token from a failed wait: %s", async (mode) => {
    const { f, tab, conn } = setup();
    conn.returnValue = page("Loading", mode === "ambiguous" ? ["Continue", "Continue"] : []);
    if (mode === "read_failed") conn.sideEffect = gate("opchrome-private-page");
    const result = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ action_label: "Continue" }), timeout_ms: 1 }, meta());
    expect(result.outcome).toBe(mode);
    expect(tab.snapshot).toBeNull();
    expect(JSON.stringify(result)).not.toContain("snapshot_id");
  });

  it("treats a disabled action as not ready", async () => {
    const { f, conn } = setup();
    conn.returnValue = page("Ready", ["Continue"], true);
    const result = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ action_label: "Continue" }), timeout_ms: 1 }, meta());
    expect(result.outcome).toBe("timeout");
  });
});

describe("tab independence", () => {
  it("serializes one tab and leaves another independent", async () => {
    const { f, conn } = setup();
    const entered = deferred();
    const finish = deferred();
    conn.sideEffect = async () => {
      entered.resolve();
      await finish.promise;
      return page();
    };
    const other = f.server.newTab("ses_test", new FakeConnection(page()), 2, "https://example.test", true);
    f.server.registry.tabs.set("2", other);
    const pending = f.server.observe({ tab_id: "1" }, meta());
    try {
      await entered.promise;
      expect(await refusal(f.server.observe({ tab_id: "1" }, meta()))).toBe("fast-chrome-tab-busy");
      expect((await f.server.observe({ tab_id: "2" }, meta())).text).toBe("Ready");
    } finally {
      finish.resolve();
    }
    expect((await pending).text).toBe("Ready");
  });

  it("takes a call's busy flag in the same step as its lookup, so a release cannot slip in between", async () => {
    const { f, tab, conn } = setup();
    const entered = deferred();
    const finish = deferred();
    conn.sideEffect = async (method: string) => {
      if (method === "observePage") {
        entered.resolve();
        await finish.promise;
      }
      return page();
    };
    // hold() is synchronous: once observe() returns its promise, the tab is already busy.
    const first = f.server.observe({ tab_id: "1" }, meta());
    expect(tab.operation.busy).toBe(true);
    const second = f.server.release({ tab_id: "1" }, meta());
    expect(() => f.server.registry.hold("1", "ses_test")).toThrow("fast-chrome-tab-busy");
    await entered.promise;
    finish.resolve();
    expect(await refusal(second)).toBe("fast-chrome-tab-busy");
    expect((await first).tab_id).toBe("1");
    expect(f.server.registry.get("1")).toBe(tab);
    expect(tab.releaseAttempted).toBe(false);
    expect(conn.methods()).not.toContain("finalizeTabs");
  });

  it("keeps a call on the tab it locked when its handle is replaced", async () => {
    const { f, tab, conn } = setup();
    const resume = deferred();
    conn.sideEffect = async () => {
      await resume.promise;
      return page();
    };
    const replacement = f.server.newTab("ses_test", new FakeConnection(page("Replacement")), 1, "https://example.test", true);
    const pending = f.server.observe({ tab_id: "1" }, meta());
    f.server.registry.tabs.set("1", replacement); // a release and re-claim after this call locked its tab
    resume.resolve();
    expect((await pending).text).toBe("Ready");
    expect(connectionOf(replacement).calls).toEqual([]);
    expect(tab.page).not.toBeNull();
    expect(replacement.page).toBeNull();
  });

  it("confirms hold and the registry updates are synchronous", () => {
    const { f, tab } = setup();
    const held = f.server.registry.hold("1", "ses_test");
    expect(held).toBe(tab);
    expect(held instanceof Promise).toBe(false);
    tab.operation.release();
    const fresh = f.server.newTab("ses_test", new FakeConnection(), 9, "https://example.test", true);
    expect(f.server.registry.publish(fresh)).toBeUndefined();
    expect(f.server.registry.get("9")).toBe(fresh);
  });
});

describe("release", () => {
  const REQUIRES_A_SEMANTIC_READBACK_CASES = [[true, false, true], [true, true, false], [false, false, false]];
  it.each(REQUIRES_A_SEMANTIC_READBACK_CASES)(
    "requires a semantic readback (created %s, keep_open %s)", async (created, keep, closed) => {
      const { f, tab, conn } = setup();
      tab.created = created;
      const free = closed ? [] : [{ id: 1, url: "https://example.test/", title: "Fixture" }];
      conn.sideEffect = [{ closedOrReleased: true }, [], free];
      const result = await f.server.release({ tab_id: "1", keep_open: keep }, meta());
      expect(result).toEqual({ tab_id: "1", closed, release_confirmed: true });
      expect(f.server.registry.get("1")).toBeUndefined();
      expect(conn.closed).toBe(1);
    });

  it("never replays an unknown release", async () => {
    const { f, conn } = setup();
    conn.sideEffect = gate("opchrome-outcome-unknown");
    expect(await refusal(f.server.release({ tab_id: "1" }, meta()))).toBe("browser-control-outcome-unknown");
    expect(await refusal(f.server.release({ tab_id: "1" }, meta()))).toBe("fast-chrome-tab-terminal");
    expect(conn.calls).toHaveLength(1);
    expect(f.server.registry.get("1")).toBeDefined();
  });
});

describe("screenshots", () => {
  it("guards the capture and saves a private artifact", async () => {
    const { f, conn } = setup();
    const artifacts = path.join(f.root, "artifacts-root");
    fs.mkdirSync(artifacts, { mode: 0o700 });
    const tab = f.server.newTab("ses_test", conn, 1, "https://example.test", true, { artifactRoot: artifacts });
    f.server.registry.tabs.set("1", tab);
    conn.returnValue = { data: JPEG_4X4 };
    const result = await f.server.screenshot({ tab_id: "1" }, meta());
    expect(result[0].type).toBe("image");
    const saved = fs.readdirSync(artifacts).map((name) => path.join(artifacts, name, "screenshot.jpg"));
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(saved[0]).equals(Buffer.from(JPEG_4X4, "base64"))).toBe(true);
    expect(fs.statSync(saved[0]).mode & 0o077).toBe(0);
    expect(conn.calls[conn.calls.length - 1][0]).toBe("capturePage");
    conn.sideEffect = gate("opchrome-private-page");
    expect(await refusal(f.server.screenshot({ tab_id: "1" }, meta()))).toBe("browser-control-private-page");
    expect(fs.readdirSync(artifacts)).toHaveLength(1);
  });

  it("creates the default user artifact root on first use (D2)", async () => {
    const f = fixture();
    const conn = new FakeConnection();
    conn.sideEffect = [{ id: 1, active: false, url: "about:blank" }, { name: "OpenCode · test", confirmed: true }, { attached: true },
      { bound: true }, { status: "dispatched" }, page(), { data: JPEG_4X4 }];
    setConnect(f.server, () => conn);
    await f.server.openTab({ url: "https://example.test/" }, meta());
    const root = path.join(f.root, "artifacts/user");
    expect(fs.existsSync(root)).toBe(false);
    const result = await f.server.screenshot({ tab_id: "1" }, meta());
    expect((result[1] as { text: string }).text).toMatch(new RegExp(`^Saved screenshot: ${root}/chrome-capture-[^/]+/screenshot.jpg$`));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });
});

describe("setup", () => {
  it("retains the handle after an observation failure while opening", async () => {
    const f = fixture();
    const conn = new FakeConnection();
    conn.sideEffect = [{ id: 1, active: false, url: "about:blank" }, { name: "OpenCode · test", confirmed: true }, { attached: true },
      { bound: true }, { status: "dispatched" }, gate("opchrome-page-not-ready")];
    setConnect(f.server, () => conn);
    const result = await f.server.openTab({ url: "https://example.test/" }, meta());
    expect(result.outcome).toBe("opened");
    expect(result.tab_id).toBe("1");
    expect(result.observation_error).toBe("browser-control-page-not-ready");
    expect(f.server.registry.get("1")).toBeDefined();
    expect(conn.closed).toBe(0);
  });

  it("cleans a created tab after a failed bind, before closing the connection", async () => {
    const f = fixture();
    const conn = new FakeConnection();
    conn.sideEffect = [{ id: 1, active: false, url: "about:blank" }, { name: "OpenCode · test", confirmed: true }, { attached: true },
      gate("opchrome-operation-refused"), { closedOrReleased: true }, [], []];
    setConnect(f.server, () => conn);
    const result = await f.server.openTab({ url: "https://example.test/" }, meta());
    expect(result.outcome).toBe("incomplete");
    expect(result.cleanup).toBe("confirmed");
    expect(result.error).toBe("browser-control-operation-refused");
    expect(f.server.registry.tabs.size).toBe(0);
    expect(conn.methods()).toEqual(["createTab", "nameSession", "attach", "bindPage", "finalizeTabs", "getTabs", "getUserTabs"]);
  });

  it("keeps a failed attach with uncertain cleanup visible", async () => {
    const f = fixture();
    const conn = new FakeConnection();
    conn.sideEffect = [{ id: 1, active: false, url: "about:blank" }, { name: "OpenCode · test", confirmed: true },
      gate("opchrome-operation-refused"), gate("opchrome-outcome-unknown")];
    setConnect(f.server, () => conn);
    const result = await f.server.openTab({ url: "https://example.test/" }, meta());
    expect(result.outcome).toBe("incomplete");
    expect(result.cleanup).toBe("unconfirmed");
    expect(f.server.registry.get("1")?.releaseAttempted).toBe(true);
    const discovery = new FakeConnection([]);
    setConnect(f.server, () => discovery);
    expect(((await f.server.tabs({}, meta())).tabs as Array<{ cleanup: string }>)[0].cleanup).toBe("unconfirmed");
  });

  it("never lets a register race replace an existing handle", async () => {
    const f = fixture();
    const original = f.server.newTab("original", new FakeConnection(), 1, "https://example.test", true);
    const conn = new FakeConnection();
    const candidate = f.server.newTab("candidate", conn, 1, "https://example.test", true);
    conn.sideEffect = (method: string) => {
      if (method === "bindPage") {
        f.server.registry.tabs.set("1", original);
        return { bound: true };
      }
      return { attached: true };
    };
    expect(await refusal(f.server.register(candidate))).toBe("fast-chrome-tab-already-managed");
    conn.sideEffect = [{ closedOrReleased: true }, [], []];
    await f.server.failedSetup(candidate, conn, gate("fast-chrome-tab-already-managed"));
    expect(f.server.registry.get("1")).toBe(original);
  });

  const PUBLISHES_A_NEW_TAB_CASES = [false, true];
  it.each(PUBLISHES_A_NEW_TAB_CASES)("publishes a new tab only while it is busy (claim %s)", async (claim) => {
    const f = fixture();
    const conn = new FakeConnection();
    const first = claim ? [[{ id: 1, url: "https://example.test/", title: "User" }], { id: 1, url: "https://example.test/", title: "User" }]
      : [{ id: 1, active: false, url: "about:blank" }];
    conn.sideEffect = [...first, { name: "OpenCode · test", confirmed: true }, { attached: true }, { bound: true },
      ...(claim ? [] : [{ status: "dispatched" }]), page(), page()];
    setConnect(f.server, () => conn);
    const refusals: string[] = [];
    const publish = f.server.register.bind(f.server);
    f.server.register = async (tab: Tab) => {
      await publish(tab);
      const code = await refusal(f.server.observe({ tab_id: tab.key }, meta()));
      if (code) refusals.push(code);
      return tab;
    };
    const result = claim ? await f.server.claimTab({ tab_id: "1" }, meta()) : await f.server.openTab({ url: "https://example.test/" }, meta());
    expect(result.outcome).toBe(claim ? "claimed" : "opened");
    expect(refusals).toEqual(["fast-chrome-tab-busy"]);
    expect((await f.server.observe({ tab_id: "1" }, meta())).tab_id).toBe("1");
  });
});

describe("controls-only preference", () => {
  it("preserves coverage metadata in controls-only mode", async () => {
    const { f, conn } = setup();
    const raw = page("");
    Object.assign(raw, { mode: "controls-only", partial: true, opaqueSurfaces: [{ id: "opaque-0", kind: "closed-shadow-root" }] });
    conn.returnValue = raw;
    const result = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    expect(result.partial).toBe(true);
    expect(result.opaqueSurfaces).toEqual(raw.opaqueSurfaces);
    expect(result.truncation).toEqual(raw.truncation);
    expect(result.text).toBe("");
    expect(conn.calls[conn.calls.length - 1][1].controlsOnly).toBe(true);
  });

  it("survives the automatic post-action observation", async () => {
    const { f, conn } = setup();
    const raw = { ...page(""), mode: "controls-only" };
    conn.returnValue = raw;
    const observed = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    conn.sideEffect = [{ status: "executed" }, raw];
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0" }, meta());
    expect(result.mode).toBe("controls-only");
    expect(result.text).toBe("");
    expect(conn.calls[conn.calls.length - 1][1].controlsOnly).toBe(true);
  });

  const SURVIVES_AN_ACTION_WAIT_CASES = [true, false];
  it.each(SURVIVES_AN_ACTION_WAIT_CASES)("survives an action wait (matched %s)", async (matched) => {
    const { f, tab, conn } = setup();
    const raw = { ...page("", matched ? ["Continue", "Recipient"] : ["Continue"]), mode: "controls-only" };
    conn.returnValue = raw;
    const observed = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    conn.sideEffect = (method: string) => (method === "actPage" ? { status: "executed" } : raw);
    const result = await f.server.act({
      tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ action_label: "Recipient" }), timeout_ms: 1
    }, meta());
    expect(result.wait).toBe(matched ? "matched" : "timeout");
    expect(tab.controlsOnly).toBe(true);
    expect(conn.calls.filter(([method]) => method === "observePage").every(([, params]) => params.controlsOnly === true)).toBe(true);
    if (matched) {
      expect(result.mode).toBe("controls-only");
      expect(result.text).toBe("");
    } else {
      expect(JSON.stringify(result)).not.toContain("snapshot_id");
      expect(tab.snapshot).toBeNull();
    }
  });

  it("survives a standalone wait and the following action", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = (method: string, params: any) => {
      if (method === "actPage") return { status: "executed" };
      const limited = params?.controlsOnly ?? false;
      return { ...page(limited ? "" : "BODY_CANARY", ["Continue", "Recipient"]), mode: limited ? "controls-only" : "full" };
    };
    await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const waited = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ action_label: "Recipient" }) }, meta());
    expect(waited.outcome).toBe("matched");
    expect((waited.snapshot as { mode: string }).mode).toBe("controls-only");
    expect(JSON.stringify(waited)).not.toContain("BODY_CANARY");
    const acted = await f.server.act({ tab_id: "1", snapshot_id: (waited.snapshot as { snapshot_id: string }).snapshot_id, action_id: "0" }, meta());
    expect(acted.mode).toBe("controls-only");
    expect(acted.text).toBe("");
    expect(tab.controlsOnly).toBe(true);
  });

  it("reads full for a standalone text wait and matches", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch();
    await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const waited = await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ text: "Ready" }), timeout_ms: 1 }, meta());
    const snapshot = waited.snapshot as Record<string, any>;
    expect(waited.outcome).toBe("matched");
    expect(snapshot.mode).toBe("controls-only");
    expect(snapshot.text).toBe("");
    expect(snapshot.truncation.text).toBe(false);
    expect(JSON.stringify(waited)).not.toContain("BODY_CANARY");
    expect(tab.controlsOnly).toBe(true);
    expect(tab.page?.text).toContain("BODY_CANARY");
    expect(conn.modes()).toEqual([["observePage", true], ["observePage", false]]);
    const acted = await f.server.act({ tab_id: "1", snapshot_id: snapshot.snapshot_id, action_id: "0" }, meta());
    expect(acted.outcome).toBe("executed");
    expect(acted.mode).toBe("controls-only");
    expect(conn.modes().slice(-2)).toEqual([["actPage", undefined], ["observePage", true]]);
  });

  it("reads full for a text expectation after an action", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch();
    const observed = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const result = await f.server.act({ tab_id: "1", snapshot_id: observed.snapshot_id, action_id: "0", expect: new PageExpectation({ text: "Ready" }) }, meta());
    expect(result.outcome).toBe("executed");
    expect(result.wait).toBe("matched");
    expect(result.mode).toBe("controls-only");
    expect(result.text).toBe("");
    expect(JSON.stringify(result)).not.toContain("BODY_CANARY");
    expect(result.snapshot_id).toBe(tab.snapshot?.[0]);
    expect(tab.controlsOnly).toBe(true);
    expect(conn.modes()).toEqual([["observePage", true], ["actPage", undefined], ["observePage", false]]);
  });

  it("keeps the controls-only preference on an existing claim", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch();
    await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const claimed = await f.server.claimTab({ tab_id: "1" }, meta());
    expect(claimed.mode).toBe("controls-only");
    expect(claimed.text).toBe("");
    expect(tab.controlsOnly).toBe(true);
    expect(conn.modes()).toEqual([["observePage", true], ["observePage", true]]);
  });

  it("resets the controls-only preference only through observe", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch();
    await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    await f.server.waitFor({ tab_id: "1", expect: new PageExpectation({ text: "Ready" }), timeout_ms: 1 }, meta());
    expect(tab.controlsOnly).toBe(true);
    const full = await f.server.observe({ tab_id: "1" }, meta());
    expect(full.mode).toBe("full");
    expect(full.text).toContain("BODY_CANARY");
    expect(tab.controlsOnly).toBe(false);
    expect(await refusal(f.server.observe({ tab_id: "1", controls_only: "yes" }, meta()))).toBe("fast-chrome-invalid-observation-mode");
    expect(tab.controlsOnly).toBe(false);
    expect(tab.snapshot).toBeNull();
  });
});

describe("recording (added: the server's wiring of native_captures)", () => {
  function recorder(f: Fixture) {
    const artifacts = path.join(f.root, "recordings");
    fs.mkdirSync(artifacts, { mode: 0o700 });
    const conn = new FakeConnection();
    conn.sideEffect = (method: string, params: any) => {
      if (method === "recordingState") return { recording: params.active };
      if (method === "capturePage") return { data: JPEG_4X4 };
      if (method === "finalizeTabs") return { closedOrReleased: true };
      if (method === "getTabs" || method === "getUserTabs") return [];
      return page();
    };
    const tab = f.server.newTab("ses_test", conn, 1, "https://example.test", true, { artifactRoot: artifacts });
    f.server.registry.tabs.set("1", tab);
    return { tab, conn, artifacts };
  }

  const deps = {
    ffmpeg: () => "/synthetic/ffmpeg",
    run: async (_file: string, args: string[], cwd: string) => {
      if (args.includes("recording.mp4")) fs.writeFileSync(path.join(cwd, "recording.mp4"), "synthetic video");
    }
  };

  it("starts one recording per tab, refuses release while it runs, and stops it with a receipt", async () => {
    const f = fixture({ recordingDeps: deps });
    const { tab, artifacts } = recorder(f);
    const started = await f.server.startRecording({ tab_id: "1", fps: 15, max_seconds: 1 }, meta());
    expect(started).toEqual({ directory: tab.recording?.directory, fps: 15, max_seconds: 1, kind: "timestamped-jpeg-sampled-video" });
    expect(path.dirname(started.directory as string)).toBe(artifacts);
    expect(await refusal(f.server.startRecording({ tab_id: "1" }, meta()))).toBe("fast-chrome-recording-already-exists");
    expect(await refusal(f.server.release({ tab_id: "1" }, meta()))).toBe("fast-chrome-stop-recording-first");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const receipt = await f.server.stopRecording({ tab_id: "1" }, meta());
    expect(receipt.kind).toBe("timestamped-jpeg-sampled-video");
    expect((receipt.frames as unknown[]).length).toBeGreaterThan(0);
    expect(receipt.path).toBe(path.join(started.directory as string, "recording.mp4"));
    expect(receipt.decode_verified).toBe(true);
    expect(tab.recording).toBeNull();
    expect(await refusal(f.server.stopRecording({ tab_id: "1" }, meta()))).toBe("fast-chrome-no-recording");
    expect((await f.server.release({ tab_id: "1" }, meta())).release_confirmed).toBe(true);
  });

  it("refuses a recording outside the bounds or without ffmpeg", async () => {
    const f = fixture({ recordingDeps: { ...deps, ffmpeg: () => null } });
    recorder(f);
    expect(await refusal(f.server.startRecording({ tab_id: "1", fps: 0 }, meta()))).toBe("fast-chrome-recording-bounds");
    expect(await refusal(f.server.startRecording({ tab_id: "1" }, meta()))).toBe("fast-chrome-ffmpeg-required");
  });

  it("stops a running recording without encoding during cleanup", async () => {
    const f = fixture({ recordingDeps: deps });
    const { conn } = recorder(f);
    const started = await f.server.startRecording({ tab_id: "1" }, meta());
    await f.server.cleanup(performance.now() / 1000 + 2.5);
    expect(conn.calls.filter(([method]) => method === "recordingState").map(([, params]) => params.active)).toEqual([true, false]);
    expect(conn.methods().slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(fs.existsSync(path.join(started.directory as string, "recording.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(started.directory as string, "capture.json"))).toBe(true);
  });
});
