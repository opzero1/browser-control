#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_rpc = require("../chunks/rpc-CKph8efs.js");
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
//#region src/native-host/client.ts
var args = node_process.default.argv.slice(2);
if (args[0] === "--") args.shift();
var streaming = args[0] === "--stdio";
var method = args[0] || "ping";
if (args.length > 1 || !streaming && ![
	"ping",
	"getInfo",
	"host.ping",
	"host.info"
].includes(method)) {
	node_process.default.stderr.write("Payloads are accepted only through --stdio JSONL; never pass private values in argv\n");
	node_process.default.exit(1);
}
var useTcp = node_process.default.platform === "win32" || node_process.default.env.BROWSER_CONTROL_HOST_TRANSPORT === "tcp";
var socket = useTcp ? node_net.default.connect(Number(node_process.default.env.BROWSER_CONTROL_HOST_PORT || 17365), "127.0.0.1") : node_net.default.connect(node_process.default.env.BROWSER_CONTROL_HOST_SOCKET || node_path.default.join(node_os.default.homedir(), ".opzero-chrome", "default.sock"));
var pending = /* @__PURE__ */ new Map();
var ready = false;
var inputEnded = false;
var input = "";
var output = "";
var stopped = false;
var maxBytes = 1024 * 1024;
var maxResponseBytes = 64 * maxBytes;
function fail() {
	if (stopped) return;
	stopped = true;
	node_process.default.stderr.write("Private client stopped; outcome may be unknown; do not replay\n");
	socket.destroy();
	node_process.default.exitCode = 1;
	node_process.default.stdin.destroy();
}
function finish() {
	socket.setTimeout(pending.size ? 35e3 : 0);
	if (inputEnded && pending.size === 0) socket.end();
}
function drain() {
	if (!ready) return;
	let index;
	while ((index = input.indexOf("\n")) !== -1) {
		const line = input.slice(0, index);
		input = input.slice(index + 1);
		if (!line.trim()) continue;
		try {
			const request = require_rpc.parseJsonRpcMessage(JSON.parse(line));
			if (!require_rpc.isJsonRpcRequest(request) || request.id == null || request.id === "__auth" || pending.has(request.id)) throw new Error();
			pending.set(request.id, request.method);
			socket.write(`${JSON.stringify(request)}\n`);
		} catch {
			fail();
			return;
		}
	}
	finish();
}
function start() {
	ready = true;
	if (!streaming) {
		input = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: {}
		})}\n`;
		inputEnded = true;
	}
	drain();
}
socket.setEncoding("utf8");
socket.setTimeout(35e3);
socket.on("timeout", fail);
socket.on("connect", () => {
	if (!useTcp) {
		start();
		return;
	}
	try {
		const file = node_process.default.env.BROWSER_CONTROL_HOST_TOKEN_FILE;
		if (!file) throw new Error();
		socket.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: "__auth",
			method: "host.authenticate",
			params: { token: node_fs.default.readFileSync(file, "utf8").trim() }
		})}\n`);
	} catch {
		fail();
	}
});
socket.on("data", (chunk) => {
	output += chunk;
	if (Buffer.byteLength(output) > maxResponseBytes) {
		fail();
		return;
	}
	let index;
	while ((index = output.indexOf("\n")) !== -1) {
		const line = output.slice(0, index);
		output = output.slice(index + 1);
		try {
			const response = require_rpc.parseJsonRpcMessage(JSON.parse(line));
			if (require_rpc.isJsonRpcRequest(response)) continue;
			if (response.id === "__auth") {
				if (response.error) fail();
				else start();
				continue;
			}
			if (response.id == null || !pending.has(response.id)) continue;
			const requestMethod = pending.get(response.id);
			pending.delete(response.id);
			if (requestMethod === "privateFill") {
				const value = response.result;
				const filled = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "filled";
				const unsupported = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "unsupported";
				const notReady = !response.error && typeof value === "object" && value !== null && "status" in value && value.status === "not-ready";
				node_process.default.stdout.write(`${JSON.stringify({
					jsonrpc: "2.0",
					id: response.id,
					result: {
						status: filled ? "filled" : unsupported ? "unsupported" : notReady ? "not-ready" : "not-filled-or-unknown",
						retry: false
					}
				})}\n`);
			} else node_process.default.stdout.write(`${JSON.stringify(response)}\n`);
			if (response.error) node_process.default.exitCode = 1;
		} catch {
			fail();
			return;
		}
	}
	finish();
});
socket.on("error", fail);
socket.on("close", () => {
	if (pending.size || output) fail();
	node_process.default.stdin.destroy();
});
if (streaming) {
	node_process.default.stdin.setEncoding("utf8");
	node_process.default.stdin.on("data", (chunk) => {
		input += chunk;
		if (Buffer.byteLength(input) > maxBytes) {
			fail();
			return;
		}
		drain();
	});
	node_process.default.stdin.on("end", () => {
		inputEnded = true;
		if (input.trim()) input += "\n";
		drain();
	});
	node_process.default.stdin.on("error", fail);
}
//#endregion
