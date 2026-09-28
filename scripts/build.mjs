#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import childProcess from "node:child_process";

const root = process.cwd();
const dist = path.join(root, "dist");

function run(command, args) {
  childProcess.execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else copyFile(source, target);
  }
}

function writeExecutable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}

function zipDir(sourceDir, zipPath) {
  try {
    fs.rmSync(zipPath, { force: true });
    childProcess.execFileSync("zip", ["-qr", zipPath, "."], { cwd: sourceDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

fs.rmSync(dist, { recursive: true, force: true });

for (const [index, entry] of ["background", "content-scripts/opzero-chrome", "popup"].entries()) {
  childProcess.execFileSync("pnpm", ["exec", "vite", "build", "--config", "vite.extension.config.ts"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      OPZERO_EXTENSION_ENTRY: entry,
      OPZERO_EXTENSION_EMPTY: index === 0 ? "1" : "0"
    }
  });
}
copyFile("src/extension/manifest.json", "dist/extension/manifest.json");
copyFile("src/extension/popup.html", "dist/extension/popup.html");
copyFile("src/extension/popup.css", "dist/extension/popup.css");
copyDir("src/extension/images", "dist/extension/images");

run("pnpm", ["exec", "vite", "build", "--config", "vite.node.config.ts"]);
for (const entry of ["cli", "native-host"]) {
  childProcess.execFileSync("pnpm", ["exec", "vite", "build", "--config", "vite.server.config.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BROWSER_CONTROL_SERVER_ENTRY: entry }
  });
}
if (process.platform !== "win32") fs.chmodSync("dist/server/cli.js", 0o755);
writeExecutable("dist/native-host/opzero-chrome-host", `#!/usr/bin/env sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/host.js"
fi
if [ -x /opt/homebrew/bin/node ]; then
  exec /opt/homebrew/bin/node "$SCRIPT_DIR/host.js"
fi
if [ -x /usr/local/bin/node ]; then
  exec /usr/local/bin/node "$SCRIPT_DIR/host.js"
fi
echo "Unable to find node executable for opzero-chrome-host" >&2
exit 127
`);
writeExecutable("dist/native-host/opzero-chrome-host.cmd", `@echo off
node "%~dp0host.js"
`);
copyFile("scripts/extension-id.example.json", "dist/scripts/extension-id.example.json");
if (process.env.OPZERO_CHROME_EXTENSION_ID) {
  fs.writeFileSync("dist/scripts/extension-id.json", `${JSON.stringify({
    extensionId: process.env.OPZERO_CHROME_EXTENSION_ID,
    extensionHostName: "com.opzero.chrome"
  }, null, 2)}\n`);
} else if (fs.existsSync("scripts/extension-id.store.json")) {
  copyFile("scripts/extension-id.store.json", "dist/scripts/extension-id.json");
}

function syncInstallableSkill(skillDir) {
  fs.mkdirSync(skillDir, { recursive: true });
  copyFile("skills/chrome-control/SKILL.md", path.join(skillDir, "SKILL.md"));
  for (const generatedPath of ["native-host", "scripts", "chunks"]) {
    fs.rmSync(path.join(skillDir, generatedPath), { recursive: true, force: true });
  }
  copyDir("dist/native-host", path.join(skillDir, "native-host"));
  copyDir("dist/scripts", path.join(skillDir, "scripts"));
  if (fs.existsSync(path.join(dist, "chunks"))) copyDir("dist/chunks", path.join(skillDir, "chunks"));
}

const sourceSkill = path.join(root, "skills", "chrome-control");
const skillDist = path.join(dist, "skill", "chrome-control");
syncInstallableSkill(sourceSkill);
syncInstallableSkill(skillDist);

fs.mkdirSync(path.join(dist, "release"), { recursive: true });
zipDir(path.join(dist, "extension"), path.join(dist, "release", "browser-control-extension.zip"));
zipDir(skillDist, path.join(dist, "release", "chrome-control-skill.zip"));

process.stdout.write("Built dist/extension and dist/skill/chrome-control\n");
