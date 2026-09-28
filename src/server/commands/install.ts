// `browser-control install`: idempotent setup of the stable native host, its user wrapper and Chrome manifest,
// the clipboard guard and the bundled skills, plus read-only checks of what the user installs separately.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireInstallLock, InstallLockBusy, manifestLockPath, type InstallLock } from "../../shared/install-lock";
import { packageAssets, type PackageAssets } from "../assets";
import { HOST_WRAPPER_NAME, nodeExecutable, resolveCuaDriver, statePaths, STORE_EXTENSION_ID, type Env } from "../config";
import { childDirectory, existingDirectory, openDirectory, writePrivate } from "../fs-private";
import { BUNDLE } from "../pool/start";
import { buildClipboardGuard } from "../private/clipboard-guard";
import { clipboardGuardBinary, ensureStableHost, publishTree, stableHostPlan, treeMatches } from "../stable-copy";
import { mcpSnippets } from "./config";
import { checkExtensionInstalled } from "./extension";
import {
  bundledSkills, CHROME_FOR_TESTING_EXECUTABLE, CHROME_FOR_TESTING_INSTALL_COMMAND, chromeManifestDirectory, commandEnv, CUA_INSTALL_COMMAND,
  exists, expectedWrapper, failed, formatSteps, gateCode, launchServicesApp, MANIFEST_FILE, manifestState, manifestText, nodeStep, parseOptions,
  readLink, readRegular, skillFiles, skillsDirectories, stableSkillDir, step, STORE_URL, trustedGuard, UsageError, userWrapperPath,
  XCODE_TOOLS_COMMAND, xcodeToolsSelected, type CommandIo, type ManifestState, type Options, type Step
} from "./shared";

export interface CommandDeps {
  assets: PackageAssets;
  platform: NodeJS.Platform;
  /** The app path LaunchServices resolves for a bundle ID, or null. */
  locateApp: (bundleId: string) => Promise<string | null>;
  /** Whether xcrun swiftc can run without prompting to install the command line tools. */
  xcodeTools: (env: Env) => Promise<boolean>;
  buildClipboardGuard: (env: Env, assets: PackageAssets) => Promise<{ path: string; built: boolean }>;
}

export function defaultDeps(): CommandDeps {
  return { assets: packageAssets(), platform: process.platform, locateApp: launchServicesApp, xcodeTools: xcodeToolsSelected, buildClipboardGuard };
}

export const INSTALL_FLAGS = ["--state-dir", "--chrome-manifest-dir", "--skills-dir", "--dry-run", "--force", "--json"] as const;

function stateStep(env: Env, dryRun: boolean): Step {
  const root = statePaths(env).root;
  try {
    const created = !exists(root);
    if (dryRun && created) return step("state", "ok", "would-create", "Would create the private state directory.", { path: root });
    if (dryRun) existingDirectory(root);
    else openDirectory(root);
    return created
      ? step("state", "ok", "created", "Created the private state directory.", { path: root })
      : step("state", "ok", "unchanged", "The state directory is private.", { path: root });
  } catch (error) {
    return step("state", "fail", "unsafe",
      "The state directory must be a real directory owned by you with mode 0700. Fix it or pass another --state-dir.", { path: root, code: gateCode(error) });
  }
}

async function hostSteps(env: Env, assets: PackageAssets, dryRun: boolean): Promise<Step[]> {
  const node = nodeExecutable();
  const planned = stableHostPlan(env, assets);
  const hostCurrent = readRegular(planned.hostScript, planned.data.length)?.equals(planned.data) ?? false;
  let hostScript = planned.hostScript;
  const steps: Step[] = [];
  if (hostCurrent) {
    steps.push(step("host", "ok", "unchanged", "The native host copy is current.", { path: hostScript }));
    // ensureStableHost also re-verifies the copy it keeps.
    if (!dryRun) hostScript = (await ensureStableHost(env, assets)).hostScript;
  } else if (dryRun) {
    steps.push(step("host", "ok", "would-create", "Would copy the native host into the state directory.", { path: hostScript }));
  } else {
    hostScript = (await ensureStableHost(env, assets)).hostScript;
    steps.push(step("host", "ok", "created", "Copied the native host into the state directory.", { path: hostScript }));
  }

  const wrapper = userWrapperPath(env);
  const text = Buffer.from(expectedWrapper(env, hostScript, node));
  const current = readRegular(wrapper);
  if (current?.equals(text) && (fs.lstatSync(wrapper).mode & 0o777) === 0o700) {
    steps.push(step("wrapper", "ok", "unchanged", "The native host wrapper is current.", { path: wrapper }));
  } else if (dryRun) {
    steps.push(current
      ? step("wrapper", "ok", "would-update", "Would update the native host wrapper for this version.", { path: wrapper })
      : step("wrapper", "ok", "would-create", "Would write the native host wrapper.", { path: wrapper }));
  } else {
    writePrivate(childDirectory(openDirectory(statePaths(env).hosts), "user"), HOST_WRAPPER_NAME, text, 0o700, ".write-");
    steps.push(current
      ? step("wrapper", "ok", "updated", "Updated the native host wrapper for this version.", { path: wrapper })
      : step("wrapper", "ok", "created", "Wrote the native host wrapper.", { path: wrapper }));
  }
  return steps;
}

/** Replace `file` atomically: a temporary file beside it, fsync, rename. A symlink at `file` is replaced, not followed. */
function writeManifest(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${MANIFEST_FILE}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try {
    try {
      fs.fchmodSync(fd, 0o644);
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The step for a manifest that needs no write: unchanged, a refused conflict, or what a dry run would do. */
function manifestPlan(file: string, state: ManifestState, options: Options): Step | null {
  if (state.kind === "current") return step("manifest", "ok", "unchanged", "The Chrome native messaging manifest is current.", { path: file });
  if (state.kind === "foreign" && !options.force) {
    return step("manifest", "fail", "conflict",
      "A Chrome native messaging manifest for com.opzero.chrome already points at another host. Run browser-control install --force to replace it.",
      { path: file, previous: state.previous });
  }
  if (!options.dryRun) return null;
  if (state.kind === "absent") return step("manifest", "ok", "would-create", "Would write the Chrome native messaging manifest.", { path: file });
  if (state.kind === "outdated") return step("manifest", "ok", "would-update", "Would update the Chrome native messaging manifest.", { path: file });
  return step("manifest", "ok", "would-replace", "Would replace the Chrome native messaging manifest that points at another host.",
    { path: file, previous: state.previous });
}

async function manifestStep(env: Env, platform: NodeJS.Platform, options: Options): Promise<Step> {
  const directory = chromeManifestDirectory(env, platform, options);
  if (!directory) {
    return step("manifest", "fail", "unsupported",
      "Chrome native messaging manifests are set up only on macOS and Linux. Pass --chrome-manifest-dir to choose a directory.");
  }
  const file = path.join(directory, MANIFEST_FILE);
  const wrapper = userWrapperPath(env);
  const planned = manifestPlan(file, manifestState(file, wrapper), options);
  if (planned) return planned;
  // The release zip's installer takes the same lock, so the manifest is classified again and replaced as one step.
  fs.mkdirSync(directory, { recursive: true });
  let lock: InstallLock;
  try {
    lock = await acquireInstallLock(manifestLockPath(file));
  } catch (error) {
    if (!(error instanceof InstallLockBusy)) throw error;
    return step("manifest", "fail", "locked",
      "Another installer is writing the Chrome native messaging manifest. If no installer is running, remove the lock directory, then run browser-control install again.",
      { path: error.lockPath });
  }
  let state: ManifestState;
  try {
    state = manifestState(file, wrapper);
    const settled = manifestPlan(file, state, options);
    if (settled) return settled;
    writeManifest(file, manifestText(wrapper));
  } finally {
    lock.release();
  }
  if (state.kind === "foreign") {
    return step("manifest", "ok", "replaced", "Replaced the Chrome native messaging manifest that pointed at another host.",
      { path: file, previous: state.previous });
  }
  if (state.kind === "outdated") return step("manifest", "ok", "updated", "Updated the Chrome native messaging manifest.", { path: file });
  return step("manifest", "ok", "created", "Wrote the Chrome native messaging manifest.", { path: file });
}

/** Install reports a missing extension as a warning (the user installs it from the store); doctor fails on it. */
export function extensionStep(env: Env, platform: NodeJS.Platform, missing: "warn" | "fail" = "warn"): Step {
  const found = checkExtensionInstalled(STORE_EXTENSION_ID, env, platform);
  const where = found.preferencesPath ?? undefined;
  switch (found.status) {
    case "enabled":
      return step("extension", "ok", "enabled", "The Browser Control extension is installed and enabled in Chrome.", { path: where });
    case "disabled":
      return step("extension", missing, "disabled", "The Browser Control extension is installed but disabled. Enable it in chrome://extensions.", { path: where });
    case "not-installed":
      return step("extension", missing, "not-installed", "The Browser Control extension is not installed in Chrome. Install it from the Chrome Web Store.",
        { path: where, command: STORE_URL });
    case "profile-missing":
      return step("extension", missing, "profile-missing", "No Chrome profile was found. Open Chrome once, then install Browser Control from the Chrome Web Store.",
        { path: where, command: STORE_URL });
    default:
      return step("extension", "warn", "unsupported", "The extension check supports Chrome on macOS and Linux only.");
  }
}

export function cuaStep(env: Env): Step {
  const cua = resolveCuaDriver(env);
  if (cua) return step("cua-driver", "ok", "found", "cua-driver is installed.", { path: cua });
  return step("cua-driver", "warn", "missing",
    "cua-driver is not installed. claim_browser and paste_1password_field need it. Install it with its upstream installer.", { command: CUA_INSTALL_COMMAND });
}

export async function chromeForTestingStep(deps: CommandDeps): Promise<Step> {
  if (deps.platform !== "darwin") {
    return step("chrome-for-testing", "warn", "unsupported", "Isolated browsers need macOS; claim_browser is unavailable on this platform.");
  }
  const app = await deps.locateApp(BUNDLE);
  if (!app) {
    return step("chrome-for-testing", "warn", "missing",
      "Chrome for Testing is not registered with macOS. claim_browser needs it. Install it, then open it once so macOS registers com.google.chrome.for.testing.",
      { command: CHROME_FOR_TESTING_INSTALL_COMMAND });
  }
  try {
    const executable = path.join(app, CHROME_FOR_TESTING_EXECUTABLE);
    if (!fs.statSync(executable).isFile()) throw new Error("not a file");
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    return step("chrome-for-testing", "warn", "broken", "The registered Chrome for Testing app has no executable. Reinstall Chrome for Testing.",
      { path: app, command: CHROME_FOR_TESTING_INSTALL_COMMAND });
  }
  return step("chrome-for-testing", "ok", "found", "Chrome for Testing can be launched by its bundle ID.", { path: app });
}

async function clipboardStep(env: Env, deps: CommandDeps, dryRun: boolean): Promise<Step> {
  if (deps.platform !== "darwin") return step("clipboard-guard", "ok", "skipped", "The clipboard guard is used only on macOS.");
  const binary = clipboardGuardBinary(env, deps.assets);
  if (trustedGuard(binary)) return step("clipboard-guard", "ok", "unchanged", "The clipboard guard is built and trusted.", { path: binary });
  if (!(await deps.xcodeTools(env))) {
    return step("clipboard-guard", "warn", "toolchain-missing",
      "The clipboard guard needs the Xcode Command Line Tools. Install them, then run browser-control install again. paste_1password_field is unavailable until then.",
      { command: XCODE_TOOLS_COMMAND });
  }
  if (dryRun) return step("clipboard-guard", "ok", "would-build", "Would build the clipboard guard with xcrun swiftc.", { path: binary });
  let built: { path: string; built: boolean };
  try {
    built = await deps.buildClipboardGuard(env, deps.assets);
  } catch (error) {
    return step("clipboard-guard", "fail", "build-failed", "Could not build the clipboard guard with xcrun swiftc. paste_1password_field is unavailable.",
      { path: binary, code: gateCode(error) });
  }
  if (built.path !== binary || !trustedGuard(binary)) {
    return step("clipboard-guard", "fail", "untrusted",
      "The clipboard guard failed verification: it must be a Mach-O file owned by you with mode 0700. Run browser-control install again.", { path: binary });
  }
  return step("clipboard-guard", "ok", "built", "Built and verified the clipboard guard.", { path: binary });
}

/** Point `link` at `target` atomically: a temporary symlink beside it, then rename over the old entry. */
function linkSkill(link: string, target: string) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const temporary = path.join(path.dirname(link), `.${path.basename(link)}.${randomUUID()}.tmp`);
  fs.symlinkSync(target, temporary);
  try {
    fs.renameSync(temporary, link);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function lstat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * Link each bundled skill into each --skills-dir. Links point at a stable copy under the state root, never
 * into the npx cache. An older version's link is ours to move; anything else needs --force, and a real
 * directory is never removed. Without --skills-dir nothing is linked.
 */
async function skillSteps(env: Env, assets: PackageAssets, options: Options): Promise<Step[]> {
  const directories = skillsDirectories(options);
  if (!directories.length) {
    return [step("skills", "ok", "skipped", "No skills directory was given, so no skill was linked. Pass --skills-dir <dir> to link the bundled skills.")];
  }
  const steps: Step[] = [];
  for (const name of bundledSkills(assets)) {
    const id = `skill:${name}`;
    const files = skillFiles(assets, name);
    if (!files) {
      steps.push(step(id, "fail", "missing-from-package", "The package does not contain this skill. Reinstall @op1/browser-control."));
      continue;
    }
    const target = stableSkillDir(env, assets, name, files);
    const copyCurrent = treeMatches(target, files);
    for (const directory of directories) {
      const link = path.join(directory, name);
      const stats = lstat(link);
      const previous = stats?.isSymbolicLink() ? readLink(link) : null;
      const ours = previous !== null && path.dirname(previous) === path.dirname(target);
      if (previous === target && copyCurrent) {
        steps.push(step(id, "ok", "unchanged", "The skill link is current.", { path: link }));
        continue;
      }
      if (stats?.isDirectory()) {
        steps.push(step(id, "fail", "conflict-directory",
          "A directory with this skill's name already exists here. Move it away, then run browser-control install again.", { path: link }));
        continue;
      }
      if (stats && !ours && !options.force) {
        steps.push(step(id, "fail", "conflict",
          "Another skill with this name is installed here. Run browser-control install --force to replace the link.", { path: link, previous }));
        continue;
      }
      if (options.dryRun) {
        if (!stats) steps.push(step(id, "ok", "would-create", "Would link the skill.", { path: link }));
        else if (ours) steps.push(step(id, "ok", "would-update", "Would link the skill to this version.", { path: link }));
        else steps.push(step(id, "ok", "would-replace", "Would replace the link to another skill with this name.", { path: link, previous }));
        continue;
      }
      await publishTree(openDirectory(path.dirname(target)), path.basename(target), files);
      if (previous !== target) linkSkill(link, target);
      if (!stats) steps.push(step(id, "ok", "linked", "Linked the skill.", { path: link }));
      else if (ours) steps.push(step(id, "ok", "updated", "Linked the skill to this version.", { path: link }));
      else steps.push(step(id, "ok", "replaced", "Replaced the link to another skill with this name.", { path: link, previous }));
    }
  }
  return steps;
}

async function guarded(id: string, body: () => Promise<Step[]> | Step[]): Promise<Step[]> {
  try {
    return await body();
  } catch (error) {
    return [step(id, "fail", "error", "This step failed. Fix the reported code, then run browser-control install again.", { code: gateCode(error) })];
  }
}

export interface InstallReport { command: "install"; version: string; dryRun: boolean; ok: boolean; steps: Step[]; snippets: Record<string, string> }

export async function install(options: Options, env: Env, deps: CommandDeps = defaultDeps()): Promise<InstallReport> {
  const scoped = commandEnv(env, options);
  const steps: Step[] = [nodeStep()];
  const state = await guarded("state", () => [stateStep(scoped, options.dryRun)]);
  const ready = !failed(steps) && !failed(state);
  steps.push(...state);
  if (ready) {
    const host = await guarded("host", () => hostSteps(scoped, deps.assets, options.dryRun));
    steps.push(...host);
    // A manifest never names a wrapper that was not written.
    if (!failed(host)) steps.push(...await guarded("manifest", async () => [await manifestStep(scoped, deps.platform, options)]));
  }
  steps.push(...await guarded("extension", () => [extensionStep(scoped, deps.platform)]));
  steps.push(...await guarded("cua-driver", () => [cuaStep(scoped)]));
  steps.push(...await guarded("chrome-for-testing", async () => [await chromeForTestingStep(deps)]));
  if (ready) {
    steps.push(...await guarded("clipboard-guard", async () => [await clipboardStep(scoped, deps, options.dryRun)]));
    steps.push(...await guarded("skills", () => skillSteps(scoped, deps.assets, options)));
  }
  const snippets = ready ? mcpSnippets(scoped) : {};
  return { command: "install", version: deps.assets.version, dryRun: options.dryRun, ok: !failed(steps), steps, snippets };
}

export async function runInstall(argv: readonly string[], io: CommandIo, deps?: CommandDeps): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv, INSTALL_FLAGS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`browser-control install: ${error.message}\n`
      + "usage: browser-control install [--state-dir <dir>] [--chrome-manifest-dir <dir>] [--skills-dir <dir>]... [--dry-run] [--force] [--json]\n");
    return 2;
  }
  const report = await install(options, io.env, deps ?? defaultDeps());
  if (options.json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(`Browser Control ${report.version}: install${report.dryRun ? " (dry run, nothing written)" : ""}\n${formatSteps(report.steps)}\n\n`);
    io.stdout.write("Add the MCP server to your client:\n\n");
    for (const [client, text] of Object.entries(report.snippets)) io.stdout.write(`${client}\n${text}\n`);
  }
  return report.ok ? 0 : 1;
}
