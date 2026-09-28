// test_native_stdio.py: the real stdio server in a subprocess (tests/server/support/child-server.ts) against a
// fake native host on a private Unix socket. No browser. Stdin EOF and SIGTERM share one bounded shutdown.
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { claim, poolContext } from "../../../src/server/pool/registry";
import { monotonic } from "../../../src/server/time";
import { killChildren, startChild, type Child } from "../support/children";
import { FakeHost, result, send, type Handler, type Request } from "../support/fake-host";
import { McpStdio } from "../support/mcp-stdio";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";
import { deferred, until } from "./helpers";

const PAGE = {
  status: "observed", pageProtocolVersion: 2, snapshot: "token", url: "https://example.test/", title: "Fixture", text: "Ready", mode: "full",
  partial: false, opaqueSurfaces: [], truncation: { text: false, actions: false, opaqueSurfaces: false, labels: false, title: false },
  actions: [{ id: "0", kind: "click", label: "Continue", role: "button", disabled: false }]
};
const TAB_METHODS = new Set(["createTab", "nameSession", "attach", "bindPage", "navigatePage", "observePage", "actPage", "finalizeTabs", "getTabs", "getUserTabs"]);
// OpenCode's MCP client closes stdin, sends SIGTERM 2 s later, then SIGKILL 2 s after that.
const KILL_AFTER_EOF = 4;
const SECRET = "synthetic-shutdown-secret";
const META = { "ai.opencode/sessionID": "ses_stdio" };

const hosts: FakeHost[] = [];

afterEach(async () => {
  killChildren();
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  removeTempRoots();
});

/** The fake host's answers. A hung method is never answered, like an endpoint that stopped responding. */
function reply(hang: string | null = null): Handler {
  return (socket, request) => {
    if (request.method === hang) return;
    const params = request.params ?? {};
    const answers: Record<string, unknown> = {
      createTab: { id: 5, active: false, url: "about:blank", title: "" }, nameSession: { name: params.name, confirmed: true },
      attach: { attached: true }, bindPage: { bound: true }, navigatePage: { status: "dispatched" }, observePage: PAGE,
      actPage: { status: "executed" }, finalizeTabs: { closedOrReleased: true }, getTabs: [], getUserTabs: []
    };
    result(socket, request, answers[request.method]);
  };
}

class Stdio {
  readonly child: Child;
  readonly client: McpStdio;
  /** Everything the server wrote to stdout. */
  output = "";

  constructor(readonly root: string, endpoint: string, vault?: string) {
    const env = testEnv(root, { BROWSER_CONTROL_STATE_DIR: root, BROWSER_CONTROL_HOST_SOCKET: endpoint, BROWSER_CONTROL_TEST_PSL: packageAssets().publicSuffixList });
    this.child = startChild("child-server", vault ? [vault] : [], env as NodeJS.ProcessEnv);
    this.client = new McpStdio(this.child.process.stdin as NonNullable<Child["process"]["stdin"]>, this.child.process.stdout as NonNullable<Child["process"]["stdout"]>);
    this.child.process.stdout?.on("data", (chunk: string) => { this.output += chunk; });
  }

  async start(): Promise<this> {
    await this.client.initialize();
    return this;
  }

  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call(name, args, META, 10000);
  }

  /** Send without waiting for the response. */
  send(name: string, args: Record<string, unknown>): void {
    void this.client.send(name, args, META);
  }

  begin(how: "eof" | "sigterm"): void {
    if (how === "eof") this.child.process.stdin?.end();
    else this.child.process.kill("SIGTERM");
  }

  async stop(how: "eof" | "sigterm"): Promise<[number | string, number]> {
    const started = monotonic();
    this.begin(how);
    const code = await this.child.exited;
    return [code, monotonic() - started];
  }
}

interface Setup { root: string; host: FakeHost; start(vault?: string): Promise<Stdio>; lease(options?: { hang?: string; handler?: Handler }): Promise<FakeHost> }

async function stdio(): Promise<Setup> {
  const root = privateTemp();
  fs.mkdirSync(path.join(root, "sockets"), { mode: 0o700 });
  const host = await FakeHost.start(path.join(root, "host.sock"), { handler: reply() });
  hosts.push(host);
  const env = testEnv(root, { BROWSER_CONTROL_STATE_DIR: root });
  return {
    root, host,
    start: (vault) => new Stdio(root, host.path, vault).start(),
    async lease(options = {}) {
      const leased = await FakeHost.start(path.join(root, "sockets/isolated-1.sock"), { handler: options.handler ?? reply(options.hang ?? null) });
      hosts.push(leased);
      await claim("ses_stdio", { site: "https://example.test/", ctx: poolContext(env) });
      return leased;
    }
  };
}

function tabMethods(host: FakeHost): string[] {
  return host.requests.map(([, request]) => request.method).filter((method) => TAB_METHODS.has(method));
}

function bodyOf(response: Record<string, unknown>): any {
  return JSON.parse((response.content as Array<{ text: string }>)[0].text);
}

function markers(root: string): string[] {
  const directory = path.join(root, "pool/registry/isolated-1");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^tab-.*\.json$/.test(name)) : [];
}

/**
 * A fake host for one sign-in page with per-session tabs and the private transfer methods. privateFill answers
 * once `fill` resolves, or never when `fill` is null. The #otp field has not appeared: every read of it is refused
 * as the extension refuses a missing private field, and the first refusal waits until `otp` resolves.
 */
class Signin {
  readonly filling = deferred();
  readonly polling = deferred();
  private readonly owned = new Map<string, Map<number, string>>();
  private nextId = 4;

  constructor(private readonly fill: Promise<void> | null, private readonly otp: Promise<void> | null = null) {}

  readonly handler: Handler = async (socket: net.Socket, request: Request, authority: string) => {
    const { method } = request;
    const params = request.params ?? {};
    let tabs = this.owned.get(authority);
    if (!tabs) this.owned.set(authority, tabs = new Map());
    const within = (promise: Promise<void> | null) => Promise.race([promise ?? new Promise<void>(() => undefined),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
    if (method === "observeDocument" && JSON.stringify(params.selectors) === JSON.stringify(["#otp"])) {
      if (!this.polling.settled()) {
        this.polling.resolve();
        await within(this.otp);
      }
      send(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Private observation refused" } });
      return;
    }
    let value: unknown;
    if (method === "createTab") {
      this.nextId += 1;
      tabs.set(this.nextId, "about:blank");
      value = { id: this.nextId, active: false, url: "about:blank", title: "" };
    } else if (method === "navigatePage") {
      tabs.set(params.tabId as number, params.url as string);
      value = { status: "dispatched" };
    } else if (method === "getTabs") {
      value = [...tabs].map(([n, url]) => ({ id: n, url, title: "Owned" }));
    } else if (method === "finalizeTabs") {
      tabs.clear();
      value = { closedOrReleased: true };
    } else if (method === "observeDocument") {
      value = { origin: "https://example.test", url: params.expectedUrl, token: "fill-token", documentId: "document-1" };
    } else if (method === "preparePrivateSubmit") {
      value = { status: "prepared", submitToken: "submit-token", documentId: "document-1", expiresInMs: 90000 };
    } else if (method === "privateFill") {
      this.filling.resolve();
      if (this.fill === null || await within(this.fill) === "timeout") return;
      value = { status: "filled" };
    } else if (method === "submitPrivate") {
      value = { status: "executed" };
    } else {
      reply()(socket, request, authority);
      return;
    }
    result(socket, request, value);
  };
}

describe("stdio server", () => {
  const FINALIZES_MANAGED_TABS_ON_CASES = ["eof", "sigterm"] as const;
  it.each(FINALIZES_MANAGED_TABS_ON_CASES)("finalizes managed tabs on %s the same way", async (how) => {
    const s = await stdio();
    const server = await s.start();
    const opened = bodyOf(await server.call("open_tab", { url: "https://example.test/" }));
    expect(opened.outcome).toBe("opened");
    expect(opened.tab_id).toBe("5");
    const [code, elapsed] = await server.stop(how);
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5);
    expect(tabMethods(s.host).slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(server.child.stderr()).toBe("");
  });

  it("stops a running wait at once on SIGTERM, then finalizes", async () => {
    const s = await stdio();
    const server = await s.start();
    await server.call("open_tab", { url: "https://example.test/" });
    const reads = tabMethods(s.host).filter((method) => method === "observePage").length;
    server.send("wait_for", { tab_id: "5", expect: { text: "never present" }, timeout_ms: 15000 });
    await until(() => tabMethods(s.host).filter((method) => method === "observePage").length > reads);
    const [code, elapsed] = await server.stop("sigterm");
    const methods = tabMethods(s.host);
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2);
    expect(methods.slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(methods.slice(methods.indexOf("finalizeTabs"))).not.toContain("observePage");
    expect(server.child.stderr()).toBe("");
  });

  const STOPS_A_LONG_ACT_CASES = ["eof", "sigterm"] as const;
  it.each(STOPS_A_LONG_ACT_CASES)("stops a long act_steps wait on %s without replay", async (how) => {
    const s = await stdio();
    const server = await s.start();
    await server.call("open_tab", { url: "https://example.test/" });
    const steps = [{ label: "Continue", expect: { text: "never present" }, timeout_ms: 15000 }, { label: "Continue" }];
    server.send("act_steps", { tab_id: "5", steps, timeout_ms: 60000 });
    await until(() => tabMethods(s.host).slice(-1)[0] === "observePage" && tabMethods(s.host).includes("actPage"));
    const [code, elapsed] = await server.stop(how);
    const methods = tabMethods(s.host);
    // The run stopped in its first wait: one dispatch, no second step, then cleanup.
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2);
    expect(methods.filter((method) => method === "actPage")).toHaveLength(1);
    expect(methods.slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(methods.slice(methods.indexOf("finalizeTabs"))).not.toContain("observePage");
    expect(server.child.stderr()).toBe("");
  });

  const ENDS_CLEANUP_BEFORE_THE_CASES = [[null, "eof"], ["finalizeTabs", "eof"], ["finalizeTabs", "sigterm"], ["actPage", "sigterm"]] as const;
  it.each(ENDS_CLEANUP_BEFORE_THE_CASES)(
    "ends cleanup before the parent's kill and keeps unconfirmed markers (hang %s, %s)", async (hang, how) => {
      const s = await stdio();
      const host = await s.lease({ hang: hang ?? undefined });
      const server = await s.start();
      const opened = bodyOf(await server.call("open_tab", { url: "https://example.test/" }));
      expect(opened.outcome).toBe("opened");
      expect(opened.tab_id).toBe("isolated-1:5");
      expect(markers(s.root)).toHaveLength(1);
      if (hang === "actPage") {
        // The action is in flight when shutdown begins and never answers.
        server.send("act_steps", { tab_id: "isolated-1:5", steps: [{ label: "Continue" }] });
        await until(() => tabMethods(host).includes("actPage"));
      }
      const [code, elapsed] = await server.stop(how);
      const methods = tabMethods(host);
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(KILL_AFTER_EOF);
      expect(methods.filter((method) => method === "actPage")).toHaveLength(hang === "actPage" ? 1 : 0);
      if (hang === null) {
        expect(methods.slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
        expect(markers(s.root)).toEqual([]);
      } else {
        // Unconfirmed cleanup keeps the marker for operator inspection; nothing is replayed.
        expect(methods.filter((method) => method === "finalizeTabs")).toHaveLength(hang === "finalizeTabs" ? 1 : 0);
        expect(markers(s.root)).toHaveLength(1);
      }
      expect(server.child.stderr()).toBe("");
    }, 15000);

  it("keeps cleaning up when the parent's SIGTERM follows EOF during cleanup, then exits 0", async () => {
    // finalizeTabs answers 2.2 s after it arrives, inside the 2.5 s bound; SIGTERM lands 2 s after EOF, while
    // cleanup still waits for it, as OpenCode's client escalates. Cleanup must finish rather than die by signal.
    const s = await stdio();
    const finalizing = deferred();
    const answer = reply();
    const host = await s.lease({
      handler: (socket, request, authority) => {
        if (request.method !== "finalizeTabs") return answer(socket, request, authority);
        finalizing.resolve();
        setTimeout(() => result(socket, request, { closedOrReleased: true }), 2200);
      }
    });
    const server = await s.start();
    expect(bodyOf(await server.call("open_tab", { url: "https://example.test/" })).tab_id).toBe("isolated-1:5");
    expect(markers(s.root)).toHaveLength(1);
    const started = monotonic();
    server.begin("eof");
    await finalizing.promise;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2000 - (monotonic() - started) * 1000)));
    expect(server.child.process.exitCode).toBeNull();
    server.begin("sigterm");
    const code = await server.child.exited;
    const elapsed = monotonic() - started;
    expect(code).toBe(0);
    expect(elapsed).toBeGreaterThan(2);
    expect(elapsed).toBeLessThan(KILL_AFTER_EOF);
    // Cleanup completed: the delayed finalization was read back and the tab's marker removed.
    expect(tabMethods(host).slice(-3)).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(markers(s.root)).toEqual([]);
    expect(server.child.stderr()).toBe("");
  }, 15000);

  const SENDS_NO_FURTHER_PRIVATE_CASES = [["vault", "sigterm"], ["vault", "eof"], ["fill", "sigterm"], ["hung-fill", "eof"]] as const;
  it.each(SENDS_NO_FURTHER_PRIVATE_CASES)(
    "sends no further private input when shutdown begins during the %s step (%s)", async (stage, how) => {
      const fill = deferred();
      const signin = new Signin(stage === "hung-fill" ? null : fill.promise);
      const s = await stdio();
      const host = await s.lease({ handler: signin.handler });
      const barrier = path.join(s.root, "vault");
      fs.mkdirSync(barrier, { mode: 0o700 });
      fs.writeFileSync(path.join(barrier, "secret"), SECRET);
      if (stage !== "vault") fs.writeFileSync(path.join(barrier, "resume"), "");
      const server = await s.start(barrier);
      const busy = bodyOf(await server.call("open_tab", { url: "https://example.test/" })).tab_id;
      const idle = bodyOf(await server.call("open_tab", { url: "https://example.test/" })).tab_id;
      expect([busy, idle]).toEqual(["isolated-1:5", "isolated-1:6"]);
      const snapshot = bodyOf(await server.call("observe", { tab_id: busy })).snapshot_id;
      server.send("paste_1password_field", {
        tab_id: busy, expected_url: "https://example.test/", expected_email: "synthetic@example.test", field: "password", selector: "#password",
        username_selector: "#email", snapshot_id: snapshot, submit_action_id: "0"
      });
      if (stage === "vault") await until(() => fs.existsSync(path.join(barrier, "entered")));
      else await signin.filling.promise;
      const began = host.requests.length;
      const started = monotonic();
      server.begin(how);
      await until(() => host.requests.slice(began).some(([, request]) => request.method === "finalizeTabs"));
      fs.writeFileSync(path.join(barrier, "resume"), "");
      fill.resolve();
      const code = await server.child.exited;
      const elapsed = monotonic() - started;
      const sessions = new Set(host.requests.filter(([, request]) => request.method === "preparePrivateSubmit").map(([authority]) => authority));
      expect(sessions.size).toBe(1);
      const [session] = sessions;
      const sent = host.requests.filter(([authority]) => authority === session).map(([, request]) => request.method);
      const after = host.requests.slice(began).filter(([authority]) => authority === session).map(([, request]) => request.method);
      const stderr = server.child.stderr();
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(KILL_AFTER_EOF);
      expect(stderr).toBe("");
      expect(sent).not.toContain("submitPrivate");
      expect(sent.filter((method) => method === "privateFill")).toHaveLength(stage === "vault" ? 0 : 1);
      expect(JSON.stringify(host.requests.filter(([, request]) => request.method !== "privateFill"))).not.toContain(SECRET);
      expect(stderr).not.toContain(SECRET);
      expect(server.output).not.toContain(SECRET);
      if (stage === "hung-fill") {
        // Cut off at the deadline: no finalization of the busy tab, whose marker stays for inspection.
        expect(after).toEqual([]);
        expect(markers(s.root)).toHaveLength(1);
      } else {
        // Nothing follows a vault read or fill that returns after shutdown began, not even a readback. Cleanup then finalizes.
        expect(after).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
        expect(markers(s.root)).toEqual([]);
      }
    }, 15000);

  const ENDS_AN_OTP_FIELD_CASES = ["sigterm", "eof"] as const;
  it.each(ENDS_AN_OTP_FIELD_CASES)("ends an OTP field wait on %s so cleanup finalizes its tab", async (how) => {
    const otp = deferred();
    const signin = new Signin(null, otp.promise);
    const s = await stdio();
    const host = await s.lease({ handler: signin.handler });
    const barrier = path.join(s.root, "vault");
    fs.mkdirSync(barrier, { mode: 0o700 });
    fs.writeFileSync(path.join(barrier, "secret"), SECRET);
    fs.writeFileSync(path.join(barrier, "resume"), "");
    const server = await s.start(barrier);
    const busy = bodyOf(await server.call("open_tab", { url: "https://example.test/" })).tab_id;
    const idle = bodyOf(await server.call("open_tab", { url: "https://example.test/" })).tab_id;
    expect([busy, idle]).toEqual(["isolated-1:5", "isolated-1:6"]);
    server.send("paste_1password_field", {
      tab_id: busy, expected_url: "https://example.test/", expected_email: "synthetic@example.test", field: "one-time password", selector: "#otp"
    });
    await signin.polling.promise;
    const began = host.requests.length;
    const started = monotonic();
    server.begin(how);
    await until(() => host.requests.slice(began).some(([, request]) => request.method === "finalizeTabs"));
    otp.resolve();
    const code = await server.child.exited;
    const elapsed = monotonic() - started;
    const sessions = new Set(host.requests.filter(([, request]) => request.method === "observeDocument").map(([authority]) => authority));
    const [session] = sessions;
    const after = host.requests.slice(began).filter(([authority]) => authority === session).map(([, request]) => request.method);
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2);
    expect(server.child.stderr()).toBe("");
    expect(after).toEqual(["finalizeTabs", "getTabs", "getUserTabs"]);
    expect(markers(s.root)).toEqual([]);
    expect(fs.existsSync(path.join(barrier, "entered"))).toBe(false);
  });
});
