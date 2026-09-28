// Clipboard preservation around a vault copy (clipboard_guard.py). A native guardian process snapshots every
// pasteboard item and representation before the copy and restores them afterwards; the value copied in
// between never passes through this module. Its pipe carries fixed status lines only.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packageAssets, type PackageAssets } from "../assets";
import { statePaths, whichExecutable, type Env } from "../config";
import { io, openDirectory, syncDirectory, verified } from "../fs-private";
import { clipboardGuardBinary } from "../stable-copy";

export const START_SECONDS = 3;
export const RESTORE_SECONDS = 3;
/** asyncio's StreamReader limit for the guardian's stdout: no status line is longer. */
const LINE_LIMIT = 64;
/** swiftc on a cold module cache can take a while; the build is an explicit install step. */
const BUILD_SECONDS = 600;

export type ClipboardErrorCode = "clipboard-unavailable" | "clipboard-restore-failed";
export const ERROR_CODES: ReadonlySet<string> = new Set<ClipboardErrorCode>(["clipboard-unavailable", "clipboard-restore-failed"]);

/** A clipboard preservation failure with a fixed, non-private message. */
export class ClipboardError extends Error {
  readonly code: ClipboardErrorCode;

  constructor(code: string) {
    const fixed: ClipboardErrorCode = ERROR_CODES.has(code) ? code as ClipboardErrorCode : "clipboard-unavailable";
    super(fixed);
    this.code = fixed;
    this.name = "ClipboardError";
  }
}

/** Buffered stdout lines, each capped like StreamReader.readline(limit=64); EOF yields the partial line. */
class Lines {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      // Past the limit the next read fails anyway, so a noisy guardian cannot grow this buffer.
      if (this.buffer.length <= LINE_LIMIT * 4) this.buffer = Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    stream.on("end", () => { this.ended = true; this.notify(); });
    stream.on("error", () => { this.ended = true; this.notify(); });
  }

  private notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async read(): Promise<Buffer> {
    while (true) {
      const end = this.buffer.indexOf(0x0a);
      if (end >= 0 && end <= LINE_LIMIT) {
        const line = this.buffer.subarray(0, end + 1);
        this.buffer = this.buffer.subarray(end + 1);
        return line;
      }
      if (end > LINE_LIMIT || this.buffer.length > LINE_LIMIT) throw new Error("line limit");
      if (this.ended) {
        const line = this.buffer;
        this.buffer = Buffer.alloc(0);
        return line;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

interface Guardian { child: ChildProcess; lines: Lines; exited: Promise<number | null> }

function within<T>(seconds: number, body: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), seconds * 1000);
    body.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function terminate(guardian: Guardian): Promise<void> {
  if (running(guardian.child)) {
    try {
      guardian.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await guardian.exited;
}

/** The binary is trusted only as a regular file (not a link) owned by this user, not group- or other-writable, and executable. */
export function guardianTrusted(binary: string): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(binary);
  } catch {
    return false;
  }
  if (!stats.isFile() || stats.uid !== process.getuid?.() || stats.mode & 0o022) return false;
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

async function startGuardian(binary: string): Promise<Guardian> {
  if (!guardianTrusted(binary)) throw new ClipboardError("clipboard-unavailable");
  let guardian: Guardian | null = null;
  try {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code));
    });
    // A write to a guardian that already exited fails through the restore status, never as an uncaught EPIPE.
    child.stdin?.on("error", () => undefined);
    guardian = { child, exited, lines: new Lines(child.stdout as NodeJS.ReadableStream) };
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await within(START_SECONDS, spawned.then(() => (guardian as Guardian).lines.read()).then((response) => {
      if (!response.equals(Buffer.from("ready\n")) || !running(child)) throw new ClipboardError("clipboard-unavailable");
    }));
    return guardian;
  } catch {
    if (guardian) await terminate(guardian);
    throw new ClipboardError("clipboard-unavailable");
  }
}

async function restore(guardian: Guardian): Promise<void> {
  try {
    await within(RESTORE_SECONDS, (async () => {
      const stdin = guardian.child.stdin;
      if (!stdin) throw new Error("no pipe");
      await new Promise<void>((resolve, reject) => {
        stdin.write("restore\n", (error) => (error ? reject(error) : resolve()));
      });
      stdin.end();
      const response = await guardian.lines.read();
      const code = await guardian.exited;
      if (!response.equals(Buffer.from("restored\n")) || code !== 0) throw new Error("not restored");
    })());
  } catch {
    await terminate(guardian);
    throw new ClipboardError("clipboard-restore-failed");
  }
}

/** Settle a promise into a result, like awaiting it inside try. */
async function settle<T>(body: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    return { ok: false, error };
  }
}

function defaultBinary(): string {
  try {
    return clipboardGuardBinary();
  } catch {
    throw new ClipboardError("clipboard-unavailable");
  }
}

/**
 * preserve_clipboard: restore every clipboard item and representation before leaving the body. A failed
 * restore masks the body's value or error with clipboard-restore-failed. An abort cannot interrupt the start
 * or the restore: an abort during the start restores, then throws the abort reason without running the body;
 * an abort during the body or the restore is thrown after the restore instead of returning the body's value.
 */
export async function withPreservedClipboard<T>(body: () => Promise<T>, options: { binary?: string; signal?: AbortSignal } = {}): Promise<T> {
  const { signal } = options;
  const guardian = await startGuardian(options.binary ?? defaultBinary());
  if (signal?.aborted) {
    await restore(guardian);
    throw signal.reason;
  }
  const outcome = await settle(body);
  await restore(guardian);
  if (!outcome.ok) throw outcome.error;
  if (signal?.aborted) throw signal.reason;
  return outcome.value;
}

function compile(xcrun: string, source: string, output: string, env: Env): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(xcrun, ["swiftc", "-O", "-framework", "AppKit", source, "-o", output],
      { env: { ...env }, timeout: BUILD_SECONDS * 1000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Build <state>/bin/clipboard-guard-<sha12 of the Swift source> (D16) with `xcrun swiftc -O -framework AppKit`.
 * The source is compiled from a private copy of the exact bytes the name hashes, made owner-only (0700) and
 * published by rename. An existing trusted binary is reused.
 */
export async function buildClipboardGuard(env: Env = process.env, assets: PackageAssets = packageAssets()): Promise<{ path: string; built: boolean }> {
  if (process.platform !== "darwin") throw new ClipboardError("clipboard-unavailable");
  let target: string;
  let source: Buffer;
  try {
    target = clipboardGuardBinary(env, assets);
    source = io(() => fs.readFileSync(assets.clipboardGuardSource));
  } catch {
    throw new ClipboardError("clipboard-unavailable");
  }
  if (path.basename(target) !== `clipboard-guard-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`) {
    throw new ClipboardError("clipboard-unavailable");
  }
  if (guardianTrusted(target)) return { path: target, built: false };
  const xcrun = whichExecutable("xcrun", env) ?? (fs.existsSync("/usr/bin/xcrun") ? "/usr/bin/xcrun" : null);
  if (!xcrun) throw new ClipboardError("clipboard-unavailable");
  let staging: string | null = null;
  try {
    const bin = openDirectory(statePaths(env).bin);
    staging = path.join(verified(bin), `.build-${randomUUID()}`);
    io(() => fs.mkdirSync(staging as string, { mode: 0o700 }));
    const copy = path.join(staging, "clipboard_guard.swift");
    const output = path.join(staging, "clipboard-guard");
    io(() => fs.writeFileSync(copy, source, { mode: 0o600, flag: "wx" }));
    await compile(xcrun, copy, output, env);
    io(() => fs.chmodSync(output, 0o700));
    if (!guardianTrusted(output)) throw new Error("untrusted build");
    io(() => fs.renameSync(output, path.join(verified(bin), path.basename(target))));
    syncDirectory(bin);
  } catch {
    throw new ClipboardError("clipboard-unavailable");
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
  if (!guardianTrusted(target)) throw new ClipboardError("clipboard-unavailable");
  return { path: target, built: true };
}
