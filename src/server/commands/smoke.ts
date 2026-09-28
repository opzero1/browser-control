// `browser-control doctor --smoke`: one end-to-end run against an isolated browser. The server gets a temporary
// state directory and a user-route socket that does not exist, so the user's Chrome is never reached. A loopback
// fixture (FAST_CHROME_ALLOW_LOOPBACK=1) takes one act_steps batch; then the tab, the lease and the temporary
// Chrome for Testing profile are released.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable, type Readable } from "node:stream";
import type { PackageAssets } from "../assets";
import { HOST_SOCKET_ENV, type Env } from "../config";
import { runPoolCommand } from "../pool/operator";
import { step, type Step } from "./shared";

/** sockaddr_un.sun_path on macOS, without its NUL. */
const SOCKET_PATH_LIMIT = 103;
export const SMOKE_FILL_TEXT = "browser-control";
export const SMOKE_DONE_TEXT = "Smoke check passed";
const CLAIM_TIMEOUT_SECONDS = 60;

export interface SmokeDeps {
  /** The server to start; the default runs this package's CLI with `mcp`. */
  server: (assets: PackageAssets) => { command: string; args: string[] };
  /** Stop the temporary profile's Chrome (`pool reap`); true when it confirmed. */
  reap: (env: Env, controller: string | null) => Promise<boolean>;
  /** A real (symlink-free) directory for the temporary state root. */
  tempBase: () => string;
}

/** The temporary state root is <base>/bcs-XXXXXX; its longest controller socket must fit sun_path. */
function fits(base: string): boolean {
  return Buffer.byteLength(path.join(base, "bcs-XXXXXX/sockets/isolated-8.sock")) <= SOCKET_PATH_LIMIT;
}

export function defaultSmokeDeps(): SmokeDeps {
  return {
    server: (assets) => ({ command: process.execPath, args: [path.join(assets.root, "dist/server/cli.js"), "mcp"] }),
    reap: async (env, controller) => {
      const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
      return (await runPoolCommand(controller ? ["reap", controller] : ["reap"], { stdout: sink, env })) === 0;
    },
    tempBase: () => {
      const base = fs.realpathSync(os.tmpdir());
      return fits(base) ? base : fs.realpathSync("/tmp");
    }
  };
}

const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Browser Control smoke check</title></head>
<body>
<main>
<h1>Browser Control smoke check</h1>
<input type="text" aria-label="Smoke name" autocomplete="off">
<button type="button" aria-label="Run smoke check">Run smoke check</button>
<p id="status" role="status">Waiting</p>
</main>
<script>
document.querySelector("button").addEventListener("click", async () => {
  const response = await fetch("/done", { method: "POST", body: document.querySelector("input").value });
  document.getElementById("status").textContent = response.ok ? ${JSON.stringify(SMOKE_DONE_TEXT)} : "Smoke check failed";
});
</script>
</body>
</html>
`;

interface Fixture { url: string; received: string[]; close(): Promise<void> }

/** The loopback page: GET / serves the form, POST /done records what the page submitted. */
async function startFixture(): Promise<Fixture> {
  const received: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(FIXTURE);
      return;
    }
    if (request.method === "POST" && request.url === "/done") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { if (body.length < 1024) body += chunk; });
      request.on("end", () => {
        received.push(body.slice(0, 1024));
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    received,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

/** The parent environment without any Browser Control or fast-chrome setting, plus the smoke's own. */
export function smokeEnv(env: Env, state: string, socket: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("FAST_CHROME_") || key.startsWith("BROWSER_CONTROL_") || key.startsWith("OPZERO_")) continue;
    result[key] = value;
  }
  // The server reads HOST_SOCKET_ENV (D19); the retired name is set too, so no older reader finds the default.
  return { ...result, BROWSER_CONTROL_STATE_DIR: state, [HOST_SOCKET_ENV]: socket, OPZERO_CHROME_HOST_SOCKET: socket, FAST_CHROME_ALLOW_LOOPBACK: "1" };
}

/**
 * The client side of MCP over a child's stdio, like the SDK's StdioClientTransport (EOF, then SIGTERM after 2 s,
 * then SIGKILL) but spawning through node:child_process, so the bundle needs no cross-spawn.
 */
class ChildStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly command: string, private readonly args: string[], private readonly env: Record<string, string>) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, { env: this.env, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => resolve());
      child.once("close", () => {
        this.child = null;
        this.onclose?.();
      });
      child.stdin.on("error", (error) => this.onerror?.(error));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
        } catch (error) {
          this.onerror?.(error as Error);
          void this.close();
          return;
        }
        while (true) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage();
          } catch (error) {
            this.onerror?.(error as Error);
            continue;
          }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) return reject(new Error("not connected"));
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const wait = () => Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    child.stdin.end();
    await wait();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await wait();
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    this.buffer.clear();
  }
}

type Called = { ok: true; value: Record<string, unknown> } | { ok: false; code: string };

async function callTool(client: Client, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<Called> {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const first = Array.isArray(result.content) ? result.content[0] as { type?: unknown; text?: unknown } | undefined : undefined;
    const text = first?.type === "text" && typeof first.text === "string" ? first.text : "";
    if (result.isError) {
      // Only a fixed code is reported, never other text a tool returned.
      const code = /^Error executing tool [a-z_0-9]+: ([a-z0-9-]{1,80})$/.exec(text)?.[1];
      return { ok: false, code: code ?? "tool-error" };
    }
    const value = result.structuredContent ?? JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "unexpected-result" };
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, code: code === -32001 ? "request-timeout" : "request-failed" };
  }
}

function field(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item ? item : null;
}

/** A fixed error code a tool result reported, if any. */
function resultCode(value: Record<string, unknown>): string | undefined {
  const code = value.error ?? value.reason;
  return typeof code === "string" && /^[a-z0-9-]{1,80}$/.test(code) ? code : undefined;
}

export async function smoke(env: Env, assets: PackageAssets, deps: SmokeDeps = defaultSmokeDeps()): Promise<Step[]> {
  const steps: Step[] = [];
  const base = deps.tempBase();
  if (!fits(base)) {
    return [step("smoke:server", "fail", "temp-path-too-long", "The temporary directory path is too long for Unix sockets. Set TMPDIR to a shorter directory.")];
  }
  // The temporary directory is the state root itself; the user-route socket names a directory that does not exist.
  const state = fs.mkdtempSync(path.join(base, "bcs-"));
  fs.chmodSync(state, 0o700);
  const serverEnv = smokeEnv(env, state, path.join(state, "absent", "user.sock"));
  const fixture = await startFixture();
  const server = deps.server(assets);
  const client = new Client({ name: "browser-control-doctor", version: assets.version }, { capabilities: {} });
  let started = false;
  let claimed = false;
  let controller: string | null = null;
  let leaseId: string | null = null;
  let tabId: string | null = null;
  try {
    try {
      await client.connect(new ChildStdioTransport(server.command, server.args, serverEnv), { timeout: 30000 });
      const names = new Set((await client.listTools(undefined, { timeout: 30000 })).tools.map((tool) => tool.name));
      started = ["claim_browser", "open_tab", "act_steps", "release", "release_browser"].every((name) => names.has(name));
    } catch {
      started = false;
    }
    if (!started) {
      steps.push(step("smoke:server", "fail", "unavailable", "The server did not start or does not list the tools the smoke check uses."));
      return steps;
    }
    steps.push(step("smoke:server", "ok", "started", "Started the server with a temporary state directory and no route to your Chrome.", { path: state }));

    claimed = true;
    const claim = await callTool(client, "claim_browser", { timeout_seconds: CLAIM_TIMEOUT_SECONDS }, (CLAIM_TIMEOUT_SECONDS + 30) * 1000);
    if (claim.ok) {
      controller = field(claim.value, "controller_id");
      leaseId = field(claim.value, "lease_id");
    }
    if (!claim.ok || claim.value.ready !== true || !leaseId) {
      steps.push(step("smoke:claim_browser", "fail", "not-ready", "claim_browser did not return a ready isolated browser.",
        { code: claim.ok ? resultCode(claim.value) : claim.code }));
      return steps;
    }
    steps.push(step("smoke:claim_browser", "ok", "ready", "Claimed an isolated Chrome for Testing profile."));

    const opened = await callTool(client, "open_tab", { url: fixture.url, group_title: "Browser Control doctor" }, 60000);
    if (opened.ok) tabId = field(opened.value, "tab_id");
    if (!opened.ok || !tabId || opened.value.outcome === "incomplete") {
      steps.push(step("smoke:open_tab", "fail", "not-opened", "open_tab did not open the loopback fixture.",
        { code: opened.ok ? resultCode(opened.value) : opened.code }));
      return steps;
    }
    steps.push(step("smoke:open_tab", "ok", "opened", "Opened the loopback fixture in the isolated browser."));

    const acted = await callTool(client, "act_steps", {
      tab_id: tabId,
      steps: [
        { label: "Smoke name", kind: "fill", text: SMOKE_FILL_TEXT },
        { label: "Run smoke check", kind: "click", expect: { text: SMOKE_DONE_TEXT } }
      ]
    }, 60000);
    const completed = acted.ok && Array.isArray(acted.value.completed) ? acted.value.completed.length : 0;
    if (!acted.ok || acted.value.stopped !== null || completed !== 2 || !fixture.received.includes(SMOKE_FILL_TEXT)) {
      const stopped = acted.ok && acted.value.stopped && typeof acted.value.stopped === "object" ? acted.value.stopped as Record<string, unknown> : null;
      steps.push(step("smoke:act_steps", "fail", "incomplete", "act_steps did not fill and submit the loopback fixture.",
        { code: acted.ok ? (stopped ? resultCode(stopped) : undefined) : acted.code }));
      return steps;
    }
    steps.push(step("smoke:act_steps", "ok", "completed", "Ran one act_steps batch: the fixture received the filled text."));
  } finally {
    if (tabId) {
      const released = await callTool(client, "release", { tab_id: tabId }, 30000);
      steps.push(released.ok
        ? step("smoke:release", "ok", "released", "Released the tab.")
        : step("smoke:release", "fail", "unconfirmed", "The tab release was not confirmed.", { code: released.code }));
    }
    if (leaseId) {
      const released = await callTool(client, "release_browser", { lease_id: leaseId }, 30000);
      steps.push(released.ok && released.value.released === true
        ? step("smoke:release_browser", "ok", "released", "Released the browser lease.")
        : step("smoke:release_browser", "fail", "unconfirmed", "The browser lease release was not confirmed.",
          { code: released.ok ? resultCode(released.value) : released.code }));
    }
    await client.close().catch(() => undefined);
    await fixture.close();
    // claim_browser may have started Chrome even when it reported no ready lease.
    const stopped = !claimed || await deps.reap(serverEnv, controller).catch(() => false);
    if (stopped) {
      fs.rmSync(state, { recursive: true, force: true });
      if (claimed) steps.push(step("smoke:cleanup", "ok", "removed", "Stopped the isolated browser and removed the temporary state directory."));
    } else {
      steps.push(step("smoke:cleanup", "fail", "kept",
        "The isolated browser was not confirmed stopped, so its temporary state directory was kept. Stop it with the pool command below.",
        { path: state, command: `BROWSER_CONTROL_STATE_DIR='${state}' browser-control pool reap` }));
    }
  }
  return steps;
}
