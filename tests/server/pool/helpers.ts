// Shared fixtures for the pool ports: a private state root per test, the pool child, sockets and fakes.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, inject } from "vitest";
import type { PackageAssets } from "../../../src/server/assets";
import { packageAssets } from "../../../src/server/assets";
import { openDirectory } from "../../../src/server/fs-private";
import { Gate } from "../../../src/server/gate";
import { lockWait, type HeldLock } from "../../../src/server/lock";
import { operate, poolContext, type PoolContext } from "../../../src/server/pool/registry";
import { startChild } from "../support/children";
import { privateTemp, testEnv } from "../support/temp";

export const P1 = "https://deploy-preview-1--example.netlify.app/login";
export const P2 = "https://deploy-preview-2--example.netlify.app/login";
export const P3 = "https://deploy-preview-3--example.netlify.app/login";
export const STAGING = "https://staging.dashboard.example.global/";

/**
 * Run this file's suite while no other pool suite runs. The registry fsyncs every record (about 9 ms per write on
 * APFS), and several such suites at once slow other workers' child processes enough to expose their startup races.
 * The lock is the pool's own SQLite lock, in this run's private children directory.
 */
export function serialSuite(): void {
  let held: HeldLock | null = null;
  beforeAll(async () => {
    held = await lockWait(openDirectory(inject("serverChildren")), "pool-suites.lock", true);
  }, 180000);
  afterAll(() => held?.release());
}

export interface Pool { root: string; env: Record<string, string | undefined>; ctx: PoolContext }

/**
 * A fresh state root (BROWSER_CONTROL_STATE_DIR is the temp root itself, so socket paths stay under the
 * 103-byte limit) with no inherited FAST_CHROME_* settings. `extra` adds or overrides variables.
 */
export function pool(extra: Record<string, string | undefined> = {}): Pool {
  const root = privateTemp();
  const env = testEnv(root, { BROWSER_CONTROL_STATE_DIR: root, BROWSER_CONTROL_TEST_PSL: packageAssets().publicSuffixList, ...extra });
  const ctx = poolContext(env);
  fs.mkdirSync(ctx.sockets, { recursive: true, mode: 0o700 });
  return { root, env, ctx };
}

/** The same pool with changed environment variables (monkeypatch.setenv). */
export function withEnv(target: Pool, extra: Record<string, string | undefined>): Pool {
  const env = { ...target.env, ...extra };
  return { ...target, env, ctx: { ...target.ctx, env } };
}

/** The code of a rejected promise or thrown call (null when it succeeds). */
export async function gate(body: Promise<unknown> | (() => unknown)): Promise<string | null> {
  try {
    await (typeof body === "function" ? body() : body);
    return null;
  } catch (error) {
    if (error instanceof Gate) return error.code;
    throw error;
  }
}

/** Run one tests/server/support/child-pool.ts mode and parse its JSON line. */
export async function child(target: Pool, args: string[], extra: Record<string, string | undefined> = {}): Promise<any> {
  const running = startChild("child-pool", args, { ...target.env, ...extra } as NodeJS.ProcessEnv);
  const line = await running.line(20000);
  const code = await running.exited;
  if (code !== 0) throw new Error(`child-pool ${args.join(" ")} exited ${code}: ${running.stderr()}`);
  return JSON.parse(line);
}

export function call(target: Pool, name: string, args: Record<string, unknown>, extra: Record<string, string | undefined> = {}): Promise<any> {
  return child(target, ["call", name, JSON.stringify(args)], extra);
}

export async function rows(target: Pool): Promise<Record<string, any>> {
  const status = await operate("status", { ctx: target.ctx }) as { controllers: Array<Record<string, any>> };
  return Object.fromEntries(status.controllers.map((row) => [row.controller_id, row]));
}

export function registryPath(target: Pool, controller: string): string {
  return path.join(target.ctx.registry, controller);
}

/**
 * A socket file with no listener. libuv unlinks a Unix socket when its server closes, so the server listens on
 * a temporary name that is renamed into place before it closes.
 */
export async function staleSocket(file: string): Promise<void> {
  const temporary = `${file}.t`;
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(temporary, () => resolve());
  });
  fs.renameSync(temporary, file);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Leave a socket file, which claims read as a running Chrome. */
export async function running(target: Pool, ...controllers: string[]): Promise<void> {
  for (const controller of controllers) await staleSocket(path.join(target.ctx.sockets, `${controller}.sock`));
}

/** A live listener on `file`, owner-only like the native host's. */
export async function listen(file: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.on("error", () => undefined));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => resolve());
  });
  fs.chmodSync(file, 0o600);
  return server;
}

export function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Synthetic package files for provisioning and startup: a native host script and an unpacked extension with a
 * manifest, under a private temp directory.
 */
export function syntheticAssets(root: string): PackageAssets {
  const base = path.join(root, "package");
  fs.mkdirSync(path.join(base, "dist/server"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(base, "dist/extension"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(base, "dist/server/native-host.js"), "// synthetic native host\n");
  fs.writeFileSync(path.join(base, "dist/extension/manifest.json"), `${JSON.stringify({ manifest_version: 3, name: "Synthetic", version: "0.0.0" })}\n`);
  fs.writeFileSync(path.join(base, "dist/extension/background.js"), "// synthetic worker\n");
  const real = packageAssets();
  return {
    root: base, extensionDir: path.join(base, "dist/extension"), nativeHost: path.join(base, "dist/server/native-host.js"),
    publicSuffixList: real.publicSuffixList, clipboardGuardSource: real.clipboardGuardSource, version: "0.0.0-test"
  };
}

/** Files under a directory whose names mark SQLite journals, which the never-written lock databases must not leave. */
export function journals(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/-(journal|wal|shm)$/.test(entry.name)) found.push(file);
    }
  };
  walk(root);
  return found;
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export function tempDir(): string {
  return privateTemp();
}
