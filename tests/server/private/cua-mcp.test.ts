// The private cua-driver connection over a real MCP stdio subprocess: a synthetic `cua-driver mcp`
// (tests/server/support/child-private.ts) behind CUA_DRIVER, a synthetic /bin/sh clipboard guardian at the
// state root's guardian path, and the production readField dependencies. No real driver, vault or pasteboard.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { VAULT_TIMING, VaultError, readField } from "../../../src/server/private/onepassword";
import { clipboardGuardBinary } from "../../../src/server/stable-copy";
import { monotonic } from "../../../src/server/time";
import { childPath, killChildren, startChild } from "../support/children";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";
import { exposure, watchOutput } from "./canary";
import { EMAIL, detailElements } from "./fake-cua";

const SECRET = "synthetic-driver-secret-9d41";
const saved = { ...VAULT_TIMING };

interface Driver { env: Record<string, string | undefined>; root: string; log: string; marker: string; wrapper: string }

/** A private root with a synthetic driver for `scenario` and a synthetic guardian at the guardian path. */
function driver(scenario: Record<string, unknown> = {}): Driver {
  const root = privateTemp();
  const scenarioFile = path.join(root, "scenario.json");
  const log = path.join(root, "calls.log");
  fs.writeFileSync(scenarioFile, JSON.stringify({ elements: detailElements(), copies: [EMAIL, SECRET, EMAIL], stderr: SECRET, ...scenario }));
  const wrapper = path.join(root, "cua-driver");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${childPath("child-private")}' cua '${scenarioFile}' '${log}' "$@"\n`, { mode: 0o700 });
  const env = testEnv(root, { CUA_DRIVER: wrapper });
  const guardian = clipboardGuardBinary(env);
  const marker = path.join(root, "restored.marker");
  fs.mkdirSync(path.dirname(guardian), { recursive: true, mode: 0o700 });
  fs.writeFileSync(guardian, `#!/bin/sh\necho ready\nread line\nprintf done > '${marker}'\necho restored\n`, { mode: 0o700 });
  return { env, root, log, marker, wrapper };
}

function calls(log: string): { name: string; args?: Record<string, unknown> }[] {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function failure(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error("expected a VaultError");
}

beforeEach(() => {
  Object.assign(VAULT_TIMING, { searchWaitSeconds: 0.2, searchPollSeconds: 0.01, selectionWaitSeconds: 0.2 });
});

afterEach(() => {
  Object.assign(VAULT_TIMING, saved);
  killChildren();
  removeTempRoots();
});

describe("the private cua-driver MCP connection", () => {
  it("reads a field through a real cua-driver MCP subprocess, restores the clipboard and closes the driver", async () => {
    const { env, log, marker, root } = driver();
    const watch = watchOutput();
    let value: string;
    try {
      value = await readField(EMAIL, "password", { env });
    } finally {
      watch.restore();
    }
    expect(value).toBe(SECRET);
    const names = calls(log).map((call) => call.name);
    expect(names.slice(0, 3)).toEqual(["list_apps", "list_windows", "get_window_state"]);
    expect(names.filter((name) => name === "click")).toHaveLength(3);
    expect(names[names.length - 1]).toBe("closed");
    expect(fs.readFileSync(log, "utf8")).not.toContain(SECRET);
    expect(calls(log).find((call) => call.name === "list_windows")?.args).toEqual({ pid: 41 });
    expect(fs.readFileSync(marker, "utf8")).toBe("done");
    expect(watch.text()).not.toContain(SECRET);
    expect(fs.readdirSync(path.join(root, "state", "locks"))).toEqual(["onepassword.lock"]);
  });

  it.each([
    ["an error result", { behavior: { list_apps: "error" } }],
    ["a result without a structured object", { behavior: { list_apps: "unstructured" } }],
    ["a driver that exits during a call", { behavior: { list_windows: "exit" } }]
  ])("reports %s as transport-unavailable without upstream text", async (_name, scenario) => {
    const { env, marker } = driver(scenario);
    const error = await failure(readField(EMAIL, "password", { env }));
    expect(error.code).toBe("transport-unavailable");
    expect(exposure(error)).not.toContain(SECRET);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("bounds a driver that never answers the handshake by the read deadline", async () => {
    VAULT_TIMING.timeoutSeconds = 0.8;
    const { env, log } = driver({ initialize: "hang" });
    const started = monotonic();
    const error = await failure(readField(EMAIL, "password", { env }));
    expect(error.code).toBe("transport-unavailable");
    expect(monotonic() - started).toBeLessThan(3);
    expect(calls(log).map((call) => call.name)).toEqual(["closed"]);
  });

  it("cancels a hung call at the deadline, restores the clipboard first, then closes the driver", async () => {
    // The deadline must fall inside the hung clipboard_read. Under a loaded full suite the path up to it (driver
    // start, MCP handshake, window lookup) takes about 2 s, so a shorter budget expires before the hang.
    VAULT_TIMING.timeoutSeconds = 4;
    const { env, log, marker } = driver({ behavior: { clipboard_read: "hang" } });
    const started = monotonic();
    const error = await failure(readField(EMAIL, "password", { env }));
    expect(error.code).toBe("deadline-exceeded");
    expect(monotonic() - started).toBeLessThan(6.5);
    expect(fs.readFileSync(marker, "utf8")).toBe("done");
    const names = calls(log).map((call) => call.name);
    expect(names).toContain("clipboard_write");
    expect(names).not.toContain("click");
    expect(names[names.length - 1]).toBe("closed");
  });

  it.each([
    ["a relative path", "cua-driver"],
    ["a missing file", "/nonexistent/cua-driver"],
    ["a non-executable file", "non-executable"]
  ])("refuses %s in CUA_DRIVER without falling back to PATH", async (_name, configured) => {
    const { env, root, wrapper, log } = driver();
    let value = configured;
    if (configured === "non-executable") {
      value = path.join(root, "not-executable");
      fs.writeFileSync(value, "#!/bin/sh\n", { mode: 0o600 });
    }
    const error = await failure(readField(EMAIL, "password", { env: { ...env, CUA_DRIVER: value, PATH: `${path.dirname(wrapper)}:${env.PATH ?? ""}` } }));
    expect(error.code).toBe("transport-unavailable");
    expect(calls(log)).toEqual([]);
  });

  it("reports a driver that cannot start as transport-unavailable promptly", async () => {
    const { env, root } = driver();
    const broken = path.join(root, "broken-driver");
    fs.writeFileSync(broken, "#!/nonexistent/interpreter\n", { mode: 0o700 });
    const started = monotonic();
    expect((await failure(readField(EMAIL, "password", { env: { ...env, CUA_DRIVER: broken } }))).code).toBe("transport-unavailable");
    expect(monotonic() - started).toBeLessThan(2);
  });

  it("discards the driver's stderr and writes nothing private from a separate process", async () => {
    const { root, wrapper } = driver();
    const child = startChild("child-private", ["vault", packageAssets().root, path.join(root, "state"), wrapper, EMAIL, "password"], testEnv(root));
    const line = await child.line(20000);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(line)).toEqual({ ok: true, sha256: createHash("sha256").update(SECRET).digest("hex") });
    expect(line).not.toContain(SECRET);
    expect(child.stderr()).toBe("");
  }, 30000);
});
