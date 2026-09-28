// The caller's session identity (C7). Python read _meta["ai.opencode/sessionID"] or _meta["sessionID"] and
// failed without one; the port falls back to one random ID per server process when both are absent, so MCP
// clients that send no session metadata (Claude Code, Codex, Cursor) still work.
import { randomBytes } from "node:crypto";
import { Gate } from "./gate";

export const SESSION_META_KEYS = ["ai.opencode/sessionID", "sessionID"] as const;

let processSession: string | null = null;

/** "ses_" + 32 lowercase hex characters, created once per process. */
export function processSessionId(): string {
  processSession ??= `ses_${randomBytes(16).toString("hex")}`;
  return processSession;
}

/** Python truthiness for a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function field(meta: unknown, key: string): unknown {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  return Object.prototype.hasOwnProperty.call(meta, key) ? (meta as Record<string, unknown>)[key] : undefined;
}

/**
 * `meta["ai.opencode/sessionID"] or meta["sessionID"]` with Python's `or`. Only an absent identity (both keys
 * missing or null) uses the process fallback. A present identity that is not a non-empty string still fails
 * with fast-chrome-session-required (D9).
 */
export function sessionFromMeta(meta: unknown): string {
  const [primary, secondary] = SESSION_META_KEYS.map((key) => field(meta, key));
  if ((primary === undefined || primary === null) && (secondary === undefined || secondary === null)) {
    return processSessionId();
  }
  const value = truthy(primary) ? primary : secondary;
  if (typeof value !== "string" || !value) throw new Gate("fast-chrome-session-required");
  return value;
}
