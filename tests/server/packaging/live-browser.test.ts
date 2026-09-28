import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { expect, it } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { HOST_WRAPPER_NAME, ISOLATED_EXTENSION_ID } from "../../../src/server/config";
import { Gate } from "../../../src/server/gate";
import { Connection } from "../../../src/server/host-connection";
import { provision } from "../../../src/server/pool/provision";
import { ensureStableExtension, ensureStableHost } from "../../../src/server/stable-copy";
import { privateTemp, removeTempRoots, socketPath, testEnv } from "../support/temp";

const executablePath = process.env.BROWSER_CONTROL_SYNTHETIC_CHROME;

it.skipIf(!executablePath || process.platform !== "darwin")("connects the real MCP bundle through Chrome native messaging and completes a synthetic batch", async () => {
  const root = privateTemp("live-");
  const socket = socketPath(root, "h.sock");
  const env = testEnv(root, { BROWSER_CONTROL_HOST_SOCKET: socket, FAST_CHROME_ALLOW_LOOPBACK: "1" });
  const assets = packageAssets();
  const profile = path.join(root, "profile");
  const client = new Client({ name: "synthetic-live-test", version: "1" });
  let browser: BrowserContext | undefined;
  let received = "";
  const fixture = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/done") {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { received += chunk; });
      request.on("end", () => { response.writeHead(204); response.end(); });
    } else {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Synthetic native messaging</title>
        <label>Public name<input aria-label="Public name"></label><button>Save example</button><p>Waiting</p>
        <script>document.querySelector('button').onclick=async()=>{
          await fetch('/done',{method:'POST',body:document.querySelector('input').value});
          document.querySelector('p').textContent='Example saved';
        }</script>`);
    }
  });
  try {
    const [host, extension] = await Promise.all([ensureStableHost(env, assets), ensureStableExtension(env, assets)]);
    provision({ controller_id: "isolated-1", server: "browser-control", socket, profile,
      downloads: path.join(root, "downloads"), artifacts: path.join(root, "artifacts"),
      host: path.join(root, "host", HOST_WRAPPER_NAME) }, { host, extension, node: process.execPath });
    fs.mkdirSync(env.HOME!, { mode: 0o700 });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    const url = `http://127.0.0.1:${address.port}/`;
    browser = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, env: { ...env, TMPDIR: root },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--load-extension=${extension.dir}`, `--disable-extensions-except=${extension.dir}`,
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"]
    });
    await browser.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await expect.poll(() => browser!.serviceWorkers().map((worker) => new URL(worker.url()).hostname), { timeout: 15000 })
      .toContain(ISOLATED_EXTENSION_ID);
    await expect.poll(() => fs.existsSync(socket), { timeout: 15000 }).toBe(true);
    // The host binds its socket before the extension finishes the protocol handshake.
    // expect.poll would also retry other errors, so only these two gates are retried until the deadline.
    const deadline = Date.now() + 30000;
    let connection: Connection;
    for (;;) {
      try {
        connection = await Connection.open(socket, 5);
        break;
      } catch (error) {
        const pending = error instanceof Gate
          && ["browser-control-unavailable", "browser-control-protocol-mismatch"].includes(error.code);
        if (!pending || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    try {
      expect(await connection.call("host.info")).toMatchObject({ protocolVersion: 2, extensionProtocol: "ready" });
      expect(await connection.call("getInfo")).toMatchObject({ protocolVersion: 2, pageProtocolVersion: 2, version: assets.version });
    } finally { connection.close(); }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(assets.root, "dist/server/cli.js"), "mcp"], env, stderr: "pipe" }));
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      if (result.structuredContent) return result.structuredContent;
      const content = result.content;
      if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error(`Missing text result: ${name}`);
      const value: unknown = JSON.parse(content[0].text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid result: ${name}`);
      return value as Record<string, unknown>;
    }
    expect(await call("status")).toMatchObject({ ready: true, protocol: 2, page_protocol: 2, backend: "browser-control" });
    const opened = await call("open_tab", { url, group_title: "Synthetic native messaging" });
    expect(typeof opened.tab_id).toBe("string");
    const acted = await call("act_steps", { tab_id: opened.tab_id, steps: [
      { label: "Public name", kind: "fill", text: "Synthetic example" },
      { label: "Save example", kind: "click", expect: { text: "Example saved" } }
    ], include_text: true });
    expect(acted.stopped).toBeNull();
    expect(acted.completed).toHaveLength(2);
    expect(received).toBe("Synthetic example");
    await call("release", { tab_id: opened.tab_id });
  } finally {
    await client.close();
    await browser?.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    removeTempRoots();
  }
}, 60000);
