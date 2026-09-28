// `browser-control doctor`: read-only checks of everything install sets up, each with a fixed, actionable
// message. `--smoke` adds one isolated end-to-end run (smoke.ts) that never reaches the user's Chrome.
import fs from "node:fs";
import path from "node:path";
import type { PackageAssets } from "../assets";
import { HOST_SOCKET_ENV, nodeExecutable, statePaths, userSocket, whichExecutable, type Env } from "../config";
import { existingDirectory } from "../fs-private";
import { isGate } from "../gate";
import { Connection, type Connect } from "../host-connection";
import { clipboardGuardBinary, stableHostPlan, treeMatches } from "../stable-copy";
import { chromeForTestingStep, cuaStep, defaultDeps, extensionStep, type CommandDeps } from "./install";
import {
  bundledSkills, chromeManifestDirectory, commandEnv, exists, expectedWrapper, failed, formatSteps, gateCode, MANIFEST_FILE, manifestState,
  nodeStep, parseOptions, readLink, readRegular, skillFiles, skillsDirectories, stableSkillDir, step, trustedGuard, UsageError,
  userWrapperPath, type CommandIo, type Options, type Step
} from "./shared";
import { defaultSmokeDeps, smoke, type SmokeDeps } from "./smoke";

export interface DoctorDeps extends CommandDeps {
  connect: Connect;
  smoke: SmokeDeps;
}

export function defaultDoctorDeps(): DoctorDeps {
  return { ...defaultDeps(), connect: (socket, timeout) => Connection.open(socket, timeout), smoke: defaultSmokeDeps() };
}

export const DOCTOR_FLAGS = ["--state-dir", "--chrome-manifest-dir", "--skills-dir", "--json", "--smoke"] as const;
const INSTALL_HINT = "browser-control install";

function stateStep(env: Env): Step {
  const root = statePaths(env).root;
  try {
    if (!existingDirectory(root)) return step("state", "fail", "missing", "The state directory does not exist. Run browser-control install.", { path: root, command: INSTALL_HINT });
    return step("state", "ok", "private", "The state directory is private.", { path: root });
  } catch (error) {
    return step("state", "fail", "unsafe",
      "The state directory must be a real directory owned by you with mode 0700. Fix it or pass another --state-dir.", { path: root, code: gateCode(error) });
  }
}

function hostStep(env: Env, assets: PackageAssets): { step: Step; hostScript: string } {
  const { hostScript, data } = stableHostPlan(env, assets);
  const current = readRegular(hostScript, 256 * 1024 * 1024);
  if (!current) {
    return { hostScript, step: step("host", "fail", "missing", "The native host copy for this version is missing. Run browser-control install.",
      { path: hostScript, command: INSTALL_HINT }) };
  }
  if (!current.equals(data) || (fs.lstatSync(hostScript).mode & 0o077) !== 0) {
    return { hostScript, step: step("host", "fail", "changed", "The native host copy does not match this package. Run browser-control install.",
      { path: hostScript, command: INSTALL_HINT }) };
  }
  return { hostScript, step: step("host", "ok", "current", "The native host copy matches this package.", { path: hostScript }) };
}

/** The socket that a wrapper written by install exports, or null for any other file. */
function wrapperSocket(text: string): string | null {
  const match = new RegExp(`^#!/bin/sh\nexport ${HOST_SOCKET_ENV}='([^'\x00-\x1f\x7f]*)'\n`).exec(text);
  return match ? match[1] : null;
}

function wrapperStep(env: Env, hostScript: string): Step {
  const wrapper = userWrapperPath(env);
  const current = readRegular(wrapper);
  if (!current) return step("wrapper", "fail", "missing", "The native host wrapper is missing. Run browser-control install.", { path: wrapper, command: INSTALL_HINT });
  const node = nodeExecutable();
  const modeOk = (fs.lstatSync(wrapper).mode & 0o777) === 0o700;
  if (current.equals(Buffer.from(expectedWrapper(env, hostScript, node))) && modeOk) {
    return step("wrapper", "ok", "current", "The native host wrapper runs this version's host with this Node.js.", { path: wrapper });
  }
  // Right host and Node, but the socket install was given differs from the one this server connects to.
  const socket = wrapperSocket(current.toString("utf8"));
  if (modeOk && socket !== null && socket !== userSocket(env) && current.equals(Buffer.from(expectedWrapper({ ...env, [HOST_SOCKET_ENV]: socket }, hostScript, node)))) {
    return step("wrapper", "fail", "socket-mismatch",
      "The native host wrapper listens on another socket than this server connects to. Run browser-control install with the server's BROWSER_CONTROL_STATE_DIR and BROWSER_CONTROL_HOST_SOCKET.",
      { path: wrapper, previous: socket, command: INSTALL_HINT });
  }
  return step("wrapper", "fail", "stale", "The native host wrapper does not run this version's host with this Node.js. Run browser-control install.",
    { path: wrapper, command: INSTALL_HINT });
}

function manifestStep(env: Env, platform: NodeJS.Platform, options: Options): Step {
  const directory = chromeManifestDirectory(env, platform, options);
  if (!directory) {
    return step("manifest", "fail", "unsupported",
      "Chrome native messaging manifests are set up only on macOS and Linux. Pass --chrome-manifest-dir to choose a directory.");
  }
  const file = path.join(directory, MANIFEST_FILE);
  const state = manifestState(file, userWrapperPath(env));
  switch (state.kind) {
    case "current":
      return step("manifest", "ok", "current", "The Chrome native messaging manifest names the wrapper and both extension IDs.", { path: file });
    case "absent":
      return step("manifest", "fail", "missing", "The Chrome native messaging manifest is missing. Run browser-control install.", { path: file, command: INSTALL_HINT });
    case "outdated":
      return step("manifest", "fail", "outdated", "The Chrome native messaging manifest is outdated. Run browser-control install.", { path: file, command: INSTALL_HINT });
    default:
      return step("manifest", "fail", "foreign", "The Chrome native messaging manifest points at another host. Run browser-control install --force to replace it.",
        { path: file, previous: state.previous, command: `${INSTALL_HINT} --force` });
  }
}

/** The user route's endpoint answers the protocol 2 handshake. Chrome may simply be closed, so this only warns. */
async function endpointStep(env: Env, connect: Connect): Promise<Step> {
  const socket = userSocket(env);
  try {
    const connection = await connect(socket, 2);
    connection.close();
    return step("endpoint", "ok", "connected", "Your Chrome's Browser Control extension answered the native host handshake.", { path: socket });
  } catch (error) {
    if (isGate(error, "browser-control-protocol-mismatch")) {
      return step("endpoint", "fail", "protocol-mismatch", "The Browser Control extension or native host does not speak protocol 2. Update the extension and run browser-control install.",
        { path: socket, code: error.code });
    }
    if (isGate(error, "browser-control-unavailable")) {
      return step("endpoint", "warn", "unavailable",
        "Your Chrome is not reachable: Chrome is closed, the extension is not connected, or the native host is not installed.", { path: socket, code: error.code });
    }
    return step("endpoint", "warn", "unknown", "The native host did not answer the handshake. Reload the extension in chrome://extensions.",
      { path: socket, code: gateCode(error) });
  }
}

function clipboardStep(env: Env, deps: CommandDeps): Step {
  if (deps.platform !== "darwin") return step("clipboard-guard", "ok", "skipped", "The clipboard guard is used only on macOS.");
  const binary = clipboardGuardBinary(env, deps.assets);
  if (trustedGuard(binary)) return step("clipboard-guard", "ok", "trusted", "The clipboard guard is built and trusted.", { path: binary });
  if (exists(binary)) {
    return step("clipboard-guard", "fail", "untrusted",
      "The clipboard guard failed verification: it must be a Mach-O file owned by you with mode 0700. Run browser-control install.",
      { path: binary, command: INSTALL_HINT });
  }
  return step("clipboard-guard", "warn", "missing", "The clipboard guard is not built, so paste_1password_field is unavailable. Run browser-control install.",
    { path: binary, command: INSTALL_HINT });
}

function skillSteps(env: Env, assets: PackageAssets, options: Options): Step[] {
  const directories = skillsDirectories(options);
  if (!directories.length) {
    return [step("skills", "ok", "skipped", "No skills directory was given, so no skill link was checked. Pass --skills-dir <dir> to check one.")];
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
    for (const directory of directories) {
      const link = path.join(directory, name);
      const previous = readLink(link);
      if (previous === target && treeMatches(target, files)) {
        steps.push(step(id, "ok", "current", "The skill is linked to this version.", { path: link }));
      } else if (!exists(link)) {
        steps.push(step(id, "warn", "missing", "The skill is not linked. Run browser-control install.", { path: link, command: INSTALL_HINT }));
      } else {
        steps.push(step(id, "warn", "stale", "The skill link does not point at this version. Run browser-control install.",
          { path: link, previous, command: INSTALL_HINT }));
      }
    }
  }
  return steps;
}

function ffmpegStep(env: Env): Step {
  const ffmpeg = whichExecutable("ffmpeg", env);
  if (ffmpeg) return step("ffmpeg", "ok", "found", "ffmpeg is on PATH for recordings.", { path: ffmpeg });
  return step("ffmpeg", "warn", "missing", "ffmpeg is not on PATH, so start_recording is refused. Screenshots work without it.");
}

async function guarded(id: string, body: () => Promise<Step[]> | Step[]): Promise<Step[]> {
  try {
    return await body();
  } catch (error) {
    return [step(id, "fail", "error", "This check failed. Fix the reported code, then run browser-control doctor again.", { code: gateCode(error) })];
  }
}

export interface DoctorReport { command: "doctor"; version: string; ok: boolean; steps: Step[] }

export async function doctor(options: Options, env: Env, deps: DoctorDeps = defaultDoctorDeps()): Promise<DoctorReport> {
  const scoped = commandEnv(env, options);
  const steps: Step[] = [nodeStep()];
  const state = await guarded("state", () => [stateStep(scoped)]);
  steps.push(...state);
  if (!failed(steps)) {
    let host: ReturnType<typeof hostStep> | null = null;
    try {
      host = hostStep(scoped, deps.assets);
      steps.push(host.step);
    } catch (error) {
      steps.push(...await guarded("host", () => { throw error; }));
    }
    if (host) {
      const hostScript = host.hostScript;
      steps.push(...await guarded("wrapper", () => [wrapperStep(scoped, hostScript)]));
    }
  }
  steps.push(...await guarded("manifest", () => [manifestStep(scoped, deps.platform, options)]));
  steps.push(...await guarded("extension", () => [extensionStep(scoped, deps.platform, "fail")]));
  steps.push(...await guarded("endpoint", async () => [await endpointStep(scoped, deps.connect)]));
  steps.push(...await guarded("cua-driver", () => [cuaStep(scoped)]));
  steps.push(...await guarded("chrome-for-testing", async () => [await chromeForTestingStep(deps)]));
  if (!failed(state)) {
    steps.push(...await guarded("clipboard-guard", () => [clipboardStep(scoped, deps)]));
    steps.push(...await guarded("skills", () => skillSteps(scoped, deps.assets, options)));
  }
  steps.push(ffmpegStep(scoped));
  if (options.smoke) steps.push(...await guarded("smoke", () => smoke(scoped, deps.assets, deps.smoke)));
  return { command: "doctor", version: deps.assets.version, ok: !failed(steps), steps };
}

export async function runDoctor(argv: readonly string[], io: CommandIo, deps?: DoctorDeps): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv, DOCTOR_FLAGS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`browser-control doctor: ${error.message}\n`
      + "usage: browser-control doctor [--state-dir <dir>] [--chrome-manifest-dir <dir>] [--skills-dir <dir>]... [--smoke] [--json]\n");
    return 2;
  }
  const report = await doctor(options, io.env, deps ?? defaultDoctorDeps());
  if (options.json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout.write(`Browser Control ${report.version}: doctor\n${formatSteps(report.steps)}\n`);
  return report.ok ? 0 : 1;
}
