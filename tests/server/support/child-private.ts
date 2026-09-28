// Subprocess helper for private-slice tests. Modes:
//   cua <scenario.json> <log> mcp
//     A synthetic `cua-driver mcp`: an MCP stdio server over the FakeCua vault. It logs each call's name and
//     arguments to <log>, logs "closed" when its stdin ends, and writes the scenario's stderr text first.
//     scenario.behavior maps a tool name to "error" (isError result), "unstructured" (no structured object),
//     "hang" (never answers) or "exit" (the driver exits mid-call); scenario.initialize "hang" never answers
//     the MCP handshake.
//   vault <repo> <state> <cua-driver> <email> <field>
//     Run readField with the production dependencies under <state> and print one JSON status line with the
//     value's sha256, never the value.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PackageAssets } from "../../../src/server/assets";
import { VaultError, readField, vaultDeps, type VaultField } from "../../../src/server/private/onepassword";
import { FakeCua, type Row } from "../private/fake-cua";

interface Scenario { elements: Row[]; copies?: string[]; behavior?: Record<string, string>; initialize?: string; stderr?: string }

const TOOLS = ["list_apps", "list_windows", "get_window_state", "clipboard_read", "clipboard_write", "click", "set_value", "verify_state",
  "bring_to_front", "hotkey", "press_key", "type_text"];

async function cuaMode([scenarioFile, log]: string[]) {
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8")) as Scenario;
  const record = (line: string) => fs.appendFileSync(log, `${line}\n`);
  process.stdin.on("end", () => {
    record(JSON.stringify({ name: "closed" }));
    process.exit(0);
  });
  if (scenario.stderr) process.stderr.write(`synthetic driver diagnostics: ${scenario.stderr}\n`);
  if (scenario.initialize === "hang") {
    process.stdin.resume();
    return;
  }
  const fake = new FakeCua(scenario.elements, { copies: scenario.copies });
  const server = new Server({ name: "cua-driver", version: "0.0.0-synthetic" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Row;
    record(JSON.stringify({ name, args }));
    const behavior = scenario.behavior?.[name];
    if (behavior === "error") return { isError: true, content: [{ type: "text" as const, text: `synthetic upstream detail ${scenario.stderr ?? ""}` }] };
    if (behavior === "unstructured") return { content: [{ type: "text" as const, text: "{}" }] };
    if (behavior === "hang") return new Promise<never>(() => undefined);
    if (behavior === "exit") process.exit(3);
    return { content: [], structuredContent: await fake.call(name, args) };
  });
  await server.connect(new StdioServerTransport());
}

async function vaultMode([repo, state, cua, email, field]: string[]) {
  const env = { ...process.env, BROWSER_CONTROL_STATE_DIR: state, CUA_DRIVER: cua };
  const assets: PackageAssets = {
    root: repo,
    extensionDir: path.join(repo, "dist/extension"),
    nativeHost: path.join(repo, "dist/server/native-host.js"),
    publicSuffixList: path.join(repo, "data/public_suffix_list.dat"),
    clipboardGuardSource: path.join(repo, "native/clipboard-guard/clipboard_guard.swift"),
    version: "0.0.0-test"
  };
  try {
    const value = await readField(email, field as VaultField, { deps: vaultDeps(env, assets) });
    process.stdout.write(`${JSON.stringify({ ok: true, sha256: createHash("sha256").update(value).digest("hex") })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof VaultError ? error.code : "not-a-vault-error" })}\n`);
  }
}

const [mode, ...args] = process.argv.slice(2);
const modes: Record<string, (args: string[]) => Promise<void>> = { cua: cuaMode, vault: vaultMode };
const body = modes[mode];
if (!body) {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
body(args).catch(() => {
  process.stdout.write("child-private failed\n");
  process.exit(1);
});
