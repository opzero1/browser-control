import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testTemp } from "../support/temp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function copyDir(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Chrome Control distribution", () => {
  it("builds a loadable MV3 extension with self-contained browser entrypoints", () => {
    const manifest = readJson("dist/extension/manifest.json");
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("Chrome Control");
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.permissions).toEqual(expect.arrayContaining(["nativeMessaging", "debugger", "scripting", "tabs"]));
    expect(manifest.permissions).not.toEqual(expect.arrayContaining(["bookmarks", "downloads.ui", "favicon", "notifications", "readingList", "sessions", "topSites"]));

    for (const [size, file] of Object.entries({
      "16": "images/icon-16.png",
      "32": "images/icon-32.png",
      "48": "images/icon-48.png",
      "128": "images/icon-128.png"
    })) {
      expect(manifest.icons[size]).toBe(file);
      expect(manifest.action.default_icon[size]).toBe(file);
      expect(fs.existsSync(path.join(root, "dist/extension", file))).toBe(true);
    }

    for (const file of [
      "dist/extension/background.js",
      "dist/extension/content-scripts/opzero-chrome.js",
      "dist/extension/popup.js"
    ]) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source).not.toMatch(/\bimport\s/);
      const disabledTypeCheckPattern = new RegExp("@ts-" + "nocheck|@ts-" + "ignore");
      expect(source).not.toMatch(disabledTypeCheckPattern);
    }
  });

  it("packages an installable skill with native host and helper scripts", () => {
    const files = [
      "dist/skill/chrome-control/SKILL.md",
      "dist/skill/chrome-control/native-host/client.js",
      "dist/skill/chrome-control/native-host/host.js",
      "dist/skill/chrome-control/native-host/opzero-chrome-host",
      "dist/skill/chrome-control/chunks",
      "dist/skill/chrome-control/scripts/install-native-host.js",
      "dist/skill/chrome-control/scripts/check-native-host-manifest.js",
      "dist/release/opzero-chrome-extension.zip",
      "dist/release/chrome-control-skill.zip"
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    const skill = fs.readFileSync(path.join(root, "dist/skill/chrome-control/SKILL.md"), "utf8");
    expect(skill).toContain("node native-host/client.js ping");
    expect(skill).toContain("@chrome-control");
    expect(skill).not.toContain("pnpm run client");
    expect(readJson("dist/skill/chrome-control/scripts/extension-id.json")).toEqual({
      extensionId: "dcnjjnecbhipdbngkhjppkckpkellmld",
      extensionHostName: "com.opzero.chrome"
    });

    const zippedSkill = spawn("unzip", ["-l", "dist/release/chrome-control-skill.zip"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let zipList = "";
    zippedSkill.stdout.setEncoding("utf8");
    zippedSkill.stdout.on("data", (chunk) => { zipList += chunk; });
    return new Promise<void>((resolve) => {
      zippedSkill.on("close", () => {
        expect(zipList).toContain("scripts/extension-id.json");
        resolve();
      });
    });
  });

  it("keeps the GitHub skill path installable by skill-installer", () => {
    const files = [
      "skills/chrome-control/SKILL.md",
      "skills/chrome-control/native-host/client.js",
      "skills/chrome-control/native-host/host.js",
      "skills/chrome-control/native-host/opzero-chrome-host",
      "skills/chrome-control/chunks",
      "skills/chrome-control/scripts/install-native-host.js",
      "skills/chrome-control/scripts/check-native-host-manifest.js",
      "skills/chrome-control/scripts/extension-id.json"
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    expect(readJson("skills/chrome-control/scripts/extension-id.json")).toEqual({
      extensionId: "dcnjjnecbhipdbngkhjppkckpkellmld",
      extensionHostName: "com.opzero.chrome"
    });
  });

  it("installs and validates a native host manifest using the packaged skill", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "chrome-control");
    copyDir(path.join(root, "dist/skill/chrome-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const socketPath = path.join(tempDir, "opzero-chrome.sock");

    const install = await runNode([
      path.join(skillDir, "scripts/install-native-host.js"),
      "--extension-id",
      "testextensionid",
      "--manifest-path",
      manifestPath,
      "--socket-path",
      socketPath
    ]);
    expect(install.stderr).toBe("");
    expect(install.code).toBe(0);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.name).toBe("com.opzero.chrome");
    expect(manifest.allowed_origins).toContain("chrome-extension://testextensionid/");
    expect(fs.existsSync(manifest.path)).toBe(true);
    expect(fs.readFileSync(manifest.path, "utf8")).toContain(`OPZERO_CHROME_HOST_SOCKET="${socketPath}"`);
    expect(JSON.parse(fs.readFileSync(path.join(skillDir, "scripts/extension-id.json"), "utf8")).extensionId).toBe("testextensionid");

    const check = await runNode([
      path.join(skillDir, "scripts/check-native-host-manifest.js"),
      "--manifest-path",
      manifestPath,
      "--json"
    ]);
    expect(check.stderr).toBe("");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).ok).toBe(true);
  });

  it("reports a repair command for an invalid native host manifest", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "chrome-control");
    copyDir(path.join(root, "dist/skill/chrome-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: "com.opzero.chrome",
      description: "Opzero Chrome native messaging host",
      type: "stdio",
      path: process.execPath,
      allowed_origins: []
    }, null, 2)}\n`);

    const check = await runNode([
      path.join(skillDir, "scripts/check-native-host-manifest.js"),
      "--extension-id",
      "testextensionid",
      "--manifest-path",
      manifestPath,
      "--json"
    ]);
    expect(check.stderr).toBe("");
    expect(check.code).toBe(1);
    const result = JSON.parse(check.stdout);
    expect(result.failures).toContain("Missing allowed origin chrome-extension://testextensionid/");
    expect(result.repairCommand).toEqual([
      process.execPath,
      fs.realpathSync(path.join(skillDir, "scripts/install-native-host.js")),
      "--extension-id",
      "testextensionid",
      "--manifest-path",
      manifestPath
    ]);
  });

  it("detects extensions registered in Chrome Secure Preferences", async () => {
    const tempDir = testTemp();
    const profileDir = path.join(tempDir, "Default");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "Local State"), `${JSON.stringify({ profile: { last_used: "Default" } })}\n`);
    fs.writeFileSync(path.join(profileDir, "Preferences"), `${JSON.stringify({ extensions: { settings: {} } })}\n`);
    fs.writeFileSync(path.join(profileDir, "Secure Preferences"), `${JSON.stringify({
      extensions: {
        settings: {
          testextensionid: {
            disable_reasons: 0,
            manifest: { version: "1.2.3" }
          }
        }
      }
    })}\n`);

    const check = await runNode([
      "dist/scripts/check-extension-installed.js",
      "--extension-id",
      "testextensionid",
      "--json"
    ], {
      OPZERO_CHROME_USER_DATA_DIR: tempDir
    });
    expect(check.stderr).toBe("");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({
      ok: true,
      status: "enabled",
      settingsPath: path.join(profileDir, "Secure Preferences"),
      version: "1.2.3"
    });
  });

  it("responds to native messaging ping frames", async () => {
    const tempDir = testTemp();
    const child = spawn(process.execPath, ["dist/native-host/host.js"], {
      cwd: root,
      env: { ...process.env, OPZERO_CHROME_HOST_SOCKET: path.join(tempDir, "s") },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("native host ping timed out"));
      }, 2000);

      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          const length = buffer.readUInt32LE(0);
          const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
          buffer = buffer.subarray(4 + length);
          if (message.method === "getInfo") {
            const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 2 } }));
            const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
            child.stdin.write(Buffer.concat([header, body]));
            continue;
          }
          clearTimeout(timeout);
          child.kill();
          resolve(message);
        }
      });
      child.on("error", reject);

      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      child.stdin.write(Buffer.concat([header, body]));
    });

    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
  });

  it("lets pnpm-style script forwarding call the built client", async () => {
    const socketPath = path.join(os.tmpdir(), "opencode", `oc-${process.pid}.sock`);
    fs.rmSync(socketPath, { force: true });

    const server = net.createServer();
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("client command timed out"));
      }, 2000);

      server.on("connection", (socket) => {
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          clearTimeout(timeout);
          const request = JSON.parse(chunk.trim());
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "pong" })}\n`);
          socket.end();
          resolve(request);
        });
      });
      server.on("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, resolve);
      server.on("error", reject);
    });

    const client = await runNode(["dist/native-host/client.js", "--", "ping"], {
      OPZERO_CHROME_HOST_SOCKET: socketPath
    });
    const request = await received;
    server.close();
    fs.rmSync(socketPath, { force: true });

    expect(client.stderr).toBe("");
    expect(client.code).toBe(0);
    expect(JSON.parse(client.stdout)).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
    expect(request).toMatchObject({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  });
});
