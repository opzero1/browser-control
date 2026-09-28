// Whether the user's Chrome has the Browser Control extension: the check of src/scripts/check-extension-installed.ts
// (same profile selection, the same Preferences and Secure Preferences lookup, the same statuses) as a read-only
// function. The script itself runs at import and its build output is published with the browser-control skill,
// so it is ported rather than refactored.
import fs from "node:fs";
import path from "node:path";
import { homeDirectory, type Env } from "../config";

export type ExtensionStatus = "enabled" | "disabled" | "not-installed" | "profile-missing" | "unsupported";

export interface ExtensionCheck {
  status: ExtensionStatus;
  extensionId: string;
  preferencesPath: string | null;
  settingsPath?: string;
  version?: string;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function selectProfilePreferences(userDataDir: string): string {
  const localState = readJsonFile(path.join(userDataDir, "Local State")) as { profile?: { last_used?: unknown } } | null;
  const lastProfile = localState?.profile?.last_used;
  if (typeof lastProfile === "string" && lastProfile && fs.existsSync(path.join(userDataDir, lastProfile, "Preferences"))) {
    return path.join(userDataDir, lastProfile, "Preferences");
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(userDataDir);
  } catch {
    entries = [];
  }
  const candidates = entries
    .filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry))
    .sort((a, b) => {
      if (a === "Default") return 1;
      if (b === "Default") return -1;
      return Number(b.replace("Profile ", "")) - Number(a.replace("Profile ", ""));
    });
  for (const profile of candidates) {
    const preferences = path.join(userDataDir, profile, "Preferences");
    if (fs.existsSync(preferences)) return preferences;
  }
  return path.join(userDataDir, "Default", "Preferences");
}

function preferencesPath(env: Env, platform: NodeJS.Platform): string | null {
  if (env.BROWSER_CONTROL_PREFERENCES_PATH) return env.BROWSER_CONTROL_PREFERENCES_PATH;
  if (env.BROWSER_CONTROL_USER_DATA_DIR) return selectProfilePreferences(env.BROWSER_CONTROL_USER_DATA_DIR);
  if (env.CHROME_PROFILE_DIR) return path.join(env.CHROME_PROFILE_DIR, "Preferences");
  const home = homeDirectory(env);
  if (platform === "darwin") return selectProfilePreferences(path.join(home, "Library", "Application Support", "Google", "Chrome"));
  if (platform === "linux") return selectProfilePreferences(path.join(home, ".config", "google-chrome"));
  return null;
}

/** Read-only: find `extensionId` in the last used Chrome profile and report whether it is enabled. */
export function checkExtensionInstalled(extensionId: string, env: Env, platform: NodeJS.Platform): ExtensionCheck {
  const preferences = preferencesPath(env, platform);
  if (!preferences) return { status: "unsupported", extensionId, preferencesPath: null };
  if (!fs.existsSync(preferences)) return { status: "profile-missing", extensionId, preferencesPath: preferences };
  for (const settingsPath of [preferences, path.join(path.dirname(preferences), "Secure Preferences")]) {
    const parsed = readJsonFile(settingsPath) as { extensions?: { settings?: Record<string, unknown> } } | null;
    const settings = parsed?.extensions?.settings?.[extensionId] as
      | { state?: unknown; disable_reasons?: unknown; version?: unknown; manifest?: { version?: unknown } } | undefined;
    if (!settings || typeof settings !== "object") continue;
    const disabledReasons = settings.disable_reasons || 0;
    const state = settings.state;
    const version = settings.manifest?.version || settings.version;
    const found = { extensionId, preferencesPath: preferences, settingsPath, ...(typeof version === "string" ? { version } : {}) };
    // An empty array is how newer Chrome writes "no disable reasons".
    const disabled = Array.isArray(disabledReasons) ? disabledReasons.length > 0 : disabledReasons !== 0;
    if ((state !== undefined && state !== 1) || disabled) return { status: "disabled", ...found };
    return { status: "enabled", ...found };
  }
  return { status: "not-installed", extensionId, preferencesPath: preferences };
}
