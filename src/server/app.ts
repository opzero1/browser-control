// The tool surface. Foundation ships this stub with its final contract; the server slice owns the file.
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { packageAssets } from "./assets";
import { SERVER_NAME, type Env } from "./config";
import type { Connect } from "./host-connection";
import type { Shutdown } from "./runtime/shutdown";

export type VaultField = "username" | "password" | "one-time password";
export type ReadField = (email: string, field: VaultField, options?: { allow_foreground_search: true }) => Promise<string>;

export interface AppOptions { env: Env; shutdown: Shutdown; connect?: Connect; readField?: ReadField }

export interface App {
  readonly serverInfo: { name: string; version: string };
  readonly instructions: string;
  listTools(): Tool[];
  callTool(name: string, args: unknown, meta: unknown): Promise<CallToolResult>;
  /** Finalize every managed tab by a monotonic deadline (seconds). */
  cleanup(deadline: number): Promise<void>;
}

export function createApp(_options: AppOptions): App {
  return {
    serverInfo: { name: SERVER_NAME, version: packageAssets().version },
    instructions: "",
    listTools: () => [],
    callTool: async (name) => ({ isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] }),
    cleanup: async () => undefined
  };
}
