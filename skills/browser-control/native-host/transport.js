Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_rpc = require("../chunks/rpc-CKph8efs.js");
let node_net = require("node:net");
node_net = require_Layer.__toESM(node_net);
let node_path = require("node:path");
node_path = require_Layer.__toESM(node_path);
let node_crypto = require("node:crypto");
let node_fs_promises = require("node:fs/promises");
node_fs_promises = require_Layer.__toESM(node_fs_promises);
let node_child_process = require("node:child_process");
let node_util = require("node:util");
//#region src/shared/page-protocol.ts
function parseObservation(value) {
	const fail = () => {
		throw new Error("Invalid page protocol v2 observation");
	};
	const object = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : fail();
	const string = (v, limit) => typeof v === "string" && v.length <= limit ? v : fail();
	const bool = (v) => typeof v === "boolean" ? v : fail();
	const raw = object(value), truncation = object(raw.truncation);
	if (raw.status !== "observed" || raw.pageProtocolVersion !== 2 || raw.mode !== "full" && raw.mode !== "controls-only" || !Array.isArray(raw.actions) || raw.actions.length > 100 || !Array.isArray(raw.opaqueSurfaces) || raw.opaqueSurfaces.length > 100) fail();
	const actions = raw.actions.map((value) => {
		const a = object(value);
		if (a.kind !== "fill" && a.kind !== "click" && a.kind !== "upload") return fail();
		return {
			id: string(a.id, 100),
			kind: a.kind,
			label: string(a.label, 160),
			role: string(a.role, 80),
			disabled: bool(a.disabled)
		};
	});
	const opaqueSurfaces = raw.opaqueSurfaces.map((value, index) => {
		const o = object(value);
		if (Object.keys(o).length !== 2 || o.id !== `opaque-${index}` || typeof o.kind !== "string" || ![
			"iframe",
			"frame",
			"object",
			"embed",
			"closed-shadow-root"
		].includes(o.kind)) return fail();
		return {
			id: string(o.id, 100),
			kind: o.kind
		};
	});
	const flags = {
		text: bool(truncation.text),
		actions: bool(truncation.actions),
		opaqueSurfaces: bool(truncation.opaqueSurfaces),
		labels: bool(truncation.labels),
		title: bool(truncation.title)
	};
	const text = string(raw.text, 12e3), snapshot = string(raw.snapshot, 200), partial = bool(raw.partial);
	if (!snapshot || actions.some((a) => !a.id) || new Set(actions.map((a) => a.id)).size !== actions.length || partial !== opaqueSurfaces.length > 0 || flags.opaqueSurfaces && opaqueSurfaces.length !== 100 || raw.mode === "controls-only" && (text !== "" || flags.text)) fail();
	return {
		status: "observed",
		pageProtocolVersion: 2,
		snapshot,
		url: string(raw.url, 8192),
		title: string(raw.title, 200),
		text,
		actions,
		mode: raw.mode,
		partial,
		opaqueSurfaces,
		truncation: flags
	};
}
//#endregion
//#region src/native-host/transport.ts
var exec = (0, node_util.promisify)(node_child_process.execFile);
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function object(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid transport response");
	return value;
}
function string(value) {
	if (typeof value !== "string") throw new Error("Invalid string response");
	return value;
}
var transientObservationErrors = [
	"Page origin not ready or mismatch",
	"Frame with ID 0 was removed.",
	"Capture or observation blocked: private fields or frames",
	"Private document quarantined until cross-document navigation"
];
function isTransientObservationError(message) {
	return transientObservationErrors.includes(message) || message.startsWith("Cannot access contents of url \"about:blank\".");
}
var ChromeTransport = class ChromeTransport {
	#socket;
	#next = 0;
	#pending = /* @__PURE__ */ new Map();
	#pages = /* @__PURE__ */ new Map();
	#recordings = /* @__PURE__ */ new Map();
	session;
	epoch;
	constructor(socket, session, epoch) {
		this.#socket = socket;
		this.session = session;
		this.epoch = epoch;
	}
	static async connect(socketPath) {
		const directory = await node_fs_promises.default.lstat(node_path.default.dirname(socketPath));
		const endpoint = await node_fs_promises.default.lstat(socketPath);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 63) !== 0 || !endpoint.isSocket() || endpoint.uid !== process.getuid?.()) throw new Error("Explicit private owned Unix socket required");
		const socket = node_net.default.createConnection(socketPath);
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const transport = new ChromeTransport(socket, "", "");
		let text = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			text += chunk;
			if (Buffer.byteLength(text) > 64 * 1024 * 1024) {
				transport.#fail();
				return;
			}
			let index;
			while ((index = text.indexOf("\n")) >= 0) {
				const line = text.slice(0, index);
				text = text.slice(index + 1);
				try {
					const response = require_rpc.parseJsonRpcMessage(JSON.parse(line));
					if (require_rpc.isJsonRpcRequest(response) || typeof response.id !== "number") continue;
					const pending = transport.#pending.get(response.id);
					if (!pending) continue;
					clearTimeout(pending.timer);
					transport.#pending.delete(response.id);
					if (response.error) pending.reject(new Error(response.error.message));
					else pending.resolve(response.result);
				} catch {
					transport.#fail();
				}
			}
		});
		socket.on("error", () => transport.#fail());
		socket.on("close", () => transport.#fail());
		try {
			const info = object(await transport.#call("host.info"));
			if (info.protocolVersion !== 2 || info.extensionProtocol !== "ready") throw new Error("Extension protocol not ready; connect again explicitly without replaying inputs");
			const extension = object(await transport.#call("getInfo"));
			if (extension.protocolVersion !== 2 || extension.pageProtocolVersion !== 2) throw new Error("Typed page protocol version 2 required");
			Object.defineProperties(transport, {
				session: { value: string(info.session_id) },
				epoch: { value: string(info.epoch) }
			});
			return transport;
		} catch (error) {
			transport.#fail();
			throw error;
		}
	}
	#fail() {
		this.#socket.destroy();
		this.#pages.clear();
		for (const request of this.#pending.values()) {
			clearTimeout(request.timer);
			request.reject(/* @__PURE__ */ new Error("Transport closed; outcome unknown; no replay"));
		}
		this.#pending.clear();
	}
	#call(method, params = {}) {
		if (this.#socket.destroyed) return Promise.reject(/* @__PURE__ */ new Error("Transport closed; no replay"));
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.#fail(), 35e3);
			this.#pending.set(id, {
				resolve,
				reject,
				timer
			});
			this.#socket.write(JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params
			}) + "\n");
		});
	}
	#owned(page) {
		if (this.#pages.get(page.tabId) !== page || this.#socket.destroyed) throw new Error("Page is not owned by this connection");
		return { tabId: page.tabId };
	}
	async open(url, options = {}) {
		const origin = new URL(url).origin;
		const result = object(await this.#call("createTab"));
		if (typeof result.id !== "number" || result.active !== false) throw new Error("Inactive page creation failed");
		const page = Object.freeze({
			tabId: result.id,
			origin
		});
		this.#pages.set(page.tabId, page);
		await this.#call("attach", { tabId: page.tabId });
		await this.#call("bindPage", {
			tabId: page.tabId,
			expectedOrigin: origin,
			...options
		});
		await this.navigate(page, url);
		return page;
	}
	async navigate(page, url) {
		if (new URL(url).origin !== page.origin) throw new Error("Origin change refused");
		await this.#call("navigatePage", {
			...this.#owned(page),
			url
		});
	}
	async observe(page, options = {}) {
		if (options.controlsOnly !== void 0 && typeof options.controlsOnly !== "boolean") throw new Error("Invalid observation mode");
		const result = parseObservation(await this.#call("observePage", {
			...this.#owned(page),
			controlsOnly: options.controlsOnly === true
		}));
		if (new URL(result.url).origin !== page.origin || result.mode !== (options.controlsOnly ? "controls-only" : "full")) throw new Error("Observation binding changed");
		return result;
	}
	async waitFor(page, expect, timeoutMs = 1e4) {
		if (!expect.text && !expect.url || timeoutMs < 1 || timeoutMs > 15e3) throw new Error("Bounded nonempty expectation required");
		const deadline = performance.now() + timeoutMs;
		while (true) {
			try {
				const snapshot = await this.observe(page);
				if ((!expect.text || snapshot.text.includes(expect.text)) && (!expect.url || snapshot.url === expect.url)) return snapshot;
			} catch (error) {
				if (!(error instanceof Error) || !isTransientObservationError(error.message)) throw error;
			}
			if (performance.now() >= deadline) throw new Error("Read-only wait timed out; no input replayed");
			await sleep(50);
		}
	}
	async act(page, snapshot, actionId, text) {
		const result = object(await this.#call("actPage", {
			...this.#owned(page),
			snapshot,
			actionId,
			...text === void 0 ? {} : { text }
		}));
		if (result.status !== "executed" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid action result; no replay");
		return {
			status: result.status,
			retry: false,
			...typeof result.reason === "string" ? { reason: result.reason } : {}
		};
	}
	async uploadFile(page, snapshot, actionId, filePath) {
		if (this.#recordings.has(page.tabId) || !node_path.default.isAbsolute(filePath) || filePath.includes("\0") || node_path.default.extname(filePath).toLowerCase() !== ".pdf") throw new Error("Valid local PDF required and recording must be stopped");
		const info = await node_fs_promises.default.lstat(filePath);
		if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size < 1) throw new Error("Current-user-owned regular PDF required");
		const handle = await node_fs_promises.default.open(filePath, "r");
		try {
			const magic = Buffer.alloc(5);
			if ((await handle.read(magic, 0, 5, 0)).bytesRead !== 5 || magic.toString() !== "%PDF-") throw new Error("PDF signature required");
		} finally {
			await handle.close();
		}
		const name = node_path.default.basename(filePath);
		const result = object(await this.#call("uploadFile", {
			...this.#owned(page),
			snapshot,
			actionId,
			path: filePath,
			name,
			size: info.size
		}));
		if (result.status !== "attached" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid upload result; no replay");
		return result.status === "attached" ? {
			status: "attached",
			retry: false,
			name,
			mime: "application/pdf",
			size: info.size
		} : {
			status: result.status,
			retry: false
		};
	}
	async privateFill(page, selectors, values, options = {}) {
		if (this.#recordings.has(page.tabId)) throw new Error("Stop recording before private input");
		const params = this.#owned(page);
		const observed = object(await this.#call("observeDocument", {
			...params,
			expectedOrigin: page.origin,
			selectors,
			...options
		}));
		return {
			status: object(await this.#call("privateFill", {
				...params,
				expectedOrigin: page.origin,
				token: string(observed.token),
				documentId: string(observed.documentId),
				values
			})).status === "filled" ? "filled" : "not-filled-or-unknown",
			retry: false
		};
	}
	async preparePrivateSubmit(page, snapshot, actionId) {
		const result = object(await this.#call("preparePrivateSubmit", {
			...this.#owned(page),
			snapshot,
			actionId
		}));
		if (result.status !== "prepared") throw new Error("Private submit preparation refused");
		return Object.freeze({
			submitToken: string(result.submitToken),
			documentId: string(result.documentId)
		});
	}
	async submitPrivate(page, submission) {
		const result = object(await this.#call("submitPrivate", {
			...this.#owned(page),
			submitToken: submission.submitToken,
			documentId: submission.documentId
		}));
		if (result.status !== "executed" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid private submit result; no replay");
		return {
			status: result.status,
			retry: false
		};
	}
	async screenshot(page) {
		const result = object(await this.#call("capturePage", this.#owned(page)));
		const data = Buffer.from(string(result.data), "base64");
		if (data.subarray(0, 3).toString("hex") !== "ffd8ff") throw new Error("Invalid JPEG response");
		return data;
	}
	async startRecording(page, artifactRoot, options = {}) {
		const fps = options.fps ?? 5, maxSeconds = options.maxSeconds ?? 30;
		if (!Number.isInteger(fps) || fps < 1 || fps > 15 || !Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 60 || this.#recordings.has(page.tabId)) throw new Error("Invalid or duplicate recording");
		const stat = await node_fs_promises.default.lstat(artifactRoot);
		if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 63) !== 0) throw new Error("Owned private artifact directory required");
		const directory = await node_fs_promises.default.mkdtemp(node_path.default.join(artifactRoot, "tab-video-"));
		await node_fs_promises.default.chmod(directory, 448);
		await this.#call("recordingState", {
			...this.#owned(page),
			active: true
		});
		const frames = [];
		const start = performance.now();
		let stopped = false, error = null, bytes = 0, ended = start, captureMs = 0;
		const capture = async () => {
			const began = performance.now();
			try {
				const data = await this.screenshot(page);
				bytes += data.length;
				if (bytes > 100 * 1024 * 1024) throw new Error("Recording storage limit");
				const file = `${String(frames.length).padStart(5, "0")}.jpg`;
				await node_fs_promises.default.writeFile(node_path.default.join(directory, file), data, { mode: 384 });
				frames.push({
					file,
					seconds: (performance.now() - start) / 1e3,
					sha256: (0, node_crypto.createHash)("sha256").update(data).digest("hex")
				});
			} finally {
				captureMs += performance.now() - began;
			}
		};
		let stopPromise;
		const record = { stop: () => stopPromise ??= (async () => {
			stopped = true;
			await loop;
			try {
				await this.#call("recordingState", {
					...this.#owned(page),
					active: false
				});
			} catch {
				error ??= "Transport unavailable; recording incomplete";
			}
			this.#recordings.delete(page.tabId);
			const seconds = Math.max(1 / 30, (ended - start) / 1e3 - (frames[0]?.seconds ?? 0));
			const encodeStart = performance.now();
			let output = null;
			if (frames.length) {
				const concat = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(.001, (frames[i + 1]?.seconds ?? (ended - start) / 1e3) - frame.seconds).toFixed(6)}`).join("\n") + `\nfile '${frames.at(-1)?.file}'\n`;
				await node_fs_promises.default.writeFile(node_path.default.join(directory, "frames.ffconcat"), concat, { mode: 384 });
				try {
					await exec("ffmpeg", [
						"-v",
						"error",
						"-y",
						"-f",
						"concat",
						"-safe",
						"1",
						"-i",
						"frames.ffconcat",
						"-vf",
						"fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2",
						"-t",
						String(seconds),
						"-c:v",
						"libx264",
						"-pix_fmt",
						"yuv420p",
						"-movflags",
						"+faststart",
						"recording.mp4"
					], {
						cwd: directory,
						timeout: 6e4,
						env: { PATH: process.env.PATH }
					});
					output = node_path.default.join(directory, "recording.mp4");
					await node_fs_promises.default.chmod(output, 384);
				} catch {
					error ??= "Encoding failed; JPEG frames preserved";
				}
			}
			const receipt = {
				path: output,
				directory,
				seconds,
				frames,
				error,
				encodeMs: performance.now() - encodeStart,
				captureMs,
				sampleFps: fps
			};
			await node_fs_promises.default.writeFile(node_path.default.join(directory, "capture.json"), JSON.stringify(receipt, null, 2), { mode: 384 });
			return receipt;
		})() };
		const loop = (async () => {
			try {
				do {
					await capture();
					if (stopped) break;
					await sleep(1e3 / fps);
				} while (!stopped && performance.now() - start < maxSeconds * 1e3);
			} catch {
				error = "Capture interrupted: privacy, ownership, navigation, or transport changed";
			} finally {
				ended = performance.now();
			}
		})();
		this.#recordings.set(page.tabId, record);
		return record;
	}
	async close() {
		try {
			for (const recording of this.#recordings.values()) await recording.stop();
			if (!this.#socket.destroyed) await this.#call("finalizeTabs", { keep: [] });
		} finally {
			this.#fail();
		}
	}
};
//#endregion
exports.ChromeTransport = ChromeTransport;
