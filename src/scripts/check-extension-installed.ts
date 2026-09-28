#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { argValue, runScript, ScriptIo } from "./effect-services";

const json = process.argv.includes("--json");
type CheckResult = {
  ok: boolean;
  message: string;
  [key: string]: unknown;
};

function output(result: CheckResult, exitCode: number) {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) yield* io.stdout(`${result.message}\n`);
    else yield* io.stderr(`${result.message}\n`);
    process.exitCode = exitCode;
  });
}

function configuredExtensionId() {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    const positional = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]);
    const explicit = argValue("extension-id", positional);
    if (explicit) return explicit;
    if (process.env.OPZERO_CHROME_EXTENSION_ID) return process.env.OPZERO_CHROME_EXTENSION_ID;
    const configPath = path.join(__dirname, "extension-id.json");
    if (!(yield* io.exists(configPath))) return null;
    return JSON.parse(yield* io.readText(configPath)).extensionId || null;
  });
}

function selectProfilePreferences(userDataDir: string) {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    const localStatePath = path.join(userDataDir, "Local State");
    if (yield* io.exists(localStatePath)) {
      const parsed = yield* Effect.either(io.readText(localStatePath));
      if (parsed._tag === "Right") {
        try {
          const lastProfile = JSON.parse(parsed.right).profile?.last_used;
          if (lastProfile && (yield* io.exists(path.join(userDataDir, lastProfile, "Preferences")))) {
            return path.join(userDataDir, lastProfile, "Preferences");
          }
        } catch {
          // Fall back to profile directory scan.
        }
      }
    }
    const candidates = (yield* io.exists(userDataDir))
      ? (yield* io.readdir(userDataDir))
        .filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry))
        .sort((a, b) => {
          if (a === "Default") return 1;
          if (b === "Default") return -1;
          return Number(b.replace("Profile ", "")) - Number(a.replace("Profile ", ""));
        })
      : [];
    for (const profile of candidates) {
      const pref = path.join(userDataDir, profile, "Preferences");
      if (yield* io.exists(pref)) return pref;
    }
    return path.join(userDataDir, "Default", "Preferences");
  });
}

function preferencesPath() {
  return Effect.gen(function* () {
    if (process.env.OPZERO_CHROME_PREFERENCES_PATH) return process.env.OPZERO_CHROME_PREFERENCES_PATH;
    if (process.env.OPZERO_CHROME_USER_DATA_DIR) return yield* selectProfilePreferences(process.env.OPZERO_CHROME_USER_DATA_DIR);
    if (process.env.CHROME_PROFILE_DIR) return path.join(process.env.CHROME_PROFILE_DIR, "Preferences");
    if (process.platform === "darwin") {
      return yield* selectProfilePreferences(path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"));
    }
    if (process.platform === "linux") {
      return yield* selectProfilePreferences(path.join(os.homedir(), ".config", "google-chrome"));
    }
    if (process.platform === "win32") {
      return yield* selectProfilePreferences(path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"));
    }
    return yield* Effect.fail(new Error(`Unsupported platform: ${process.platform}`));
  });
}

function readExtensionSettings(profilePreferencesPath: string, extensionId: string) {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    const paths = [
      profilePreferencesPath,
      path.join(path.dirname(profilePreferencesPath), "Secure Preferences")
    ];

    for (const settingsPath of paths) {
      if (!(yield* io.exists(settingsPath))) continue;
      const prefs = JSON.parse(yield* io.readText(settingsPath));
      const settings = prefs.extensions?.settings?.[extensionId];
      if (settings) return { settings, settingsPath };
    }

    return null;
  });
}

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const extensionId = yield* configuredExtensionId();
  if (!extensionId) {
    yield* output({
      ok: false,
      status: "missing-extension-id",
      message: "Missing extension ID. Pass --extension-id <id>, set OPZERO_CHROME_EXTENSION_ID, or create scripts/extension-id.json."
    }, 3);
    return;
  }

  const prefPath = yield* preferencesPath();
  if (!(yield* io.exists(prefPath))) {
    yield* output({
      ok: false,
      status: "profile-missing",
      extensionId,
      preferencesPath: prefPath,
      message: `Chrome Preferences not found: ${prefPath}`
    }, 3);
    return;
  }

  const installed = yield* readExtensionSettings(prefPath, extensionId);
  if (!installed) {
    yield* output({
      ok: false,
      status: "not-installed",
      extensionId,
      preferencesPath: prefPath,
      message: `Browser Control extension is not registered in ${prefPath}`
    }, 2);
    return;
  }

  const { settings, settingsPath } = installed;
  const disabledReasons = settings.disable_reasons || 0;
  const state = settings.state;
  if ((state !== undefined && state !== 1) || disabledReasons !== 0) {
    yield* output({
      ok: false,
      status: "disabled",
      extensionId,
      preferencesPath: prefPath,
      settingsPath,
      state,
      disabledReasons,
      message: `Browser Control extension is installed but not enabled. state=${state}, disable_reasons=${disabledReasons}`
    }, 1);
    return;
  }

  yield* output({
    ok: true,
    status: "enabled",
    extensionId,
    preferencesPath: prefPath,
    settingsPath,
    version: settings.manifest?.version || settings.version,
    message: `Browser Control extension installed and enabled: ${extensionId}`
  }, 0);
}));
