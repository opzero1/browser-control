#!/usr/bin/env node
// Render one local HTML file to a PNG at an exact CSS-pixel size with headless Chrome for Testing over CDP.
// (This Chrome build's --headless --screenshot flag never writes a file, so the capture goes through CDP.)
// Usage: node render.mjs <chrome-binary> <file.html> <width> <height> <out.png>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [binary, html, width, height, out] = process.argv.slice(2);
const w = Number(width), h = Number(height);
const profile = fs.mkdtempSync(path.join(process.env.BC_TMP || os.tmpdir(), "bc-promo-profile-"));
const chrome = spawn(binary, ["--headless", "--use-mock-keychain", "--no-first-run", "--hide-scrollbars",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { await sleep(100); }
  }
  if (!port) throw new Error("headless Chrome did not start");
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(), events = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m.method);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `file://${path.resolve(html)}` });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i++) await sleep(50);
  await send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  ws.close();
} finally {
  chrome.kill("SIGTERM");
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
