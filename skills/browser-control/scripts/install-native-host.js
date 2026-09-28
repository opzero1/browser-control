#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
let node_os = require("node:os");
node_os = require_Layer.__toESM(node_os);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
let node_process = require("node:process");
node_process = require_Layer.__toESM(node_process);
//#region src/scripts/install-native-host.ts
var root = node_path.default.resolve(__dirname, "..");
var hostName = "com.opzero.chrome";
function chromeManifestPath() {
	if (node_process.default.platform === "darwin") return node_path.default.join(node_os.default.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${hostName}.json`);
	if (node_process.default.platform === "linux") return node_path.default.join(node_os.default.homedir(), ".config", "google-chrome", "NativeMessagingHosts", `${hostName}.json`);
	if (node_process.default.platform === "win32") return node_path.default.join(node_os.default.homedir(), "AppData", "Local", "opzero-chrome", `${hostName}.json`);
	throw new Error(`Unsupported platform: ${node_process.default.platform}`);
}
function registerWindowsManifest(manifestPath) {
	return require_Layer.gen(function* () {
		if (node_process.default.platform !== "win32") return;
		const io = yield* require_effect_services.ScriptIo;
		const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
		yield* io.execFileInherit("reg", [
			"add",
			key,
			"/ve",
			"/t",
			"REG_SZ",
			"/d",
			manifestPath,
			"/f"
		]);
	});
}
function nativeHostLauncher() {
	const nodeFallback = JSON.stringify(node_process.default.execPath);
	const socketPath = require_effect_services.argValue("socket-path", node_process.default.env.BROWSER_CONTROL_HOST_SOCKET);
	return `#!/usr/bin/env sh
${socketPath ? `export BROWSER_CONTROL_HOST_SOCKET=${JSON.stringify(socketPath)}\n` : ""}SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/host.js"
fi
if [ -x /opt/homebrew/bin/node ]; then
  exec /opt/homebrew/bin/node "$SCRIPT_DIR/host.js"
fi
if [ -x /usr/local/bin/node ]; then
  exec /usr/local/bin/node "$SCRIPT_DIR/host.js"
fi
if [ -x ${nodeFallback} ]; then
  exec ${nodeFallback} "$SCRIPT_DIR/host.js"
fi
echo "Unable to find node executable for browser-control-host" >&2
exit 127
`;
}
function windowsNativeHostLauncher() {
	const socketPath = require_effect_services.argValue("socket-path", node_process.default.env.BROWSER_CONTROL_HOST_SOCKET);
	return `@echo off
${socketPath ? `set "BROWSER_CONTROL_HOST_SOCKET=${socketPath.replace(/"/g, "\"\"")}"\r\n` : ""}"${node_process.default.execPath.replace(/"/g, "\"\"")}" "%~dp0host.js"
`;
}
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const extensionId = require_effect_services.argValue("extension-id", node_process.default.env.BROWSER_CONTROL_EXTENSION_ID);
	if (!extensionId) {
		yield* io.stderr("Missing extension ID. Pass --extension-id <id> after loading extension/ unpacked in Chrome.\n");
		node_process.default.exitCode = 1;
		return;
	}
	const hostPath = node_process.default.platform === "win32" ? node_path.default.join(root, "native-host", "browser-control-host.cmd") : node_path.default.join(root, "native-host", "browser-control-host");
	const manifestPath = require_effect_services.argValue("manifest-path", chromeManifestPath());
	yield* io.mkdir(node_path.default.dirname(hostPath));
	yield* io.writeText(hostPath, node_process.default.platform === "win32" ? windowsNativeHostLauncher() : nativeHostLauncher());
	const manifest = {
		name: hostName,
		description: "Browser Control native messaging host",
		type: "stdio",
		path: hostPath,
		allowed_origins: [`chrome-extension://${extensionId}/`]
	};
	yield* io.mkdir(node_path.default.dirname(manifestPath));
	if (node_process.default.platform !== "win32") yield* io.chmod(hostPath, 493);
	yield* io.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	yield* registerWindowsManifest(manifestPath);
	yield* io.stdout(`Installed native messaging manifest:\n${manifestPath}\n`);
	yield* io.stdout(`Allowed extension origin: chrome-extension://${extensionId}/\n`);
	yield* io.stdout(`Host executable: ${hostPath}\n`);
	yield* require_Layer.catchAll(io.writeText(node_path.default.join(__dirname, "extension-id.json"), `${JSON.stringify({
		extensionId,
		extensionHostName: hostName
	}, null, 2)}\n`), () => require_Layer._void);
}));
//#endregion
