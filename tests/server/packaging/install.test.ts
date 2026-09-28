// browser-control install: stable host, wrapper, manifest, checks, clipboard guard and skills, all inside
// temporary directories.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ISOLATED_EXTENSION_ID, STORE_EXTENSION_ID } from "../../../src/server/config";
import { mcpSnippet, runConfig } from "../../../src/server/commands/config";
import { checkExtensionInstalled } from "../../../src/server/commands/extension";
import { install, runInstall } from "../../../src/server/commands/install";
import { parseOptions, type Options, type Step } from "../../../src/server/commands/shared";
import { ClipboardError } from "../../../src/server/private/clipboard-guard";
import { clipboardGuardBinary, hostWrapper } from "../../../src/server/stable-copy";
import {
  fakeChromeForTesting, fakeDeps, fakePackage, MACH_O, readText, realDefaultPaths, snapshotTree, writeFile
} from "../support/packaging";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";

const repository = path.resolve(__dirname, "../../..");
let defaults: Record<string, string>;

beforeAll(() => {
  defaults = realDefaultPaths();
});

beforeEach(() => {
  // Any fallback to the real home directory fails the test instead of touching it.
  vi.spyOn(os, "homedir").mockImplementation(() => {
    throw new Error("the real home directory was used");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRoots();
});

afterAll(() => {
  expect(realDefaultPaths()).toEqual(defaults);
});

interface Setup {
  root: string;
  env: Record<string, string | undefined>;
  assets: ReturnType<typeof fakePackage>;
  state: string;
  manifests: string;
  skills: string;
  flags: string[];
}

function setup(extra: Record<string, string | undefined> = {}): Setup {
  const root = privateTemp("pk-");
  const cua = writeFile(path.join(root, "tools/cua-driver"), "#!/bin/sh\nexit 0\n", 0o755);
  const env = testEnv(root, { CUA_DRIVER: cua, BROWSER_CONTROL_STATE_DIR: undefined, BROWSER_CONTROL_HOST_SOCKET: path.join(root, "user.sock"), ...extra });
  fs.mkdirSync(env.HOME as string, { mode: 0o700 });
  const state = path.join(root, "state");
  const manifests = path.join(root, "manifests");
  const skills = path.join(root, "skills");
  return { root, env, assets: fakePackage(root), state, manifests, skills, flags: ["--state-dir", state, "--chrome-manifest-dir", manifests, "--skills-dir", skills] };
}

function options(argv: string[]): Options {
  return parseOptions(argv, ["--state-dir", "--chrome-manifest-dir", "--skills-dir", "--dry-run", "--force", "--json"]);
}

function byId(steps: readonly Step[]): Record<string, Step> {
  return Object.fromEntries(steps.map((item) => [item.id, item]));
}

function statuses(steps: readonly Step[]): Record<string, string> {
  return Object.fromEntries(steps.map((item) => [item.id, item.status]));
}

function sink(): Writable & { text: string } {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      stream.text += String(chunk);
      done();
    }
  }) as Writable & { text: string };
  stream.text = "";
  return stream;
}

function hostScriptOf(report: { steps: Step[] }): string {
  return byId(report.steps).host.path as string;
}

describe("browser-control install", () => {
  it("installs into the flagged directories and writes nothing under the home directory", async () => {
    const { root, env, assets, state, manifests, skills, flags } = setup();
    const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });
    const report = await install(options(flags), env, deps);
    expect(statuses(report.steps)).toEqual({
      node: "found", state: "created", host: "created", wrapper: "created", manifest: "created", extension: "profile-missing",
      "cua-driver": "found", "chrome-for-testing": "found", "clipboard-guard": "built", "skill:browser-control": "linked"
    });
    expect(report.ok).toBe(true);
    expect(deps.located).toEqual(["com.google.chrome.for.testing"]);

    const wrapper = path.join(state, "hosts/user/browser-control-host");
    const hostScript = hostScriptOf(report);
    expect(path.dirname(hostScript)).toMatch(new RegExp(`^${state}/hosts/1\\.2\\.3-[0-9a-f]{12}$`));
    expect(fs.readFileSync(hostScript)).toEqual(fs.readFileSync(assets.nativeHost));
    expect(readText(wrapper)).toBe(hostWrapper(path.join(root, "user.sock"), hostScript, process.execPath));
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);
    const manifestFile = path.join(manifests, "com.opzero.chrome.json");
    expect(JSON.parse(readText(manifestFile))).toEqual({
      name: "com.opzero.chrome", description: "Browser Control native messaging host", path: wrapper, type: "stdio",
      allowed_origins: [`chrome-extension://${STORE_EXTENSION_ID}/`, `chrome-extension://${ISOLATED_EXTENSION_ID}/`]
    });
    expect(ISOLATED_EXTENSION_ID).toBe("mpodnojmjjafgogldgieimgbmfhhknbe");
    // Chrome launches only the stable copies under the state root, never files inside the package.
    for (const file of [manifestFile, wrapper]) expect(readText(file).includes(assets.root)).toBe(false);

    const guard = clipboardGuardBinary({ ...env, BROWSER_CONTROL_STATE_DIR: state }, assets);
    expect(byId(report.steps)["clipboard-guard"].path).toBe(guard);
    expect(fs.statSync(guard).mode & 0o777).toBe(0o700);

    const link = path.join(skills, "browser-control");
    const target = fs.readlinkSync(link);
    expect(target).toMatch(new RegExp(`^${state}/skills/browser-control/1\\.2\\.3-[0-9a-f]{12}$`));
    expect(readText(path.join(link, "SKILL.md"))).toBe(readText(path.join(assets.root, "skills/browser-control/SKILL.md")));
    expect(readText(path.join(link, "references/setup.md"))).toBe("# Setup\n");

    expect(fs.readdirSync(env.HOME as string)).toEqual([]);
    expect(fs.statSync(state).mode & 0o777).toBe(0o700);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { root, env, assets, flags } = setup();
    const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });
    await install(options(flags), env, deps);
    const before = snapshotTree(root);
    const again = await install(options(flags), env, deps);
    expect(statuses(again.steps)).toEqual({
      node: "found", state: "unchanged", host: "unchanged", wrapper: "unchanged", manifest: "unchanged", extension: "profile-missing",
      "cua-driver": "found", "chrome-for-testing": "found", "clipboard-guard": "unchanged", "skill:browser-control": "unchanged"
    });
    expect(deps.builds).toBe(1);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("moves the wrapper and skill to a new package version while the manifest stays", async () => {
    const { root, env, flags, state, manifests } = setup();
    const first = fakePackage(path.join(root, "v1"), "1.2.3");
    const firstReport = await install(options(flags), env, fakeDeps(first, { app: fakeChromeForTesting(root) }));
    const manifest = readText(path.join(manifests, "com.opzero.chrome.json"));
    const second = fakePackage(path.join(root, "v2"), "1.3.0");
    const report = await install(options(flags), env, fakeDeps(second, { app: fakeChromeForTesting(root) }));
    expect(statuses(report.steps)).toMatchObject({ host: "created", wrapper: "updated", manifest: "unchanged", "skill:browser-control": "updated" });
    expect(readText(path.join(manifests, "com.opzero.chrome.json"))).toBe(manifest);
    expect(readText(path.join(state, "hosts/user/browser-control-host")).includes(`${state}/hosts/1.3.0-`)).toBe(true);
    // The previous copy stays for a Chrome that still runs it.
    expect(fs.existsSync(hostScriptOf(firstReport))).toBe(true);
    expect(fs.readlinkSync(path.join(root, "skills/browser-control"))).toMatch(/\/skills\/browser-control\/1\.3\.0-[0-9a-f]{12}$/);
  });

  it("never overwrites a manifest that points elsewhere without --force, and reports the old path", async () => {
    const { root, env, assets, manifests, flags } = setup();
    const manifestFile = writeFile(path.join(manifests, "com.opzero.chrome.json"),
      JSON.stringify({ name: "com.opzero.chrome", path: "/opt/other/opzero-chrome-host", type: "stdio", allowed_origins: [] }));
    const foreign = readText(manifestFile);
    const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });
    const out = sink();
    expect(await runInstall(flags, { stdout: out, stderr: sink(), env }, deps)).toBe(1);
    expect(out.text).toContain("FAIL manifest: A Chrome native messaging manifest for com.opzero.chrome already points at another host."
      + " Run browser-control install --force to replace it.\n");
    expect(out.text).toContain("     previous: /opt/other/opzero-chrome-host\n");
    expect(readText(manifestFile)).toBe(foreign);

    const report = await install(options([...flags, "--force"]), env, deps);
    expect(byId(report.steps).manifest).toMatchObject({ level: "ok", status: "replaced", previous: "/opt/other/opzero-chrome-host", path: manifestFile });
    expect(JSON.parse(readText(manifestFile)).path).toBe(path.join(root, "state/hosts/user/browser-control-host"));

    writeFile(manifestFile, "{not json");
    const unreadable = await install(options(flags), env, deps);
    expect(byId(unreadable.steps).manifest).toMatchObject({ level: "fail", status: "conflict", previous: null });
    expect(readText(manifestFile)).toBe("{not json");
  });

  it("updates its own outdated manifest without --force", async () => {
    const { root, env, assets, manifests, flags, state } = setup();
    const wrapper = path.join(state, "hosts/user/browser-control-host");
    const manifestFile = writeFile(path.join(manifests, "com.opzero.chrome.json"),
      JSON.stringify({ name: "com.opzero.chrome", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${STORE_EXTENSION_ID}/`] }));
    const report = await install(options(flags), env, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    expect(byId(report.steps).manifest.status).toBe("updated");
    expect(JSON.parse(readText(manifestFile)).allowed_origins).toEqual([`chrome-extension://${STORE_EXTENSION_ID}/`, `chrome-extension://${ISOLATED_EXTENSION_ID}/`]);
  });

  it("writes nothing in a dry run", async () => {
    const { root, env, assets, flags, manifests } = setup();
    const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });
    const before = snapshotTree(root);
    const planned = await install(options([...flags, "--dry-run"]), env, deps);
    expect(statuses(planned.steps)).toEqual({
      node: "found", state: "would-create", host: "would-create", wrapper: "would-create", manifest: "would-create", extension: "profile-missing",
      "cua-driver": "found", "chrome-for-testing": "found", "clipboard-guard": "would-build", "skill:browser-control": "would-create"
    });
    expect(deps.builds).toBe(0);
    expect(snapshotTree(root)).toEqual(before);

    await install(options(flags), env, deps);
    writeFile(path.join(manifests, "com.opzero.chrome.json"), JSON.stringify({ path: "/opt/other" }));
    const installed = snapshotTree(root);
    const again = await install(options([...flags, "--dry-run", "--force"]), env, deps);
    expect(statuses(again.steps)).toMatchObject({ state: "unchanged", host: "unchanged", wrapper: "unchanged", manifest: "would-replace",
      "clipboard-guard": "unchanged", "skill:browser-control": "unchanged" });
    expect(byId(again.steps).manifest.previous).toBe("/opt/other");
    expect(snapshotTree(root)).toEqual(installed);
  });

  it.each([
    ["darwin", "Library/Application Support/Google/Chrome/NativeMessagingHosts"],
    ["linux", ".config/google-chrome/NativeMessagingHosts"]
  ] as const)("defaults to paths under HOME on %s and links skills only into a flagged directory", async (platform, manifestDir) => {
    const { root, env, assets } = setup();
    const home = env.HOME as string;
    const report = await install(options([]), env, fakeDeps(assets, { platform, app: fakeChromeForTesting(root) }));
    const state = path.join(home, ".local/state/browser-control");
    expect(byId(report.steps).state.path).toBe(state);
    expect(byId(report.steps).manifest.path).toBe(path.join(home, manifestDir, "com.opzero.chrome.json"));
    // No agent client's configuration directory is a default target (C4).
    expect(byId(report.steps).skills).toMatchObject({ level: "ok", status: "skipped" });
    expect(report.steps.filter((item) => item.id.startsWith("skill:"))).toEqual([]);
    expect(fs.readdirSync(home).sort()).toEqual(platform === "darwin" ? [".local", "Library"] : [".config", ".local"]);
    expect(fs.readdirSync(state).includes("skills")).toBe(false);
    expect(JSON.parse(readText(path.join(home, manifestDir, "com.opzero.chrome.json"))).path).toBe(path.join(state, "hosts/user/browser-control-host"));
    expect(byId(report.steps)["clipboard-guard"].status).toBe(platform === "darwin" ? "built" : "skipped");
    expect(Object.values(report.snippets).join("")).not.toContain("BROWSER_CONTROL_STATE_DIR");
  });

  it("links skills into several skills directories and handles existing entries", async () => {
    const { root, env, assets } = setup();
    const claude = path.join(root, "home/.claude/skills");
    const agents = path.join(root, "home/.agents/skills");
    const base = ["--state-dir", path.join(root, "state"), "--chrome-manifest-dir", path.join(root, "manifests"), "--skills-dir", claude, "--skills-dir", agents];
    fs.mkdirSync(claude, { recursive: true });
    fs.symlinkSync("/opt/someone-else/browser-control", path.join(claude, "browser-control"));
    fs.mkdirSync(path.join(agents, "browser-control"), { recursive: true });
    writeFile(path.join(agents, "browser-control/SKILL.md"), "mine\n");
    const deps = fakeDeps(assets, { app: fakeChromeForTesting(root) });

    const refused = await install(options(base), env, deps);
    const skillSteps = refused.steps.filter((item) => item.id === "skill:browser-control");
    expect(skillSteps.map((item) => [item.status, item.path, item.previous])).toEqual([
      ["conflict", path.join(claude, "browser-control"), "/opt/someone-else/browser-control"],
      ["conflict-directory", path.join(agents, "browser-control"), undefined]
    ]);
    expect(fs.readlinkSync(path.join(claude, "browser-control"))).toBe("/opt/someone-else/browser-control");

    const forced = await install(options([...base, "--force"]), env, deps);
    expect(forced.steps.filter((item) => item.id === "skill:browser-control").map((item) => item.status)).toEqual(["replaced", "conflict-directory"]);
    expect(fs.readlinkSync(path.join(claude, "browser-control")).startsWith(path.join(root, "state/skills/browser-control/"))).toBe(true);
    // A real directory is never removed, even with --force.
    expect(readText(path.join(agents, "browser-control/SKILL.md"))).toBe("mine\n");
  });

  it("reports a skill the package does not contain", async () => {
    const { root, env, assets, flags } = setup();
    fs.rmSync(path.join(assets.root, "skills"), { recursive: true });
    const report = await install(options(flags), env, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    expect(byId(report.steps)["skill:browser-control"]).toMatchObject({ level: "fail", status: "missing-from-package",
      message: "The package does not contain this skill. Reinstall @op1/browser-control." });
  });

  it("refuses a state directory that is not private and writes no manifest", async () => {
    const { root, env, assets, flags, state, manifests } = setup();
    fs.mkdirSync(state, { mode: 0o755 });
    fs.chmodSync(state, 0o755);
    const report = await install(options(flags), env, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    expect(byId(report.steps).state).toMatchObject({ level: "fail", status: "unsafe", code: "browser-controller-unsafe-registry" });
    expect(report.steps.map((item) => item.id)).toEqual(["node", "state", "extension", "cua-driver", "chrome-for-testing"]);
    expect(fs.existsSync(manifests)).toBe(false);
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it("creates a missing manifest directory with mode 0755 under a group-writable umask, so its lock is accepted", async () => {
    const { root, env, assets, manifests, flags } = setup();
    const previous = process.umask(0o002);
    let report: Awaited<ReturnType<typeof install>>;
    try {
      report = await install(options(flags), env, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    } finally {
      process.umask(previous);
    }
    expect(byId(report.steps).manifest).toMatchObject({ level: "ok", status: "created" });
    expect(fs.statSync(manifests).mode & 0o7777).toBe(0o755);
  });

  it("prints cua-driver's upstream install command when it is missing (C1)", async () => {
    const { root, env, assets, flags } = setup({ CUA_DRIVER: undefined, PATH: "/nonexistent-bin" });
    const report = await install(options(flags), env, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    expect(byId(report.steps)["cua-driver"]).toEqual({
      id: "cua-driver", level: "warn", status: "missing",
      message: "cua-driver is not installed. claim_browser and paste_1password_field need it. Install it with its upstream installer.",
      command: '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"'
    });
    const fallback = writeFile(path.join(env.HOME as string, ".local/bin/cua-driver"), "#!/bin/sh\n", 0o755);
    expect(byId((await install(options(flags), env, fakeDeps(assets))).steps)["cua-driver"]).toMatchObject({ status: "found", path: fallback });
  });

  it("checks that Chrome for Testing can launch by its bundle ID", async () => {
    const { root, env, assets, flags } = setup();
    const missing = byId((await install(options(flags), env, fakeDeps(assets, { app: null }))).steps)["chrome-for-testing"];
    expect(missing).toMatchObject({ level: "warn", status: "missing", command: "npx @puppeteer/browsers install chrome@stable --path ~/Applications/ChromeForTesting" });
    const hollow = path.join(root, "apps/Hollow.app");
    fs.mkdirSync(hollow, { recursive: true });
    expect(byId((await install(options(flags), env, fakeDeps(assets, { app: hollow }))).steps)["chrome-for-testing"])
      .toMatchObject({ level: "warn", status: "broken", path: hollow });
    const linux = fakeDeps(assets, { platform: "linux", app: fakeChromeForTesting(root) });
    expect(byId((await install(options(flags), env, linux)).steps)["chrome-for-testing"]).toMatchObject({ level: "warn", status: "unsupported" });
    expect(linux.located).toEqual([]);
  });

  it("builds the clipboard guard into the state directory with mode 0700 and verifies it", async () => {
    const { root, env, assets, flags } = setup();
    const app = fakeChromeForTesting(root);
    const guardOf = async (overrides: Parameters<typeof fakeDeps>[1]) => {
      const deps = fakeDeps(assets, { app, ...overrides });
      return { deps, guard: byId((await install(options(flags), env, deps)).steps)["clipboard-guard"] };
    };
    const noTools = await guardOf({ xcodeTools: async () => false });
    expect(noTools.guard).toMatchObject({ level: "warn", status: "toolchain-missing", command: "xcode-select --install" });
    expect(noTools.deps.builds).toBe(0);
    expect((await guardOf({ buildClipboardGuard: async () => { throw new ClipboardError("clipboard-unavailable"); } })).guard)
      .toMatchObject({ level: "fail", status: "build-failed", code: "clipboard-unavailable" });
    expect((await guardOf({ guardMode: 0o755 })).guard).toMatchObject({ level: "fail", status: "untrusted" });
    fs.rmSync(path.join(root, "state/bin"), { recursive: true });
    expect((await guardOf({ guardData: Buffer.from("#!/bin/sh\n") })).guard).toMatchObject({ level: "fail", status: "untrusted" });
    fs.rmSync(path.join(root, "state/bin"), { recursive: true });
    const built = await guardOf({});
    expect(built.guard).toMatchObject({ level: "ok", status: "built" });
    expect(fs.readFileSync(built.guard.path as string).subarray(0, MACH_O.length)).toEqual(MACH_O);
    const again = await guardOf({});
    expect(again.guard.status).toBe("unchanged");
    expect(again.deps.builds).toBe(0);
    expect((await guardOf({ platform: "linux" })).guard).toMatchObject({ level: "ok", status: "skipped" });
  });

  it("prints the MCP config snippets for OpenCode, Claude Code and Codex", async () => {
    const { root, env, assets, flags, state } = setup();
    const out = sink();
    await runInstall(flags, { stdout: out, stderr: sink(), env }, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    expect(out.text).toContain("OpenCode (opencode.jsonc):\n");
    expect(out.text).toContain("Claude Code (.mcp.json):\n");
    expect(out.text).toContain("Codex (~/.codex/config.toml; claim_browser can take up to 120 s):\n");
    expect(out.text).toContain(`  BROWSER_CONTROL_STATE_DIR = "${state}"\n`);
    // The socket install wrote into the wrapper goes to the server too (D1).
    const socket = path.join(root, "user.sock");
    expect(readText(path.join(state, "hosts/user/browser-control-host"))).toContain(`export BROWSER_CONTROL_HOST_SOCKET='${socket}'\n`);
    expect(out.text).toContain(`  BROWSER_CONTROL_HOST_SOCKET = "${socket}"\n`);
    const json = sink();
    await runInstall([...flags, "--json"], { stdout: json, stderr: sink(), env }, fakeDeps(assets, { app: fakeChromeForTesting(root) }));
    const snippets = JSON.parse(json.text).snippets;
    expect(Object.keys(snippets)).toHaveLength(3);
    expect(JSON.parse(snippets["OpenCode (opencode.jsonc):"]).mcp["browser-control"].environment).toEqual({ BROWSER_CONTROL_STATE_DIR: state, BROWSER_CONTROL_HOST_SOCKET: socket });
    expect(JSON.parse(snippets["Claude Code (.mcp.json):"]).mcpServers["browser-control"].env).toEqual({ BROWSER_CONTROL_STATE_DIR: state, BROWSER_CONTROL_HOST_SOCKET: socket });
  });

  it("rejects unknown options and resolves relative directories", async () => {
    const err = sink();
    expect(await runInstall(["--bogus"], { stdout: sink(), stderr: err, env: {} })).toBe(2);
    expect(err.text).toContain("browser-control install: unknown option: --bogus\n");
    expect(await runInstall(["--state-dir"], { stdout: sink(), stderr: sink(), env: {} })).toBe(2);
    expect(await runInstall(["--force=yes"], { stdout: sink(), stderr: sink(), env: {} })).toBe(2);
    expect(options(["--state-dir=rel/state", "--skills-dir", "a", "--skills-dir", "b"])).toMatchObject({
      stateDir: path.resolve("rel/state"), skillsDirs: [path.resolve("a"), path.resolve("b")]
    });
  });
});

describe("the MCP config snippets", () => {
  const home = { HOME: "/home/u" };

  it("match the design's snippets for the default state directory", () => {
    expect(mcpSnippet("opencode", home)).toBe(`{
  "mcp": {
    "browser-control": {
      "type": "local",
      "command": ["npx", "-y", "@op1/browser-control", "mcp"],
      "enabled": true
    }
  }
}
`);
    const claude = `{
  "mcpServers": {
    "browser-control": {
      "command": "npx",
      "args": ["-y", "@op1/browser-control", "mcp"]
    }
  }
}
`;
    expect(mcpSnippet("claude", home)).toBe(claude);
    expect(mcpSnippet("cursor", home)).toBe(claude);
    expect(mcpSnippet("codex", home)).toBe(`[mcp_servers.browser-control]
command = "npx"
args = ["-y", "@op1/browser-control", "mcp"]
tool_timeout_sec = 150
`);
    expect(mcpSnippet("opencode", { ...home, BROWSER_CONTROL_STATE_DIR: "/home/u/.local/state/browser-control" })).not.toContain("environment");
  });

  it("pass a non-default state directory in the server environment", async () => {
    const env = { ...home, BROWSER_CONTROL_STATE_DIR: "/srv/bc" };
    expect(JSON.parse(mcpSnippet("opencode", env)).mcp["browser-control"].environment).toEqual({ BROWSER_CONTROL_STATE_DIR: "/srv/bc" });
    expect(JSON.parse(mcpSnippet("claude", env)).mcpServers["browser-control"].env).toEqual({ BROWSER_CONTROL_STATE_DIR: "/srv/bc" });
    expect(mcpSnippet("codex", env)).toContain('\n[mcp_servers.browser-control.env]\nBROWSER_CONTROL_STATE_DIR = "/srv/bc"\n');
    const out = sink();
    expect(await runConfig(["codex", "--state-dir", "/srv/other"], { stdout: out, stderr: sink(), env: home })).toBe(0);
    expect(out.text).toContain('BROWSER_CONTROL_STATE_DIR = "/srv/other"');
    const err = sink();
    expect(await runConfig(["emacs"], { stdout: sink(), stderr: err, env: home })).toBe(2);
    expect(err.text).toContain("unknown client: emacs");
    expect(await runConfig([], { stdout: sink(), stderr: err, env: { ...home, BROWSER_CONTROL_STATE_DIR: "relative" } })).toBe(1);
    expect(err.text).toContain("browser-control config: browser-control-invalid-state-dir\n");
  });

  it("pass a user socket other than the state directory's default", () => {
    const socket = { ...home, BROWSER_CONTROL_HOST_SOCKET: "/run/bc/user.sock" };
    expect(JSON.parse(mcpSnippet("opencode", socket)).mcp["browser-control"].environment).toEqual({ BROWSER_CONTROL_HOST_SOCKET: "/run/bc/user.sock" });
    const both = { ...socket, BROWSER_CONTROL_STATE_DIR: "/srv/bc" };
    expect(JSON.parse(mcpSnippet("cursor", both)).mcpServers["browser-control"].env).toEqual({ BROWSER_CONTROL_STATE_DIR: "/srv/bc", BROWSER_CONTROL_HOST_SOCKET: "/run/bc/user.sock" });
    expect(mcpSnippet("codex", both)).toContain('\n[mcp_servers.browser-control.env]\nBROWSER_CONTROL_STATE_DIR = "/srv/bc"\nBROWSER_CONTROL_HOST_SOCKET = "/run/bc/user.sock"\n');
    // The state directory's own socket is the server's default, so it needs no setting.
    expect(mcpSnippet("opencode", { ...home, BROWSER_CONTROL_STATE_DIR: "/srv/bc", BROWSER_CONTROL_HOST_SOCKET: "/srv/bc/sockets/user.sock" })).not.toContain("HOST_SOCKET");
  });
});

function chromeProfile(userData: string, profile: string, file: "Preferences" | "Secure Preferences", settings: unknown) {
  writeFile(path.join(userData, profile, "Preferences"), JSON.stringify({}));
  const target = path.join(userData, profile, file);
  const existing = fs.existsSync(target) ? JSON.parse(readText(target)) : {};
  writeFile(target, JSON.stringify({ ...existing, extensions: { settings: { [STORE_EXTENSION_ID]: settings } } }));
}

function runScript(env: Record<string, string | undefined>): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repository, "dist/scripts/check-extension-installed.js"), "--extension-id", STORE_EXTENSION_ID, "--json"],
      { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("the extension check (ported from src/scripts/check-extension-installed.ts)", () => {
  it("gives the script's status for the same Chrome profiles", async () => {
    const { root, env } = setup();
    const home = env.HOME as string;
    const userData = path.join(home, "Library/Application Support/Google/Chrome");
    const cases: Array<[string, () => void, string]> = [
      ["no profile", () => undefined, "profile-missing"],
      ["registered in another extension only", () => writeFile(path.join(userData, "Default/Preferences"), JSON.stringify({ extensions: { settings: { other: {} } } })), "not-installed"],
      ["enabled in Secure Preferences", () => chromeProfile(userData, "Default", "Secure Preferences", { state: 1, manifest: { version: "0.2.1" } }), "enabled"],
      ["disabled by reason", () => chromeProfile(userData, "Default", "Secure Preferences", { state: 1, disable_reasons: 1 }), "disabled"],
      ["disabled by state", () => chromeProfile(userData, "Default", "Preferences", { state: 0 }), "disabled"],
      ["the last used profile wins", () => {
        writeFile(path.join(userData, "Local State"), JSON.stringify({ profile: { last_used: "Profile 3" } }));
        chromeProfile(userData, "Profile 3", "Secure Preferences", { disable_reasons: 0 });
      }, "enabled"],
      ["the highest numbered profile before Default", () => {
        fs.rmSync(path.join(userData, "Local State"));
        fs.rmSync(path.join(userData, "Profile 3"), { recursive: true });
        writeFile(path.join(userData, "Profile 2/Preferences"), JSON.stringify({}));
        writeFile(path.join(userData, "Profile 10/Preferences"), JSON.stringify({}));
      }, "not-installed"]
    ];
    for (const [name, arrange, expected] of cases) {
      arrange();
      const ported = checkExtensionInstalled(STORE_EXTENSION_ID, env, "darwin");
      expect(ported.status, name).toBe(expected);
      if (process.platform === "darwin") expect((await runScript(env)).status, `script: ${name}`).toBe(expected);
    }
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, env, "darwin").preferencesPath).toBe(path.join(userData, "Profile 10/Preferences"));
    const custom = writeFile(path.join(root, "custom/Preferences"), JSON.stringify({ extensions: { settings: { [STORE_EXTENSION_ID]: { state: 1 } } } }));
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, { ...env, BROWSER_CONTROL_PREFERENCES_PATH: custom }, "darwin")).toMatchObject({ status: "enabled", preferencesPath: custom });
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, { ...env, BROWSER_CONTROL_USER_DATA_DIR: userData }, "linux"))
      .toMatchObject({ status: "not-installed", preferencesPath: path.join(userData, "Profile 10/Preferences") });
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, { ...env, OPZERO_CHROME_PREFERENCES_PATH: custom, OPZERO_CHROME_USER_DATA_DIR: userData }, "linux").status)
      .toBe("profile-missing");
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, { ...env, CHROME_PROFILE_DIR: path.dirname(custom) }, "linux").status).toBe("enabled");
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, env, "linux").status).toBe("profile-missing");
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, env, "win32").status).toBe("unsupported");
  });

  it("reads Chrome's list form of disable_reasons", () => {
    const { env } = setup();
    const userData = path.join(env.HOME as string, ".config/google-chrome");
    chromeProfile(userData, "Default", "Secure Preferences", { disable_reasons: [] });
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, env, "linux").status).toBe("enabled");
    chromeProfile(userData, "Default", "Secure Preferences", { disable_reasons: [1] });
    expect(checkExtensionInstalled(STORE_EXTENSION_ID, env, "linux").status).toBe("disabled");
  });
});
