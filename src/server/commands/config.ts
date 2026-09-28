// `browser-control config <client>`: the MCP configuration snippet for each supported client. install prints
// the same snippets. A non-default state directory or user socket is passed to the server through its environment.
import { BIN_NAME, HOST_SOCKET_ENV, statePaths, userSocket, type Env } from "../config";
import { isGate } from "../gate";
import { commandEnv, PACKAGE_COMMAND, parseOptions, UsageError, type CommandIo } from "./shared";

export const CLIENTS = ["opencode", "claude", "codex", "cursor"] as const;
export type Client = (typeof CLIENTS)[number];

const TITLES: Record<Client, string> = {
  opencode: "OpenCode (opencode.jsonc):",
  claude: "Claude Code (.mcp.json):",
  codex: "Codex (~/.codex/config.toml; claim_browser can take up to 120 s):",
  cursor: "Cursor (~/.cursor/mcp.json):"
};

/**
 * The server environment a snippet must carry: a state directory other than the default, and a user socket
 * other than that state directory's default, which install wrote into the user wrapper (D1).
 */
function serverEnvironment(env: Env): Record<string, string> {
  const paths = statePaths(env);
  const environment: Record<string, string> = {};
  if (paths.root !== statePaths({ ...env, BROWSER_CONTROL_STATE_DIR: undefined }).root) environment.BROWSER_CONTROL_STATE_DIR = paths.root;
  if (userSocket(env) !== paths.userSocket) environment[HOST_SOCKET_ENV] = userSocket(env);
  return environment;
}

/** JSON with two-space indentation and arrays of strings kept on one line, as people write config files. */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\[\n\s*("(?:[^"\\\n]|\\.)*"(?:,\n\s*"(?:[^"\\\n]|\\.)*")*)\n\s*\]/g,
    (_match, items: string) => `[${items.split(/,\n\s*/).join(", ")}]`);
}

function indent(text: string): string {
  return text.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
}

export function mcpSnippet(client: Client, env: Env): string {
  const [command, ...args] = PACKAGE_COMMAND;
  const environment = serverEnvironment(env);
  const extra = Object.keys(environment).length > 0;
  if (client === "opencode") {
    const entry = { type: "local", command: [...PACKAGE_COMMAND], enabled: true, ...(extra ? { environment } : {}) };
    return `${prettyJson({ mcp: { [BIN_NAME]: entry } })}\n`;
  }
  if (client === "codex") {
    const lines = [`[mcp_servers.${BIN_NAME}]`, `command = ${JSON.stringify(command)}`, `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      "tool_timeout_sec = 150"];
    if (extra) lines.push("", `[mcp_servers.${BIN_NAME}.env]`, ...Object.entries(environment).map(([key, value]) => `${key} = ${JSON.stringify(value)}`));
    return `${lines.join("\n")}\n`;
  }
  const entry = { command, args, ...(extra ? { env: environment } : {}) };
  return `${prettyJson({ mcpServers: { [BIN_NAME]: entry } })}\n`;
}

/** The snippets install prints: OpenCode, Claude Code and Codex, keyed by their titles. */
export function mcpSnippets(env: Env, clients: readonly Client[] = ["opencode", "claude", "codex"]): Record<string, string> {
  return Object.fromEntries(clients.map((client) => [TITLES[client], indent(mcpSnippet(client, env))]));
}

export async function runConfig(argv: readonly string[], io: CommandIo): Promise<number> {
  try {
    const options = parseOptions(argv, ["--state-dir"], 1);
    const client = options.positional[0];
    if (client !== undefined && !(CLIENTS as readonly string[]).includes(client)) throw new UsageError(`unknown client: ${client}`);
    const env = commandEnv(io.env, options);
    if (client) io.stdout.write(mcpSnippet(client as Client, env));
    else for (const [title, text] of Object.entries(mcpSnippets(env, CLIENTS))) io.stdout.write(`${title}\n${text}\n`);
    return 0;
  } catch (error) {
    if (isGate(error)) {
      io.stderr.write(`browser-control config: ${error.code}\n`);
      return 1;
    }
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`browser-control config: ${error.message}\nusage: browser-control config [${CLIENTS.join("|")}] [--state-dir <dir>]\n`);
    return 2;
  }
}
