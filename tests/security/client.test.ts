import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { testTemp } from "../support/temp";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function client(args: string[], endpoint?: string) {
  const child = spawn(process.execPath, ["dist/native-host/client.js", ...args], {
    env: { ...process.env, BROWSER_CONTROL_HOST_SOCKET: endpoint }, stdio: ["pipe", "pipe", "pipe"]
  });
  cleanup.push(() => child.kill());
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on("close", code => resolve({ code, stdout, stderr })));
  return { child, done };
}

it("refuses argv payloads without printing them", async () => {
  const c = client(["privateFill", '{"value":"synthetic-private-value"}']);
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
  expect(result.stderr).toContain("--stdio");
});

it("frames streaming responses, suppresses events, and sanitizes private errors", async () => {
  const directory = testTemp();
  const endpoint = path.join(directory, "s");
  const received: any[] = [];
  const server = net.createServer(socket => {
    cleanup.push(() => socket.destroy());
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", chunk => {
      text += chunk;
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const message = JSON.parse(text.slice(0, index)); text = text.slice(index + 1); received.push(message);
        socket.write('{"jsonrpc":"2.0","method":"onCDPEvent","params":{"value":"synthetic-private-value"}}\n');
        const response = `${JSON.stringify(message.method === "privateFill"
          ? { jsonrpc: "2.0", id: message.id, error: { code: -1, message: "synthetic-private-value" } }
          : { jsonrpc: "2.0", id: message.id, result: "pong" })}\n`;
        socket.write(response.slice(0, 7));
        setImmediate(() => socket.write(response.slice(7)));
      }
    });
  });
  cleanup.push(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const c = client(["--stdio"], endpoint);
  c.child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"privateFill","params":{"values":["synthetic-private-value"]}}\n');
  const result = await c.done;
  expect(received).toHaveLength(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
  expect(JSON.parse(result.stdout).result).toEqual({ status: "not-filled-or-unknown", retry: false });
});

it("never echoes malformed stdin payloads", async () => {
  const directory = testTemp();
  const endpoint = path.join(directory, "s");
  const server = net.createServer(socket => cleanup.push(() => socket.destroy()));
  cleanup.push(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const c = client(["--stdio"], endpoint);
  c.child.stdin.end('{synthetic-private-value\n');
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain("synthetic-private-value");
});
