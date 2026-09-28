// test_native_server.py, act_steps: 1-10 exact-label steps in order, a stop at the first mismatch before or
// after input, the dispatched flag with final or final: null, the expect predicates and the run budget.
import { afterEach, describe, expect, it } from "vitest";
import { PageExpectation, Step, ValidationError } from "../../../src/server/args";
import { monotonic } from "../../../src/server/time";
import { removeTempRoots } from "../support/temp";
import {
  body, connectionOf, deferred, fixture, gate, mcpClient, meta, modeDispatch, refusal, serve, stepsPage, tabFixture, text, type FakeConnection,
  type Fixture
} from "./helpers";
import type { Tab } from "../../../src/server/tabs";

afterEach(() => removeTempRoots());

const BEFORE_INPUT = "choose from final.actions; do not replay completed steps";
const AFTER_INPUT = "observe; do not replay";
const UNTIL_ENABLED = "wait for it to enable, e.g. wait_for expect {action_label: label}; do not replay completed steps";

function setup(): { f: Fixture; tab: Tab; conn: FakeConnection } {
  const f = fixture();
  const tab = tabFixture(f);
  return { f, tab, conn: connectionOf(tab) };
}

const step = (fields: Record<string, unknown>) => new Step(fields);

describe("act_steps", () => {
  it("runs steps in order from each returned snapshot", async () => {
    const { f, tab, conn } = setup();
    const form = stepsPage([["fill", "Amount"], ["click", "Continue"]]);
    const review = stepsPage([["click", "Back"], ["click", "Confirm"]], { token: "token-2" });
    const done = stepsPage([["click", "Done"], ["click", "Retry"]], { text: "Paid BODY_CANARY", token: "token-3" });
    done.actions[1].disabled = true;
    conn.sideEffect = [form, { status: "executed" }, review, { status: "executed" }, review, done];
    const result = await f.server.actSteps({
      tab_id: "1", steps: [step({ label: "Amount", kind: "fill", text: "12.50" }),
        step({ label: "Confirm", role: "button", expect: new PageExpectation({ action_label: "Done" }) })]
    }, meta());
    expect(result.tab_id).toBe("1");
    expect(result.stopped).toBeNull();
    expect(Number.isInteger(result.elapsed_ms)).toBe(true);
    expect((result.completed as any[]).map((c) => [c.i, c.label, c.action_id, c.outcome, c.wait])).toEqual([
      [0, "Amount", "0", "executed", undefined], [1, "Confirm", "1", "executed", "matched"]]);
    expect(conn.calls.filter(([method]) => method === "actPage").map(([, params]) => params)).toEqual([
      { tabId: 1, snapshot: "backend-token", actionId: "0", text: "12.50" }, { tabId: 1, snapshot: "token-2", actionId: "1" }]);
    expect(result.final).toEqual({
      url: "https://example.test/", title: "Fixture", mode: "full", partial: false, truncated: [], snapshot_id: tab.snapshot?.[0], actions: ["0:Done"]
    });
    expect(tab.snapshot?.[1]).toBe("token-3");
    expect(JSON.stringify(result)).not.toContain("BODY_CANARY");
    expect(conn.methods()).toEqual(["observePage", "actPage", "observePage", "actPage", "observePage", "observePage"]);
  });

  const UNRESOLVED_LABELS = [["No such control", "no_match"], ["Continue", "ambiguous"]];
  it.each(UNRESOLVED_LABELS)(
    "stops before dispatch on an unresolved label %j with a usable snapshot", async (label, reason) => {
      const { f, tab, conn } = setup();
      serve(conn, stepsPage([["fill", "Email"], ["click", "Continue"], ["click", "Continue"]]));
      const observed = await f.server.observe({ tab_id: "1" }, meta());
      const result = await f.server.actSteps({
        tab_id: "1", steps: [step({ label: "Email", text: "canary@example.invalid" }), step({ label })], snapshot_id: observed.snapshot_id
      }, meta());
      expect((result.completed as any[]).map((c) => c.label)).toEqual(["Email"]);
      expect(result.stopped).toEqual({ i: 1, label, reason, dispatched: false, ...(reason === "ambiguous" ? { count: 2 } : {}), next: BEFORE_INPUT });
      expect((result.final as any).actions).toEqual(["0:Email", "1:Continue", "2:Continue"]);
      expect((result.final as any).snapshot_id).toBe(tab.snapshot?.[0]);
      expect(conn.methods()).toEqual(["observePage", "actPage", "observePage"]);
      expect((await f.server.act({ tab_id: "1", snapshot_id: (result.final as any).snapshot_id, action_id: "1" }, meta())).outcome).toBe("executed");
    });

  const REFUSES_AN_UNSUPPORTED_CONTROL_CASES = [
    [{ label: "Upload PDF" }, "upload_excluded"],
    [{ label: "Amount" }, "text_required"],
    [{ label: "Continue", text: "public" }, "invalid_public_input"],
    [{ label: "Continue", kind: "fill", text: "public" }, "no_match"],
    [{ label: "Continue", role: "link" }, "no_match"],
    [{ label: "Disabled", kind: "fill", text: "public" }, "no_match"],
    [{ label: "Disabled", role: "link" }, "no_match"]
  ];
  it.each(REFUSES_AN_UNSUPPORTED_CONTROL_CASES)("refuses an unsupported control %j before dispatch", async (fields, reason) => {
    const { f, conn } = setup();
    const raw = stepsPage([["upload", "Upload PDF"], ["fill", "Amount"], ["click", "Continue"], ["click", "Disabled"]]);
    raw.actions[3].disabled = true;
    conn.returnValue = raw;
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const result = await f.server.actSteps({ tab_id: "1", steps: [step(fields)], snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toEqual({ i: 0, label: fields.label, reason, dispatched: false, next: BEFORE_INPUT });
    expect(result.completed).toEqual([]);
    expect((result.final as any).snapshot_id).toBe(observed.snapshot_id);
    expect((result.final as any).actions).toEqual(["0:Upload PDF", "1:Amount", "2:Continue"]);
    expect(conn.methods()).toEqual(["observePage"]);
  });

  const DISABLED_COPIES = [1, 2];
  it.each(DISABLED_COPIES)("stops before dispatch on %d disabled matches with a usable snapshot", async (copies) => {
    const { f, tab, conn } = setup();
    const raw = stepsPage([...Array.from({ length: copies }, () => ["click", "Skip for now"] as [string, string]), ["click", "Continue"]]);
    for (const action of raw.actions.slice(0, copies)) action.disabled = true;
    serve(conn, raw);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Skip for now", kind: "click", role: "button" })], snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toEqual({ i: 0, label: "Skip for now", reason: "disabled", dispatched: false, count: copies, next: UNTIL_ENABLED });
    expect(result.completed).toEqual([]);
    expect((result.final as any).actions).toEqual([`${copies}:Continue`]);
    expect((result.final as any).snapshot_id).toBe(observed.snapshot_id);
    expect(tab.snapshot?.[0]).toBe(observed.snapshot_id);
    expect(conn.methods()).toEqual(["observePage"]);
    expect((await f.server.act({ tab_id: "1", snapshot_id: (result.final as any).snapshot_id, action_id: String(copies) }, meta())).outcome).toBe("executed");
  });

  it("selects the enabled action among disabled duplicates", async () => {
    const { f, conn } = setup();
    const raw = stepsPage([["click", "Skip for now"], ["click", "Skip for now"], ["click", "Skip for now"]]);
    raw.actions[0].disabled = raw.actions[2].disabled = true;
    serve(conn, raw);
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Skip for now", kind: "click", role: "button" })] }, meta());
    expect(result.stopped).toBeNull();
    expect((result.completed as any[]).map((c) => [c.i, c.action_id, c.outcome])).toEqual([[0, "1", "executed"]]);
    expect(conn.calls.filter(([method]) => method === "actPage").map(([, params]) => params.actionId)).toEqual(["1"]);
  });

  const STOPS_WITHOUT_REPLAY_AFTER_CASES = [
    [{ status: "not-executed" }, "not_executed", null],
    [{ status: "unknown" }, "unknown", null],
    [gate("opchrome-outcome-unknown"), "unknown", "browser-control-outcome-unknown"],
    [{ status: "PRIVATE_SENTINEL" }, "unknown", "fast-chrome-invalid-action-result"]
  ];
  it.each(STOPS_WITHOUT_REPLAY_AFTER_CASES)("stops without replay after an unconfirmed dispatch %#", async (response, reason, error) => {
    const { f, tab, conn } = setup();
    conn.returnValue = stepsPage([["click", "Continue"], ["click", "Next"]]);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [response];
    const run = [step({ label: "Continue", expect: new PageExpectation({ text: "Ready" }) }), step({ label: "Next" })];
    const result = await f.server.actSteps({ tab_id: "1", steps: run, snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toEqual({ i: 0, label: "Continue", reason, dispatched: true, action_id: "0", outcome: reason, ...(error ? { error } : {}), next: AFTER_INPUT });
    expect(result.completed).toEqual([]);
    expect(result.final).toBeNull();
    expect(tab.snapshot).toBeNull();
    expect(conn.methods()).toEqual(["observePage", "actPage"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(await refusal(f.server.actSteps({ tab_id: "1", steps: run, snapshot_id: observed.snapshot_id }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(conn.methods()).toEqual(["observePage", "actPage"]);
  });

  const STOPS_AFTER_DISPATCH_WITHOUT_CASES = [
    [{ text: "fast-chrome-never-present" }, stepsPage([["click", "Continue"]]), "wait_timeout", null],
    [{ action_label: "Continue" }, stepsPage([["click", "Continue"], ["click", "Continue"]]), "wait_ambiguous", null],
    [{ text: "Ready" }, gate("opchrome-private-page"), "wait_read_failed", "browser-control-private-page"]
  ];
  it.each(STOPS_AFTER_DISPATCH_WITHOUT_CASES)("stops after dispatch without a token on a failed wait %#", async (expectation, after, reason, error) => {
    const { f, tab, conn } = setup();
    conn.returnValue = stepsPage([["click", "Continue"], ["click", "Next"]]);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = (method: string) => {
      if (method === "actPage") return { status: "executed" };
      if (after instanceof Error) throw after;
      return after;
    };
    const run = [step({ label: "Continue", expect: new PageExpectation(expectation), timeout_ms: 1 }), step({ label: "Next" })];
    const result = await f.server.actSteps({ tab_id: "1", steps: run, snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toEqual({ i: 0, label: "Continue", reason, dispatched: true, action_id: "0", outcome: "executed", ...(error ? { error } : {}), next: AFTER_INPUT });
    expect(result.completed).toEqual([]);
    expect(result.final).toBeNull();
    expect(tab.snapshot).toBeNull();
    expect(JSON.stringify(result)).not.toContain("snapshot_id");
    expect(conn.methods().filter((method) => method === "actPage")).toHaveLength(1);
  });

  it("stops with the observation's gate when the read after a step fails", async () => {
    const { f, tab, conn } = setup();
    conn.returnValue = stepsPage([["click", "Continue"], ["click", "Next"]]);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    conn.sideEffect = [{ status: "executed" }, gate("opchrome-private-page")];
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" }), step({ label: "Next" })], snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toEqual({
      i: 0, label: "Continue", reason: "observation_failed", dispatched: true, action_id: "0", outcome: "executed", error: "browser-control-private-page",
      next: AFTER_INPUT
    });
    expect(result.completed).toEqual([]);
    expect(result.final).toBeNull();
    expect(tab.snapshot).toBeNull();
    expect(conn.methods()).toEqual(["observePage", "actPage", "observePage"]);
  });

  it("stops before the next dispatch once the budget is spent", async () => {
    const { f, tab, conn } = setup();
    serve(conn, stepsPage([["click", "Continue"], ["click", "Next"]]), "executed", 80);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" }), step({ label: "Next" })], snapshot_id: observed.snapshot_id, timeout_ms: 50 }, meta());
    expect((result.completed as any[]).map((c) => c.label)).toEqual(["Continue"]);
    expect(result.stopped).toEqual({ i: 1, label: "Next", reason: "budget_exhausted", dispatched: false, next: BEFORE_INPUT });
    expect((result.final as any).snapshot_id).toBe(tab.snapshot?.[0]);
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(50);
    expect(conn.methods()).toEqual(["observePage", "actPage", "observePage"]);
  });

  it("stops before the wait after a dispatch once the budget is spent", async () => {
    const { f, tab, conn } = setup();
    serve(conn, stepsPage([["click", "Continue"], ["click", "Next"]]), "executed", 80);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const run = [step({ label: "Continue", expect: new PageExpectation({ action_label: "Next" }), timeout_ms: 15000 }), step({ label: "Next" })];
    const result = await f.server.actSteps({ tab_id: "1", steps: run, snapshot_id: observed.snapshot_id, timeout_ms: 50 }, meta());
    expect(result.stopped).toEqual({ i: 0, label: "Continue", reason: "budget_exhausted", dispatched: true, action_id: "0", outcome: "executed", next: AFTER_INPUT });
    expect(result.completed).toEqual([]);
    expect(result.final).toBeNull();
    expect(tab.snapshot).toBeNull();
    expect(conn.methods()).toEqual(["observePage", "actPage"]);
  });

  it("caps a step's wait by the run budget", async () => {
    const { f, conn } = setup();
    serve(conn, stepsPage([["click", "Continue"]]));
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    const started = monotonic();
    const result = await f.server.actSteps({
      tab_id: "1", steps: [step({ label: "Continue", expect: new PageExpectation({ text: "never" }), timeout_ms: 15000 })], snapshot_id: observed.snapshot_id,
      timeout_ms: 150
    }, meta());
    expect((result.stopped as any).reason).toBe("wait_timeout");
    expect(monotonic() - started).toBeLessThan(2);
  });

  const REFUSES_BAD_INPUT_BEFORE_CASES = [
    [[], 30000, "fast-chrome-steps-bounds"],
    [Array.from({ length: 11 }, () => ({ label: "Continue" })), 30000, "fast-chrome-steps-bounds"],
    [[{ label: "Continue" }], 0, "fast-chrome-steps-bounds"],
    [[{ label: "Continue" }], 60001, "fast-chrome-steps-bounds"],
    [[{ label: "Continue" }], true, "fast-chrome-steps-bounds"],
    ["plain", 30000, "fast-chrome-steps-bounds"],
    [[{ label: "Continue" }, { label: "Continue", kind: "click", text: "public" }], 30000, "fast-chrome-invalid-public-input"],
    [[{ label: "Amount", kind: "fill" }], 30000, "fast-chrome-invalid-public-input"]
  ];
  it.each(REFUSES_BAD_INPUT_BEFORE_CASES)("refuses bad input before any socket call %#", async (fields, timeout, expected) => {
    const { f, conn } = setup();
    // "plain" is a dict instead of a Step, as Python passed [{"label": "Continue"}].
    const steps = fields === "plain" ? [{ label: "Continue" }] : (fields as Array<Record<string, unknown>>).map(step);
    expect(await refusal(f.server.actSteps({ tab_id: "1", steps, timeout_ms: timeout }, meta()))).toBe(expected);
    expect(conn.calls).toEqual([]);
  });

  const KEEPS_THE_STEP_MODEL_CASES = [
    { label: "" }, { label: "x".repeat(161) }, { label: "Continue", role: "" }, { label: "Continue", text: "x".repeat(2001) },
    { label: "Continue", timeout_ms: 0 }, { label: "Continue", timeout_ms: 15001 }, { label: "Continue", timeout_ms: "10" },
    { label: "Continue", kind: "upload" }, { label: "Continue", value: "secret" }
  ];
  it.each(KEEPS_THE_STEP_MODEL_CASES)("keeps the Step model strict and bounded: %j", (fields) => {
    expect(() => new Step(fields)).toThrow(ValidationError);
  });

  it("requires the current snapshot", async () => {
    const { f, tab, conn } = setup();
    expect(await refusal(f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" })], snapshot_id: "missing" }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(conn.calls).toEqual([]);
    const observed = await f.server.observe({ tab_id: "1" }, meta());
    expect(await refusal(f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" })], snapshot_id: "stale" }, meta()))).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(conn.methods()).toEqual(["observePage"]);
    expect(tab.snapshot?.[0]).toBe(observed.snapshot_id);
  });

  it("refuses a busy tab before any call", async () => {
    const { f, tab, conn } = setup();
    tab.operation.tryAcquire();
    expect(await refusal(f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" })] }, meta()))).toBe("fast-chrome-tab-busy");
    expect(conn.calls).toEqual([]);
  });

  it("holds the tab busy for the whole run", async () => {
    const { f, conn } = setup();
    const entered = deferred();
    const finish = deferred();
    const raw = stepsPage([["click", "Continue"], ["click", "Next"]]);
    conn.sideEffect = async (method: string) => {
      if (method === "actPage") {
        entered.resolve();
        await finish.promise;
        return { status: "executed" };
      }
      return raw;
    };
    const pending = f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" }), step({ label: "Next" })] }, meta());
    try {
      await entered.promise;
      expect(await refusal(f.server.observe({ tab_id: "1" }, meta()))).toBe("fast-chrome-tab-busy");
      expect(await refusal(f.server.actSteps({ tab_id: "1", steps: [step({ label: "Next" })] }, meta()))).toBe("fast-chrome-tab-busy");
    } finally {
      finish.resolve();
    }
    expect((await pending).stopped).toBeNull();
  });

  it("reads only the final view full with include_text", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch(["Continue", "Next"]);
    const observed = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" }), step({ label: "Next" })], snapshot_id: observed.snapshot_id, include_text: true }, meta());
    expect(result.stopped).toBeNull();
    expect(tab.controlsOnly).toBe(true);
    expect((result.final as any).text).toBe("Ready BODY_CANARY");
    expect((result.final as any).mode).toBe("full");
    expect((result.final as any).truncated).toEqual(["text"]);
    expect(conn.modes()).toEqual([["observePage", true], ["actPage", undefined], ["observePage", true], ["actPage", undefined], ["observePage", false]]);
    const plain = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue" })] }, meta());
    expect((plain.final as any).mode).toBe("controls-only");
    expect(plain.final).not.toHaveProperty("text");
    expect((plain.final as any).truncated).toEqual([]);
    expect(JSON.stringify(plain)).not.toContain("BODY_CANARY");
    expect(conn.modes()[conn.modes().length - 1]).toEqual(["observePage", true]);
  });

  it("reads full for a text expectation under controls-only", async () => {
    const { f, tab, conn } = setup();
    conn.sideEffect = modeDispatch();
    const observed = await f.server.observe({ tab_id: "1", controls_only: true }, meta());
    const result = await f.server.actSteps({ tab_id: "1", steps: [step({ label: "Continue", expect: new PageExpectation({ text: "Ready" }) })], snapshot_id: observed.snapshot_id }, meta());
    expect(result.stopped).toBeNull();
    expect((result.completed as any[])[0].wait).toBe("matched");
    expect((result.final as any).mode).toBe("controls-only");
    expect(result.final).not.toHaveProperty("text");
    expect(JSON.stringify(result)).not.toContain("BODY_CANARY");
    expect(tab.controlsOnly).toBe(true);
    expect(conn.modes()).toEqual([["observePage", true], ["actPage", undefined], ["observePage", false]]);
  });

  it("accepts strict JSON steps through MCP", async () => {
    const { f, conn } = setup();
    serve(conn, stepsPage([["fill", "Amount"], ["click", "Continue"]]));
    const sessionMeta = { "ai.opencode/sessionID": "ses_test" };
    const refusals = [
      [{ label: "Amount", timeout_ms: "500" }],
      [{ label: "Amount", text: "1", expect: { text: "Ready", value: "secret" } }],
      [{ label: "Amount", text: "1", expect: { url: "//other.test/path" } }],
      Array.from({ length: 11 }, () => ({ label: "Continue" }))
    ];
    const { client, close } = await mcpClient(f.server);
    try {
      const tool = (await client.listTools()).tools.find((item) => item.name === "act_steps") as any;
      const accepted = await client.callTool({
        name: "act_steps", _meta: sessionMeta, arguments: {
          tab_id: "1", steps: [{ label: "Amount", kind: "fill", text: "12.50", expect: { action_label: "Continue" }, timeout_ms: 500 }, { label: "Continue", role: "button" }]
        }
      });
      const calls = conn.methods();
      const refused = [];
      for (const steps of refusals) refused.push(await client.callTool({ name: "act_steps", _meta: sessionMeta, arguments: { tab_id: "1", steps } }));
      expect(tool.inputSchema.properties.steps.minItems).toBe(1);
      expect(tool.inputSchema.properties.steps.maxItems).toBe(10);
      expect(tool.inputSchema.$defs.Step.additionalProperties).toBe(false);
      expect(tool.inputSchema.$defs.PageExpectation.additionalProperties).toBe(false);
      expect(accepted.isError).toBe(false);
      const parsed = body(accepted);
      expect(parsed.stopped).toBeNull();
      expect(parsed.completed.map((c: any) => c.action_id)).toEqual(["0", "1"]);
      expect(parsed.completed[0].wait).toBe("matched");
      expect(calls).toEqual(["observePage", "actPage", "observePage", "actPage", "observePage"]);
      expect(refused.every((result) => result.isError)).toBe(true);
      expect(conn.methods()).toEqual(calls);
      const reasons = ["valid integer", "Extra inputs are not permitted", "approved-web-url-required", "at most 10 items"];
      reasons.forEach((reason, i) => expect(text(refused[i])).toContain(reason));
    } finally {
      await close();
    }
  });
});
