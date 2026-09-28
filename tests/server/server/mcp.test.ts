// test_native_server.py through an MCP client, and the captured Python surfaces: tools/list, the argument
// corpus (FastMCP pre_parse_json and pydantic), the result envelopes and the HTTPS origin corpus.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PyFloat, reviveFloats, validateArguments, ValidationError } from "../../../src/server/args";
import { Gate } from "../../../src/server/gate";
import { origin } from "../../../src/server/page";
import type { StartRuntime, Window } from "../../../src/server/pool/start";
import { processSessionId } from "../../../src/server/session";
import { deserializeMessage } from "../../../src/server/stdio-transport";
import { INSTRUCTIONS, TOOLS } from "../../../src/server/tool-definitions";
import { renamePython } from "../support/renames";
import { removeTempRoots } from "../support/temp";
import { body, deferred, FakeConnection, fixture, JPEG_4X4, mcpClient, meta, page, running, setConnect, text } from "./helpers";

afterEach(() => removeTempRoots());

const FIXTURES = path.join(__dirname, "../fixtures");

function load(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"), reviveFloats as never);
}

/** Replace PyFloat markers with plain numbers, for comparison with validated values. */
function plain(value: unknown): unknown {
  if (value instanceof PyFloat) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

describe("MCP calls", () => {
  it("overlaps tool calls from two sessions in time", async () => {
    const f = fixture();
    let arrived = 0;
    const both = deferred();
    const observed = async (method: string) => {
      if (method === "observePage") {
        arrived += 1;
        if (arrived === 2) both.resolve();
        // Passes only while both bodies are inside a page read at once.
        await Promise.race([both.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("barrier timeout")), 5000))]);
      }
      return page();
    };
    for (const [id, name] of [[1, "ses_one"], [2, "ses_two"]] as const) {
      const connection = new FakeConnection();
      connection.sideEffect = observed;
      const tab = f.server.newTab(name, connection, id, "https://example.test", true);
      f.server.registry.tabs.set(tab.key, tab);
    }
    const { client, close } = await mcpClient(f.server);
    try {
      const results = await Promise.all([
        client.callTool({ name: "observe", arguments: { tab_id: "1" }, _meta: { "ai.opencode/sessionID": "ses_one" } }),
        client.callTool({ name: "observe", arguments: { tab_id: "2" }, _meta: { "ai.opencode/sessionID": "ses_two" } })
      ]);
      expect(results.some((result) => result.isError)).toBe(false);
      expect(results.map((result) => body(result).tab_id)).toEqual(["1", "2"]);
    } finally {
      await close();
    }
  });

  it("keeps only its own tab busy while a call runs", async () => {
    const f = fixture();
    const entered = deferred();
    const finish = deferred();
    const slow = new FakeConnection();
    slow.sideEffect = async (method: string) => {
      if (method === "observePage") {
        entered.resolve();
        await finish.promise;
      }
      return page();
    };
    for (const [id, connection] of [[1, slow], [2, new FakeConnection(page())]] as const) {
      const tab = f.server.newTab("ses_one", connection, id, "https://example.test", true);
      f.server.registry.tabs.set(tab.key, tab);
    }
    const { client, close } = await mcpClient(f.server);
    const call = (tabId: string) => client.callTool({ name: "observe", arguments: { tab_id: tabId }, _meta: { "ai.opencode/sessionID": "ses_one" } });
    try {
      const pending = call("1");
      await entered.promise;
      let busy;
      let free;
      try {
        busy = await call("1");
        free = await call("2");
      } finally {
        finish.resolve();
      }
      const slowResult = await pending;
      expect(busy.isError).toBe(true);
      expect(text(busy)).toContain("fast-chrome-tab-busy");
      expect(free.isError).toBe(false);
      expect(slowResult.isError).toBe(false);
    } finally {
      await close();
    }
  });

  it("lets a running body finish after its caller cancels, keeping the tab busy until then", async () => {
    // D11: the TS SDK sends no response to a cancelled request; the body still runs to completion.
    const f = fixture();
    const entered = deferred();
    const finish = deferred();
    let finished = false;
    const connection = new FakeConnection();
    connection.sideEffect = async (method: string) => {
      if (method === "observePage") {
        entered.resolve();
        await finish.promise;
        finished = true;
      }
      return page();
    };
    const tab = f.server.newTab("ses_one", connection, 1, "https://example.test", true);
    f.server.registry.tabs.set("1", tab);
    const { client, close } = await mcpClient(f.server);
    try {
      const controller = new AbortController();
      const cancelled = client.callTool({ name: "observe", arguments: { tab_id: "1" }, _meta: { sessionID: "ses_one" } }, undefined, { signal: controller.signal })
        .then(() => "resolved", () => "cancelled");
      await entered.promise;
      controller.abort();
      expect(await cancelled).toBe("cancelled");
      expect(tab.operation.busy).toBe(true);
      const busy = await client.callTool({ name: "observe", arguments: { tab_id: "1" }, _meta: { sessionID: "ses_one" } });
      expect(text(busy)).toContain("fast-chrome-tab-busy");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      finish.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(true);
      expect(tab.operation.busy).toBe(false);
      expect(tab.snapshot).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("takes no session argument and accepts JSON input", async () => {
    const runtime: StartRuntime & { pids: Map<string, number> } = {
      pids: new Map(),
      provision() {},
      prepare() {},
      processes(info) { const pid = this.pids.get(info.controller_id); return pid === undefined ? [] : [pid]; },
      probe(info) { return this.pids.has(info.controller_id); },
      configure(_info, options) { return { password_saving_disabled: true, downloads_configured: true, preferences_changed: !options.running }; },
      async launch(info) {
        this.pids.set(info.controller_id, 4001);
        await running(path.dirname(info.socket), info.controller_id);
      },
      windows(pid): Window[] { return [{ pid, window_id: pid + 1, bounds: { width: 800, height: 600 } }]; }
    };
    const f = fixture({ startRuntime: () => runtime });
    const sessionMeta = { "ai.opencode/sessionID": "ses_one" };
    const { client, close } = await mcpClient(f.server);
    try {
      const tools = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema as any]));
      const claimed = await client.callTool({ name: "claim_browser", arguments: { site: "https://deploy-preview-1--example.netlify.app/login", timeout_seconds: 5 }, _meta: sessionMeta });
      const refused = [];
      for (const args of [{ timeout_seconds: "5" }, { timeout_seconds: 121 }, { session: "ses_x" }]) {
        refused.push(await client.callTool({ name: "claim_browser", arguments: args, _meta: sessionMeta }));
      }
      const lease = body(claimed).lease_id;
      const released = await client.callTool({ name: "release_browser", arguments: { lease_id: lease }, _meta: sessionMeta });
      const anonymous = await client.callTool({ name: "release_browser", arguments: { lease_id: lease } });
      expect(Object.keys(tools)).toHaveLength(18);
      expect(Object.values(tools).some((schema) => Object.keys(schema.properties).some((name) => name.includes("session") || name.includes("owner")))).toBe(false);
      expect(new Set(Object.keys(tools.claim_browser.properties))).toEqual(new Set(["site", "exclusive", "timeout_seconds"]));
      expect(tools.release_browser.required).toEqual(["lease_id"]);
      expect(claimed.isError).toBe(false);
      expect(body(claimed).ready).toBe(true);
      expect(refused.map((result) => result.isError)).toEqual([true, true, false]);
      // An argument named session is ignored: identity comes only from _meta.
      expect(body(refused[2]).lease_id).toBe(lease);
      expect(released.isError).toBe(false);
      expect(body(released).released).toBe(true);
      // C7: without _meta the call runs as the process session, which owns no lease (Python: session-required).
      expect(anonymous.isError).toBe(true);
      expect(text(anonymous)).toBe("Error executing tool release_browser: browser-controller-lease-not-owned");
      expect(processSessionId()).toMatch(/^ses_[0-9a-f]{32}$/);
    } finally {
      await close();
    }
  });
});

describe("captured Python surfaces", () => {
  const captured = load("python-tools.json");

  it("lists the captured tools with only the D19 renames and the Q2 lease_id removal", async () => {
    const expected = captured.tools.map((tool: any) => {
      const copy = structuredClone(plain(tool)) as any;
      copy.description = renamePython(copy.description);
      if (copy.name === "paste_1password_field") {
        delete copy.inputSchema.properties.lease_id;
        copy.description = copy.description.replace(" Pool accounts require their owned lease_id.", "");
      }
      return copy;
    });
    const f = fixture();
    expect(f.server.listTools()).toEqual(expected);
    expect(TOOLS.map((tool) => tool.name)).toEqual(captured.tools.map((tool: any) => tool.name));
    expect(INSTRUCTIONS).toBe(renamePython(captured.instructions));
    const { client, close } = await mcpClient(f.server);
    try {
      expect((await client.listTools()).tools).toEqual(expected);
      expect(client.getInstructions()).toBe(INSTRUCTIONS);
      expect(client.getServerVersion()).toMatchObject({ name: "browser-control" });
      expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
    } finally {
      await close();
    }
  });

  it("validates the captured argument corpus like FastMCP and pydantic", () => {
    const corpus = load("python-arguments.json") as Record<string, Array<{ arguments: Record<string, unknown>; accepted?: unknown; rejected?: Array<{ type: string; loc: string[] }>; gate?: string }>>;
    let cases = 0;
    for (const [tool, records] of Object.entries(corpus)) {
      for (const record of records) {
        cases += 1;
        const label = `${tool} ${JSON.stringify(plain(record.arguments))}`;
        let outcome: Record<string, unknown>;
        try {
          outcome = { accepted: JSON.parse(JSON.stringify(validateArguments(tool, record.arguments, {}))) };
        } catch (error) {
          if (error instanceof Gate) outcome = { gate: error.code };
          else if (error instanceof ValidationError) outcome = { rejected: error.errors.map((item) => ({ type: item.type, loc: item.loc.map(String) })) };
          else throw error;
        }
        const expected = plain(record) as Record<string, any>;
        delete expected.arguments;
        // Q2: lease_id is gone from paste_1password_field, so it is ignored like any unknown argument.
        if (tool === "paste_1password_field" && expected.accepted) delete expected.accepted.lease_id;
        expect(outcome, label).toEqual(expected);
      }
    }
    expect(cases).toBe(136);
  });

  it("keeps integral float literals as floats from the wire and pre-parsed JSON", () => {
    const message = deserializeMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for", arguments: {} } })
      .replace('"arguments":{}', '"arguments":{"tab_id":"1","expect":{"text":"a"},"timeout_ms":100.0}'));
    const args = (message as any).params.arguments;
    expect(args.timeout_ms).toBeInstanceOf(PyFloat);
    expect(() => validateArguments("wait_for", args, {})).toThrow("int_type");
    expect(validateArguments("start_recording", { tab_id: "1", fps: new PyFloat(5) }, {}).fps).toBe(5);
    expect(() => validateArguments("act_steps", { tab_id: "1", steps: '[{"label": "Go", "timeout_ms": 5.0}]' }, {})).toThrow("int_type");
    const plainIds = deserializeMessage('{"jsonrpc":"2.0","id":1.0,"method":"tools/list","params":{"_meta":{"x":2.0}}}') as any;
    expect(plainIds.id).toBe(1);
    expect(plainIds.params._meta.x).toBe(2);
  });

  it("returns the captured result envelopes", async () => {
    const shapes = load("python-call-shapes.json") as Record<string, { name: string; arguments: Record<string, unknown>; meta: boolean; result: any }>;
    const f = fixture();
    const artifacts = path.join(f.root, "artifacts-capture");
    fs.mkdirSync(artifacts, { mode: 0o700 });
    f.env.FAST_CHROME_ARTIFACT_ROOT = artifacts;
    const responses: Record<string, unknown> = {
      getInfo: { version: "0.2.1", protocolVersion: 2, pageProtocolVersion: 2 },
      getUserTabs: [{ id: 7, url: "https://example.test/é", title: "Café 😀" }],
      getTabs: [{ id: 1, url: "https://example.test/", title: "Owned" }],
      capturePage: { data: JPEG_4X4 }
    };
    const responder = () => {
      const connection = new FakeConnection();
      connection.sideEffect = (method: string) => responses[method];
      return connection;
    };
    setConnect(f.server, responder);
    const tab = f.server.newTab("ses_capture", responder(), 1, "https://example.test", true, { artifactRoot: artifacts });
    f.server.registry.tabs.set("1", tab);
    for (const [key, shape] of Object.entries(shapes)) {
      const result = await f.server.callTool(shape.name, plain(shape.arguments), shape.meta ? { sessionID: "ses_capture" } : undefined);
      const expected = plain(shape.result) as any;
      if (key === "status-no-session") {
        // C7: a call without session metadata runs as the process session instead of failing.
        expect(result.isError).toBe(false);
        expect(body(result).route).toBe("user");
        continue;
      }
      expect(result.isError, key).toBe(expected.isError);
      if (key === "screenshot") {
        const [image, saved] = result.content as any[];
        expect(image).toEqual({ type: "image", data: JPEG_4X4, mimeType: "image/jpeg" });
        expect(saved.type).toBe("text");
        expect(saved.text).toMatch(new RegExp(`^Saved screenshot: ${artifacts}/chrome-capture-[^/]+/screenshot\\.jpg$`));
        continue;
      }
      const actual = text(result);
      const wanted = renamePython(expected.content[0].text);
      if (/validation error/.test(wanted)) {
        // D10: the port keeps pydantic's first lines and error type; input_value and the help URL are dropped.
        expect(wanted.startsWith(actual.replace(/\]$/, ""))).toBe(true);
      } else {
        expect(actual, key).toBe(wanted);
      }
    }
  });

  it("matches the captured origin corpus, with and without FAST_CHROME_ALLOW_LOOPBACK", () => {
    const corpus = load("python-urls.json") as { cases: Array<{ input: string; origin: any; origin_loopback: any }>; non_strings: Array<{ input: unknown; origin: any }> };
    const outcome = (value: unknown, env: Record<string, string>) => {
      try {
        return { ok: origin(value, env) };
      } catch (error) {
        if (error instanceof Gate) return { gate: error.code };
        throw error;
      }
    };
    for (const item of corpus.cases) {
      expect(outcome(item.input, {}), item.input).toEqual(item.origin);
      expect(outcome(item.input, { FAST_CHROME_ALLOW_LOOPBACK: "1" }), item.input).toEqual(item.origin_loopback);
    }
    for (const item of corpus.non_strings) expect(outcome(plain(item.input), {})).toEqual(item.origin);
    expect(corpus.cases.length).toBeGreaterThan(300);
  });
});
