#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { argValue, runScript, ScriptIo } from "./effect-services";

const root = path.resolve(__dirname, "..");
const hostName = "com.opzero.chrome";

function chromeManifestPath() {
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

function registerWindowsManifest(manifestPath: string) {
  return Effect.gen(function* () {
    if (process.platform !== "win32") return;
    const io = yield* ScriptIo;
    const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
    yield* io.execFileInherit("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  });
}

function nativeHostLauncher() {
  const nodeFallback = JSON.stringify(process.execPath);
  const socketPath = argValue("socket-path", process.env.BROWSER_CONTROL_HOST_SOCKET);
  const socketExport = socketPath ? `export BROWSER_CONTROL_HOST_SOCKET=${JSON.stringify(socketPath)}\n` : "";
  return `#!/usr/bin/env sh
${socketExport}SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
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
  const socketPath = argValue("socket-path", process.env.BROWSER_CONTROL_HOST_SOCKET);
  const socketSet = socketPath ? `set "BROWSER_CONTROL_HOST_SOCKET=${socketPath.replace(/"/g, "\"\"")}"\r\n` : "";
  return `@echo off
${socketSet}"${process.execPath.replace(/"/g, "\"\"")}" "%~dp0host.js"
`;
}

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const extensionId = argValue("extension-id", process.env.BROWSER_CONTROL_EXTENSION_ID);
  if (!extensionId) {
    yield* io.stderr("Missing extension ID. Pass --extension-id <id> after loading extension/ unpacked in Chrome.\n");
    process.exitCode = 1;
    return;
  }

  const hostPath = process.platform === "win32"
    ? path.join(root, "native-host", "browser-control-host.cmd")
    : path.join(root, "native-host", "browser-control-host");
  const manifestPath = argValue("manifest-path", chromeManifestPath()) as string;
  yield* io.mkdir(path.dirname(hostPath));
  yield* io.writeText(hostPath, process.platform === "win32" ? windowsNativeHostLauncher() : nativeHostLauncher());
  const manifest = {
    name: hostName,
    description: "Browser Control native messaging host",
    type: "stdio",
    path: hostPath,
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };

  yield* io.mkdir(path.dirname(manifestPath));
  if (process.platform !== "win32") yield* io.chmod(hostPath, 0o755);
  yield* io.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  yield* registerWindowsManifest(manifestPath);

  yield* io.stdout(`Installed native messaging manifest:\n${manifestPath}\n`);
  yield* io.stdout(`Allowed extension origin: chrome-extension://${extensionId}/\n`);
  yield* io.stdout(`Host executable: ${hostPath}\n`);
  yield* Effect.catchAll(
    io.writeText(path.join(__dirname, "extension-id.json"), `${JSON.stringify({ extensionId, extensionHostName: hostName }, null, 2)}\n`),
    () => Effect.void
  );
}));
