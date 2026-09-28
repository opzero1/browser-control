#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { argValue, runScript, ScriptIo } from "./effect-services";

const hostName = "com.opzero.chrome";
const json = process.argv.includes("--json");
type CheckResult = {
  ok: boolean;
  message: string;
  [key: string]: unknown;
};

function defaultManifestPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${hostName}.json`);
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${hostName}.json`);
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "opzero-chrome", `${hostName}.json`);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

const manifestPath = argValue("manifest-path", defaultManifestPath()) as string;

function configuredExtensionId() {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    const explicit = argValue("extension-id", process.env.BROWSER_CONTROL_EXTENSION_ID);
    if (explicit) return explicit;
    const configPath = path.join(__dirname, "extension-id.json");
    if (!(yield* io.exists(configPath))) return null;
    return JSON.parse(yield* io.readText(configPath)).extensionId || null;
  });
}

function checkWindowsRegistry(expectedPath: string) {
  return Effect.gen(function* () {
    if (process.platform !== "win32") return [];
    const io = yield* ScriptIo;
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
    const output = yield* Effect.either(io.execFile("reg", ["query", key, "/ve"], { encoding: "utf8" }));
    if (output._tag === "Left") return [`Windows registry key ${key} is missing: ${output.left.message}`];
    return output.right.includes(expectedPath) ? [] : [`Windows registry key ${key} does not point at ${expectedPath}`];
  });
}

function output(result: CheckResult, exitCode: number) {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) yield* io.stdout(`${result.message}\n`);
    else yield* io.stderr(`${result.message}\n`);
    process.exitCode = exitCode;
  });
}

function repairCommand(extensionId: string) {
  return [process.execPath, path.join(__dirname, "install-native-host.js"), "--extension-id", extensionId, "--manifest-path", manifestPath];
}

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const extensionId = yield* configuredExtensionId();
  if (!extensionId) {
    yield* output({
      ok: false,
      status: "missing-extension-id",
      hostName,
      manifestPath,
      message: "Missing extension ID. Pass --extension-id <id>, set BROWSER_CONTROL_EXTENSION_ID, or create scripts/extension-id.json."
    }, 2);
    return;
  }

  const failures: string[] = [];
  if (!(yield* io.exists(manifestPath))) {
    failures.push(`Manifest does not exist: ${manifestPath}`);
  } else {
    const manifest = JSON.parse(yield* io.readText(manifestPath));
    if (manifest.name !== hostName) failures.push(`Expected name ${hostName}, got ${manifest.name}`);
    if (manifest.type !== "stdio") failures.push(`Expected type stdio, got ${manifest.type}`);
    if (!manifest.path || !(yield* io.exists(manifest.path))) failures.push(`Host executable does not exist: ${manifest.path}`);
    const origin = `chrome-extension://${extensionId}/`;
    if (!manifest.allowed_origins?.includes(origin)) failures.push(`Missing allowed origin ${origin}`);
    failures.push(...(yield* checkWindowsRegistry(manifestPath)));
  }

  if (failures.length) {
    const repair = repairCommand(extensionId);
    yield* output({
      ok: false,
      status: "invalid",
      hostName,
      extensionId,
      manifestPath,
      repairCommand: repair,
      failures,
      message: `Native host manifest check failed:\n${failures.map((item) => `- ${item}`).join("\n")}\nRepair with:\n${repair.map((part) => JSON.stringify(part)).join(" ")}`
    }, 1);
    return;
  }

  yield* output({
    ok: true,
    status: "valid",
    hostName,
    extensionId,
    manifestPath,
    message: `Native host manifest OK: ${manifestPath}`
  }, 0);
}));
