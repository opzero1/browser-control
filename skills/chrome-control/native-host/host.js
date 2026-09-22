#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-nAKmzBoW.js");
const require_rpc = require("../chunks/rpc-BTiTvO3J.js");
let node_fs = require("node:fs");
node_fs = require_Layer.__toESM(node_fs);
let node_net = require("node:net");
node_net = require_Layer.__toESM(node_net);
let node_os = require("node:os");
node_os = require_Layer.__toESM(node_os);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
let node_process = require("node:process");
node_process = require_Layer.__toESM(node_process);
let node_crypto = require("node:crypto");
//#region src/native-host/host.ts
var socketPath = node_process.default.env.OPZERO_CHROME_HOST_SOCKET || node_path.default.join(node_os.default.homedir(), ".opzero-chrome", "default.sock");
var useTcp = node_process.default.platform === "win32" || node_process.default.env.OPZERO_CHROME_HOST_TRANSPORT === "tcp";
var port = Number(node_process.default.env.OPZERO_CHROME_HOST_PORT || 17365);
var epoch = (0, node_crypto.randomUUID)();
var protocolRequestId = `protocol:${epoch}`;
var extensionProtocol = "checking";
var protocolTimer = setTimeout(() => {
	extensionProtocol = "unsupported";
}, 1e4);
protocolTimer.unref();
var maxBytes = 1024 * 1024;
var maxResponseBytes = 64 * maxBytes;
var clients = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
var nextId = 1;
var ownsSocket = false;
var tcpToken;
function native(message) {
	const body = Buffer.from(JSON.stringify(message));
	if (body.length > maxBytes) return false;
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length);
	node_process.default.stdout.write(Buffer.concat([header, body]));
	return true;
}
function result(id, value) {
	return {
		jsonrpc: "2.0",
		id,
		result: value
	};
}
function error(id, message) {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code: -32e3,
			message
		}
	};
}
function reply(socket, message) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
function release(socket) {
	const client = clients.get(socket);
	if (!client) return;
	clients.delete(socket);
	for (const [id, request] of pending) {
		if (request.socket !== socket) continue;
		clearTimeout(request.timer);
		pending.delete(id);
	}
	if (client.authenticated && extensionProtocol === "ready") native({
		jsonrpc: "2.0",
		method: "internal.releaseClient",
		params: { session_id: client.session }
	});
}
function handleNative(message) {
	if (!require_rpc.isJsonRpcRequest(message)) {
		if (message.id === protocolRequestId) {
			if (extensionProtocol !== "checking") return;
			clearTimeout(protocolTimer);
			extensionProtocol = !message.error && typeof message.result === "object" && message.result !== null && "protocolVersion" in message.result && message.result.protocolVersion === 2 ? "ready" : "unsupported";
			return;
		}
		const request = typeof message.id === "number" ? pending.get(message.id) : void 0;
		if (!request) return;
		pending.delete(Number(message.id));
		clearTimeout(request.timer);
		if (request.private) {
			const ok = !message.error && typeof message.result === "object" && message.result !== null && "status" in message.result && message.result.status === "filled";
			reply(request.socket, result(request.id, {
				status: ok ? "filled" : "not-filled-or-unknown",
				retry: false
			}));
		} else reply(request.socket, message.error ? error(request.id, message.error.message) : result(request.id, message.result));
		return;
	}
	if (message.id != null) {
		if (message.method === "ping") native(result(message.id, "pong"));
		else if (message.method === "getHostInfo") native(result(message.id, {
			name: "opzero-chrome-native-host",
			version: "0.2.0",
			protocolVersion: 2,
			extensionProtocol,
			epoch,
			pid: node_process.default.pid,
			transport: useTcp ? "tcp" : "unix",
			endpoint: useTcp ? `127.0.0.1:${port}` : socketPath
		}));
		else native(error(message.id, "Unsupported native host method"));
		return;
	}
	if (extensionProtocol !== "ready") return;
	const params = typeof message.params === "object" && message.params !== null ? message.params : {};
	const session = "session_id" in params ? params.session_id : void 0;
	for (const [socket, client] of clients) {
		if (!client.authenticated) continue;
		if (typeof session === "string" ? client.session === session : message.method === "onControlStopped" || message.method === "onDownloadChange" && client.profileEvents) reply(socket, message);
	}
	if (message.method === "onControlStopped") for (const socket of clients.keys()) {
		release(socket);
		socket.end();
	}
}
function handleClient(socket, message) {
	const client = clients.get(socket);
	if (!client) return;
	if (!require_rpc.isJsonRpcRequest(message) || typeof message.id !== "number" && typeof message.id !== "string") {
		reply(socket, error(null, "Expected JSON-RPC request with a non-null id"));
		return;
	}
	const id = JSON.stringify(message.id);
	if (client.ids.has(id)) {
		reply(socket, error(message.id, "Duplicate id; action not replayed"));
		return;
	}
	if (client.ids.size >= 1e4) {
		reply(socket, error(message.id, "Connection request limit reached; no action dispatched; connection revoked"));
		release(socket);
		socket.end();
		return;
	}
	client.ids.add(id);
	const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? message.params : {};
	if (!client.authenticated) {
		const token = "token" in params && typeof params.token === "string" ? Buffer.from(params.token) : Buffer.alloc(0);
		if (message.method !== "host.authenticate" || !tcpToken || token.length !== tcpToken.length || !(0, node_crypto.timingSafeEqual)(token, tcpToken)) {
			reply(socket, error(message.id, "Authentication required"));
			socket.end();
			return;
		}
		client.authenticated = true;
		reply(socket, result(message.id, { authenticated: true }));
		return;
	}
	if (message.method === "host.ping") {
		reply(socket, result(message.id, "pong"));
		return;
	}
	if (message.method === "host.info") {
		reply(socket, result(message.id, {
			protocolVersion: 2,
			extensionProtocol,
			epoch,
			session_id: client.session,
			reconnect: "new-session-no-replay"
		}));
		return;
	}
	if (message.method === "host.subscribeProfileEvents") {
		client.profileEvents = "enabled" in params && params.enabled === true;
		reply(socket, result(message.id, { enabled: client.profileEvents }));
		return;
	}
	if (message.method.startsWith("internal.") || message.method.startsWith("host.")) {
		reply(socket, error(message.id, "Reserved method"));
		return;
	}
	if (extensionProtocol !== "ready") {
		reply(socket, message.method === "privateFill" ? result(message.id, {
			status: extensionProtocol === "checking" ? "not-ready" : "unsupported",
			retry: false
		}) : error(message.id, "Extension protocol v2 is not ready; no action dispatched"));
		return;
	}
	const extensionId = nextId++;
	const timer = setTimeout(() => {
		pending.delete(extensionId);
		reply(socket, error(message.id, "Outcome unknown; connection revoked; do not replay"));
		release(socket);
		socket.end();
	}, Number(node_process.default.env.OPZERO_CHROME_REQUEST_TIMEOUT_MS || 3e4));
	pending.set(extensionId, {
		socket,
		id: message.id,
		private: message.method === "privateFill",
		timer
	});
	if (!native({
		jsonrpc: "2.0",
		id: extensionId,
		method: message.method,
		params: {
			...params,
			session_id: client.session,
			sessionId: client.session,
			turn_id: epoch,
			turnId: epoch
		}
	})) {
		clearTimeout(timer);
		pending.delete(extensionId);
		reply(socket, error(message.id, "Request exceeds native frame limit; no action dispatched"));
	}
}
var server = node_net.default.createServer((socket) => {
	clients.set(socket, {
		session: (0, node_crypto.randomUUID)(),
		authenticated: !useTcp,
		ids: /* @__PURE__ */ new Set(),
		profileEvents: false
	});
	socket.on("close", () => release(socket));
	socket.on("error", () => {
		release(socket);
		socket.destroy();
	});
	socket.setEncoding("utf8");
	let text = "";
	socket.on("data", (chunk) => {
		text += chunk;
		if (Buffer.byteLength(text) > maxBytes) {
			socket.destroy();
			return;
		}
		let index;
		while ((index = text.indexOf("\n")) !== -1) {
			const line = text.slice(0, index);
			text = text.slice(index + 1);
			if (!line.trim()) continue;
			try {
				handleClient(socket, require_rpc.parseJsonRpcMessage(JSON.parse(line)));
			} catch {
				reply(socket, error(null, "Invalid JSON-RPC request"));
			}
		}
	});
});
function shutdown(code) {
	for (const socket of clients.keys()) socket.destroy();
	if (ownsSocket) try {
		node_fs.default.unlinkSync(socketPath);
	} catch {}
	node_process.default.exit(code);
}
server.on("error", () => {
	node_process.default.stderr.write("Native endpoint unavailable; no existing endpoint was replaced\n");
	shutdown(1);
});
try {
	if (useTcp) {
		const file = node_process.default.env.OPZERO_CHROME_HOST_TOKEN_FILE;
		if (!file) throw new Error("token file required");
		const stat = node_fs.default.lstatSync(file);
		if (!stat.isFile() || node_process.default.platform !== "win32" && (stat.mode & 63) !== 0) throw new Error("private token file required");
		tcpToken = Buffer.from(node_fs.default.readFileSync(file, "utf8").trim());
		if (tcpToken.length < 32) throw new Error("token too short");
		server.listen(port, "127.0.0.1");
	} else {
		node_process.default.umask(63);
		const directory = node_path.default.dirname(socketPath);
		node_fs.default.mkdirSync(directory, {
			recursive: true,
			mode: 448
		});
		const stat = node_fs.default.lstatSync(directory);
		if (!stat.isDirectory() || stat.uid !== node_process.default.getuid?.() || (stat.mode & 63) !== 0) throw new Error("private socket directory required");
		if (node_fs.default.existsSync(socketPath)) throw new Error("endpoint exists");
		server.listen(socketPath, () => {
			ownsSocket = true;
			node_fs.default.chmodSync(socketPath, 384);
		});
	}
} catch {
	node_process.default.stderr.write("Native endpoint setup refused; use a private directory or authenticated TCP\n");
	shutdown(1);
}
var buffer = Buffer.alloc(0);
node_process.default.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
	while (buffer.length >= 4) {
		const length = buffer.readUInt32LE(0);
		if (length > maxResponseBytes) shutdown(1);
		if (buffer.length < length + 4) break;
		const body = buffer.subarray(4, length + 4);
		buffer = buffer.subarray(length + 4);
		try {
			handleNative(require_rpc.parseJsonRpcMessage(JSON.parse(body.toString("utf8"))));
		} catch {}
	}
});
node_process.default.stdin.on("end", () => shutdown(0));
node_process.default.stdin.on("error", () => shutdown(1));
node_process.default.stdout.on("error", () => shutdown(1));
node_process.default.on("SIGTERM", () => shutdown(0));
node_process.default.on("SIGINT", () => shutdown(0));
native({
	jsonrpc: "2.0",
	id: protocolRequestId,
	method: "getInfo",
	params: {}
});
//#endregion
