// `browser-control pool <status|claim|ensure|release|reap|reset>` (D15). Foundation stub with the final
// signature; the pool slice owns this file.
import type { Env } from "../config";

export async function runPoolCommand(_argv: readonly string[], io: { stdout: NodeJS.WritableStream; env?: Env } = { stdout: process.stdout }): Promise<number> {
  io.stdout.write(`${JSON.stringify({ error: "browser-controller-invalid-command" })}\n`);
  return 1;
}
