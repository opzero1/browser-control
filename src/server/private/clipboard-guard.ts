// Clipboard preservation around a vault copy (clipboard_guard.py). Foundation stub with the final contract;
// the private slice owns this file. Until then no copy is possible, which fails closed.
import type { PackageAssets } from "../assets";
import type { Env } from "../config";

export const START_SECONDS = 3;
export const RESTORE_SECONDS = 3;

export class ClipboardError extends Error {
  readonly code: "clipboard-unavailable" | "clipboard-restore-failed";
  constructor(code: "clipboard-unavailable" | "clipboard-restore-failed") {
    super(code);
    this.code = code;
    this.name = "ClipboardError";
  }
}

export async function withPreservedClipboard<T>(_body: () => Promise<T>, _options: { binary?: string; signal?: AbortSignal } = {}): Promise<T> {
  throw new ClipboardError("clipboard-unavailable");
}

export async function buildClipboardGuard(_env?: Env, _assets?: PackageAssets): Promise<{ path: string; built: boolean }> {
  throw new ClipboardError("clipboard-unavailable");
}
