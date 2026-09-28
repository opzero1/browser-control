// captures.ts (native_captures.py): guarded JPEG capture, private artifacts and sampled recording.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDirectory, jpeg, Recording, saveExclusive, type CaptureTab, type RecordingDeps } from "../../../src/server/captures";
import { Gate } from "../../../src/server/gate";
import { BusyFlag } from "../../../src/server/runtime/busy";
import { privateTemp, removeTempRoots } from "../support/temp";

afterEach(() => removeTempRoots());

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/python-jpeg.json"), "utf8")) as { cases: Array<{ name: string; data: string }> };
const sample = (name: string) => corpus.cases.find((item) => item.name === name)?.data as string;
const JPEG = sample("rgb-4x4");

function fakeTab(capture: () => unknown = () => ({ data: JPEG }), states: unknown[] = [{ recording: true }, { recording: false }]) {
  const calls: Array<[string, unknown]> = [];
  const tab: CaptureTab & { calls: typeof calls } = {
    calls,
    operation: new BusyFlag(),
    async call(method, params) {
      calls.push([method, params]);
      if (method === "capturePage") return capture();
      return states.shift();
    }
  };
  return tab;
}

async function gate(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(Gate);
  await expect(promise).rejects.toMatchObject({ code });
}

const deps = (run: RecordingDeps["run"] = async () => undefined): RecordingDeps => ({ ffmpeg: () => "/usr/bin/ffmpeg", run });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("capture directories and files", () => {
  it("creates a private chrome-capture directory only under an owner-only root", () => {
    const root = privateTemp();
    const directory = captureDirectory(root);
    expect(path.dirname(directory)).toBe(root);
    expect(path.basename(directory)).toMatch(/^chrome-capture-/);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    fs.symlinkSync(root, path.join(root, "link"));
    fs.mkdirSync(path.join(root, "shared"), { mode: 0o750 });
    fs.chmodSync(path.join(root, "shared"), 0o750);
    for (const bad of [path.join(root, "missing"), path.join(root, "link"), path.join(root, "shared"), ""]) {
      expect(() => captureDirectory(bad)).toThrow("fast-chrome-private-artifact-root-required");
    }
  });

  it("saves exclusively with mode 0600", () => {
    const file = path.join(privateTemp(), "screenshot.jpg");
    saveExclusive(file, Buffer.from("a"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => saveExclusive(file, Buffer.from("b"))).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("a");
  });
});

describe("guarded JPEG capture", () => {
  it("returns a verified JPEG from capturePage", async () => {
    const tab = fakeTab();
    expect(await jpeg(tab)).toEqual(Buffer.from(JPEG, "base64"));
    expect(tab.calls).toEqual([["capturePage", undefined]]);
    expect(await jpeg(fakeTab(() => ({ data: sample("25M-exact") })))).toHaveLength(Buffer.from(sample("25M-exact"), "base64").length);
  });

  it("refuses anything that is not a bounded JPEG", async () => {
    const oversized = Buffer.concat([Buffer.from(JPEG, "base64"), Buffer.alloc(24 * 1024 * 1024)]).toString("base64");
    for (const result of [null, [], "x", {}, { data: 5 }, { data: "QQ=" }, { data: `${JPEG}\n` }, { data: sample("png") },
      { data: sample("mpo") }, { data: sample("25M-plus") }, { data: sample("no-sos") }, { data: oversized }]) {
      await gate(jpeg(fakeTab(() => result)), "fast-chrome-invalid-image");
    }
  });

  it("passes a page refusal through unchanged", async () => {
    await gate(jpeg(fakeTab(() => { throw new Gate("browser-control-private-page"); })), "browser-control-private-page");
  });
});

describe("sampled recording", () => {
  it("validates bounds before ffmpeg and confirms the extension state", async () => {
    const root = privateTemp();
    for (const [fps, max] of [[0, 30], [16, 30], [1.5, 30], [true, 30], ["5", 30], [5, 0], [5, 61], [5, 2.5]]) {
      await gate(Recording.start(fakeTab(), fps, max, root, { ffmpeg: () => null, run: async () => undefined }), "fast-chrome-recording-bounds");
    }
    await gate(Recording.start(fakeTab(), 5, 30, root, { ffmpeg: () => null, run: async () => undefined }), "fast-chrome-ffmpeg-required");
    await gate(Recording.start(fakeTab(), 5, 30, path.join(root, "missing"), deps()), "fast-chrome-private-artifact-root-required");
    const refused = fakeTab(undefined, [{ recording: false }]);
    await gate(Recording.start(refused, 5, 30, root, deps()), "fast-chrome-recording-unconfirmed");
    expect(refused.calls).toEqual([["recordingState", { active: true }]]);
    await gate(Recording.start(fakeTab(undefined, [{ recording: true, extra: 1 }]), 5, 30, root, deps()), "fast-chrome-recording-unconfirmed");
  });

  it("samples frames privately and writes a receipt once", async () => {
    const tab = fakeTab();
    const recording = await Recording.start(tab, 15, 30, privateTemp(), deps());
    await sleep(250);
    const receipt = await recording.stop({ encode: false });
    expect(Object.keys(receipt)).toEqual(["path", "directory", "seconds", "frames", "sample_fps", "error", "kind", "decode_verified", "playback_verified"]);
    expect(receipt).toMatchObject({ path: null, directory: recording.directory, sample_fps: 15, error: null, kind: "timestamped-jpeg-sampled-video", decode_verified: false, playback_verified: false });
    expect(receipt.frames.length).toBeGreaterThanOrEqual(2);
    const digest = createHash("sha256").update(Buffer.from(JPEG, "base64")).digest("hex");
    receipt.frames.forEach((frame, index) => {
      expect(frame.file).toBe(`${String(index).padStart(5, "0")}.jpg`);
      expect(frame.sha256).toBe(digest);
      expect(fs.statSync(path.join(recording.directory, frame.file)).mode & 0o777).toBe(0o600);
    });
    expect(receipt.seconds).toBeGreaterThan(0);
    const saved = JSON.parse(fs.readFileSync(path.join(recording.directory, "capture.json"), "utf8"));
    expect(saved).toEqual(JSON.parse(JSON.stringify(receipt)));
    expect(await recording.stop()).toBe(receipt);
    expect(tab.calls.filter(([method]) => method === "recordingState")).toEqual([["recordingState", { active: true }], ["recordingState", { active: false }]]);
    expect(tab.operation.busy).toBe(false);
  });

  it("skips intervals while the tab is busy", async () => {
    const tab = fakeTab();
    expect(tab.operation.tryAcquire()).toBe(true);
    const recording = await Recording.start(tab, 15, 30, privateTemp(), deps());
    await sleep(150);
    const receipt = await recording.stop({ encode: false });
    expect(receipt.frames).toEqual([]);
    expect(receipt.error).toBe("no-frames-captured");
    expect(tab.calls.some(([method]) => method === "capturePage")).toBe(false);
    tab.operation.release();
  });

  it("encodes and decode-checks the MP4 through ffmpeg", async () => {
    const runs: Array<{ args: string[]; cwd: string; timeout: number }> = [];
    const recording = await Recording.start(fakeTab(), 10, 30, privateTemp(), deps(async (file, args, cwd, timeout) => {
      expect(file).toBe("/usr/bin/ffmpeg");
      runs.push({ args, cwd, timeout });
      if (args.includes("recording.mp4")) fs.writeFileSync(path.join(cwd, "recording.mp4"), "mp4", { mode: 0o644 });
    }));
    await sleep(250);
    const receipt = await recording.stop();
    expect(receipt.path).toBe(path.join(recording.directory, "recording.mp4"));
    expect(receipt.decode_verified).toBe(true);
    expect(receipt.error).toBeNull();
    expect(fs.statSync(receipt.path as string).mode & 0o777).toBe(0o600);
    expect(runs.map((run) => run.timeout)).toEqual([60000, 60000]);
    expect(runs[0].args.slice(0, 9)).toEqual(["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "frames.ffconcat"]);
    expect(runs[0].args[runs[0].args.indexOf("-t") + 1]).toMatch(/^[0-9]+\.[0-9]+(e-[0-9]+)?$/);
    expect(runs[1].args).toEqual(["-v", "error", "-i", receipt.path, "-f", "null", "-"]);
    const concat = fs.readFileSync(path.join(recording.directory, "frames.ffconcat"), "utf8").trim().split("\n");
    expect(concat[0]).toBe("file '00000.jpg'");
    expect(concat[1]).toMatch(/^duration [0-9]+\.[0-9]{6}$/);
    expect(concat[concat.length - 1]).toBe(`file '${receipt.frames[receipt.frames.length - 1].file}'`);
  });

  it("reports encoding failure and interrupted capture in the receipt", async () => {
    const failing = await Recording.start(fakeTab(), 10, 30, privateTemp(), deps(async () => { throw new Error("ffmpeg failed"); }));
    await sleep(150);
    expect(await failing.stop()).toMatchObject({ path: null, decode_verified: false, error: "encoding-or-decode-failed" });
    let count = 0;
    const interrupted = await Recording.start(fakeTab(() => (count++ ? { data: "not base64!" } : { data: JPEG })), 15, 30, privateTemp(), deps());
    await sleep(200);
    const receipt = await interrupted.stop({ encode: false });
    expect(receipt.frames).toHaveLength(1);
    expect(receipt.error).toBe("capture-interrupted");
  });

  it("refuses an unconfirmed stop and never retries it", async () => {
    const tab = fakeTab(undefined, [{ recording: true }, { recording: true }]);
    const recording = await Recording.start(tab, 5, 30, privateTemp(), deps());
    await gate(recording.stop(), "fast-chrome-recording-stop-unconfirmed");
    await gate(recording.stop(), "fast-chrome-recording-stop-unconfirmed");
    expect(tab.calls.filter(([method]) => method === "recordingState")).toHaveLength(2);
  });

  it("ends sampling by itself at max_seconds", async () => {
    vi.useRealTimers();
    const tab = fakeTab();
    const recording = await Recording.start(tab, 15, 1, privateTemp(), deps());
    await sleep(1300);
    const captured = tab.calls.filter(([method]) => method === "capturePage").length;
    await sleep(150);
    expect(tab.calls.filter(([method]) => method === "capturePage").length).toBe(captured);
    const receipt = await recording.stop({ encode: false });
    expect(receipt.seconds).toBeLessThan(1.3);
  }, 10000);
});
