const require_Layer = require("./Layer-Dc3MJVHo.js");
let node_fs = require("node:fs");
node_fs = require_Layer.__toESM(node_fs);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
var WRITABLE_BY_OTHERS = 18;
var STICKY = 512;
var nodeFs = {
	lstat: (file) => node_fs.default.lstatSync(file),
	readlink: (file) => node_fs.default.readlinkSync(file),
	mkdir: (directory, mode) => node_fs.default.mkdirSync(directory, { mode })
};
function codeOf(error) {
	return error?.code;
}
/** Windows has no POSIX owners or modes, so there only the kind of each entry is checked. */
function ownerId() {
	return process.getuid?.();
}
function ownedByUs(stats) {
	const uid = ownerId();
	return uid === void 0 || stats.uid === uid || stats.uid === 0;
}
/** A directory that only its owner, this user or root, can change: others may write to it only if it is sticky. */
function trustedDirectory(stats) {
	if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
	if (ownerId() === void 0) return true;
	const shared = (stats.mode & WRITABLE_BY_OTHERS) !== 0 && (stats.mode & STICKY) === 0;
	return ownedByUs(stats) && !shared;
}
function components(text) {
	return text.split(process.platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part && part !== ".");
}
/**
* The canonical path of the directory `given` and its identity, once the whole walk passed the rule above; else
* the first directory or symlink at fault. A relative path is taken from the working directory. Errors other than
* a missing directory (EACCES, ENOTDIR) are thrown.
*/
function trustedPath(given, options = {}) {
	const io = {
		...nodeFs,
		...options.calls
	};
	const absolute = node_path.default.isAbsolute(given) ? given : `${process.cwd()}${node_path.default.sep}${given}`;
	const root = node_path.default.parse(absolute).root;
	const pending = components(absolute.slice(root.length));
	let current = root;
	let stats = io.lstat(current);
	if (!trustedDirectory(stats)) return { unsafe: current };
	let links = 0;
	while (pending.length) {
		const name = pending.shift();
		if (name === "..") {
			current = node_path.default.dirname(current);
			stats = io.lstat(current);
			if (!trustedDirectory(stats)) return { unsafe: current };
			continue;
		}
		const next = node_path.default.join(current, name);
		let entry;
		try {
			entry = io.lstat(next);
		} catch (error) {
			if (codeOf(error) !== "ENOENT") throw error;
			if (options.create === void 0) {
				if (options.missing && !pending.includes("..")) return {
					path: node_path.default.join(next, ...pending),
					missing: next
				};
				throw error;
			}
			try {
				io.mkdir(next, options.create);
			} catch (made) {
				if (codeOf(made) !== "EEXIST") throw made;
			}
			entry = io.lstat(next);
		}
		if (entry.isSymbolicLink()) {
			links += 1;
			if (!ownedByUs(entry) || links > 16) return { unsafe: next };
			const target = io.readlink(next);
			pending.unshift(...components(node_path.default.isAbsolute(target) ? target.slice(node_path.default.parse(target).root.length) : target));
			if (node_path.default.isAbsolute(target)) {
				current = node_path.default.parse(target).root;
				stats = io.lstat(current);
				if (!trustedDirectory(stats)) return { unsafe: current };
			}
			continue;
		}
		if (!trustedDirectory(entry)) return { unsafe: next };
		current = next;
		stats = entry;
	}
	return {
		path: current,
		dev: stats.dev,
		ino: stats.ino
	};
}
/**
* The path to export for a Unix socket: its directory's canonical path, where a missing part is kept as given,
* and its name. A path that is relative, has no plain name, or whose directory fails the rule is returned as
* given; the host and the server refuse it when they use it.
*/
function canonicalSocketPath(file, calls = {}) {
	const name = node_path.default.basename(file);
	if (!node_path.default.isAbsolute(file) || !name || name === "." || name === "..") return file;
	try {
		const directory = trustedPath(node_path.default.dirname(file), {
			missing: true,
			calls
		});
		return "unsafe" in directory ? file : node_path.default.join(directory.path, name);
	} catch (error) {
		if (codeOf(error) === void 0) throw error;
		return file;
	}
}
/**
* The canonical path of the Unix socket `file` for a client to connect to: its directory passed the rule, is
* private (owned by this user, no group or other bits) and still has the identity the rule saw, and the endpoint
* there is a socket owned by this user that group and others cannot use. Only this user or root can change
* anything on that path, so connecting through it reaches the endpoint that was checked. Anything else throws,
* and on Windows, which has no owners, every path does. The server, client.js and transport.js all connect this way.
*/
function privateSocketEndpoint(file, calls = {}) {
	const name = node_path.default.basename(file);
	if (!name || name === "." || name === "..") throw new Error("socket name required");
	const directory = trustedPath(node_path.default.dirname(file), { calls });
	if ("unsafe" in directory) throw new Error("trusted socket directory required");
	const lstat = calls.lstat ?? nodeFs.lstat;
	const canonical = node_path.default.join(directory.path, name);
	const uid = ownerId();
	const parent = lstat(directory.path);
	const endpoint = lstat(canonical);
	if (!parent.isDirectory() || parent.dev !== directory.dev || parent.ino !== directory.ino || parent.uid !== uid || parent.mode & 63 || !endpoint.isSocket() || endpoint.uid !== uid || endpoint.mode & 63) throw new Error("private owned socket required");
	return canonical;
}
//#endregion
Object.defineProperty(exports, "canonicalSocketPath", {
	enumerable: true,
	get: function() {
		return canonicalSocketPath;
	}
});
Object.defineProperty(exports, "privateSocketEndpoint", {
	enumerable: true,
	get: function() {
		return privateSocketEndpoint;
	}
});
Object.defineProperty(exports, "trustedPath", {
	enumerable: true,
	get: function() {
		return trustedPath;
	}
});
