#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
let node_os = require("node:os");
node_os = require_Layer.__toESM(node_os);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
//#region src/scripts/check-extension-installed.ts
var json = process.argv.includes("--json");
function output(result, exitCode) {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
		else if (result.ok) yield* io.stdout(`${result.message}\n`);
		else yield* io.stderr(`${result.message}\n`);
		process.exitCode = exitCode;
	});
}
function configuredExtensionId() {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		const explicit = require_effect_services.argValue("extension-id", process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]));
		if (explicit) return explicit;
		if (process.env.OPZERO_CHROME_EXTENSION_ID) return process.env.OPZERO_CHROME_EXTENSION_ID;
		const configPath = node_path.default.join(__dirname, "extension-id.json");
		if (!(yield* io.exists(configPath))) return null;
		return JSON.parse(yield* io.readText(configPath)).extensionId || null;
	});
}
function selectProfilePreferences(userDataDir) {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		const localStatePath = node_path.default.join(userDataDir, "Local State");
		if (yield* io.exists(localStatePath)) {
			const parsed = yield* require_Layer.either(io.readText(localStatePath));
			if (parsed._tag === "Right") try {
				const lastProfile = JSON.parse(parsed.right).profile?.last_used;
				if (lastProfile && (yield* io.exists(node_path.default.join(userDataDir, lastProfile, "Preferences")))) return node_path.default.join(userDataDir, lastProfile, "Preferences");
			} catch {}
		}
		const candidates = (yield* io.exists(userDataDir)) ? (yield* io.readdir(userDataDir)).filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry)).sort((a, b) => {
			if (a === "Default") return 1;
			if (b === "Default") return -1;
			return Number(b.replace("Profile ", "")) - Number(a.replace("Profile ", ""));
		}) : [];
		for (const profile of candidates) {
			const pref = node_path.default.join(userDataDir, profile, "Preferences");
			if (yield* io.exists(pref)) return pref;
		}
		return node_path.default.join(userDataDir, "Default", "Preferences");
	});
}
function preferencesPath() {
	return require_Layer.gen(function* () {
		if (process.env.OPZERO_CHROME_PREFERENCES_PATH) return process.env.OPZERO_CHROME_PREFERENCES_PATH;
		if (process.env.OPZERO_CHROME_USER_DATA_DIR) return yield* selectProfilePreferences(process.env.OPZERO_CHROME_USER_DATA_DIR);
		if (process.env.CHROME_PROFILE_DIR) return node_path.default.join(process.env.CHROME_PROFILE_DIR, "Preferences");
		if (process.platform === "darwin") return yield* selectProfilePreferences(node_path.default.join(node_os.default.homedir(), "Library", "Application Support", "Google", "Chrome"));
		if (process.platform === "linux") return yield* selectProfilePreferences(node_path.default.join(node_os.default.homedir(), ".config", "google-chrome"));
		if (process.platform === "win32") return yield* selectProfilePreferences(node_path.default.join(node_os.default.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"));
		return yield* require_Layer.fail(/* @__PURE__ */ new Error(`Unsupported platform: ${process.platform}`));
	});
}
function readExtensionSettings(profilePreferencesPath, extensionId) {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		const paths = [profilePreferencesPath, node_path.default.join(node_path.default.dirname(profilePreferencesPath), "Secure Preferences")];
		for (const settingsPath of paths) {
			if (!(yield* io.exists(settingsPath))) continue;
			const settings = JSON.parse(yield* io.readText(settingsPath)).extensions?.settings?.[extensionId];
			if (settings) return {
				settings,
				settingsPath
			};
		}
		return null;
	});
}
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
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
			message: `Opzero Chrome extension is not registered in ${prefPath}`
		}, 2);
		return;
	}
	const { settings, settingsPath } = installed;
	const disabledReasons = settings.disable_reasons || 0;
	const state = settings.state;
	if (state !== void 0 && state !== 1 || disabledReasons !== 0) {
		yield* output({
			ok: false,
			status: "disabled",
			extensionId,
			preferencesPath: prefPath,
			settingsPath,
			state,
			disabledReasons,
			message: `Opzero Chrome extension is installed but not enabled. state=${state}, disable_reasons=${disabledReasons}`
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
		message: `Opzero Chrome extension installed and enabled: ${extensionId}`
	}, 0);
}));
//#endregion
