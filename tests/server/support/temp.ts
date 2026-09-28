import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** sockaddr_un.sun_path is 104 bytes on macOS, including the terminating NUL. */
export const SOCKET_PATH_LIMIT = 103;

const created: string[] = [];

/**
 * A private (0700) temporary directory under the real test temp root, short enough for Unix socket paths.
 * Removed by removeTempRoots(), which the suites call in afterEach.
 */
export function privateTemp(prefix = "fc-"): string {
  const base = process.env.OPZERO_TEST_TMPDIR || path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(base), prefix));
  fs.chmodSync(root, 0o700);
  created.push(root);
  return root;
}

export function socketPath(directory: string, name: string): string {
  const file = path.join(directory, name);
  if (Buffer.byteLength(file) > SOCKET_PATH_LIMIT) throw new Error(`socket path too long: ${file}`);
  return file;
}

export function removeTempRoots(): void {
  for (const root of created.splice(0)) {
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // Already gone.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** An env for one test: a private state root and no inherited FAST_CHROME_* or host settings. */
export function testEnv(root: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FAST_CHROME_") || key.startsWith("BROWSER_CONTROL_") || key.startsWith("OPZERO_") || key === "CUA_DRIVER") continue;
    env[key] = value;
  }
  return { ...env, HOME: path.join(root, "home"), BROWSER_CONTROL_STATE_DIR: path.join(root, "state"), ...extra };
}
