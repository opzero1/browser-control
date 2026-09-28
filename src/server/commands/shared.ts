// Shared pieces of `browser-control install`, `doctor` and `config`: options, default locations, step reports
// and the read-only checks both commands run. Paths, stable copies and trust rules come from the server's own
// modules, so the commands check exactly what the server and the pool use.
import fs from "node:fs";
import path from "node:path";
import type { PackageAssets } from "../assets";
import {
  HOST_WRAPPER_NAME, homeDirectory, NATIVE_HOST_NAME, nodeExecutable, PACKAGE_NAME, statePaths, STORE_EXTENSION_ID, userSocket, whichExecutable,
  type Env
} from "../config";
import { isGate } from "../gate";
import { runProcess } from "../pool/cua-cli";
import { ISOLATED_EXTENSION_ORIGIN, MANIFEST } from "../pool/provision";
import { guardianTrusted } from "../private/clipboard-guard";
import { hostWrapper, treeDigest } from "../stable-copy";

export type Level = "ok" | "warn" | "fail";

/** One reported step. `message` is a fixed sentence per (id, status); paths and codes travel beside it. */
export interface Step {
  id: string;
  level: Level;
  status: string;
  message: string;
  path?: string;
  previous?: string | null;
  command?: string;
  code?: string;
}

export interface CommandIo { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; env: Env }

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Options {
  stateDir: string | null;
  chromeManifestDir: string | null;
  skillsDirs: string[];
  dryRun: boolean;
  force: boolean;
  json: boolean;
  smoke: boolean;
  positional: string[];
}

const VALUE_FLAGS = { "--state-dir": "stateDir", "--chrome-manifest-dir": "chromeManifestDir", "--skills-dir": "skillsDirs" } as const;
const BOOLEAN_FLAGS = { "--dry-run": "dryRun", "--force": "force", "--json": "json", "--smoke": "smoke" } as const;

/** Parse `argv` accepting only `allowed` flags; `--flag value` and `--flag=value` both work. */
export function parseOptions(argv: readonly string[], allowed: readonly string[], positional = 0): Options {
  const options: Options = { stateDir: null, chromeManifestDir: null, skillsDirs: [], dryRun: false, force: false, json: false, smoke: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      if (options.positional.length >= positional) throw new UsageError(`unexpected argument: ${argument}`);
      options.positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!allowed.includes(flag)) throw new UsageError(`unknown option: ${flag}`);
    if (flag in BOOLEAN_FLAGS) {
      if (equals >= 0) throw new UsageError(`${flag} takes no value`);
      options[BOOLEAN_FLAGS[flag as keyof typeof BOOLEAN_FLAGS]] = true;
      continue;
    }
    let value: string | undefined;
    if (equals >= 0) value = argument.slice(equals + 1);
    else value = argv[++index];
    if (!value) throw new UsageError(`${flag} needs a directory`);
    const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS];
    if (key === "skillsDirs") options.skillsDirs.push(path.resolve(value));
    else options[key] = path.resolve(value);
  }
  return options;
}

/** The environment the commands use: --state-dir becomes BROWSER_CONTROL_STATE_DIR. */
export function commandEnv(env: Env, options: Options): Env {
  return options.stateDir ? { ...env, BROWSER_CONTROL_STATE_DIR: options.stateDir } : env;
}

/** The user Chrome's manifest has the same file name as each isolated profile's. */
export const MANIFEST_FILE = MANIFEST;
export const MANIFEST_DESCRIPTION = "Browser Control native messaging host";
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}`;
export const CUA_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"';
export const CHROME_FOR_TESTING_EXECUTABLE = "Contents/MacOS/Google Chrome for Testing";
export const CHROME_FOR_TESTING_INSTALL_COMMAND = "npx @puppeteer/browsers install chrome@stable --path ~/Applications/ChromeForTesting";
export const XCODE_TOOLS_COMMAND = "xcode-select --install";

/** The user-level Chrome directory for native messaging manifests; null where only a flag can name one. */
export function chromeManifestDirectory(env: Env, platform: NodeJS.Platform, options: Options): string | null {
  if (options.chromeManifestDir) return options.chromeManifestDir;
  const home = homeDirectory(env);
  if (platform === "darwin") return path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts");
  if (platform === "linux") return path.join(home, ".config/google-chrome/NativeMessagingHosts");
  return null;
}

/**
 * The skills directories named with --skills-dir. There is no default: agent clients keep skills in different
 * places, and install writes into a client's configuration only where the user points it.
 */
export function skillsDirectories(options: Options): string[] {
  return [...new Set(options.skillsDirs)];
}

/** The user route's wrapper, which the user Chrome manifest names. It stays put across upgrades. */
export function userWrapperPath(env: Env): string {
  return path.join(statePaths(env).hosts, "user", HOST_WRAPPER_NAME);
}

/** The Web Store extension and the isolated profiles' copy (Q1). */
export function allowedOrigins(): string[] {
  return [`chrome-extension://${STORE_EXTENSION_ID}/`, ISOLATED_EXTENSION_ORIGIN];
}

export function manifestText(wrapper: string): string {
  const manifest = { name: NATIVE_HOST_NAME, description: MANIFEST_DESCRIPTION, path: wrapper, type: "stdio", allowed_origins: allowedOrigins() };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function expectedWrapper(env: Env, hostScript: string, node: string): string {
  return hostWrapper(userSocket(env), hostScript, node);
}

/** A file's bytes when it is a regular file of at most `limit` bytes; null when missing or anything else. */
export function readRegular(file: string, limit = 65536): Buffer | null {
  try {
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.size > limit) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export type ManifestState =
  | { kind: "absent" }
  | { kind: "current" }
  | { kind: "outdated" }
  | { kind: "foreign"; previous: string | null };

/** Classify the existing user manifest against the one install writes. */
export function manifestState(file: string, wrapper: string): ManifestState {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "foreign", previous: null };
  }
  const data = stats.isFile() ? readRegular(file) : null;
  if (!data) return { kind: "foreign", previous: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    return { kind: "foreign", previous: null };
  }
  const previous = parsed && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string"
    ? (parsed as { path: string }).path : null;
  if (previous !== wrapper) return { kind: "foreign", previous };
  return data.toString("utf8") === manifestText(wrapper) ? { kind: "current" } : { kind: "outdated" };
}

/** Skills the package ships: every `skills/<name>/` entry of package.json `files`. */
export function bundledSkills(assets: PackageAssets): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(assets.root, "package.json"), "utf8")) as { files?: unknown };
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  return files.flatMap((entry) => {
    const match = typeof entry === "string" ? /^skills\/([A-Za-z0-9._-]+)\/?$/.exec(entry) : null;
    return match && match[1] !== "." && match[1] !== ".." ? [match[1]] : [];
  });
}

/** The skill's files (relative path -> bytes), or null when the package lacks its SKILL.md. */
export function skillFiles(assets: PackageAssets, name: string): Map<string, Buffer> | null {
  const root = path.join(assets.root, "skills", name);
  if (!readRegular(path.join(root, "SKILL.md"), 16 * 1024 * 1024)) return null;
  const files = new Map<string, Buffer>();
  const walk = (prefix: string) => {
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.set(relative, fs.readFileSync(path.join(root, relative)));
    }
  };
  walk("");
  return files;
}

/** <state>/skills/<name>/<version>-<sha12>: the stable copy a skills directory links to. */
export function stableSkillDir(env: Env, assets: PackageAssets, name: string, files: ReadonlyMap<string, Uint8Array>): string {
  return path.join(statePaths(env).root, "skills", name, `${assets.version}-${treeDigest(files).slice(0, 12)}`);
}

export function readLink(file: string): string | null {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

/** The trust rule the private transfer applies before it runs the guard, plus the mode 0700 install sets and Mach-O. */
export function trustedGuard(file: string): boolean {
  if (!guardianTrusted(file)) return false;
  try {
    if ((fs.lstatSync(file).mode & 0o777) !== 0o700) return false;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(4);
      if (fs.readSync(fd, magic, 0, 4, 0) !== 4) return false;
      const value = magic.readUInt32BE(0);
      return [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xbebafeca].includes(value);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** A read-only probe: exit status 0 and its stdout, or not ok on any failure or timeout (SIGKILL). */
export async function run(file: string, args: readonly string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await runProcess(file, args, timeoutMs);
    return { ok: result.status === 0, stdout: result.stdout.toString("utf8") };
  } catch {
    return { ok: false, stdout: "" };
  }
}

const LAUNCH_SERVICES_SCRIPT = 'function run(argv) { ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]); return u.isNil() ? "" : u.path.js }';

/**
 * The app LaunchServices opens for `bundleId`, the lookup cua-driver's launch_app relies on. Read-only: it asks
 * NSWorkspace for the URL and never launches anything.
 */
export async function launchServicesApp(bundleId: string): Promise<string | null> {
  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", LAUNCH_SERVICES_SCRIPT, bundleId], 10000);
  const found = result.stdout.trim();
  return result.ok && path.isAbsolute(found) ? found : null;
}

/** The Xcode command line tools are selected; `xcode-select -p` never prompts, unlike the xcrun shims. */
export async function xcodeToolsSelected(env: Env): Promise<boolean> {
  const select = whichExecutable("xcode-select", env);
  if (!select || !whichExecutable("xcrun", env)) return false;
  return (await run(select, ["-p"], 10000)).ok;
}

export function step(id: string, level: Level, status: string, message: string, extra: Omit<Step, "id" | "level" | "status" | "message"> = {}): Step {
  return { id, level, status, message, ...extra };
}

export const MINIMUM_NODE_MAJOR = 24;

/** Node 24 or newer, as an absolute executable: generated wrappers exec this exact Node (C2). */
export function nodeStep(version = process.versions.node): Step {
  if (Number(version.split(".")[0]) < MINIMUM_NODE_MAJOR) {
    return step("node", "fail", "too-old", "Node.js 24 or newer is required. Run browser-control with a current Node.js.", { path: process.execPath });
  }
  try {
    return step("node", "ok", "found", "Node.js can run the server and the native host.", { path: nodeExecutable() });
  } catch (error) {
    return step("node", "fail", "unavailable", "The running Node.js is not an absolute executable file. Run browser-control with an installed Node.js.",
      { code: gateCode(error) });
  }
}

export function gateCode(error: unknown): string {
  if (isGate(error)) return error.code;
  const code = (error as { code?: unknown; errno?: unknown } | null)?.code ?? (error as { errno?: unknown } | null)?.errno;
  return typeof code === "string" ? code : "unexpected-error";
}

const MARK: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatSteps(steps: readonly Step[]): string {
  return steps.map((item) => {
    const lines = [`${MARK[item.level]} ${item.id}: ${item.message}`];
    if (item.path) lines.push(`     path: ${item.path}`);
    if (item.previous !== undefined) lines.push(`     previous: ${item.previous ?? "(unreadable)"}`);
    if (item.code) lines.push(`     code: ${item.code}`);
    if (item.command) lines.push(`     run: ${item.command}`);
    return lines.join("\n");
  }).join("\n");
}

export function failed(steps: readonly Step[]): boolean {
  return steps.some((item) => item.level === "fail");
}

export const PACKAGE_COMMAND = ["npx", "-y", PACKAGE_NAME, "mcp"] as const;
