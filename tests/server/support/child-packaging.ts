// Subprocess helper for packaging tests: a stdio MCP server standing in for `browser-control mcp` under
// `doctor --smoke`. Modes:
//   server <log> <ok|claim-fails|act-stops>
//     Serve claim_browser, open_tab, act_steps, release and release_browser. Each call appends one JSON line to
//     <log> with its arguments and the smoke-relevant environment. open_tab fetches the fixture page and
//     act_steps posts the fill text to it, as the extension would.
//   empty
//     Serve no tools.
import fs from "node:fs";
import type { App, AppOptions } from "../../../src/server/app";
import { runStdioServer } from "../../../src/server/entry";

type Result = Record<string, unknown>;

function reply(result: Result) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function serverMode([log, mode]: string[]) {
  let opened: string | null = null;
  const record = (tool: string, args: unknown) => fs.appendFileSync(log, `${JSON.stringify({
    tool, args,
    env: {
      state: process.env.BROWSER_CONTROL_STATE_DIR, socket: process.env.BROWSER_CONTROL_HOST_SOCKET,
      retiredSocket: process.env.OPZERO_CHROME_HOST_SOCKET, loopback: process.env.FAST_CHROME_ALLOW_LOOPBACK,
      artifactRoot: process.env.FAST_CHROME_ARTIFACT_ROOT ?? null
    },
    socketExists: fs.existsSync(process.env.BROWSER_CONTROL_HOST_SOCKET ?? "")
  })}\n`);
  const tools = ["claim_browser", "open_tab", "act_steps", "release", "release_browser"];
  const app = (_options: AppOptions): App => ({
    serverInfo: { name: "browser-control", version: "0.0.0-test" },
    instructions: "synthetic",
    listTools: () => tools.map((name) => ({ name, inputSchema: { type: "object" as const, properties: {} } })),
    callTool: async (name, args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      record(name, input);
      if (name === "claim_browser") {
        if (mode === "claim-fails") {
          return reply({ controller_id: "isolated-1", lease_id: "0123456789abcdef0123456789abcdef", ready: false,
            error: "browser-controller-startup-timeout", lease_retained: true });
        }
        return reply({ controller_id: "isolated-1", server: "browser-control", lease_id: "0123456789abcdef0123456789abcdef",
          mode: "shared", sites: [], site_state: null, ready: true, launched: true });
      }
      if (name === "open_tab") {
        opened = String(input.url);
        const page = await (await fetch(opened)).text();
        if (!page.includes('aria-label="Smoke name"')) return reply({ outcome: "incomplete", error: "fast-chrome-setup-unconfirmed", tab_id: null });
        return reply({ tab_id: "isolated-1:7", origin: new URL(opened).origin, group_title: input.group_title, group_title_confirmed: true });
      }
      if (name === "act_steps") {
        const steps = input.steps as Array<Record<string, unknown>>;
        if (mode === "act-stops") {
          return reply({ tab_id: input.tab_id, completed: [], stopped: { i: 0, label: steps[0].label, reason: "missing", dispatched: false }, final: {} });
        }
        await fetch(new URL("/done", opened as string), { method: "POST", body: String(steps[0].text) });
        return reply({ tab_id: input.tab_id, completed: steps.map((step, i) => ({ i, label: step.label, outcome: "executed" })), stopped: null, final: {} });
      }
      if (name === "release") return reply({ tab_id: input.tab_id, released: true, cleanup: "confirmed" });
      return reply({ controller_id: "isolated-1", released: true, controller_idle: true });
    },
    cleanup: async () => undefined
  });
  void runStdioServer({ app });
}

function emptyMode() {
  void runStdioServer({
    app: () => ({
      serverInfo: { name: "browser-control", version: "0.0.0-test" },
      instructions: "",
      listTools: () => [],
      callTool: async (name) => ({ isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] }),
      cleanup: async () => undefined
    })
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "server") serverMode(rest);
else if (mode === "empty") emptyMode();
else process.exit(2);
