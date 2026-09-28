// Apply the isolated browser's password-saving and download preferences privately (browser_preferences.py).
// Preferences are parsed losslessly: numbers keep their source text and objects keep their key order, so a
// rewrite changes only the keys set here.
import fs from "node:fs";
import path from "node:path";
import { io, openDirectory, verified, writePrivate, type PrivateDir } from "../fs-private";
import { Gate } from "../gate";
import { JsonDecodeError, JsonEncodeError, LosslessNumber, parseLosslessJson, pyDumps, type LosslessObject, type LosslessValue } from "../pyjson";

const PREFERENCES_LIMIT = 32 * 1024 * 1024;
/** sys.get_int_max_str_digits() of the reference Python: json.load refuses longer integer literals. */
const INT_MAX_STR_DIGITS = 4300;

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  while (true) {
    const chunk = Buffer.allocUnsafe(1 << 20);
    const count = io(() => fs.readSync(fd, chunk, 0, chunk.length, null));
    if (!count) break;
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks);
}

function walk(value: LosslessValue, visit: (number: LosslessNumber) => void) {
  if (value instanceof LosslessNumber) visit(value);
  else if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else if (value instanceof Map) for (const item of value.values()) walk(item, visit);
}

function readPreferences(directory: PrivateDir, running: boolean, missing: string): LosslessObject {
  let fd: number;
  try {
    fd = fs.openSync(path.join(verified(directory), "Preferences"), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return io(() => { throw error; });
    if (running) throw new Gate(missing);
    return new Map();
  }
  let preferences: LosslessValue;
  try {
    const stats = io(() => fs.fstatSync(fd));
    if (!stats.isFile() || stats.uid !== process.getuid?.() || stats.nlink !== 1 || stats.size > PREFERENCES_LIMIT) {
      throw new Gate("browser-controller-unsafe-preferences");
    }
    try {
      preferences = parseLosslessJson(decoder.decode(readAll(fd)));
      walk(preferences, (number) => {
        if (number.isInteger && number.source.replace(/^-/, "").length > INT_MAX_STR_DIGITS) throw new JsonDecodeError("integer too long");
      });
    } catch (error) {
      // json.load's ValueError (including parse_constant's refusal of NaN and Infinity) or a UnicodeError.
      if (error instanceof JsonDecodeError || (error instanceof TypeError && !(error instanceof JsonEncodeError))) {
        throw new Gate("browser-controller-invalid-preferences");
      }
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (!(preferences instanceof Map)) throw new Gate("browser-controller-invalid-preferences");
  return preferences;
}

function writePreferences(directory: PrivateDir, preferences: LosslessObject) {
  // A float literal that overflowed to infinity cannot be written back (json.dump with allow_nan=False).
  walk(preferences, (number) => {
    if (!number.isInteger && !Number.isFinite(Number(number.source))) throw new JsonEncodeError("Out of range float values are not JSON compliant");
  });
  const text = `${pyDumps(preferences, { separators: [",", ":"], allowNan: false })}\n`;
  writePrivate(directory, "Preferences", Buffer.from(text, "utf8"), 0o600, ".password-preference-");
}

export function disablePasswordSaving(profile: string, options: { running: boolean }): { password_saving_disabled: true; preferences_changed: boolean } {
  const directory = openDirectory(path.join(profile, "Default"));
  const preferences = readPreferences(directory, options.running, "browser-controller-password-setting-unconfirmed");
  if (preferences.get("credentials_enable_service") === false) return { password_saving_disabled: true, preferences_changed: false };
  if (options.running) throw new Gate("browser-controller-password-saving-enabled");
  preferences.set("credentials_enable_service", false);
  writePreferences(directory, preferences);
  return { password_saving_disabled: true, preferences_changed: true };
}

function downloadSettings(downloads: string): Array<[string, string | boolean]> {
  return [["default_directory", String(downloads)], ["prompt_for_download", false], ["directory_upgrade", true]];
}

/** Write the four keys before a cold start; a running profile is only checked, never rewritten. */
export function applyPreferences(profile: string, downloads: string, options: { running: boolean }): { password_saving_disabled: true; downloads_configured: true; preferences_changed: boolean } {
  const directory = openDirectory(path.join(profile, "Default"));
  const preferences = readPreferences(directory, options.running, "browser-controller-preferences-unconfirmed");
  const download = preferences.has("download") ? preferences.get("download") : new Map<string, LosslessValue>();
  if (!(download instanceof Map)) throw new Gate("browser-controller-invalid-preferences");
  const wanted = downloadSettings(downloads);
  const password = preferences.get("credentials_enable_service") === false;
  // Strict equality keeps 0 and 1 from passing as the booleans Chrome expects.
  const configured = wanted.every(([key, value]) => download.get(key) === value);
  if (password && configured) return { password_saving_disabled: true, downloads_configured: true, preferences_changed: false };
  if (options.running) {
    throw new Gate(password ? "browser-controller-download-settings-mismatch" : "browser-controller-password-saving-enabled");
  }
  preferences.set("credentials_enable_service", false);
  const merged = new Map(download);
  for (const [key, value] of wanted) merged.set(key, value);
  preferences.set("download", merged);
  writePreferences(directory, preferences);
  return { password_saving_disabled: true, downloads_configured: true, preferences_changed: true };
}
