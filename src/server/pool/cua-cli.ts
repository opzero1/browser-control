// Subprocesses for startup and operator cleanup: the cua-driver CLI and /bin/ps (browser_start.Runtime.cua,
// Runtime.processes and browser_pool.Host.processes).
import { execFile } from "node:child_process";
import { Gate } from "../gate";
import { parsePythonJson, pyDumps, type JsonObject } from "../pyjson";
import { pySplitLines, pyStrip } from "../pystr";

/** Captured output bound per stream; Python's subprocess.run had none. */
const OUTPUT_LIMIT = 16 * 1024 * 1024;
export const PS_TIMEOUT_MS = 10_000;

export interface ProcessResult { status: number; stdout: Buffer }

/**
 * subprocess.run(capture_output=True, timeout=...): resolves with the exit status and stdout. A spawn failure,
 * a timeout (the child is killed with SIGKILL), a signal exit or an output overflow rejects.
 */
export function runProcess(file: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    try {
      const child = execFile(file, [...args], {
        encoding: "buffer", maxBuffer: OUTPUT_LIMIT, timeout: Math.max(1, Math.ceil(timeoutMs)), killSignal: "SIGKILL", windowsHide: true
      }, (error, stdout) => {
        if (!error) return resolve({ status: 0, stdout });
        const { code, killed } = error as { code?: unknown; killed?: boolean };
        if (typeof code === "number" && !killed) return resolve({ status: code, stdout });
        reject(error);
      });
      child.stdin?.end();
    } catch (error) {
      reject(error);
    }
  });
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** text=True: strict UTF-8 (a TypeError on invalid bytes, as Python's UnicodeDecodeError) with universal newlines. */
export function processText(data: Uint8Array): string {
  return decoder.decode(data).replace(/\r\n?/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** One cua-driver CLI call: `<cua> <name> <json>` printing one JSON object. */
export async function cuaCli(cua: string, name: string, args: JsonObject, timeoutMs: number): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    const result = await runProcess(cua, [name, pyDumps(args)], timeoutMs);
    if (result.status !== 0) throw new Error("cua-driver failed");
    value = parsePythonJson(processText(result.stdout));
  } catch {
    throw new Gate("browser-controller-cua-unavailable");
  }
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, "error") || value.effect === "refused") {
    throw new Gate("browser-controller-cua-refused");
  }
  return value;
}

/** The exact Chrome for Testing main process of one profile; helpers and other profiles never match. */
export function hasProfile(command: string, profile: string): boolean {
  const parts = pyStrip(command).split(" --");
  const rest = parts.slice(1);
  return parts[0].endsWith("/Contents/MacOS/Google Chrome for Testing")
    && rest.filter((part) => part.startsWith("user-data-dir=")).length === 1
    && rest.includes(`user-data-dir=${profile}`);
}

/** `/bin/ps -ww -axo pid=,command=` as (pid, command) rows; any failure is browser-controller-process-unconfirmed. */
export async function psProcesses(): Promise<Array<[number, string]>> {
  let result: ProcessResult;
  try {
    result = await runProcess("/bin/ps", ["-ww", "-axo", "pid=,command="], PS_TIMEOUT_MS);
  } catch {
    throw new Gate("browser-controller-process-unconfirmed");
  }
  if (result.status !== 0) throw new Gate("browser-controller-process-unconfirmed");
  const rows: Array<[number, string]> = [];
  for (const line of pySplitLines(processText(result.stdout))) {
    const text = pyStrip(line);
    const space = text.indexOf(" ");
    const pid = space < 0 ? text : text.slice(0, space);
    const command = space < 0 ? "" : text.slice(space + 1);
    if (/^[0-9]+$/.test(pid)) rows.push([Number(pid), command]);
  }
  return rows;
}

/** `/bin/ps -ww -p <pid> -o command=` for one process: its command line, or process-unconfirmed. */
export async function psCommand(pid: number, timeoutMs: number): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runProcess("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], timeoutMs);
  } catch {
    throw new Gate("browser-controller-process-unconfirmed");
  }
  if (result.status !== 0) throw new Gate("browser-controller-process-unconfirmed");
  return processText(result.stdout);
}
