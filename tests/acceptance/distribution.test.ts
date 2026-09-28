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

/** Every file under `dir` with its bytes and mode, by relative path. */
function treeContents(dir: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(dir, relative);
    if (entry.isDirectory()) Object.assign(result, treeContents(dir, relative));
    else result[relative] = `${(fs.lstatSync(file).mode & 0o7777).toString(8)} ${fs.readFileSync(file).toString("base64")}`;
  }
  return result;
}

/** Start an installed wrapper as Chrome does, wait for its socket, then close its native port (stdin). */
async function hostListens(wrapper: string, cwd: string, socket: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("BROWSER_CONTROL_")) env[key] = value;
  const child = spawn(wrapper, [], { cwd, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await expect.poll(() => fs.existsSync(socket) && fs.lstatSync(socket).isSocket(), { timeout: 5000 }).toBe(true);
  child.stdin.end();
  expect(await exited).toBe(0);
  expect(stderr).toBe("");
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

describe("Browser Control distribution", () => {
  it("builds a loadable MV3 extension with self-contained browser entrypoints", () => {
    const manifest = readJson("dist/extension/manifest.json");
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("Browser Control");
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.permissions).toEqual(expect.arrayContaining(["nativeMessaging", "debugger", "scripting", "tabs"]));
    expect(manifest.permissions).toEqual(["alarms", "debugger", "nativeMessaging", "scripting", "storage", "tabGroups", "tabs"]);
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);

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
      "dist/skill/browser-control/SKILL.md",
      "dist/skill/browser-control/references/native-host.md",
      "dist/skill/browser-control/native-host/client.js",
      "dist/skill/browser-control/native-host/host.js",
      "dist/skill/browser-control/native-host/browser-control-host",
      "dist/skill/browser-control/chunks",
      "dist/skill/browser-control/scripts/install-native-host.js",
      "dist/skill/browser-control/scripts/check-native-host-manifest.js",
      "dist/release/browser-control-extension.zip",
      "dist/release/browser-control-skill.zip"
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    const skill = fs.readFileSync(path.join(root, "dist/skill/browser-control/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: browser-control\n/);
    expect(skill).toContain("](references/native-host.md)");
    const hostScripts = fs.readFileSync(path.join(root, "dist/skill/browser-control/references/native-host.md"), "utf8");
    expect(hostScripts).toContain("node native-host/client.js ping");
    expect(hostScripts).toContain("node scripts/install-native-host.js");
    expect(skill + hostScripts).not.toContain("pnpm run client");
    expect(readJson("dist/skill/browser-control/scripts/extension-id.json")).toEqual({
      extensionId: "dcnjjnecbhipdbngkhjppkckpkellmld",
      extensionHostName: "com.opzero.chrome"
    });

    const zippedSkill = spawn("unzip", ["-l", "dist/release/browser-control-skill.zip"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let zipList = "";
    zippedSkill.stdout.setEncoding("utf8");
    zippedSkill.stdout.on("data", (chunk) => { zipList += chunk; });
    return new Promise<void>((resolve) => {
      zippedSkill.on("close", () => {
        expect(zipList).toContain("scripts/extension-id.json");
        expect(zipList).toContain("references/native-host.md");
        resolve();
      });
    });
  });

  it("keeps the GitHub skill path installable by skill-installer", () => {
    const files = [
      "skills/browser-control/SKILL.md",
      "skills/browser-control/references/native-host.md",
      "skills/browser-control/native-host/client.js",
      "skills/browser-control/native-host/host.js",
      "skills/browser-control/native-host/browser-control-host",
      "skills/browser-control/chunks",
      "skills/browser-control/scripts/install-native-host.js",
      "skills/browser-control/scripts/check-native-host-manifest.js",
      "skills/browser-control/scripts/extension-id.json"
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
    expect(readJson("skills/browser-control/scripts/extension-id.json")).toEqual({
      extensionId: "dcnjjnecbhipdbngkhjppkckpkellmld",
      extensionHostName: "com.opzero.chrome"
    });
  });

  it("installs and validates a native host manifest using the packaged skill", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const socketPath = path.join(tempDir, "browser-control.sock");
    const state = path.join(tempDir, "state");
    const skillBefore = treeContents(skillDir);

    const install = await runNode([
      path.join(skillDir, "scripts/install-native-host.js"),
      "--extension-id",
      "testextensionid",
      "--manifest-path",
      manifestPath,
      "--socket-path",
      socketPath
    ], { BROWSER_CONTROL_STATE_DIR: state });
    expect(install.stderr).toBe("");
    expect(install.code).toBe(0);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.name).toBe("com.opzero.chrome");
    expect(manifest.allowed_origins).toEqual(["chrome-extension://testextensionid/"]);
    // Chrome gets a wrapper under the state root's real path (macOS /var is a symlink), never a path inside the
    // skill it was installed from.
    const realState = path.join(fs.realpathSync(tempDir), "state");
    expect(manifest.path).toBe(path.join(realState, "hosts/skill/browser-control-host"));
    const copies = fs.readdirSync(path.join(state, "hosts")).filter((name) => name.startsWith("skill-"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^skill-[0-9a-f]{12}$/);
    const hostScript = path.join(realState, "hosts", copies[0], "native-host/host.js");
    expect(fs.readFileSync(manifest.path, "utf8")).toBe(
      `#!/bin/sh\nexport BROWSER_CONTROL_HOST_SOCKET='${socketPath}'\nexec '${process.execPath}' '${hostScript}'\n`);
    expect(fs.statSync(manifest.path).mode & 0o777).toBe(0o700);
    for (const dir of [state, path.join(state, "hosts"), path.join(state, "hosts", copies[0]), path.join(state, "hosts/skill")]) {
      expect(fs.lstatSync(dir).mode & 0o777, dir).toBe(0o700);
    }
    expect(fs.readFileSync(hostScript).equals(fs.readFileSync(path.join(skillDir, "native-host/host.js")))).toBe(true);
    expect(install.stdout).toContain(`Host copy: ${path.join(realState, "hosts", copies[0])}\n`);
    // The skill may be a stable copy under the state root or a package cache, so install writes nothing into it:
    // scripts/extension-id.json keeps the build's store ID.
    expect(treeContents(skillDir)).toEqual(skillBefore);
    expect(JSON.parse(fs.readFileSync(path.join(skillDir, "scripts/extension-id.json"), "utf8")).extensionId).toBe("dcnjjnecbhipdbngkhjppkckpkellmld");

    const check = await runNode([
      path.join(skillDir, "scripts/check-native-host-manifest.js"),
      "--extension-id",
      "testextensionid",
      "--manifest-path",
      manifestPath,
      "--json"
    ]);
    expect(check.stderr).toBe("");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).ok).toBe(true);

    // Running it again keeps the same copy and wrapper.
    const again = await runNode([path.join(skillDir, "scripts/install-native-host.js"), "--extension-id", "testextensionid",
      "--manifest-path", manifestPath, "--socket-path", socketPath], { BROWSER_CONTROL_STATE_DIR: state });
    expect(again.code).toBe(0);
    expect(fs.readdirSync(path.join(state, "hosts")).sort()).toEqual(["skill", copies[0]]);
  });

  it("starts the installed host after the skill it came from is gone", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const socketPath = path.join(tempDir, "h.sock");
    const install = await runNode([path.join(skillDir, "scripts/install-native-host.js"), "--extension-id", "testextensionid",
      "--manifest-path", manifestPath, "--socket-path", socketPath], { BROWSER_CONTROL_STATE_DIR: path.join(tempDir, "state") });
    expect(install.code).toBe(0);
    fs.rmSync(skillDir, { recursive: true, force: true });
    const { path: wrapper } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    await hostListens(wrapper, tempDir, socketPath);
  });

  it("keeps shell metacharacters in installed paths literal", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    // Relative command substitutions: evaluated, they would write p and q into the host's working directory.
    const socketPath = path.join(tempDir, "$(id>p)", "`id>q`.sock");
    const install = await runNode([path.join(skillDir, "scripts/install-native-host.js"), "--extension-id", "testextensionid",
      "--manifest-path", manifestPath, "--socket-path", socketPath], { BROWSER_CONTROL_STATE_DIR: path.join(tempDir, "$HOME `x`") });
    expect(install.stderr).toBe("");
    expect(install.code).toBe(0);
    const { path: wrapper } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(wrapper).toBe(path.join(fs.realpathSync(tempDir), "$HOME `x`", "hosts/skill/browser-control-host"));
    await hostListens(wrapper, tempDir, socketPath);
    expect(fs.readdirSync(tempDir).filter((name) => name === "p" || name === "q")).toEqual([]);
  });

  it("refuses a path that a single-quoted literal cannot hold, before writing anything", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const state = path.join(tempDir, "state");
    for (const socketPath of [path.join(tempDir, "it's.sock"), path.join(tempDir, "line\nbreak.sock")]) {
      const install = await runNode([path.join(skillDir, "scripts/install-native-host.js"), "--extension-id", "testextensionid",
        "--manifest-path", manifestPath, "--socket-path", socketPath], { BROWSER_CONTROL_STATE_DIR: state });
      expect(install.code).toBe(1);
      expect(install.stderr).toMatch(/^Refusing a path with an apostrophe or a control character: /);
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.existsSync(path.join(state, "hosts/skill"))).toBe(false);
    }
  });

  it("refuses a relative state root", async () => {
    const tempDir = testTemp();
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const install = await runNode(["dist/scripts/install-native-host.js", "--extension-id", "testextensionid", "--manifest-path", manifestPath],
      { BROWSER_CONTROL_STATE_DIR: "relative/state" });
    expect(install.code).toBe(1);
    expect(install.stderr).toBe("BROWSER_CONTROL_STATE_DIR must be an absolute path.\n");
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(fs.existsSync(path.join(root, "relative"))).toBe(false);
  });

  it("keeps a manifest that points at another host unless --force is given", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    const state = path.join(tempDir, "state");
    const foreign = `${JSON.stringify({ name: "com.opzero.chrome", path: "/opt/other/host", type: "stdio", allowed_origins: [] })}\n`;
    fs.writeFileSync(manifestPath, foreign);
    const args = [path.join(skillDir, "scripts/install-native-host.js"), "--extension-id", "testextensionid", "--manifest-path", manifestPath];
    const refused = await runNode(args, { BROWSER_CONTROL_STATE_DIR: state });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`A native messaging manifest for com.opzero.chrome already points at another host:\n  /opt/other/host\nPass --force to replace it: ${manifestPath}\n`);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(foreign);
    expect(fs.existsSync(path.join(state, "hosts/skill"))).toBe(false);

    fs.writeFileSync(manifestPath, "{ not json");
    expect((await runNode(args, { BROWSER_CONTROL_STATE_DIR: state })).stderr).toContain("already points at another host:\n  (unreadable)\n");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe("{ not json");

    const forced = await runNode([...args, "--force"], { BROWSER_CONTROL_STATE_DIR: state });
    expect(forced.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).path).toBe(path.join(fs.realpathSync(tempDir), "state/hosts/skill/browser-control-host"));
    // Its own manifest is replaced without --force.
    expect((await runNode(args, { BROWSER_CONTROL_STATE_DIR: state })).code).toBe(0);
  });

  it("reports a repair command for an invalid native host manifest", async () => {
    const tempDir = testTemp();
    const skillDir = path.join(tempDir, "browser-control");
    copyDir(path.join(root, "dist/skill/browser-control"), skillDir);
    const manifestPath = path.join(tempDir, "com.opzero.chrome.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: "com.opzero.chrome",
      description: "Browser Control native messaging host",
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
      BROWSER_CONTROL_USER_DATA_DIR: tempDir
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
      env: { ...process.env, BROWSER_CONTROL_HOST_SOCKET: path.join(tempDir, "s") },
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
      BROWSER_CONTROL_HOST_SOCKET: socketPath
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
