#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
let node_fs = require("node:fs");
node_fs = require_Layer.__toESM(node_fs);
let node_os = require("node:os");
node_os = require_Layer.__toESM(node_os);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
let node_process = require("node:process");
node_process = require_Layer.__toESM(node_process);
let node_crypto = require("node:crypto");
node_crypto = require_Layer.__toESM(node_crypto);
//#region src/shared/install-lock.ts
/** The lock stayed held until the deadline; `holder` is its live process, or null when that is unknown. */
var InstallLockBusy = class extends Error {
	lockPath;
	holder;
	constructor(lockPath, holder) {
		super(`Another installer is using ${lockPath}${holder === null ? "" : ` (process ${holder})`}. If no installer is running, remove that directory and try again.`);
		this.lockPath = lockPath;
		this.holder = holder;
		this.name = "InstallLockBusy";
	}
};
/**
* Another user could change the lock, so it was not used: `path` is the lock or its parent directory at fault.
* With `replaced`, the lock directory this installer held is no longer at its path, and nothing was removed.
*/
var InstallLockUnsafe = class extends Error {
	lockPath;
	code = "browser-controller-unsafe-install-lock";
	path;
	constructor(lockPath, at, replaced = false) {
		super(replaced ? `The installer lock ${lockPath} was replaced while this installer held it, so nothing was removed. Make sure no other installer is running, then try again.` : `Refusing the installer lock ${lockPath}: ${at} must be a real directory owned by you that no other user can write to.`);
		this.lockPath = lockPath;
		this.name = "InstallLockUnsafe";
		this.path = at;
	}
};
var nodeFs = {
	lstat: (file) => node_fs.default.lstatSync(file),
	stat: (file) => node_fs.default.statSync(file),
	readdir: (directory) => node_fs.default.readdirSync(directory)
};
/** The lock that serializes every installer's check and replacement of one native messaging manifest. */
function manifestLockPath(manifestFile) {
	return node_path.default.join(node_path.default.dirname(manifestFile), `.${node_path.default.basename(manifestFile)}.lock`);
}
var ENTRY = /^([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Entries this process holds, so an entry left by a dead process that had this pid is still found stale. */
var held = /* @__PURE__ */ new Set();
var WRITABLE_BY_OTHERS = 18;
var STICKY = 512;
function codeOf(error) {
	return error?.code;
}
/** Windows has no POSIX owners or modes, so there only the kind and identity of the lock are checked. */
function ownerId() {
	return process.getuid?.();
}
/**
* The parent (followed if it is a symlink) must be a directory owned by this user. If group or others can write
* to it, it needs the sticky bit, so that they cannot rename or remove the lock, which must then be ours.
*/
function checkParent(lockPath, io) {
	const parent = node_path.default.dirname(lockPath);
	const stats = io.stat(parent);
	const uid = ownerId();
	const shared = (stats.mode & WRITABLE_BY_OTHERS) !== 0 && (stats.mode & STICKY) === 0;
	if (!stats.isDirectory() || uid !== void 0 && (stats.uid !== uid || shared)) throw new InstallLockUnsafe(lockPath, parent);
}
/** The identity of the lock directory, or null when nothing is at its path; anything unsafe there is refused. */
function inspect(lockPath, io) {
	let stats;
	try {
		stats = io.lstat(lockPath);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}
	const uid = ownerId();
	if (stats.isSymbolicLink() || !stats.isDirectory() || uid !== void 0 && (stats.uid !== uid || stats.mode & WRITABLE_BY_OTHERS)) throw new InstallLockUnsafe(lockPath, lockPath);
	return {
		dev: stats.dev,
		ino: stats.ino
	};
}
/** The lock path still names the directory `expected` identifies (and is still safe). */
function unchanged(lockPath, expected, io) {
	const current = inspect(lockPath, io);
	return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}
/** Whether a process may have this id: only ESRCH proves it gone (EPERM means another user's process). */
function running(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) !== "ESRCH";
	}
}
/**
* Remove the entries of processes that are gone, then the lock directory if that left it empty (rmdir removes
* only an empty directory). Only regular files named like an entry are removed, and only while the lock path
* still names the directory that was listed; if another process replaced it, the next attempt checks the new
* one. Returns a live holder's pid, or null when none is known.
*/
function clearStale(lockPath, io) {
	const listed = inspect(lockPath, io);
	if (!listed) return null;
	let names;
	try {
		names = io.readdir(lockPath);
	} catch (error) {
		if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
		throw error;
	}
	let holder = null;
	for (const name of names) {
		const match = ENTRY.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!(pid === process.pid ? !held.has(`${lockPath}\0${name}`) : !running(pid))) {
			holder = pid;
			continue;
		}
		if (!unchanged(lockPath, listed, io)) return null;
		const file = node_path.default.join(lockPath, name);
		try {
			if (io.lstat(file).isFile()) node_fs.default.unlinkSync(file);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") throw error;
		}
	}
	if (!unchanged(lockPath, listed, io)) return null;
	try {
		node_fs.default.rmdirSync(lockPath);
	} catch (error) {
		if (![
			"ENOENT",
			"ENOTEMPTY",
			"EEXIST",
			"ENOTDIR"
		].includes(codeOf(error) ?? "")) throw error;
	}
	return holder;
}
/** One attempt: the lock, or the pid of a live holder (null when unknown). */
function attempt(lockPath, io) {
	checkParent(lockPath, io);
	inspect(lockPath, io);
	const entry = `${process.pid}-${node_crypto.default.randomUUID()}`;
	const staging = `${lockPath}.${node_crypto.default.randomUUID()}.tmp`;
	node_fs.default.mkdirSync(staging, { mode: 448 });
	let created;
	try {
		created = io.lstat(staging);
		node_fs.default.closeSync(node_fs.default.openSync(node_path.default.join(staging, entry), "wx", 384));
		try {
			node_fs.default.renameSync(staging, lockPath);
		} catch (error) {
			const code = codeOf(error) ?? "";
			if (!([
				"EEXIST",
				"ENOTEMPTY",
				"ENOTDIR"
			].includes(code) || ["EPERM", "EACCES"].includes(code) && inspect(lockPath, io) !== null)) throw error;
			return { holder: clearStale(lockPath, io) };
		}
	} finally {
		node_fs.default.rmSync(staging, {
			recursive: true,
			force: true
		});
	}
	const identity = {
		dev: created.dev,
		ino: created.ino
	};
	if (!unchanged(lockPath, identity, io)) throw new InstallLockUnsafe(lockPath, lockPath, true);
	const key = `${lockPath}\0${entry}`;
	held.add(key);
	let released = false;
	return {
		path: lockPath,
		release() {
			if (released) return;
			released = true;
			held.delete(key);
			if (!unchanged(lockPath, identity, io)) throw new InstallLockUnsafe(lockPath, lockPath, true);
			try {
				node_fs.default.unlinkSync(node_path.default.join(lockPath, entry));
			} catch (error) {
				if (codeOf(error) !== "ENOENT") throw error;
			}
			if (!unchanged(lockPath, identity, io)) return;
			try {
				node_fs.default.rmdirSync(lockPath);
			} catch {}
		}
	};
}
var POLL_MS = 20;
/** The same, for the zip's synchronous installer, which has nothing else to run while it waits. */
function acquireInstallLockSync(lockPath, timeoutMs = 1e4, calls = {}) {
	const io = {
		...nodeFs,
		...calls
	};
	const deadline = performance.now() + timeoutMs;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	while (true) {
		const result = attempt(lockPath, io);
		if ("release" in result) return result;
		if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
		Atomics.wait(pause, 0, 0, POLL_MS);
	}
}
//#endregion
//#region src/scripts/install-native-host.ts
var root = node_path.default.resolve(__dirname, "..");
var hostName = "com.opzero.chrome";
var hostEntry = "native-host/host.js";
var wrapperName = node_process.default.platform === "win32" ? "browser-control-host.cmd" : "browser-control-host";
var force = node_process.default.argv.includes("--force");
/** Serializes this installer's publications into <state>/hosts; the server's own copies use .publish.lock there. */
var publishLock = ".skill-publish.lock";
/** A refusal with a message for the user; nothing is written after one. */
var InstallError = class extends Error {};
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
/** BROWSER_CONTROL_STATE_DIR, default ~/.local/state/browser-control: the same root the MCP server uses. */
function stateRoot() {
	const configured = node_process.default.env.BROWSER_CONTROL_STATE_DIR;
	if (configured && !node_path.default.isAbsolute(configured)) throw new InstallError("BROWSER_CONTROL_STATE_DIR must be an absolute path.");
	return configured ? node_path.default.normalize(configured) : node_path.default.join(node_os.default.homedir(), ".local", "state", "browser-control");
}
function isPrivate(stats) {
	return node_process.default.platform === "win32" || stats.uid === node_process.default.getuid?.() && (stats.mode & 63) === 0;
}
/** Create `dir` (mode 0700) if needed, and refuse a symlink or a directory another user could change. */
function privateDirectory(dir) {
	node_fs.default.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const stats = node_fs.default.lstatSync(dir);
	if (!stats.isDirectory() || !isPrivate(stats)) throw new InstallError(`Refusing a directory that is not private to you: ${dir}`);
	return dir;
}
/** The host entry and every chunk it requires, by path relative to the skill root. */
function hostFiles() {
	const files = /* @__PURE__ */ new Map();
	const pending = [hostEntry];
	while (pending.length) {
		const relative = pending.pop();
		if (files.has(relative)) continue;
		const data = node_fs.default.readFileSync(node_path.default.join(root, relative));
		files.set(relative, data);
		for (const match of data.toString("utf8").matchAll(/require\("(\.\.?\/[^"]+\.js)"\)/g)) {
			const required = node_path.default.posix.normalize(node_path.default.posix.join(node_path.default.posix.dirname(relative), match[1]));
			if (required.startsWith("../")) throw new InstallError(`The native host requires a file outside the skill: ${match[1]}`);
			pending.push(required);
		}
	}
	return files;
}
function digest(files) {
	const hash = node_crypto.default.createHash("sha256");
	for (const [relative, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		hash.update(`${relative}\0${data.length}\0`);
		hash.update(data);
	}
	return hash.digest("hex");
}
function listFiles(dir, prefix = "") {
	const result = [];
	for (const entry of node_fs.default.readdirSync(node_path.default.join(dir, prefix), { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) result.push(...listFiles(dir, relative));
		else result.push(relative);
	}
	return result;
}
/**
* Whether `target` is a private directory holding exactly `files`, each a private regular file with the same
* bytes. An error other than a missing target is thrown, so a copy is only ever called different once it has
* been read.
*/
function treeState(target, files) {
	let stats;
	try {
		stats = node_fs.default.lstatSync(target);
	} catch (error) {
		if (error.code === "ENOENT") return "absent";
		throw error;
	}
	if (!stats.isDirectory() || !isPrivate(stats)) return "differs";
	const present = listFiles(target);
	if (present.length !== files.size) return "differs";
	for (const relative of present) {
		const expected = files.get(relative);
		const file = node_path.default.join(target, relative);
		const entry = node_fs.default.lstatSync(file);
		if (expected === void 0 || !entry.isFile() || !isPrivate(entry) || !node_fs.default.readFileSync(file).equals(expected)) return "differs";
	}
	return "matches";
}
function writeNew(file, data, mode) {
	const fd = node_fs.default.openSync(file, node_fs.default.constants.O_WRONLY | node_fs.default.constants.O_CREAT | node_fs.default.constants.O_EXCL, mode);
	try {
		node_fs.default.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
		node_fs.default.fsyncSync(fd);
	} finally {
		node_fs.default.closeSync(fd);
	}
	node_fs.default.chmodSync(file, mode);
}
/**
* Publish `files` as <parent>/<name>/. Publications are serialized by a lock in <parent>, and the target is
* checked again under it, so a matching copy that another installer published (and Chrome may be running) is
* never moved or deleted. Returns the published directory.
*/
function publishTree(parent, name, files) {
	const target = node_path.default.join(parent, name);
	let current = null;
	try {
		current = treeState(target, files);
	} catch {}
	if (current !== "matches") {
		const lock = acquireInstallLockSync(node_path.default.join(parent, publishLock));
		try {
			const state = treeState(target, files);
			if (state !== "matches") replaceTree(parent, target, files, state === "differs");
		} finally {
			lock.release();
		}
	}
	if (treeState(target, files) !== "matches") throw new InstallError(`Could not verify the native host copy: ${target}`);
	return target;
}
/**
* Under the publish lock: stage a private directory beside `target`, then rename it into place. A copy that
* differs is moved aside first and deleted only once the new copy is in place; if the new copy cannot be
* renamed in, the old one is put back.
*/
function replaceTree(parent, target, files, moveAside) {
	const staging = node_path.default.join(parent, `.tmp-${node_crypto.default.randomUUID()}`);
	const displaced = node_path.default.join(parent, `.old-${node_crypto.default.randomUUID()}`);
	let moved = false;
	try {
		node_fs.default.mkdirSync(staging, { mode: 448 });
		for (const [relative, data] of files) {
			const file = node_path.default.join(staging, relative);
			node_fs.default.mkdirSync(node_path.default.dirname(file), {
				recursive: true,
				mode: 448
			});
			writeNew(file, data, 384);
		}
		if (moveAside) {
			node_fs.default.renameSync(target, displaced);
			moved = true;
		}
		try {
			node_fs.default.renameSync(staging, target);
		} catch (error) {
			const restore = moved;
			moved = false;
			if (restore) try {
				node_fs.default.renameSync(displaced, target);
			} catch {}
			throw error;
		}
	} finally {
		node_fs.default.rmSync(staging, {
			recursive: true,
			force: true
		});
		if (moved) node_fs.default.rmSync(displaced, {
			recursive: true,
			force: true
		});
	}
}
/** The Node running this installer, which the wrapper execs; never a PATH lookup or a fixed location. */
function nodeExecutable() {
	const node = node_process.default.execPath;
	try {
		if (!node_path.default.isAbsolute(node) || !node_fs.default.statSync(node).isFile()) throw new Error("not a file");
		if (node_process.default.platform !== "win32") node_fs.default.accessSync(node, node_fs.default.constants.X_OK);
	} catch {
		throw new InstallError(`The running Node.js is not an absolute executable file: ${node}`);
	}
	return node;
}
/** A single-quoted sh literal: `$`, backticks and backslashes stay literal; an apostrophe or control character is refused. */
function shellLiteral(value) {
	if (value.includes("'") || /[\x00-\x1f\x7f]/.test(value)) throw new InstallError(`Refusing a path with an apostrophe or a control character: ${JSON.stringify(value)}`);
	return `'${value}'`;
}
/** A value for inside double quotes in a batch file: `%` is doubled so it expands no variable. */
function cmdValue(value) {
	if (value.includes("\"") || /[\x00-\x1f\x7f]/.test(value)) throw new InstallError(`Refusing a path with a quote or a control character: ${JSON.stringify(value)}`);
	return value.replace(/%/g, "%%");
}
function launcher(node, host, socketPath) {
	if (node_process.default.platform === "win32") return `@echo off\r\n${socketPath ? `set "BROWSER_CONTROL_HOST_SOCKET=${cmdValue(socketPath)}"\r\n` : ""}"${cmdValue(node)}" "${cmdValue(host)}"\r\n`;
	return `#!/bin/sh\n${socketPath ? `export BROWSER_CONTROL_HOST_SOCKET=${shellLiteral(socketPath)}\n` : ""}exec ${shellLiteral(node)} ${shellLiteral(host)}\n`;
}
/** Replace `file` atomically with `text`: a temporary file beside it, then a rename. */
function replaceFile(file, text, mode) {
	const temporary = node_path.default.join(node_path.default.dirname(file), `.${node_path.default.basename(file)}.${node_crypto.default.randomUUID()}.tmp`);
	try {
		writeNew(temporary, text, mode);
		node_fs.default.renameSync(temporary, file);
	} finally {
		node_fs.default.rmSync(temporary, { force: true });
	}
}
/** The host an existing manifest names: undefined when there is none, null when it names none readably. */
function existingHost(manifestPath) {
	let text;
	try {
		text = node_fs.default.readFileSync(manifestPath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		return null;
	}
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed.path === "string" ? parsed.path : null;
	} catch {
		return null;
	}
}
function refuseForeign(manifestPath, wrapper) {
	const previous = existingHost(manifestPath);
	if (previous !== void 0 && previous !== wrapper && !force) throw new InstallError(`A native messaging manifest for ${hostName} already points at another host:\n  ${previous ?? "(unreadable)"}\nPass --force to replace it: ${manifestPath}`);
}
function install(extensionId, manifestPath, socketPath) {
	const node = nodeExecutable();
	const hosts = privateDirectory(node_path.default.join(privateDirectory(stateRoot()), "hosts"));
	const files = hostFiles();
	const wrapperDir = node_path.default.join(hosts, "skill");
	const wrapper = node_path.default.join(wrapperDir, wrapperName);
	const copyDir = node_path.default.join(hosts, `skill-${digest(files).slice(0, 12)}`);
	const text = launcher(node, node_path.default.join(copyDir, ...hostEntry.split("/")), socketPath);
	refuseForeign(manifestPath, wrapper);
	publishTree(hosts, node_path.default.basename(copyDir), files);
	privateDirectory(wrapperDir);
	replaceFile(wrapper, text, 448);
	const manifest = {
		name: hostName,
		description: "Browser Control native messaging host",
		type: "stdio",
		path: wrapper,
		allowed_origins: [`chrome-extension://${extensionId}/`]
	};
	node_fs.default.mkdirSync(node_path.default.dirname(manifestPath), {
		recursive: true,
		mode: 493
	});
	const lock = acquireInstallLockSync(manifestLockPath(manifestPath));
	try {
		refuseForeign(manifestPath, wrapper);
		replaceFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 420);
	} finally {
		lock.release();
	}
	return {
		wrapper,
		copyDir
	};
}
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const extensionId = require_effect_services.argValue("extension-id", node_process.default.env.BROWSER_CONTROL_EXTENSION_ID);
	if (!extensionId) {
		yield* io.stderr("Missing extension ID. Pass --extension-id <id> after loading extension/ unpacked in Chrome.\n");
		node_process.default.exitCode = 1;
		return;
	}
	const manifestPath = require_effect_services.argValue("manifest-path", chromeManifestPath());
	const socketPath = require_effect_services.argValue("socket-path", node_process.default.env.BROWSER_CONTROL_HOST_SOCKET);
	const installed = yield* require_Layer.either(require_Layer.try_({
		try: () => install(extensionId, manifestPath, socketPath),
		catch: (error) => error instanceof Error ? error : new Error(String(error))
	}));
	if (installed._tag === "Left") {
		yield* io.stderr(`${installed.left.message}\n`);
		node_process.default.exitCode = 1;
		return;
	}
	yield* registerWindowsManifest(manifestPath);
	yield* io.stdout(`Installed native messaging manifest:\n${manifestPath}\n`);
	yield* io.stdout(`Allowed extension origin: chrome-extension://${extensionId}/\n`);
	yield* io.stdout(`Host executable: ${installed.right.wrapper}\n`);
	yield* io.stdout(`Host copy: ${installed.right.copyDir}\n`);
}));
//#endregion
