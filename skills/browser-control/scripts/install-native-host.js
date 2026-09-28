#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
const require_trusted_path = require("../chunks/trusted-path-DPFFlwYe.js");
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
function unsafeMessage(lockPath, at, fault, replaced) {
	if (replaced && fault === "lock") return `The installer lock ${lockPath} was replaced while this installer held it, so nothing was removed. Make sure no other installer is running, then try again.`;
	if (replaced) return `The directory ${at} that holds the installer lock ${lockPath} was replaced while this installer used it, so nothing was removed. Make sure no other installer is running, then try again.`;
	if (fault === "lock") return `Refusing the installer lock ${lockPath}: ${at} must be a real directory owned by you that no other user can write to.`;
	return `Refusing the installer lock ${lockPath}: ${at} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.`;
}
/**
* Another user could change the lock, so it was not used: `path` is the lock, or the directory above it, at
* fault. With `replaced`, that directory is no longer the one this installer checked, and nothing was removed.
*/
var InstallLockUnsafe = class extends Error {
	lockPath;
	code = "browser-controller-unsafe-install-lock";
	path;
	constructor(lockPath, at, fault = "lock", replaced = false) {
		super(unsafeMessage(lockPath, at, fault, replaced));
		this.lockPath = lockPath;
		this.name = "InstallLockUnsafe";
		this.path = at;
	}
};
var nodeFs = {
	lstat: (file) => node_fs.default.lstatSync(file),
	readdir: (directory) => node_fs.default.readdirSync(directory),
	readlink: (file) => node_fs.default.readlinkSync(file)
};
/** The lock that serializes every installer's check and replacement of one native messaging manifest. */
function manifestLockPath(manifestFile) {
	return node_path.default.join(node_path.default.dirname(manifestFile), `.${node_path.default.basename(manifestFile)}.lock`);
}
var ENTRY = /^([1-9][0-9]{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Entries this process holds, so an entry left by a dead process that had this pid is still found stale. */
var held = /* @__PURE__ */ new Set();
var WRITABLE_BY_OTHERS$1 = 18;
function codeOf$1(error) {
	return error?.code;
}
/** Windows has no POSIX owners or modes, so there only the kind and identity of each directory are checked. */
function ownerId() {
	return process.getuid?.();
}
/** Whether `file`, not followed, is still what `expected` identifies; a missing file is not. */
function unchangedAt(file, expected, calls = {}) {
	let stats;
	try {
		stats = (calls.lstat ?? nodeFs.lstat)(file);
	} catch (error) {
		if (codeOf$1(error) === "ENOENT" || codeOf$1(error) === "ENOTDIR") return false;
		throw error;
	}
	return !stats.isSymbolicLink() && stats.dev === expected.dev && stats.ino === expected.ino;
}
/**
* Whether `given` still passes the trusted-path rule and leads to `directory`, which still has the identity it
* was checked with. An installer checks this just before it renames a file into `directory`: the given path is
* the one Chrome reads.
*/
function stillResolves(given, directory, calls = {}) {
	const io = {
		...nodeFs,
		...calls
	};
	if (!unchangedAt(directory.path, directory, io)) return false;
	try {
		const again = require_trusted_path.trustedPath(given, { calls: io });
		return !("unsafe" in again) && again.path === directory.path && again.dev === directory.dev && again.ino === directory.ino;
	} catch (error) {
		if (codeOf$1(error) === void 0) throw error;
		return false;
	}
}
/** What `stats` says `file` is, as this process made it. */
function created(file, stats) {
	return {
		path: file,
		dev: stats.dev,
		ino: stats.ino,
		directory: stats.isDirectory()
	};
}
/**
* Remove `items` in order, each only while `within` (when given) and the item's own path are still what was
* recorded: a file is unlinked, and a directory removed with rmdir, which fails unless it is empty. The first
* mismatch or failure stops the removal and leaves the rest, which is harmless. Returns whether all were removed.
*/
function removeCreated(items, within, calls = {}) {
	for (const item of items) try {
		if (within && !unchangedAt(within.path, within, calls) || !unchangedAt(item.path, item, calls)) return false;
		if (item.directory) node_fs.default.rmdirSync(item.path);
		else node_fs.default.unlinkSync(item.path);
	} catch (error) {
		if (codeOf$1(error) === void 0) throw error;
		return false;
	}
	return true;
}
/** The identity of the lock directory, or null when nothing is at its path; anything unsafe there is refused. */
function inspect(lockPath, lock, io) {
	let stats;
	try {
		stats = io.lstat(lock);
	} catch (error) {
		if (codeOf$1(error) === "ENOENT") return null;
		throw error;
	}
	const uid = ownerId();
	if (stats.isSymbolicLink() || !stats.isDirectory() || uid !== void 0 && (stats.uid !== uid || stats.mode & WRITABLE_BY_OTHERS$1)) throw new InstallLockUnsafe(lockPath, lock);
	return {
		dev: stats.dev,
		ino: stats.ino
	};
}
/** The parent is still the directory that was checked; otherwise nothing more is done in it. */
function keepParent(lockPath, parent, io) {
	if (!unchangedAt(parent.path, parent, io)) throw new InstallLockUnsafe(lockPath, parent.path, "directory", true);
}
/** The parent and the lock path still name the directories `parent` and `expected` identify (and are still safe). */
function unchanged(lockPath, lock, expected, parent, io) {
	if (!unchangedAt(parent.path, parent, io)) return false;
	const current = inspect(lockPath, lock, io);
	return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}
/** Whether a process may have this id: only ESRCH proves it gone (EPERM means another user's process). */
function running(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf$1(error) !== "ESRCH";
	}
}
/**
* Remove the entries of processes that are gone, then the lock directory if that left it empty (rmdir removes
* only an empty directory). Only regular files named like an entry are removed, and only while the parent and
* the lock path still name the directories that were checked and listed; if another process replaced the lock,
* the next attempt checks the new one. Returns a live holder's pid, or null when none is known.
*/
function clearStale(lockPath, lock, parent, io) {
	const listed = inspect(lockPath, lock, io);
	if (!listed) return null;
	let names;
	try {
		names = io.readdir(lock);
	} catch (error) {
		if (codeOf$1(error) === "ENOENT" || codeOf$1(error) === "ENOTDIR") return null;
		throw error;
	}
	let holder = null;
	for (const name of names) {
		const match = ENTRY.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!(pid === process.pid ? !held.has(`${lock}\0${name}`) : !running(pid))) {
			holder = pid;
			continue;
		}
		const file = node_path.default.join(lock, name);
		try {
			if (!io.lstat(file).isFile()) continue;
			if (!unchanged(lockPath, lock, listed, parent, io)) return null;
			node_fs.default.unlinkSync(file);
		} catch (error) {
			if (codeOf$1(error) !== "ENOENT") throw error;
		}
	}
	if (!unchanged(lockPath, lock, listed, parent, io)) return null;
	try {
		node_fs.default.rmdirSync(lock);
	} catch (error) {
		if (![
			"ENOENT",
			"ENOTEMPTY",
			"EEXIST",
			"ENOTDIR"
		].includes(codeOf$1(error) ?? "")) throw error;
	}
	return holder;
}
/** One attempt: the lock, or the pid of a live holder (null when unknown). */
function attempt(lockPath, parent, io) {
	const lock = node_path.default.join(parent.path, node_path.default.basename(lockPath));
	keepParent(lockPath, parent, io);
	inspect(lockPath, lock, io);
	const entry = `${process.pid}-${node_crypto.default.randomUUID()}`;
	const staging = `${lock}.${node_crypto.default.randomUUID()}.tmp`;
	node_fs.default.mkdirSync(staging, { mode: 448 });
	const made = [];
	let taken = false;
	let stagingDir;
	let entryFile;
	try {
		stagingDir = created(staging, io.lstat(staging));
		made.push(stagingDir);
		keepParent(lockPath, parent, io);
		const fd = node_fs.default.openSync(node_path.default.join(staging, entry), "wx", 384);
		try {
			entryFile = created(node_path.default.join(staging, entry), node_fs.default.fstatSync(fd));
			made.unshift(entryFile);
		} finally {
			node_fs.default.closeSync(fd);
		}
		keepParent(lockPath, parent, io);
		try {
			node_fs.default.renameSync(staging, lock);
			taken = true;
		} catch (error) {
			const code = codeOf$1(error) ?? "";
			if (!([
				"EEXIST",
				"ENOTEMPTY",
				"ENOTDIR"
			].includes(code) || ["EPERM", "EACCES"].includes(code) && inspect(lockPath, lock, io) !== null)) throw error;
			const holder = clearStale(lockPath, lock, parent, io);
			keepParent(lockPath, parent, io);
			return { holder };
		}
	} finally {
		if (!taken) removeCreated(made, parent, io);
	}
	const identity = {
		dev: stagingDir.dev,
		ino: stagingDir.ino
	};
	const own = {
		...entryFile,
		path: node_path.default.join(lock, entry)
	};
	keepParent(lockPath, parent, io);
	if (!unchanged(lockPath, lock, identity, parent, io)) throw new InstallLockUnsafe(lockPath, lock, "lock", true);
	const key = `${lock}\0${entry}`;
	held.add(key);
	let released = false;
	return {
		path: lockPath,
		directory: parent,
		release() {
			if (released) return;
			released = true;
			held.delete(key);
			keepParent(lockPath, parent, io);
			if (!unchanged(lockPath, lock, identity, parent, io)) throw new InstallLockUnsafe(lockPath, lock, "lock", true);
			removeCreated([own, {
				path: lock,
				...identity,
				directory: true
			}], parent, io);
		}
	};
}
/** The lock's parent, by the canonical path the trusted-path rule gives it; an acquisition works only there. */
function trustedParent(lockPath, io) {
	const checked = require_trusted_path.trustedPath(node_path.default.dirname(lockPath), { calls: io });
	if ("unsafe" in checked) throw new InstallLockUnsafe(lockPath, checked.unsafe, "directory");
	return checked;
}
var POLL_MS = 20;
/** The same, for the zip's synchronous installer, which has nothing else to run while it waits. */
function acquireInstallLockSync(lockPath, timeoutMs = 1e4, calls = {}) {
	const io = {
		...nodeFs,
		...calls
	};
	const parent = trustedParent(lockPath, io);
	const deadline = performance.now() + timeoutMs;
	const pause = new Int32Array(new SharedArrayBuffer(4));
	while (true) {
		const result = attempt(lockPath, parent, io);
		if ("release" in result) return result;
		if (performance.now() >= deadline) throw new InstallLockBusy(lockPath, result.holder);
		Atomics.wait(pause, 0, 0, POLL_MS);
	}
}
//#endregion
//#region src/shared/manifest-file.ts
var LIMIT = 65536;
var WRITABLE_BY_OTHERS = 18;
var STICKY = 512;
function codeOf(error) {
	return error?.code;
}
/** The manifest at `file`, read without following a symlink, by the inode lstat saw. */
function existingManifest(file, calls = {}) {
	const lstat = calls.lstat ?? ((target) => node_fs.default.lstatSync(target));
	let entry;
	try {
		entry = lstat(file);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { kind: "absent" };
		return {
			kind: "present",
			text: null,
			trusted: false,
			replaceable: false
		};
	}
	const uid = process.getuid?.();
	let replaceable = uid === void 0 || uid === 0 || entry.uid === uid;
	if (!replaceable) try {
		const directory = lstat(node_path.default.dirname(file));
		replaceable = (directory.mode & STICKY) === 0 || directory.uid === uid;
	} catch {}
	let text = null;
	if (entry.isFile() && entry.size <= LIMIT) try {
		const fd = node_fs.default.openSync(file, node_fs.default.constants.O_RDONLY | (node_fs.default.constants.O_NOFOLLOW ?? 0) | (node_fs.default.constants.O_NONBLOCK ?? 0));
		try {
			const opened = node_fs.default.fstatSync(fd);
			if (opened.isFile() && opened.dev === entry.dev && opened.ino === entry.ino && opened.size <= LIMIT) text = node_fs.default.readFileSync(fd, "utf8");
		} finally {
			node_fs.default.closeSync(fd);
		}
	} catch {}
	const trusted = text !== null && (uid === void 0 || entry.uid === uid && (entry.mode & WRITABLE_BY_OTHERS) === 0);
	return {
		kind: "present",
		text,
		trusted,
		replaceable
	};
}
/** The host a manifest's text names in `path`, or null when it names none readably. */
function namedHost(text) {
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && typeof parsed.path === "string" ? parsed.path : null;
	} catch {
		return null;
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
/** `dir`, not followed, is a private directory; with `expected`, it is still that directory. */
function privateAt(dir, expected) {
	const stats = node_fs.default.lstatSync(dir);
	if (!stats.isDirectory() || !isPrivate(stats) || expected && (stats.dev !== expected.dev || stats.ino !== expected.ino)) throw new InstallError(`Refusing a directory that is not private to you: ${dir}`);
	return {
		path: dir,
		dev: stats.dev,
		ino: stats.ino
	};
}
/**
* The canonical path of the state root `dir`, once it passes the trusted-path rule and is private to you. Missing
* directories are made with mode 0700, each only inside a directory that passed. Then no other user can rename
* anything on that path.
*/
function stateDirectory(dir) {
	const checked = require_trusted_path.trustedPath(dir, { create: 448 });
	if ("unsafe" in checked) throw new InstallError(`Refusing the state directory ${dir}: ${checked.unsafe} must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit.`);
	return privateAt(checked.path, checked);
}
/** <parent>/<name>, made with mode 0700 if missing: a private directory, not a symlink, in a checked parent. */
function privateChild(parent, name) {
	const dir = node_path.default.join(parent.path, name);
	try {
		node_fs.default.mkdirSync(dir, { mode: 448 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	return privateAt(dir);
}
function sameDirectory(a, b) {
	return a.path === b.path && a.dev === b.dev && a.ino === b.ino;
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
/** Create `file` with `data`; if writing fails, the file is removed while it is still the one made here. */
function writeNew(file, data, mode) {
	const fd = node_fs.default.openSync(file, node_fs.default.constants.O_WRONLY | node_fs.default.constants.O_CREAT | node_fs.default.constants.O_EXCL, mode);
	let made = null;
	try {
		made = created(file, node_fs.default.fstatSync(fd));
		node_fs.default.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
		node_fs.default.fsyncSync(fd);
		node_fs.default.fchmodSync(fd, mode);
	} catch (error) {
		node_fs.default.closeSync(fd);
		if (made) removeCreated([made]);
		throw error;
	}
	node_fs.default.closeSync(fd);
	return made;
}
function makeDirectory(dir) {
	node_fs.default.mkdirSync(dir, { mode: 448 });
	return created(dir, node_fs.default.lstatSync(dir));
}
/**
* Publish `files` as <hosts>/<name>/. Publications are serialized by a lock in `hosts`, and the target is
* checked again under it, so a matching copy that another installer published (and Chrome may be running) is
* never moved or deleted. Returns the published directory.
*/
function publishTree(hosts, name, files) {
	const target = node_path.default.join(hosts.path, name);
	let current = null;
	try {
		current = treeState(target, files);
	} catch {}
	if (current !== "matches") {
		const lock = acquireInstallLockSync(node_path.default.join(hosts.path, publishLock));
		try {
			if (!sameDirectory(lock.directory, hosts)) throw new InstallError(`${hosts.path} was replaced while this installer used it, so no host copy was written.`);
			const state = treeState(target, files);
			if (state !== "matches") replaceTree(lock.directory, name, files, state === "differs");
		} finally {
			lock.release();
		}
	}
	if (!unchangedAt(hosts.path, hosts) || treeState(target, files) !== "matches") throw new InstallError(`Could not verify the native host copy: ${target}`);
	return target;
}
/**
* Under the publish lock, in `hosts`: write the new copy into a private staging directory made here, then
* rename it to `name`. A copy that differs is first moved into that staging directory, and deleted only once
* the new copy is in place; if the new copy cannot be renamed in, the old one is put back.
*
* What was written is removed one entry at a time, each only while it is still what was made. The displaced
* copy may hold anything, so it is the one tree removed recursively, and only inside the staging directory,
* once `hosts` and the staging directory are verified to be the directories that were checked and made.
*/
function replaceTree(hosts, name, files, moveAside) {
	const target = node_path.default.join(hosts.path, name);
	const staging = makeDirectory(node_path.default.join(hosts.path, `.tmp-${node_crypto.default.randomUUID()}`));
	const copy = node_path.default.join(staging.path, "copy");
	const displaced = node_path.default.join(staging.path, "old");
	const intact = () => unchangedAt(hosts.path, hosts) && unchangedAt(staging.path, staging);
	const made = [staging];
	let moved = false;
	let placed = false;
	try {
		made.push(makeDirectory(copy));
		for (const [relative, data] of files) {
			const parts = relative.split("/");
			for (let depth = 1; depth < parts.length; depth += 1) {
				const dir = node_path.default.join(copy, ...parts.slice(0, depth));
				if (!made.some((item) => item.path === dir)) made.push(makeDirectory(dir));
			}
			made.push(writeNew(node_path.default.join(copy, ...parts), data, 384));
		}
		if (moveAside) {
			if (!intact()) throw new InstallError(`${hosts.path} changed while the native host copy was being replaced; nothing was moved.`);
			node_fs.default.renameSync(target, displaced);
			moved = true;
		}
		try {
			node_fs.default.renameSync(copy, target);
			placed = true;
		} catch (error) {
			if (moved) try {
				node_fs.default.renameSync(displaced, target);
				moved = false;
			} catch {}
			throw error;
		}
	} finally {
		if (placed && moved && intact()) node_fs.default.rmSync(displaced, {
			recursive: true,
			force: true
		});
		removeCreated((placed ? [staging] : made).slice().reverse(), hosts);
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
/**
* Replace <directory>/<name> atomically with `text`: a temporary file beside it, then a rename. Just before the
* rename, `intact` must hold; otherwise `refusal` is thrown. Only the temporary file is ever removed, and only
* while it is still the one written here.
*/
function replaceFile(directory, name, text, mode, intact, refusal) {
	const temporary = writeNew(node_path.default.join(directory.path, `.${name}.${node_crypto.default.randomUUID()}.tmp`), text, mode);
	try {
		if (!intact()) throw new InstallError(refusal);
		node_fs.default.renameSync(temporary.path, node_path.default.join(directory.path, name));
	} catch (error) {
		removeCreated([temporary], directory);
		throw error;
	}
}
/**
* Refuse the manifest at `file` unless it is absent or this installer's own: a trusted file
* (src/shared/manifest-file.ts) that names `wrapper`. With --force, anything else is replaced, except another
* user's entry in a sticky directory that is not this user's, which only they or root can remove. `manifestPath`
* is the path the user gave.
*/
function refuseExisting(file, wrapper, manifestPath = file) {
	const existing = existingManifest(file);
	if (existing.kind === "absent") return;
	const previous = namedHost(existing.text);
	if (existing.trusted && previous === wrapper) return;
	if (!force && !existing.trusted) throw new InstallError(`A native messaging manifest for ${hostName} is already there, but it is not a regular file owned by you that only you can write to, so another user could change it.\nPass --force to replace it: ${manifestPath}`);
	if (!force) throw new InstallError(`A native messaging manifest for ${hostName} already points at another host:\n  ${previous ?? "(unreadable)"}\nPass --force to replace it: ${manifestPath}`);
	if (!existing.replaceable) throw new InstallError(`Refusing to replace the native messaging manifest ${manifestPath}: another user owns it, in a directory with the sticky bit that is not yours, so only that user or root can remove it.`);
}
function install(extensionId, manifestPath, socketPath) {
	const node = nodeExecutable();
	const hosts = privateChild(stateDirectory(stateRoot()), "hosts");
	const files = hostFiles();
	const copyName = `skill-${digest(files).slice(0, 12)}`;
	const copyDir = node_path.default.join(hosts.path, copyName);
	const wrapper = node_path.default.join(hosts.path, "skill", wrapperName);
	const socket = socketPath && node_process.default.platform !== "win32" ? require_trusted_path.canonicalSocketPath(socketPath) : socketPath;
	const text = launcher(node, node_path.default.join(copyDir, ...hostEntry.split("/")), socket);
	const given = node_path.default.dirname(manifestPath);
	const name = node_path.default.basename(manifestPath);
	const directory = require_trusted_path.trustedPath(given, { missing: true });
	if ("unsafe" in directory) throw new InstallLockUnsafe(manifestLockPath(manifestPath), directory.unsafe, "directory");
	if (!("missing" in directory)) refuseExisting(node_path.default.join(directory.path, name), wrapper, manifestPath);
	publishTree(hosts, copyName, files);
	const wrapperDir = privateChild(hosts, "skill");
	replaceFile(wrapperDir, wrapperName, text, 448, () => unchangedAt(wrapperDir.path, wrapperDir), `${wrapperDir.path} was replaced while this installer used it, so the wrapper was not written.`);
	const manifest = {
		name: hostName,
		description: "Browser Control native messaging host",
		type: "stdio",
		path: wrapper,
		allowed_origins: [`chrome-extension://${extensionId}/`]
	};
	const made = require_trusted_path.trustedPath(directory.path, { create: 493 });
	if ("unsafe" in made) throw new InstallLockUnsafe(manifestLockPath(manifestPath), made.unsafe, "directory");
	const moved = `The native messaging manifest directory ${given} no longer resolves to ${made.path}, so no manifest was written. Make sure nothing else is changing it, then try again.`;
	const lock = acquireInstallLockSync(manifestLockPath(node_path.default.join(made.path, name)));
	try {
		if (!sameDirectory(lock.directory, made)) throw new InstallError(moved);
		refuseExisting(node_path.default.join(lock.directory.path, name), wrapper, manifestPath);
		replaceFile(lock.directory, name, `${JSON.stringify(manifest, null, 2)}\n`, 420, () => stillResolves(given, lock.directory), moved);
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
