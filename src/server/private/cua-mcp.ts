// The private cua-driver connection for vault reads (onepassword.py _mcp_client and _McpCua). Each read
// starts `cua-driver mcp` through the MCP SDK's stdio client and closes it afterwards. The driver's stderr is
// discarded, so upstream text cannot escape this process; responses, including copied clipboard text and
// accessibility metadata, stay in local objects. No protocol or debug logging is enabled.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveCuaDriver, type Env } from "../config";
import { monotonic, sleep } from "../time";
import { VaultError, type CuaCaller, type CuaSession } from "./onepassword";

/** The Python client's default clientInfo, which cua-driver saw before. */
const CLIENT_INFO = { name: "mcp", version: "0.1.0" };
/** The SDK's close ends stdin, then signals after 2 s and again after 2 s more. */
const CLOSE_WAIT_SECONDS = 4.5;
/**
 * Python gave each call the remaining time, which raced the read's own deadline and could end a read at its
 * deadline as either code. Here the read's deadline aborts the call first (deadline-exceeded); the per-call
 * timeout, a little later, is only a backstop.
 */
const CALL_BACKSTOP_SECONDS = 0.25;

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open `<cua-driver> mcp` (C1 resolution) with the SDK's default environment. Opening is bounded by the read's
 * deadline and aborted with its signal; any failure is transport-unavailable. Each call is cancelled by the
 * signal and bounded by the remaining time; an error result or a missing structured object is
 * transport-unavailable, and a call after the deadline is deadline-exceeded without being sent.
 */
export async function openCuaMcp(deadline: number, signal: AbortSignal, env: Env = process.env): Promise<CuaSession> {
  const command = resolveCuaDriver(env);
  if (!command) throw new VaultError("transport-unavailable");
  const remaining = deadline - monotonic();
  if (remaining <= 0) throw new VaultError("deadline-exceeded");
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const closed = new Promise<void>((resolve) => { client.onclose = resolve; });
  // Like Python's stdio_client exit, closing waits for the driver to end, so the vault lock outlives it.
  const close = async () => {
    const waited = new AbortController();
    try {
      await client.close();
      await Promise.race([closed, sleep(CLOSE_WAIT_SECONDS * 1000, waited.signal)]);
    } finally {
      waited.abort();
    }
  };
  const transport = new StdioClientTransport({ command, args: ["mcp"], stderr: "ignore" });
  try {
    await client.connect(transport, { signal, timeout: remaining * 1000 });
  } catch {
    await close().catch(() => undefined);
    throw new VaultError("transport-unavailable");
  }
  const cua: CuaCaller = {
    async call(name, args, options = {}) {
      const left = (options.deadline ?? deadline) - monotonic();
      if (left <= 0) throw new VaultError("deadline-exceeded");
      let result: Awaited<ReturnType<Client["callTool"]>>;
      try {
        result = await client.callTool({ name, arguments: args }, undefined, { timeout: (left + CALL_BACKSTOP_SECONDS) * 1000, signal });
      } catch {
        throw new VaultError("transport-unavailable");
      }
      if (result.isError || !isDict(result.structuredContent)) throw new VaultError("transport-unavailable");
      return result.structuredContent;
    }
  };
  return { cua, close };
}
