// runStdioServer: MCP wiring, session metadata passthrough, and the bounded shutdown path (design 4.8).
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { App, AppOptions } from "../../../src/server/app";
import { runStdioServer } from "../../../src/server/entry";
import { SHUTDOWN_SECONDS } from "../../../src/server/runtime/shutdown";
import { monotonic } from "../../../src/server/time";
import { killChildren, startChild } from "../support/children";
import { McpStdio } from "../support/mcp-stdio";
import { privateTemp, removeTempRoots } from "../support/temp";

afterEach(() => {
  killChildren();
  removeTempRoots();
});

function fakeApp(overrides: Partial<App> = {}, seen: { options?: AppOptions; deadlines: number[] } = { deadlines: [] }) {
  return (options: AppOptions): App => {
    seen.options = options;
    return {
      serverInfo: { name: "browser-control", version: "9.9.9" },
      instructions: "Synthetic instructions.",
      listTools: () => [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: {} } }],
      callTool: async (name, args, meta) => ({ content: [{ type: "text", text: JSON.stringify({ name, args, meta }) }] }),
      cleanup: async (deadline) => { seen.deadlines.push(deadline); },
      ...overrides
    };
  };
}

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout, client: new McpStdio(stdin, stdout) };
}

describe("runStdioServer", () => {
  it("serves initialize, tools/list and tools/call with request _meta", async () => {
    const { stdin, stdout, client } = streams();
    const exits: number[] = [];
    const env = { BROWSER_CONTROL_STATE_DIR: "/synthetic/state" };
    const seen = { deadlines: [] as number[] } as { options?: AppOptions; deadlines: number[] };
    const done = runStdioServer({ stdin, stdout, env, installSignalHandlers: false, exit: (code) => exits.push(code), app: fakeApp({}, seen) });
    const initialized = await client.initialize();
    expect(initialized.result).toMatchObject({
      serverInfo: { name: "browser-control", version: "9.9.9" },
      capabilities: { tools: { listChanged: false } },
      instructions: "Synthetic instructions."
    });
    expect(Object.keys((initialized.result as { capabilities: object }).capabilities)).toEqual(["tools"]);
    const listed = await client.request("tools/list");
    expect(listed.result).toEqual({ tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: {} } }] });
    const called = await client.call("echo", { x: 1 }, { "ai.opencode/sessionID": "ses_meta" });
    expect(JSON.parse((called.content as Array<{ text: string }>)[0].text)).toEqual({ name: "echo", args: { x: 1 }, meta: { "ai.opencode/sessionID": "ses_meta" } });
    const bare = await client.call("echo");
    expect(JSON.parse((bare.content as Array<{ text: string }>)[0].text)).toEqual({ name: "echo", args: {} });
    expect(seen.options?.env).toBe(env);
    expect(seen.options?.shutdown.isSet).toBe(false);
    const ended = monotonic();
    stdin.end();
    expect(await done).toBe(0);
    expect(exits).toEqual([0]);
    expect(seen.options?.shutdown.isSet).toBe(true);
    expect(seen.deadlines).toHaveLength(1);
    expect(seen.deadlines[0] - ended).toBeGreaterThan(SHUTDOWN_SECONDS - 0.2);
    expect(seen.deadlines[0] - ended).toBeLessThanOrEqual(SHUTDOWN_SECONDS + 0.05);
  });

  it("forces exit at the backstop when cleanup never settles", async () => {
    const { stdin, stdout, client } = streams();
    let exitedAt = 0;
    const exited = new Promise<number>((resolve) => {
      void runStdioServer({
        stdin, stdout, installSignalHandlers: false, shutdownSeconds: 0.2,
        exit: (code) => { exitedAt = monotonic(); resolve(code); },
        app: fakeApp({ cleanup: () => new Promise(() => undefined) })
      });
    });
    await client.initialize();
    const start = monotonic();
    stdin.end();
    expect(await exited).toBe(0);
    expect(exitedAt - start).toBeGreaterThanOrEqual(0.45);
    expect(exitedAt - start).toBeLessThan(1.5);
  });

  it("treats a stdin close like EOF", async () => {
    const { stdin, stdout, client } = streams();
    const seen = { deadlines: [] as number[] };
    const done = runStdioServer({ stdin, stdout, installSignalHandlers: false, exit: () => undefined, app: fakeApp({}, seen) });
    await client.initialize();
    stdin.destroy();
    expect(await done).toBe(0);
    expect(seen.deadlines).toHaveLength(1);
  });

  const ENDINGS = ["eof", "sigterm"] as const;
  it.each(ENDINGS)("ends a real stdio server on %s within the bound, stopping a running wait", async (ending) => {
    const log = path.join(privateTemp(), "log");
    const child = startChild("child-foundation", ["server", log]);
    const reader = new McpStdio(child.process.stdin!, child.process.stdout!);
    await reader.initialize();
    const running = reader.send("wait", {}, { sessionID: "ses_stdio" });
    await expect.poll(() => fs.existsSync(log) && fs.readFileSync(log, "utf8"), { timeout: 5000 }).toContain("wait-started");
    const start = monotonic();
    if (ending === "eof") child.process.stdin!.end();
    else child.process.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const elapsed = monotonic() - start;
    expect(elapsed).toBeLessThan(2);
    await running;
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toBe("wait-started");
    expect(lines).toContain("wait-ended shutdown=true");
    const cleanup = lines.find((line) => line.startsWith("cleanup remaining="));
    expect(Number(cleanup?.split("=")[1])).toBeGreaterThan(SHUTDOWN_SECONDS - 0.5);
    expect(child.stderr()).toBe("");
  }, 15000);
});
