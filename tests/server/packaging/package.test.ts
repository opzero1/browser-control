// The packed npm tarball, run offline from a temporary extraction: the CLI starts, install copies the host out of
// the package, the stable host runs through its wrapper with this Node, and `mcp` serves stdio.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hostWrapper } from "../../../src/server/stable-copy";
import { McpStdio } from "../support/mcp-stdio";
import { realDefaultPaths } from "../support/packaging";
import { privateTemp, removeTempRoots, socketPath, testEnv } from "../support/temp";

const repository = path.resolve(__dirname, "../../..");
const version = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).version as string;
let unpacked: string;
let files: string[];
let defaults: Record<string, string>;

function run(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(unpacked, "dist/server/cli.js"), ...args], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(() => {
  defaults = realDefaultPaths();
  const base = fs.realpathSync(process.env.OPZERO_TEST_TMPDIR || path.join(os.tmpdir(), "opencode"));
  const directory = fs.mkdtempSync(path.join(base, "pk-pack-"));
  fs.chmodSync(directory, 0o700);
  execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: repository, stdio: "ignore" });
  const tarball = fs.readdirSync(directory).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack wrote no tarball");
  files = execFileSync("tar", ["-tzf", path.join(directory, tarball)], { encoding: "utf8" }).trim().split("\n").sort();
  execFileSync("tar", ["-xzf", path.join(directory, tarball), "-C", directory]);
  unpacked = path.join(directory, "package");
}, 60000);

afterEach(() => removeTempRoots());

afterAll(() => {
  if (unpacked) fs.rmSync(path.dirname(unpacked), { recursive: true, force: true });
  expect(realDefaultPaths()).toEqual(defaults);
});

describe("the packed @op1/browser-control tarball", () => {
  it("ships the CLI, native host, extension, vendored data and Swift source, and no sources or tests", () => {
    for (const file of ["package/package.json", "package/dist/server/cli.js", "package/dist/server/native-host.js", "package/dist/extension/manifest.json",
      "package/dist/extension/background.js", "package/data/public_suffix_list.dat", "package/data/README.md",
      "package/native/clipboard-guard/clipboard_guard.swift", "package/README.md", "package/docs/PRIVACY.md"]) {
      expect(files).toContain(file);
    }
    expect(files.filter((file) => /^package\/(src|tests|scripts)\//.test(file))).toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "@op1/browser-control", version, bin: { "browser-control": "dist/server/cli.js" }, engines: { node: ">=24" },
      publishConfig: { access: "public" } });
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(fs.statSync(path.join(unpacked, "dist/server/cli.js")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(unpacked, "dist/extension/manifest.json"), "utf8")).key).toBeUndefined();
  });

  it("prints its version, usage and config snippets", async () => {
    const root = privateTemp("pk-");
    const env = testEnv(root);
    expect(await run(["--version"], env)).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
    const usage = await run(["bogus"], env);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("usage: browser-control <command>");
    const claude = await run(["config", "claude"], env);
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout).mcpServers["browser-control"]).toMatchObject({ command: "npx", args: ["-y", "@op1/browser-control", "mcp"] });
  });

  it("installs a stable host that runs with this Node outside the package, and doctor accepts it", async () => {
    const root = privateTemp("pk-");
    const socket = socketPath(root, "u.sock");
    // No xcrun, cua-driver or ffmpeg on PATH: the clipboard guard is not compiled during tests.
    const env = testEnv(root, { PATH: path.dirname(process.execPath), BROWSER_CONTROL_STATE_DIR: undefined, BROWSER_CONTROL_HOST_SOCKET: socket });
    fs.mkdirSync(env.HOME as string, { mode: 0o700 });
    const state = path.join(root, "state");
    const flags = ["--state-dir", state, "--chrome-manifest-dir", path.join(root, "manifests"), "--skills-dir", path.join(root, "skills")];
    const installed = await run(["install", ...flags, "--json"], env);
    const report = JSON.parse(installed.stdout);
    const steps = Object.fromEntries(report.steps.map((step: { id: string }) => [step.id, step]));
    expect(steps.host.status).toBe("created");
    expect(steps.wrapper.status).toBe("created");
    expect(steps.manifest.status).toBe("created");
    expect(steps["clipboard-guard"].status).toBe(process.platform === "darwin" ? "toolchain-missing" : "skipped");
    const skillShipped = fs.existsSync(path.join(unpacked, "skills/browser-control/SKILL.md"));
    expect(steps["skill:browser-control"].status).toBe(skillShipped ? "linked" : "missing-from-package");
    expect(installed.code).toBe(skillShipped ? 0 : 1);

    const hostScript = steps.host.path as string;
    expect(hostScript.startsWith(`${state}/hosts/${version}-`)).toBe(true);
    expect(fs.readFileSync(hostScript)).toEqual(fs.readFileSync(path.join(unpacked, "dist/server/native-host.js")));
    const wrapper = path.join(state, "hosts/user/browser-control-host");
    expect(fs.readFileSync(wrapper, "utf8")).toBe(hostWrapper(socket, hostScript, process.execPath));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests/com.opzero.chrome.json"), "utf8"));
    expect(manifest.path).toBe(wrapper);
    for (const file of [wrapper, path.join(root, "manifests/com.opzero.chrome.json")]) {
      expect(fs.readFileSync(file, "utf8").includes(path.dirname(unpacked))).toBe(false);
    }
    expect(fs.readdirSync(env.HOME as string)).toEqual([]);

    // Chrome would launch the wrapper; the stable host listens on the pinned socket and exits on stdin EOF.
    const host = spawn(wrapper, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    host.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => host.on("exit", resolve));
    await expect.poll(() => fs.existsSync(socket) && fs.lstatSync(socket).isSocket(), { timeout: 5000 }).toBe(true);
    host.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");

    const checked = JSON.parse((await run(["doctor", ...flags, "--json"], env)).stdout);
    const doctor = Object.fromEntries(checked.steps.map((step: { id: string; status: string }) => [step.id, step.status]));
    expect(doctor).toMatchObject({ state: "private", host: "current", wrapper: "current", manifest: "current" });
  }, 30000);

  it("serves MCP over stdio and exits 0 on stdin EOF", async () => {
    const root = privateTemp("pk-");
    const env = testEnv(root, { BROWSER_CONTROL_HOST_SOCKET: socketPath(root, "none.sock") });
    const child = spawn(process.execPath, [path.join(unpacked, "dist/server/cli.js"), "mcp"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const client = new McpStdio(child.stdin, child.stdout);
    const initialized = await client.initialize();
    expect(initialized.result).toMatchObject({ serverInfo: { name: "browser-control", version } });
    const listed = await client.request("tools/list");
    expect(Array.isArray((listed.result as { tools: unknown }).tools)).toBe(true);
    const started = Date.now();
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stderr).toBe("");
    expect(fs.existsSync(path.join(root, "home"))).toBe(false);
  }, 30000);
});
