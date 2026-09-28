// Port of test_browser_preferences.py: the password-saving and download preferences, applied privately.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsError } from "../../../src/server/fs-private";
import { applyPreferences, disablePasswordSaving } from "../../../src/server/pool/preferences";
import { JsonEncodeError } from "../../../src/server/pyjson";
import { removeTempRoots } from "../support/temp";
import { gate, tempDir } from "./helpers";

afterEach(() => removeTempRoots());

function profileWith(text: string | null): { profile: string; file: string } {
  const profile = tempDir();
  const directory = path.join(profile, "Default");
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "Preferences");
  if (text !== null) fs.writeFileSync(file, text);
  return { profile, file };
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

function mtime(file: string): bigint {
  return fs.statSync(file, { bigint: true }).mtimeNs;
}

function downloadKeys(downloads: string) {
  return { default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
}

const INVALID = [
  "invalid json", "[]", "null",
  "{\"credentials_enable_service\":false,\"other\":NaN}",
  "{\"credentials_enable_service\":false,\"other\":Infinity}",
  "{\"credentials_enable_service\":false,\"other\":-Infinity}"
];
const RUNNING_CHANGES: Array<[Record<string, unknown>, string]> = [
  [{ credentials_enable_service: true }, "password-saving-enabled"],
  [{ download: { default_directory: "/other", prompt_for_download: false, directory_upgrade: true } }, "download-settings-mismatch"],
  [{ download: { default_directory: "/d", prompt_for_download: 0, directory_upgrade: true } }, "download-settings-mismatch"],
  [{ download: { default_directory: "/d", prompt_for_download: false } }, "download-settings-mismatch"]
];
const INVALID_DOWNLOADS = ["[]", "{\"download\":[]}", "{\"download\":{},\"x\":NaN}"];

describe("password saving", () => {
  it("changes only the password-saving preference", () => {
    const before = { credentials_enable_service: true, download: { default_directory: "/retained" }, profile: { name: "Retained profile" }, other: [1, 2, 3] };
    const { profile, file } = profileWith(JSON.stringify(before));
    expect(disablePasswordSaving(profile, { running: false })).toEqual({ password_saving_disabled: true, preferences_changed: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...before, credentials_enable_service: false });
    expect(mode(file)).toBe(0o600);
    const same = mtime(file);
    expect(disablePasswordSaving(profile, { running: true }).preferences_changed).toBe(false);
    expect(mtime(file)).toBe(same);
  });

  it("disables password saving in a new stopped profile", () => {
    const profile = tempDir();
    expect(disablePasswordSaving(profile, { running: false }).password_saving_disabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(profile, "Default/Preferences"), "utf8"))).toEqual({ credentials_enable_service: false });
  });

  it("never rewrites a running profile", async () => {
    const before = "{\"credentials_enable_service\":true,\"other\":42}";
    const { profile, file } = profileWith(before);
    expect(await gate(() => disablePasswordSaving(profile, { running: true }))).toBe("browser-controller-password-saving-enabled");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each(INVALID)("preserves invalid preferences: %s", async (text) => {
    const { profile, file } = profileWith(text);
    expect(await gate(() => disablePasswordSaving(profile, { running: false }))).toBe("browser-controller-invalid-preferences");
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  it("does not follow a symlinked Preferences file", () => {
    const { profile, file } = profileWith(null);
    const other = path.join(profile, "unrelated");
    fs.writeFileSync(other, "{\"credentials_enable_service\":true}");
    fs.symlinkSync(other, file);
    expect(() => disablePasswordSaving(profile, { running: false })).toThrow(FsError);
    expect(JSON.parse(fs.readFileSync(other, "utf8")).credentials_enable_service).toBe(true);
  });
});

describe("download preferences", () => {
  it("gives a cold profile the password and download keys and keeps the rest", () => {
    const before = { credentials_enable_service: true, download: { default_directory: "/elsewhere", extra: 1 }, profile: { name: "Retained profile" } };
    const { profile, file } = profileWith(JSON.stringify(before));
    const downloads = path.join(profile, "downloads");
    expect(applyPreferences(profile, downloads, { running: false })).toEqual({ password_saving_disabled: true, downloads_configured: true, preferences_changed: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...before, credentials_enable_service: false, download: { extra: 1, ...downloadKeys(downloads) } });
    expect(mode(file)).toBe(0o600);
    const same = mtime(file);
    expect(applyPreferences(profile, downloads, { running: true }).preferences_changed).toBe(false);
    expect(mtime(file)).toBe(same);
  });

  it("gives a new stopped profile all four keys", () => {
    const profile = tempDir();
    applyPreferences(profile, "/d", { running: false });
    expect(JSON.parse(fs.readFileSync(path.join(profile, "Default/Preferences"), "utf8"))).toEqual({ credentials_enable_service: false, download: downloadKeys("/d") });
  });

  it.each(RUNNING_CHANGES)("only checks a running profile: %j", async (change, error) => {
    const before = JSON.stringify({ credentials_enable_service: false, download: downloadKeys("/d"), ...change });
    const { profile, file } = profileWith(before);
    expect(await gate(() => applyPreferences(profile, "/d", { running: true }))).toBe(`browser-controller-${error}`);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("reports a running profile without Preferences as unconfirmed", async () => {
    const profile = tempDir();
    expect(await gate(() => applyPreferences(profile, "/d", { running: true }))).toBe("browser-controller-preferences-unconfirmed");
    expect(fs.existsSync(path.join(profile, "Default/Preferences"))).toBe(false);
  });

  it.each(INVALID_DOWNLOADS)("preserves invalid download preferences: %s", async (text) => {
    const { profile, file } = profileWith(text);
    expect(await gate(() => applyPreferences(profile, "/d", { running: false }))).toBe("browser-controller-invalid-preferences");
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});

describe("lossless Preferences rewrite (design 4.9)", () => {
  it("keeps large integers, float text and key order through a rewrite", () => {
    const before = "{\"b\":{\"2\":1,\"10\":2,\"a\":9007199254740993123},\"f\":1.0,\"e\":1E2,\"z\":-0,\"credentials_enable_service\":true,\"u\":\"\\u00e9\"}";
    const { profile, file } = profileWith(before);
    disablePasswordSaving(profile, { running: false });
    expect(fs.readFileSync(file, "utf8")).toBe("{\"b\":{\"2\":1,\"10\":2,\"a\":9007199254740993123},\"f\":1.0,\"e\":100.0,\"z\":0,\"credentials_enable_service\":false,\"u\":\"\\u00e9\"}\n");
  });

  it("refuses integers longer than Python's digit limit and floats that overflow on write", async () => {
    const long = `{"n":${"1".repeat(4301)}}`;
    const first = profileWith(long);
    expect(await gate(() => disablePasswordSaving(first.profile, { running: false }))).toBe("browser-controller-invalid-preferences");
    const overflow = "{\"credentials_enable_service\":true,\"x\":1e400}";
    const second = profileWith(overflow);
    expect(() => disablePasswordSaving(second.profile, { running: false })).toThrow(JsonEncodeError);
    expect(fs.readFileSync(second.file, "utf8")).toBe(overflow);
    expect(fs.readdirSync(path.dirname(second.file))).toEqual(["Preferences"]);
  });
});
