// config.ts, session.ts, assets.ts and stable-copy.ts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAssets, type PackageAssets } from "../../../src/server/assets";
import {
  allowLoopback, envLimit, HOST_SOCKET_ENV, HOST_WRAPPER_NAME, ISOLATED_EXTENSION_ID, ISOLATED_EXTENSION_KEY, nodeExecutable,
  resolveCuaDriver, SERVER_NAME, statePaths, STORE_EXTENSION_ID, unsharedSites, userArtifactRoot, userSocket, whichExecutable
} from "../../../src/server/config";
import { openDirectory } from "../../../src/server/fs-private";
import { Gate } from "../../../src/server/gate";
import { processSessionId, sessionFromMeta } from "../../../src/server/session";
import {
  clipboardGuardBinary, ensureStableExtension, ensureStableHost, extensionIdFromKey, hostWrapper, PUBLISH_LOCK, publishTree, treeMatches,
  unpackedExtensionId
} from "../../../src/server/stable-copy";
import { killChildren, startChild } from "../support/children";
import { publishFixture } from "../support/publish-fixture";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";

afterEach(() => {
  killChildren();
  removeTempRoots();
});

function gateCode(body: () => unknown): string | null {
  try {
    body();
    return null;
  } catch (error) {
    if (error instanceof Gate) return error.code;
    throw error;
  }
}

function executable(file: string, text = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o700 });
  return file;
}

describe("names and state paths", () => {
  it("keeps one state root, defaulting under the home directory", () => {
    const root = privateTemp();
    const home = path.join(root, "home");
    const paths = statePaths({ HOME: home });
    expect(paths.root).toBe(path.join(home, ".local/state/browser-control"));
    expect(statePaths({ HOME: home, BROWSER_CONTROL_STATE_DIR: "/srv/state/" })).toEqual({
      root: "/srv/state/", registry: "/srv/state/pool/registry", controllers: "/srv/state/pool/controllers",
      sockets: "/srv/state/sockets", hosts: "/srv/state/hosts", extensions: "/srv/state/extensions", artifacts: "/srv/state/artifacts",
      userArtifacts: "/srv/state/artifacts/user", locks: "/srv/state/locks", bin: "/srv/state/bin"
    });
    expect(gateCode(() => statePaths({ BROWSER_CONTROL_STATE_DIR: "relative/state" }))).toBe("browser-control-invalid-state-dir");
    // Every path lives under the one state root, so nothing lands in an agent client's configuration (C4).
    for (const value of Object.values(paths)) expect(value.startsWith(paths.root)).toBe(true);
    expect(SERVER_NAME).toBe("browser-control");
  });

  it("routes the user's Chrome through the renamed host socket variable (D19)", () => {
    expect(HOST_SOCKET_ENV).toBe("BROWSER_CONTROL_HOST_SOCKET");
    expect(HOST_WRAPPER_NAME).toBe("browser-control-host");
    expect(userSocket({ HOME: "/h", BROWSER_CONTROL_HOST_SOCKET: "/run/x.sock" })).toBe("/run/x.sock");
    expect(userSocket({ HOME: "/h", OPZERO_CHROME_HOST_SOCKET: "/run/old.sock" })).toBe("/h/.opzero-chrome/default.sock");
    expect(userArtifactRoot({ HOME: "/h", FAST_CHROME_ARTIFACT_ROOT: "/a" })).toEqual({ root: "/a", explicit: true });
    expect(userArtifactRoot({ HOME: "/h" })).toEqual({ root: "/h/.local/state/browser-control/artifacts/user", explicit: false });
    expect(allowLoopback({ FAST_CHROME_ALLOW_LOOPBACK: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1"]) expect(allowLoopback({ FAST_CHROME_ALLOW_LOOPBACK: value })).toBe(false);
  });

  it("reads unshared sites from FAST_CHROME_UNSHARED_SITES, default none, failing closed", () => {
    expect([...unsharedSites({})]).toEqual([]);
    expect([...unsharedSites({ FAST_CHROME_UNSHARED_SITES: "" })]).toEqual([]);
    expect([...unsharedSites({ FAST_CHROME_UNSHARED_SITES: " example.global , ,example.co.uk" })]).toEqual(["example.global", "example.co.uk"]);
    for (const bad of ["staging.example.global", "Example.Global", "https://example.global/", "a..b", "[::1]"]) {
      expect(gateCode(() => unsharedSites({ FAST_CHROME_UNSHARED_SITES: bad }))).toBe("browser-controller-invalid-unshared-sites");
    }
  });

  it("parses limits like browser_pool.limit", () => {
    const limit = (value: string | undefined) => envLimit("FAST_CHROME_MAX_CONTROLLERS", 3, 8, { FAST_CHROME_MAX_CONTROLLERS: value });
    expect(limit(undefined)).toBe(3);
    expect(limit("")).toBe(3);
    expect(limit("  ")).toBe(3);
    expect(limit(" 5 ")).toBe(5);
    expect(limit("0")).toBe(1);
    expect(limit("-4")).toBe(1);
    expect(limit("9999")).toBe(8);
    expect(limit("0007")).toBe(7);
    expect(limit("\u0666")).toBe(6);
    for (const bad of ["10000", "+3", "3.0", "1e1", "abc", "--1", "3 4"]) expect(gateCode(() => limit(bad))).toBe("browser-controller-invalid-limit");
  });

  it("resolves cua-driver from CUA_DRIVER, then PATH, then ~/.local/bin (C1)", () => {
    const root = privateTemp();
    const home = path.join(root, "home");
    const fallback = executable(path.join(home, ".local/bin/cua-driver"));
    const onPath = executable(path.join(root, "bin/cua-driver"));
    const explicit = executable(path.join(root, "explicit/cua"));
    fs.writeFileSync(path.join(root, "plain"), "", { mode: 0o600 });
    expect(resolveCuaDriver({ HOME: home, PATH: `relative:${path.dirname(onPath)}`, CUA_DRIVER: explicit })).toBe(explicit);
    expect(resolveCuaDriver({ HOME: home, PATH: path.dirname(onPath), CUA_DRIVER: path.join(root, "plain") })).toBeNull();
    expect(resolveCuaDriver({ HOME: home, PATH: path.dirname(onPath), CUA_DRIVER: "cua" })).toBeNull();
    expect(resolveCuaDriver({ HOME: home, PATH: `relative:${path.dirname(onPath)}` })).toBe(onPath);
    expect(resolveCuaDriver({ HOME: home, PATH: "relative" })).toBe(fallback);
    fs.rmSync(fallback);
    expect(resolveCuaDriver({ HOME: home, PATH: "" })).toBeNull();
    expect(whichExecutable("cua-driver", { PATH: `bin:${path.dirname(onPath)}` })).toBe(onPath);
  });

  it("uses the running Node for wrappers (C2)", () => {
    expect(nodeExecutable()).toBe(process.execPath);
  });
});

describe("session identity (C7, D9)", () => {
  it("reads OpenCode's key first, then sessionID, and falls back to one process ID when both are absent", () => {
    expect(sessionFromMeta({ "ai.opencode/sessionID": "ses_a", sessionID: "ses_b" })).toBe("ses_a");
    expect(sessionFromMeta({ sessionID: "ses_b" })).toBe("ses_b");
    expect(sessionFromMeta({ "ai.opencode/sessionID": "", sessionID: "ses_b" })).toBe("ses_b");
    const fallback = processSessionId();
    expect(fallback).toMatch(/^ses_[0-9a-f]{32}$/);
    for (const meta of [undefined, null, {}, { other: 1 }, { sessionID: null }, { "ai.opencode/sessionID": null, sessionID: null }, "x", []]) {
      expect(sessionFromMeta(meta)).toBe(fallback);
    }
    expect(processSessionId()).toBe(fallback);
  });

  it("still refuses a present identity that is not a non-empty string", () => {
    for (const meta of [{ sessionID: "" }, { sessionID: 5 }, { "ai.opencode/sessionID": 7 }, { "ai.opencode/sessionID": "" },
      { "ai.opencode/sessionID": false, sessionID: [] }, { sessionID: { id: "ses_x" } }]) {
      expect(gateCode(() => sessionFromMeta(meta)), JSON.stringify(meta)).toBe("fast-chrome-session-required");
    }
  });
});

function fakeAssets(root: string, version = "1.2.3"): PackageAssets {
  const extensionDir = path.join(root, "package/dist/extension");
  fs.mkdirSync(path.join(extensionDir, "images"), { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Browser Control", version }));
  fs.writeFileSync(path.join(extensionDir, "background.js"), "void 0;\n");
  fs.writeFileSync(path.join(extensionDir, "images/icon.png"), Buffer.from([0x89, 0x50]));
  const nativeHost = path.join(root, "package/dist/server/native-host.js");
  fs.mkdirSync(path.dirname(nativeHost), { recursive: true });
  fs.writeFileSync(nativeHost, "process.exit(0);\n");
  const swift = path.join(root, "package/native/clipboard_guard.swift");
  fs.mkdirSync(path.dirname(swift), { recursive: true });
  fs.writeFileSync(swift, "// synthetic\n");
  return { root: path.join(root, "package"), extensionDir, nativeHost, publicSuffixList: path.join(root, "psl"), clipboardGuardSource: swift, version };
}

describe("packaged assets and stable copies (C3, Q1)", () => {
  it("finds the packaged files from the module directory", () => {
    const assets = packageAssets();
    expect(fs.existsSync(assets.publicSuffixList)).toBe(true);
    expect(fs.existsSync(assets.clipboardGuardSource)).toBe(true);
    expect(fs.existsSync(path.join(assets.extensionDir, "manifest.json"))).toBe(true);
    expect(assets.version).toBe(JSON.parse(fs.readFileSync(path.join(assets.root, "package.json"), "utf8")).version);
  });

  it("copies the native host once into a versioned, digest-named private directory", async () => {
    const root = privateTemp();
    const env = testEnv(root);
    const assets = fakeAssets(root);
    const first = await ensureStableHost(env, assets);
    expect(first.dir).toBe(path.join(root, "state/hosts", `1.2.3-${first.digest.slice(0, 12)}`));
    expect(fs.readFileSync(first.hostScript, "utf8")).toBe("process.exit(0);\n");
    expect(fs.statSync(first.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(first.hostScript).mode & 0o777).toBe(0o600);
    const inode = fs.statSync(first.hostScript).ino;
    expect(await ensureStableHost(env, assets)).toEqual(first);
    expect(fs.statSync(first.hostScript).ino).toBe(inode);
    fs.chmodSync(first.hostScript, 0o600);
    fs.writeFileSync(first.hostScript, "tampered");
    const repaired = await ensureStableHost(env, assets);
    expect(fs.readFileSync(repaired.hostScript, "utf8")).toBe("process.exit(0);\n");
    fs.writeFileSync(assets.nativeHost, "process.exit(1);\n");
    const upgraded = await ensureStableHost(env, assets);
    expect(upgraded.dir).not.toBe(first.dir);
    expect(fs.existsSync(first.hostScript)).toBe(true);
    expect(fs.readdirSync(path.join(root, "state/hosts")).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(first.hostScript.includes(assets.root)).toBe(false);
  });

  it("gives the isolated copy the fixed key and its recomputed ID, never the source manifest", async () => {
    expect(extensionIdFromKey(ISOLATED_EXTENSION_KEY)).toBe(ISOLATED_EXTENSION_ID);
    expect(ISOLATED_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(ISOLATED_EXTENSION_ID).not.toBe(STORE_EXTENSION_ID);
    const der = Buffer.from(ISOLATED_EXTENSION_KEY, "base64");
    expect(der.length).toBe(294);
    const root = privateTemp();
    const env = testEnv(root);
    const assets = fakeAssets(root);
    const copy = await ensureStableExtension(env, assets);
    expect(copy.id).toBe(ISOLATED_EXTENSION_ID);
    expect(copy.origin).toBe(`chrome-extension://${ISOLATED_EXTENSION_ID}/`);
    expect(copy.dir.startsWith(path.join(root, "state/extensions/1.2.3-"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(copy.dir, "manifest.json"), "utf8"));
    expect(manifest.key).toBe(ISOLATED_EXTENSION_KEY);
    expect(manifest.name).toBe("Browser Control");
    expect(JSON.parse(fs.readFileSync(path.join(assets.extensionDir, "manifest.json"), "utf8")).key).toBeUndefined();
    expect(fs.readFileSync(path.join(copy.dir, "images/icon.png"))).toEqual(Buffer.from([0x89, 0x50]));
    expect(await ensureStableExtension(env, assets)).toEqual(copy);
    const source = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../src/extension/manifest.json"), "utf8"));
    expect(source.key).toBeUndefined();
  });

  it("publishes one copy when processes race, never replacing a copy another process already uses", async () => {
    const root = privateTemp();
    const parent = path.join(root, "state/extensions");
    openDirectory(parent);
    const barrier = path.join(root, "go");
    const children = Array.from({ length: 6 }, () => startChild("child-foundation", ["publish", parent, "1.2.3-race", "120", barrier]));
    // Every child is waiting at the barrier before any publishes, so all of them find the copy missing.
    expect(await Promise.all(children.map((child) => child.line(10000)))).toEqual(children.map(() => "waiting"));
    fs.writeFileSync(barrier, "");
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(children.map((child) => child.stderr())).toEqual(children.map(() => ""));
    expect(codes).toEqual(children.map(() => 0));
    const lines = await Promise.all(children.map((child) => child.line(1000)));
    const inode = fs.lstatSync(path.join(parent, "1.2.3-race")).ino;
    expect(lines).toEqual(children.map(() => `published ${inode} true`));
    expect(treeMatches(path.join(parent, "1.2.3-race"), publishFixture(120))).toBe(true);
    expect(fs.readdirSync(parent).filter((name) => name.startsWith(".tmp-") || name.startsWith(".old-"))).toEqual([]);
  }, 30000);

  it("waits for a publication in progress and keeps the copy it published", async () => {
    const root = privateTemp();
    const parent = openDirectory(path.join(root, "state/hosts"));
    const files = publishFixture(8);
    const barrier = path.join(root, "released");
    // Another publisher holds the parent's publication lock; it has seen the copy missing and is writing it.
    const holder = startChild("child-foundation", ["lock", parent.path, PUBLISH_LOCK, "exclusive", "hold", barrier]);
    expect(await holder.line()).toBe("held");
    let settled = false;
    const waiting = publishTree(parent, "1.2.3-host", files).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    expect(fs.existsSync(path.join(parent.path, "1.2.3-host"))).toBe(false);
    // The other publisher's copy lands (same content-addressed name), then it releases the lock.
    const other = path.join(parent.path, "1.2.3-host");
    for (const [relative, data] of files) {
      fs.mkdirSync(path.dirname(path.join(other, relative)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(other, relative), data, { mode: 0o600 });
    }
    const inode = fs.lstatSync(other).ino;
    fs.writeFileSync(barrier, "");
    expect(await holder.exited).toBe(0);
    expect(await waiting).toBe(other);
    expect(fs.lstatSync(other).ino).toBe(inode);
    expect(treeMatches(other, files)).toBe(true);
    expect(fs.readdirSync(parent.path).filter((name) => name.startsWith(".tmp-") || name.startsWith(".old-"))).toEqual([]);
  }, 15000);

  it("computes Chrome's unpacked extension ID like extension-id.py", () => {
    // Chrome hashes the absolute path. This rule reproduced pncpgnbanebkeopjghjleodgmphmmmcp, the ID Chrome gave the
    // Python server's unpacked install (DESIGN.md Q1). These synthetic paths' IDs were computed with Python's hashlib.
    expect(unpackedExtensionId("/opt/example/fast-chrome/op-chrome/dist/extension")).toBe("njadkfllbdcoolfneagencmbnffkfobb");
    expect(unpackedExtensionId("/home/tester/.local/state/browser-control/extensions/0.2.1-000000000000")).toBe("omiglbfgkbgjgddlnfmnpnnkmfmbmhlk");
  });

  it("writes the host wrapper text and refuses unsafe paths", () => {
    expect(hostWrapper("/s/isolated-1.sock", "/h/native-host.js", "/n/node")).toBe(
      "#!/bin/sh\nexport BROWSER_CONTROL_HOST_SOCKET='/s/isolated-1.sock'\nexec '/n/node' '/h/native-host.js'\n");
    for (const [socket, host, node] of [["/s/'x", "/h", "/n"], ["/s", "/h\n", "/n"], ["/s", "/h", "/n\x7f"]]) {
      expect(gateCode(() => hostWrapper(socket, host, node))).toBe("browser-controller-unsafe-path");
    }
  });

  it("names the clipboard guard after its source digest", () => {
    const root = privateTemp();
    const assets = fakeAssets(root);
    const binary = clipboardGuardBinary(testEnv(root), assets);
    expect(binary).toMatch(new RegExp(`^${path.join(root, "state/bin")}/clipboard-guard-[0-9a-f]{12}$`));
    fs.writeFileSync(assets.clipboardGuardSource, "// changed\n");
    expect(clipboardGuardBinary(testEnv(root), assets)).not.toBe(binary);
  });

  it("runs the stable host with the renamed socket variable", async () => {
    const root = privateTemp();
    const env = testEnv(root);
    const host = await ensureStableHost(env);
    const socket = path.join(root, "h.sock");
    const wrapperFile = path.join(root, HOST_WRAPPER_NAME);
    fs.writeFileSync(wrapperFile, hostWrapper(socket, host.hostScript, nodeExecutable()), { mode: 0o700 });
    // The host listens on the wrapper's socket, ignores the retired variable, and exits when its stdin
    // (Chrome's native port) closes.
    const child = spawn(wrapperFile, [], { env: { ...env, OPZERO_CHROME_HOST_SOCKET: path.join(root, "old.sock") }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await expect.poll(() => fs.existsSync(socket) && fs.lstatSync(socket).isSocket(), { timeout: 5000 }).toBe(true);
    expect(fs.existsSync(path.join(root, "old.sock"))).toBe(false);
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
  }, 15000);
});
