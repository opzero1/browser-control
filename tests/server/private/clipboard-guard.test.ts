// clipboard_guard.py -> private/clipboard-guard.ts, with synthetic /bin/sh guardians in private temp dirs.
// No test here runs a real pasteboard guardian: the compiled Swift binary is built and checked, never run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { ClipboardError, RESTORE_SECONDS, START_SECONDS, buildClipboardGuard, guardianTrusted, withPreservedClipboard } from "../../../src/server/private/clipboard-guard";
import { clipboardGuardBinary } from "../../../src/server/stable-copy";
import { monotonic } from "../../../src/server/time";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";
import { exposure, watchOutput } from "./canary";

const SECRET = "synthetic-clipboard-secret-value";

afterEach(() => {
  removeTempRoots();
});

interface GuardianOptions { response?: string; delay?: number; exit?: number; before?: string; ready?: string }

/** A synthetic guardian: prints its pid and `ready`, waits for a line, then records the restore and answers. */
function installGuardian(directory: string, options: GuardianOptions = {}): string {
  const marker = path.join(directory, "restored.marker");
  const pid = path.join(directory, "guardian.pid");
  const executable = path.join(directory, "synthetic-clipboard-guardian");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `echo $$ > '${pid}'`,
    options.before ?? "",
    `echo '${options.ready ?? "ready"}'`,
    "read line",
    `sleep ${options.delay ?? 0}`,
    `printf done > '${marker}'`,
    `echo '${options.response ?? "restored"}'`,
    `exit ${options.exit ?? 0}`,
    ""
  ].join("\n"));
  fs.chmodSync(executable, 0o700);
  return executable;
}

function restored(directory: string): boolean {
  const marker = path.join(directory, "restored.marker");
  return fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === "done";
}

function guardianAlive(directory: string): boolean {
  const pid = Number(fs.readFileSync(path.join(directory, "guardian.pid"), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("withPreservedClipboard", () => {
  it("waits for the restore after a cancellation during the body, then rethrows it", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { delay: 0.05 });
    const controller = new AbortController();
    let mutated = false;
    const error = await caught(withPreservedClipboard(async () => {
      mutated = true;
      controller.abort();
      await Promise.resolve();
      controller.signal.throwIfAborted();
    }, { binary, signal: controller.signal }));
    expect(error).toBe(controller.signal.reason);
    expect(mutated).toBe(true);
    expect(restored(directory)).toBe(true);
  });

  it("keeps the body's own error when the restore succeeds", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory);
    const bodyError = new RangeError("body failure");
    const error = await caught(withPreservedClipboard(async () => { throw bodyError; }, { binary }));
    expect(error).toBe(bodyError);
    expect(restored(directory)).toBe(true);
  });

  it("never returns the body's value when the restore fails", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { response: "restore-failed" });
    const watch = watchOutput();
    let error: unknown;
    try {
      error = await caught(withPreservedClipboard(async () => SECRET, { binary }));
    } finally {
      watch.restore();
    }
    expect(error).toBeInstanceOf(ClipboardError);
    expect((error as ClipboardError).code).toBe("clipboard-restore-failed");
    expect((error as ClipboardError).message).toBe("clipboard-restore-failed");
    expect(exposure(error)).not.toContain(SECRET);
    expect(watch.text()).not.toContain(SECRET);
  });

  it("refuses a missing binary as unavailable before the body", async () => {
    const directory = privateTemp();
    let ran = false;
    const error = await caught(withPreservedClipboard(async () => { ran = true; }, { binary: path.join(directory, "missing") }));
    expect(error).toBeInstanceOf(ClipboardError);
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
    expect(ran).toBe(false);
  });

  const untrusted = ["writable", "symlink"];
  it.each(untrusted)("refuses an untrusted %s binary before the body", async (kind) => {
    const directory = privateTemp();
    let binary = installGuardian(directory);
    if (kind === "writable") {
      fs.chmodSync(binary, 0o722);
    } else {
      const link = path.join(directory, "linked-guardian");
      fs.symlinkSync(binary, link);
      binary = link;
    }
    let ran = false;
    const error = await caught(withPreservedClipboard(async () => { ran = true; }, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
    expect(ran).toBe(false);
    expect(fs.existsSync(path.join(directory, "restored.marker"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "guardian.pid"))).toBe(false);
  });

  const modes: [string, number][] = [["group-writable", 0o720], ["other-writable", 0o702], ["not executable", 0o600]];
  it.each(modes)("refuses a %s binary before starting it", async (_name, mode) => {
    const directory = privateTemp();
    const binary = installGuardian(directory);
    fs.chmodSync(binary, mode);
    expect(guardianTrusted(binary)).toBe(false);
    let ran = false;
    const error = await caught(withPreservedClipboard(async () => { ran = true; }, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
    expect(ran).toBe(false);
    expect(fs.existsSync(path.join(directory, "guardian.pid"))).toBe(false);
  });

  it("refuses a directory in place of the binary", async () => {
    const directory = privateTemp();
    const binary = path.join(directory, "guardian-directory");
    fs.mkdirSync(binary, { mode: 0o700 });
    expect(guardianTrusted(binary)).toBe(false);
    expect(((await caught(withPreservedClipboard(async () => undefined, { binary }))) as ClipboardError).code).toBe("clipboard-unavailable");
  });

  it("trusts an owner-only executable regular file", () => {
    const binary = installGuardian(privateTemp());
    expect(guardianTrusted(binary)).toBe(true);
    fs.chmodSync(binary, 0o755);
    expect(guardianTrusted(binary)).toBe(true);
  });

  it("refuses a guardian whose first line is not ready and kills it", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { ready: "not-ready", delay: 30 });
    let ran = false;
    const error = await caught(withPreservedClipboard(async () => { ran = true; }, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
    expect(ran).toBe(false);
    expect(guardianAlive(directory)).toBe(false);
  });

  it("refuses a ready line over the 64-byte limit", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { ready: `ready${"x".repeat(80)}` });
    const error = await caught(withPreservedClipboard(async () => undefined, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
  });

  it("gives up on a guardian that is not ready within START_SECONDS", async () => {
    expect(START_SECONDS).toBe(3);
    const directory = privateTemp();
    const binary = installGuardian(directory, { before: "sleep 30" });
    const started = monotonic();
    const error = await caught(withPreservedClipboard(async () => undefined, { binary }));
    const elapsed = monotonic() - started;
    expect((error as ClipboardError).code).toBe("clipboard-unavailable");
    expect(elapsed).toBeGreaterThan(START_SECONDS - 0.2);
    expect(elapsed).toBeLessThan(START_SECONDS + 3);
    expect(guardianAlive(directory)).toBe(false);
  });

  it("fails the restore when the guardian exits nonzero", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { exit: 3 });
    const error = await caught(withPreservedClipboard(async () => SECRET, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-restore-failed");
  });

  it("fails the restore without an uncaught EPIPE when the guardian closed its input", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { before: "exec 0<&-", delay: 0 });
    const error = await caught(withPreservedClipboard(async () => SECRET, { binary }));
    expect(error).toBeInstanceOf(ClipboardError);
    expect(exposure(error)).not.toContain(SECRET);
  });

  it("fails a restore slower than RESTORE_SECONDS and kills the guardian", async () => {
    expect(RESTORE_SECONDS).toBe(3);
    const directory = privateTemp();
    const binary = installGuardian(directory, { delay: 30 });
    const started = monotonic();
    const error = await caught(withPreservedClipboard(async () => SECRET, { binary }));
    expect((error as ClipboardError).code).toBe("clipboard-restore-failed");
    expect(monotonic() - started).toBeLessThan(RESTORE_SECONDS + 3);
    expect(guardianAlive(directory)).toBe(false);
  });

  it("finishes the start, restores and throws on a cancellation during the start", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory, { before: "sleep 0.2" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    let ran = false;
    const error = await caught(withPreservedClipboard(async () => { ran = true; }, { binary, signal: controller.signal }));
    expect(error).toBe(controller.signal.reason);
    expect(ran).toBe(false);
    expect(restored(directory)).toBe(true);
  });

  it("returns no value when cancelled while a body that ignores the signal completes", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory);
    const controller = new AbortController();
    const error = await caught(withPreservedClipboard(async () => {
      controller.abort();
      return SECRET;
    }, { binary, signal: controller.signal }));
    expect(error).toBe(controller.signal.reason);
    expect(exposure(error)).not.toContain(SECRET);
    expect(restored(directory)).toBe(true);
  });

  it("passes the body's value through after a verified restore", async () => {
    const directory = privateTemp();
    const binary = installGuardian(directory);
    expect(await withPreservedClipboard(async () => "public-result", { binary })).toBe("public-result");
    expect(restored(directory)).toBe(true);
    expect(guardianAlive(directory)).toBe(false);
  });
});

function xcrunAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("buildClipboardGuard", () => {
  it("refuses to build off macOS", async () => {
    const env = testEnv(privateTemp());
    const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(((await caught(buildClipboardGuard(env))) as ClipboardError).code).toBe("clipboard-unavailable");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(fs.existsSync(path.join(env.BROWSER_CONTROL_STATE_DIR as string, "bin"))).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("reuses a trusted binary at the source-hashed path (macOS)", async () => {
    const env = testEnv(privateTemp());
    const target = clipboardGuardBinary(env);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o700 });
    expect(await buildClipboardGuard(env)).toEqual({ path: target, built: false });
  });

  it.skipIf(!xcrunAvailable())("compiles the Swift guardian with xcrun into an owner-only binary (needs xcrun)", async () => {
    const env = testEnv(privateTemp());
    const assets = packageAssets();
    const digest = createHash("sha256").update(fs.readFileSync(assets.clipboardGuardSource)).digest("hex").slice(0, 12);
    const built = await buildClipboardGuard(env, assets);
    expect(built.built).toBe(true);
    expect(built.path).toBe(path.join(env.BROWSER_CONTROL_STATE_DIR as string, "bin", `clipboard-guard-${digest}`));
    const stats = fs.lstatSync(built.path);
    expect(stats.isFile()).toBe(true);
    expect(stats.uid).toBe(process.getuid?.());
    expect(stats.mode & 0o777).toBe(0o700);
    expect(guardianTrusted(built.path)).toBe(true);
    expect(fs.readFileSync(built.path).subarray(0, 4).readUInt32LE(0)).toBe(0xfeedfacf);
    expect(fs.readdirSync(path.dirname(built.path))).toEqual([path.basename(built.path)]);
    expect(await buildClipboardGuard(env, assets)).toEqual({ path: built.path, built: false });
  }, 300000);
});
