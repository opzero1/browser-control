// Guarded JPEG sampling through the page protocol; no desktop capture or continuous-video claim
// (native_captures.py).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { whichExecutable } from "./config";
import { Gate } from "./gate";
import { inspectJpeg } from "./jpeg";
import { pyDumps, pyFloatRepr, type JsonObject } from "./pyjson";
import type { BusyFlag } from "./runtime/busy";
import { monotonic } from "./time";

export const JPEG_LIMIT = 24 * 1024 * 1024;
export const PIXEL_LIMIT = 25_000_000;
export const RECORDING_STORAGE_LIMIT = 100 * 1024 * 1024;
export const STOP_JOIN_SECONDS = 36;
export const FFMPEG_TIMEOUT_MS = 60_000;

export interface CaptureTab { call(method: "capturePage" | "recordingState", params?: JsonObject): Promise<unknown>; readonly operation: BusyFlag }

/** base64.b64decode(text, validate=True): only the base64 alphabet, correct padding; str or bytes-like input. */
export function strictBase64(text: unknown): Buffer | null {
  let value: string;
  if (typeof text === "string") {
    if (!/^[\x00-\x7f]*$/.test(text)) return null;
    value = text;
  } else if (text instanceof Uint8Array) {
    value = Buffer.from(text).toString("latin1");
  } else {
    return null;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  // binascii.a2b_base64(strict_mode=True): the padding must complete the final group exactly.
  const body = value.replace(/=+$/, "");
  const pads = value.length - body.length;
  if (pads !== (4 - (body.length % 4)) % 4 || body.length % 4 === 1) return null;
  return Buffer.from(body, "base64");
}

function uid(): number {
  return process.getuid?.() ?? -1;
}

/** A new private chrome-capture-* directory under `root`, which must be an owner-only real directory. */
export function captureDirectory(root: string): string {
  try {
    if (typeof root !== "string" || !root) throw new Error();
    const stats = fs.lstatSync(root);
    if (!stats.isDirectory() || stats.uid !== uid() || stats.mode & 0o077) throw new Error();
    return fs.mkdtempSync(path.join(root, "chrome-capture-"));
  } catch {
    throw new Gate("fast-chrome-private-artifact-root-required");
  }
}

export async function jpeg(tab: CaptureTab): Promise<Buffer> {
  const result = await tab.call("capturePage");
  const data = typeof result === "object" && result !== null && !Array.isArray(result)
    ? strictBase64((result as Record<string, unknown>).data) : null;
  if (!data || data.length > JPEG_LIMIT) throw new Gate("fast-chrome-invalid-image");
  const image = inspectJpeg(data);
  if (!image || image.width * image.height > PIXEL_LIMIT) throw new Gate("fast-chrome-invalid-image");
  return data;
}

/** open(path, "xb") then fchmod 0600: never replaces an existing file. */
export function saveExclusive(file: string, data: Uint8Array): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export interface RecordingReceipt { path: string | null; directory: string; seconds: number; frames: { file: string; seconds: number; sha256: string }[]; sample_fps: number; error: string | null; kind: "timestamped-jpeg-sampled-video"; decode_verified: boolean; playback_verified: false }

export interface RecordingDeps {
  ffmpeg: () => string | null;
  /** Run a program with stdio discarded; reject on a non-zero exit, a spawn failure or the timeout. */
  run: (file: string, args: string[], cwd: string, timeoutMs: number) => Promise<void>;
}

export const defaultRecordingDeps: RecordingDeps = {
  ffmpeg: () => whichExecutable("ffmpeg"),
  run: (file, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  })
};

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function sameRecordingState(value: unknown, active: boolean): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as Record<string, unknown>).recording === active;
}

/** Python "%.6f" formatting. */
function fixed6(value: number): string {
  return value.toFixed(6);
}

export class Recording {
  readonly directory: string;
  private readonly frames: { file: string; seconds: number; sha256: string }[] = [];
  private bytes = 0;
  private error: string | null = null;
  private readonly started: number;
  private ended = 0;
  private receipt: RecordingReceipt | null = null;
  private stopAttempted = false;
  private stopping: Promise<RecordingReceipt> | null = null;
  private stopRequested = false;
  private wakeSampler: (() => void) | null = null;
  private sampler: Promise<void> = Promise.resolve();

  private constructor(private readonly tab: CaptureTab, private readonly fps: number, private readonly maxSeconds: number, directory: string, private readonly deps: RecordingDeps) {
    this.directory = directory;
    this.started = monotonic();
  }

  static async start(tab: CaptureTab, fps: unknown, maxSeconds: unknown, root: string, deps: RecordingDeps = defaultRecordingDeps): Promise<Recording> {
    if (!isInt(fps) || fps < 1 || fps > 15 || !isInt(maxSeconds) || maxSeconds < 1 || maxSeconds > 60) {
      throw new Gate("fast-chrome-recording-bounds");
    }
    if (!deps.ffmpeg()) throw new Gate("fast-chrome-ffmpeg-required");
    const directory = captureDirectory(root);
    const recording = new Recording(tab, fps, maxSeconds, directory, deps);
    if (!sameRecordingState(await tab.call("recordingState", { active: true }), true)) {
      throw new Gate("fast-chrome-recording-unconfirmed");
    }
    recording.sampler = recording.run();
    return recording;
  }

  private async capture() {
    const data = await jpeg(this.tab);
    if (this.bytes + data.length > RECORDING_STORAGE_LIMIT) throw new Gate("fast-chrome-recording-storage-limit");
    const name = `${String(this.frames.length).padStart(5, "0")}.jpg`;
    saveExclusive(path.join(this.directory, name), data);
    this.frames.push({ file: name, seconds: monotonic() - this.started, sha256: createHash("sha256").update(data).digest("hex") });
    this.bytes += data.length;
  }

  /** Wait 1/fps, or less when stop is requested; true when stopped (Event.wait semantics). */
  private pause(): Promise<boolean> {
    if (this.stopRequested) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSampler = null;
        resolve(this.stopRequested);
      }, 1000 / this.fps);
      this.wakeSampler = () => {
        clearTimeout(timer);
        this.wakeSampler = null;
        resolve(true);
      };
    });
  }

  private async run(): Promise<void> {
    try {
      while (true) {
        if (this.tab.operation.tryAcquire()) {
          try {
            await this.capture();
          } finally {
            this.tab.operation.release();
          }
        }
        if (await this.pause() || monotonic() - this.started >= this.maxSeconds) break;
      }
    } catch {
      this.error = "capture-interrupted";
    } finally {
      this.ended = monotonic();
    }
  }

  /** Stop sampling, confirm the extension stopped, then optionally encode and decode the MP4. */
  stop(options: { encode?: boolean } = {}): Promise<RecordingReceipt> {
    if (this.receipt) return Promise.resolve(this.receipt);
    // One stop at a time, like stop_lock; a second caller sees the first attempt's outcome.
    const previous = this.stopping ?? Promise.resolve(null as unknown as RecordingReceipt);
    const attempt = previous.catch(() => null).then(() => this.stopOnce(options.encode ?? true));
    this.stopping = attempt;
    return attempt;
  }

  private async stopOnce(encode: boolean): Promise<RecordingReceipt> {
    if (this.receipt) return this.receipt;
    if (this.stopAttempted) throw new Gate("fast-chrome-recording-stop-unconfirmed");
    this.stopRequested = true;
    this.wakeSampler?.();
    const joined = await Promise.race([
      this.sampler.then(() => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), STOP_JOIN_SECONDS * 1000).unref(); })
    ]);
    if (!joined) throw new Gate("fast-chrome-recording-stop-unconfirmed");
    this.stopAttempted = true;
    if (!sameRecordingState(await this.tab.call("recordingState", { active: false }), false)) {
      throw new Gate("fast-chrome-recording-stop-unconfirmed");
    }
    if (!this.frames.length) this.error ??= "no-frames-captured";
    const duration = Math.max(1 / 30, this.ended - this.started - (this.frames.length ? this.frames[0].seconds : 0));
    let output: string | null = null;
    if (encode && this.frames.length) {
      const lines: string[] = [];
      this.frames.forEach((frame, i) => {
        const end = i + 1 < this.frames.length ? this.frames[i + 1].seconds : this.ended - this.started;
        lines.push(`file '${frame.file}'`, `duration ${fixed6(Math.max(0.001, end - frame.seconds))}`);
      });
      lines.push(`file '${this.frames[this.frames.length - 1].file}'`);
      saveExclusive(path.join(this.directory, "frames.ffconcat"), Buffer.from(`${lines.join("\n")}\n`));
      try {
        const ffmpeg = this.deps.ffmpeg() ?? "ffmpeg";
        await this.deps.run(ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "frames.ffconcat", "-vf",
          "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-t", pyFloatRepr(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-movflags", "+faststart", "recording.mp4"], this.directory, FFMPEG_TIMEOUT_MS);
        const video = path.join(this.directory, "recording.mp4");
        fs.chmodSync(video, 0o600);
        await this.deps.run(ffmpeg, ["-v", "error", "-i", video, "-f", "null", "-"], this.directory, FFMPEG_TIMEOUT_MS);
        output = video;
      } catch {
        this.error ??= "encoding-or-decode-failed";
      }
    }
    const receipt: RecordingReceipt = {
      path: output, directory: this.directory, seconds: duration, frames: this.frames, sample_fps: this.fps, error: this.error,
      kind: "timestamped-jpeg-sampled-video", decode_verified: output !== null, playback_verified: false
    };
    saveExclusive(path.join(this.directory, "capture.json"), Buffer.from(`${pyDumps(receipt, { indent: 2 })}\n`));
    this.receipt = receipt;
    return receipt;
  }
}
