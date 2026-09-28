import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseJsonRpcMessage, isJsonRpcRequest } from "../shared/rpc";
import { parseObservation, type Observation } from "../shared/page-protocol";
import { privateSocketEndpoint } from "../shared/trusted-path";
export type { Observation } from "../shared/page-protocol";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid transport response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid string response"); return value; }
export type OwnedPage = Readonly<{ tabId: number; origin: string }>;
export type PrivateSubmission = Readonly<{ submitToken: string; documentId: string }>;
export type ActionOutcome = { status: "executed" | "not-executed" | "unknown"; retry: false; reason?: string };
export type UploadOutcome = { status: "attached" | "not-executed" | "unknown"; retry: false; name?: string; mime?: "application/pdf"; size?: number };
export type RecordingReceipt = { path: string | null; directory: string; seconds: number; frames: { file: string; seconds: number; sha256: string }[]; error: string | null; encodeMs: number; captureMs: number; sampleFps: number };

const transientObservationErrors = ["Page origin not ready or mismatch", "Frame with ID 0 was removed.", "Capture or observation blocked: private fields or frames", "Private document quarantined until cross-document navigation"];

// Chrome refuses to inject into a new tab until its first navigation leaves
// about:blank, so an observation made in that window is safe to repeat.
function isTransientObservationError(message: string) {
  return transientObservationErrors.includes(message) || message.startsWith('Cannot access contents of url "about:blank".');
}

export class ChromeTransport {
  #socket: net.Socket;
  #next = 0;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #pages = new Map<number, OwnedPage>();
  #recordings = new Map<number, { stop: () => Promise<RecordingReceipt> }>();
  readonly session: string;
  readonly epoch: string;

  private constructor(socket: net.Socket, session: string, epoch: string) {
    this.#socket = socket; this.session = session; this.epoch = epoch;
  }

  /**
   * Connect to the host's socket at `socketPath` by its canonical path, once privateSocketEndpoint
   * (src/shared/trusted-path.ts) found it to be this user's socket in a private directory that no other user can
   * change. The handshake does not authenticate the host, so nothing is sent to any other endpoint. A file system
   * error, such as ENOENT for a host that is not running, is thrown as it is.
   */
  static async connect(socketPath: string) {
    let canonical: string;
    try { canonical = privateSocketEndpoint(socketPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      throw new Error("Explicit private owned Unix socket required");
    }
    const socket = net.createConnection(canonical);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const transport = new ChromeTransport(socket, "", "");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 64 * 1024 * 1024) { transport.#fail(); return; }
      let index;
      while ((index = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, index); text = text.slice(index + 1);
        try {
          const response = parseJsonRpcMessage(JSON.parse(line));
          if (isJsonRpcRequest(response) || typeof response.id !== "number") continue;
          const pending = transport.#pending.get(response.id);
          if (!pending) continue;
          clearTimeout(pending.timer); transport.#pending.delete(response.id);
          if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result);
        } catch { transport.#fail(); }
      }
    });
    socket.on("error", () => transport.#fail()); socket.on("close", () => transport.#fail());
    try {
      const info = object(await transport.#call("host.info"));
      if (info.protocolVersion !== 2 || info.extensionProtocol !== "ready") throw new Error("Extension protocol not ready; connect again explicitly without replaying inputs");
      const extension = object(await transport.#call("getInfo"));
      if (extension.protocolVersion !== 2 || extension.pageProtocolVersion !== 2) throw new Error("Typed page protocol version 2 required");
      Object.defineProperties(transport, { session: { value: string(info.session_id) }, epoch: { value: string(info.epoch) } });
      return transport;
    } catch (error) { transport.#fail(); throw error; }
  }

  #fail() {
    this.#socket.destroy(); this.#pages.clear();
    for (const request of this.#pending.values()) { clearTimeout(request.timer); request.reject(new Error("Transport closed; outcome unknown; no replay")); }
    this.#pending.clear();
  }
  #call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#socket.destroyed) return Promise.reject(new Error("Transport closed; no replay"));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(), 35000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  #owned(page: OwnedPage) {
    if (this.#pages.get(page.tabId) !== page || this.#socket.destroyed) throw new Error("Page is not owned by this connection");
    return { tabId: page.tabId };
  }
  async open(url: string, options: { allowInsecureLoopback?: boolean } = {}): Promise<OwnedPage> {
    const origin = new URL(url).origin;
    const result = object(await this.#call("createTab"));
    if (typeof result.id !== "number" || result.active !== false) throw new Error("Inactive page creation failed");
    const page = Object.freeze({ tabId: result.id, origin }); this.#pages.set(page.tabId, page);
    await this.#call("attach", { tabId: page.tabId });
    await this.#call("bindPage", { tabId: page.tabId, expectedOrigin: origin, ...options });
    await this.navigate(page, url);
    return page;
  }
  async navigate(page: OwnedPage, url: string) {
    if (new URL(url).origin !== page.origin) throw new Error("Origin change refused");
    await this.#call("navigatePage", { ...this.#owned(page), url });
  }
  async observe(page: OwnedPage, options: { controlsOnly?: boolean } = {}): Promise<Observation> {
    if (options.controlsOnly !== undefined && typeof options.controlsOnly !== "boolean") throw new Error("Invalid observation mode");
    const result = parseObservation(await this.#call("observePage", { ...this.#owned(page), controlsOnly: options.controlsOnly === true }));
    if (new URL(result.url).origin !== page.origin || result.mode !== (options.controlsOnly ? "controls-only" : "full")) throw new Error("Observation binding changed");
    return result;
  }
  async waitFor(page: OwnedPage, expect: { text?: string; url?: string }, timeoutMs = 10000): Promise<Observation> {
    if ((!expect.text && !expect.url) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("Bounded nonempty expectation required");
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
  async act(page: OwnedPage, snapshot: string, actionId: string, text?: string): Promise<ActionOutcome> {
    const result = object(await this.#call("actPage", { ...this.#owned(page), snapshot, actionId, ...(text === undefined ? {} : { text }) }));
    if (result.status !== "executed" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid action result; no replay");
    return { status: result.status, retry: false, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) };
  }
  async uploadFile(page: OwnedPage, snapshot: string, actionId: string, filePath: string): Promise<UploadOutcome> {
    if (this.#recordings.has(page.tabId) || !path.isAbsolute(filePath) || filePath.includes("\0") || path.extname(filePath).toLowerCase() !== ".pdf") throw new Error("Valid local PDF required and recording must be stopped");
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size < 1) throw new Error("Current-user-owned regular PDF required");
    const handle = await fs.open(filePath, "r");
    try { const magic = Buffer.alloc(5); if ((await handle.read(magic, 0, 5, 0)).bytesRead !== 5 || magic.toString() !== "%PDF-") throw new Error("PDF signature required"); }
    finally { await handle.close(); }
    const name = path.basename(filePath);
    const result = object(await this.#call("uploadFile", { ...this.#owned(page), snapshot, actionId, path: filePath, name, size: info.size }));
    if (result.status !== "attached" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid upload result; no replay");
    return result.status === "attached" ? { status: "attached", retry: false, name, mime: "application/pdf", size: info.size } : { status: result.status, retry: false };
  }
  async privateFill(page: OwnedPage, selectors: string[], values: string[], options: { allowInsecureLoopback?: boolean } = {}) {
    if (this.#recordings.has(page.tabId)) throw new Error("Stop recording before private input");
    const params = this.#owned(page);
    const observed = object(await this.#call("observeDocument", { ...params, expectedOrigin: page.origin, selectors, ...options }));
    const result = object(await this.#call("privateFill", { ...params, expectedOrigin: page.origin, token: string(observed.token), documentId: string(observed.documentId), values }));
    return { status: result.status === "filled" ? "filled" : "not-filled-or-unknown", retry: false } as const;
  }
  async preparePrivateSubmit(page: OwnedPage, snapshot: string, actionId: string): Promise<PrivateSubmission> {
    const result = object(await this.#call("preparePrivateSubmit", { ...this.#owned(page), snapshot, actionId }));
    if (result.status !== "prepared") throw new Error("Private submit preparation refused");
    return Object.freeze({ submitToken: string(result.submitToken), documentId: string(result.documentId) });
  }
  async submitPrivate(page: OwnedPage, submission: PrivateSubmission): Promise<ActionOutcome> {
    const result = object(await this.#call("submitPrivate", { ...this.#owned(page), submitToken: submission.submitToken, documentId: submission.documentId }));
    if (result.status !== "executed" && result.status !== "not-executed" && result.status !== "unknown") throw new Error("Invalid private submit result; no replay");
    return { status: result.status, retry: false };
  }
  async screenshot(page: OwnedPage): Promise<Buffer> {
    const result = object(await this.#call("capturePage", this.#owned(page)));
    const data = Buffer.from(string(result.data), "base64");
    if (data.subarray(0, 3).toString("hex") !== "ffd8ff") throw new Error("Invalid JPEG response");
    return data;
  }
  async startRecording(page: OwnedPage, artifactRoot: string, options: { fps?: number; maxSeconds?: number } = {}) {
    const fps = options.fps ?? 5, maxSeconds = options.maxSeconds ?? 30;
    if (!Number.isInteger(fps) || fps < 1 || fps > 15 || !Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 60 || this.#recordings.has(page.tabId)) throw new Error("Invalid or duplicate recording");
    const stat = await fs.lstat(artifactRoot);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Owned private artifact directory required");
    const directory = await fs.mkdtemp(path.join(artifactRoot, "tab-video-"));
    await fs.chmod(directory, 0o700);
    await this.#call("recordingState", { ...this.#owned(page), active: true });
    const frames: RecordingReceipt["frames"] = [];
    const start = performance.now(); let stopped = false, error: string | null = null, bytes = 0, ended = start, captureMs = 0;
    const capture = async () => {
      const began = performance.now();
      try {
        const data = await this.screenshot(page);
        bytes += data.length; if (bytes > 100 * 1024 * 1024) throw new Error("Recording storage limit");
        const file = `${String(frames.length).padStart(5, "0")}.jpg`;
        await fs.writeFile(path.join(directory, file), data, { mode: 0o600 });
        frames.push({ file, seconds: (performance.now() - start) / 1000, sha256: createHash("sha256").update(data).digest("hex") });
      } finally { captureMs += performance.now() - began; }
    };
    let stopPromise: Promise<RecordingReceipt> | undefined;
    const record = { stop: () => stopPromise ??= (async () => {
      stopped = true; await loop;
      try { await this.#call("recordingState", { ...this.#owned(page), active: false }); } catch { error ??= "Transport unavailable; recording incomplete"; }
      this.#recordings.delete(page.tabId);
      const seconds = Math.max(1 / 30, (ended - start) / 1000 - (frames[0]?.seconds ?? 0));
      const encodeStart = performance.now(); let output: string | null = null;
      if (frames.length) {
        const concat = frames.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.seconds ?? (ended - start) / 1000) - frame.seconds).toFixed(6)}`).join("\n") + `\nfile '${frames.at(-1)?.file}'\n`;
        await fs.writeFile(path.join(directory, "frames.ffconcat"), concat, { mode: 0o600 });
        try {
          await exec("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "frames.ffconcat", "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "recording.mp4"], { cwd: directory, timeout: 60000, env: { PATH: process.env.PATH } });
          output = path.join(directory, "recording.mp4"); await fs.chmod(output, 0o600);
        } catch { error ??= "Encoding failed; JPEG frames preserved"; }
      }
      const receipt = { path: output, directory, seconds, frames, error, encodeMs: performance.now() - encodeStart, captureMs, sampleFps: fps };
      await fs.writeFile(path.join(directory, "capture.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      return receipt;
    })() };
    const loop = (async () => {
      try { do { await capture(); if (stopped) break; await sleep(1000 / fps); } while (!stopped && performance.now() - start < maxSeconds * 1000); }
      catch { error = "Capture interrupted: privacy, ownership, navigation, or transport changed"; }
      finally { ended = performance.now(); }
    })();
    this.#recordings.set(page.tabId, record);
    return record;
  }
  async close() {
    try {
      for (const recording of this.#recordings.values()) await recording.stop();
      if (!this.#socket.destroyed) await this.#call("finalizeTabs", { keep: [] });
    } finally { this.#fail(); }
  }
}
