// `browser-control doctor --smoke`: one end-to-end run against an isolated browser. The server gets a temporary
// state directory and a user-route socket that does not exist, so the user's Chrome is never reached. A loopback
// fixture (FAST_CHROME_ALLOW_LOOPBACK=1) takes one act_steps batch; then the tab, the lease and the temporary
// Chrome for Testing profile are released.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { unchangedAt } from "../../shared/install-lock";
import { trustedPath } from "../../shared/trusted-path";
import type { PackageAssets } from "../assets";
import { HOST_SOCKET_ENV, type Env } from "../config";
import { runPoolCommand } from "../pool/operator";
import { SOCKET_PATH_LIMIT } from "../pool/provision";
import { HARD_CAP, metadata, poolContext } from "../pool/registry";
import { step, type Step } from "./shared";

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

/** The temporary state root is <base>/bcs-XXXXXX; its last controller's socket must fit sun_path. */
function fits(base: string): boolean {
  const ctx = poolContext({ BROWSER_CONTROL_STATE_DIR: path.join(base, "bcs-XXXXXX") });
  return Buffer.byteLength(metadata(`isolated-${HARD_CAP}`, ctx).socket) <= SOCKET_PATH_LIMIT;
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
  return { ...result, BROWSER_CONTROL_STATE_DIR: state, [HOST_SOCKET_ENV]: socket, FAST_CHROME_ALLOW_LOOPBACK: "1" };
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
  // TMPDIR comes from the environment, so it is used only by its canonical path once it passes the trusted-path rule.
  const checked = trustedPath(deps.tempBase());
  if ("unsafe" in checked) {
    return [step("smoke:server", "fail", "temp-unsafe",
      "Another user could change the temporary directory: it and every directory above it must be owned by you or root and writable only by their owner, unless they have the sticky bit. Set TMPDIR to such a directory.",
      { path: checked.unsafe })];
  }
  const base = checked.path;
  if (!fits(base)) {
    return [step("smoke:server", "fail", "temp-path-too-long", "The temporary directory path is too long for Unix sockets. Set TMPDIR to a shorter directory.")];
  }
  // The temporary directory is the state root itself, made 0700 by mkdtemp in the checked base; the user-route
  // socket names a directory that does not exist.
  const state = fs.mkdtempSync(path.join(base, "bcs-"));
  fs.chmodSync(state, 0o700);
  // The base may be a sticky /tmp, so the directory is removed only while it is still the one made here.
  const made = fs.lstatSync(state);
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
      // The SDK transport ends stdin on close, then sends SIGTERM and SIGKILL 2 s apart; the server's stderr is discarded.
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: serverEnv, stderr: "ignore" }), { timeout: 30000 });
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
    if (stopped && unchangedAt(state, made)) {
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
