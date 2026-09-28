#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/extension/manifest.json",
  "src/extension/images/icon-16.png",
  "src/extension/images/icon-32.png",
  "src/extension/images/icon-48.png",
  "src/extension/images/icon-128.png",
  "src/extension/background.ts",
  "src/extension/content-scripts/opzero-chrome.ts",
  "src/extension/popup.html",
  "src/extension/popup.ts",
  "src/native-host/host.ts",
  "src/native-host/client.ts",
  "src/scripts/install-native-host.ts",
  "src/scripts/installed-browsers.ts",
  "scripts/extension-id.example.json",
  "scripts/extension-id.store.json",
  "skills/browser-control/SKILL.md",
  "skills/browser-control/references/native-host.md",
  "skills/browser-control/native-host/client.js",
  "skills/browser-control/native-host/host.js",
  "skills/browser-control/native-host/browser-control-host",
  "skills/browser-control/scripts/install-native-host.js",
  "skills/browser-control/scripts/check-native-host-manifest.js",
  "skills/browser-control/scripts/extension-id.json",
  ".github/workflows/check.yml",
  ".github/workflows/chrome-web-store.yml",
  ".github/workflows/release.yml",
  "vitest.config.ts",
  "tests/acceptance/distribution.test.ts",
  "dist/extension/manifest.json",
  "dist/extension/images/icon-16.png",
  "dist/extension/images/icon-32.png",
  "dist/extension/images/icon-48.png",
  "dist/extension/images/icon-128.png",
  "dist/extension/background.js",
  "dist/extension/content-scripts/opzero-chrome.js",
  "dist/native-host/host.js",
  "dist/native-host/client.js",
  "dist/scripts/install-native-host.js",
  "dist/scripts/extension-id.json",
  "dist/skill/browser-control/SKILL.md",
  "dist/skill/browser-control/native-host/browser-control-host",
  "dist/skill/browser-control/scripts/install-native-host.js",
  "src/scripts/check-native-host-manifest.ts",
  "README.md",
  "docs/DEVELOPER.md",
  "docs/PRIVACY.md",
  "docs/RELEASE.md"
];

const failures = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/extension/manifest.json"), "utf8"));
const expectedPermissions = ["alarms", "debugger", "nativeMessaging", "scripting", "storage", "tabGroups", "tabs"];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) failures.push(`Manifest permissions must be exactly ${expectedPermissions.join(", ")}`);
if ("key" in manifest) failures.push("Store package manifest must not contain a key field");
if (manifest.manifest_version !== 3) failures.push("Manifest is not MV3");
if (manifest.background?.service_worker !== "background.js") failures.push("Manifest background service worker mismatch");
for (const [size, file] of Object.entries({ 16: "images/icon-16.png", 32: "images/icon-32.png", 48: "images/icon-48.png", 128: "images/icon-128.png" })) {
  if (manifest.icons?.[size] !== file) failures.push(`Manifest missing ${size}px icon`);
  if (manifest.action?.default_icon?.[size] !== file) failures.push(`Manifest action missing ${size}px icon`);
}

const extensionId = JSON.parse(fs.readFileSync(path.join(root, "dist/scripts/extension-id.json"), "utf8"));
if (extensionId.extensionId !== "dcnjjnecbhipdbngkhjppkckpkellmld") failures.push("Stable Chrome Web Store extension ID is not embedded");
if (extensionId.extensionHostName !== "com.opzero.chrome") failures.push("Stable extension host name mismatch");

for (const file of ["dist/native-host/host.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/^#!.*\n/, "");
  new Function(source);
}

for (const file of ["dist/server/cli.js", "dist/server/native-host.js", "data/public_suffix_list.dat", "data/README.md",
  "native/clipboard-guard/clipboard_guard.swift", "docs/server/DESIGN.md", "vite.server.config.ts", "scripts/check-parity.mjs"]) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing ${file}`);
}
if (fs.existsSync(path.join(root, "dist/server/cli.js"))) {
  const cli = path.join(root, "dist/server/cli.js");
  if (!fs.readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")) failures.push("dist/server/cli.js has no node shebang");
  if (process.platform !== "win32" && !(fs.statSync(cli).mode & 0o111)) failures.push("dist/server/cli.js is not executable");
}
for (const file of ["dist/server/cli.js", "dist/server/native-host.js"]) {
  if (!fs.existsSync(path.join(root, file))) continue;
  const source = fs.readFileSync(path.join(root, file), "utf8");
  // A require right after a backtick is text in ajv's standalone code generator, not a module load.
  const external = [...source.matchAll(/(?<!`)\brequire\("([^"]+)"\)/g)].map((match) => match[1]).filter((name) => !name.startsWith("node:"));
  if (external.length) failures.push(`${file} must bundle its dependencies, found require of ${[...new Set(external)].join(", ")}`);
}
if (fs.existsSync(path.join(root, "data/public_suffix_list.dat"))) {
  const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(root, "data/public_suffix_list.dat"))).digest("hex");
  if (digest !== "257b298daca42f6d8ec964e238c2a55518e14f09d3117917ec8acee6f188503e") failures.push("data/public_suffix_list.dat does not match its sha256 pin");
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.name !== "@op1/browser-control") failures.push("package.json name is not @op1/browser-control");
if (packageJson.bin?.["browser-control"] !== "dist/server/cli.js") failures.push("package.json bin browser-control must be dist/server/cli.js");
if (!Array.isArray(packageJson.files) || !packageJson.files.includes("dist/server/")) failures.push("package.json files must include dist/server/");
if (Object.keys(packageJson.dependencies || {}).length) failures.push("package.json must have no runtime dependencies; bundles include them");
if (fs.existsSync(path.join(root, "dist/extension/manifest.json")) && "key" in manifest) failures.push("dist/extension/manifest.json must not carry a key");

for (const file of ["dist/extension/background.js", "dist/extension/content-scripts/opzero-chrome.js", "dist/extension/popup.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  if (/\bimport\s/.test(source)) failures.push(`Extension bundle must be self-contained, found import in ${file}`);
}

if (failures.length) {
  process.stderr.write(`Project check failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Project check OK\n");
