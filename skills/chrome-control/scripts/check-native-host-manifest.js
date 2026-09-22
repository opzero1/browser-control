#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-nAKmzBoW.js");
const require_effect_services = require("../chunks/effect-services-BVazUC0E.js");
let node_os = require("node:os");
node_os = require_Layer.__toESM(node_os);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
//#region src/scripts/check-native-host-manifest.ts
var hostName = "com.opzero.chrome";
var json = process.argv.includes("--json");
function defaultManifestPath() {
	if (process.platform === "darwin") return node_path.default.join(node_os.default.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${hostName}.json`);
	if (process.platform === "linux") return node_path.default.join(node_os.default.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${hostName}.json`);
	if (process.platform === "win32") return node_path.default.join(node_os.default.homedir(), "AppData", "Local", "opzero-chrome", `${hostName}.json`);
	throw new Error(`Unsupported platform: ${process.platform}`);
}
var manifestPath = require_effect_services.argValue("manifest-path", defaultManifestPath());
function configuredExtensionId() {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		const explicit = require_effect_services.argValue("extension-id", process.env.OPZERO_CHROME_EXTENSION_ID);
		if (explicit) return explicit;
		const configPath = node_path.default.join(__dirname, "extension-id.json");
		if (!(yield* io.exists(configPath))) return null;
		return JSON.parse(yield* io.readText(configPath)).extensionId || null;
	});
}
function checkWindowsRegistry(expectedPath) {
	return require_Layer.gen(function* () {
		if (process.platform !== "win32") return [];
		const io = yield* require_effect_services.ScriptIo;
		const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
		const output = yield* require_Layer.either(io.execFile("reg", [
			"query",
			key,
			"/ve"
		], { encoding: "utf8" }));
		if (output._tag === "Left") return [`Windows registry key ${key} is missing: ${output.left.message}`];
		return output.right.includes(expectedPath) ? [] : [`Windows registry key ${key} does not point at ${expectedPath}`];
	});
}
function output(result, exitCode) {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
		else if (result.ok) yield* io.stdout(`${result.message}\n`);
		else yield* io.stderr(`${result.message}\n`);
		process.exitCode = exitCode;
	});
}
function repairCommand(extensionId) {
	return [
		process.execPath,
		node_path.default.join(__dirname, "install-native-host.js"),
		"--extension-id",
		extensionId,
		"--manifest-path",
		manifestPath
	];
}
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const extensionId = yield* configuredExtensionId();
	if (!extensionId) {
		yield* output({
			ok: false,
			status: "missing-extension-id",
			hostName,
			manifestPath,
			message: "Missing extension ID. Pass --extension-id <id>, set OPZERO_CHROME_EXTENSION_ID, or create scripts/extension-id.json."
		}, 2);
		return;
	}
	const failures = [];
	if (!(yield* io.exists(manifestPath))) failures.push(`Manifest does not exist: ${manifestPath}`);
	else {
		const manifest = JSON.parse(yield* io.readText(manifestPath));
		if (manifest.name !== hostName) failures.push(`Expected name ${hostName}, got ${manifest.name}`);
		if (manifest.type !== "stdio") failures.push(`Expected type stdio, got ${manifest.type}`);
		if (!manifest.path || !(yield* io.exists(manifest.path))) failures.push(`Host executable does not exist: ${manifest.path}`);
		const origin = `chrome-extension://${extensionId}/`;
		if (!manifest.allowed_origins?.includes(origin)) failures.push(`Missing allowed origin ${origin}`);
		failures.push(...yield* checkWindowsRegistry(manifestPath));
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
//#endregion
