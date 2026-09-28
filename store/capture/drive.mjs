#!/usr/bin/env node
// Drives the extension through the private native host socket (protocol v2), the same way a local agent does.
// It stays connected so the session tab group survives while screenshots are taken. Commands arrive as
// JSON files in $BC_STATE/cmd/NNN.json and results are written to $BC_STATE/out/NNN.json:
//   {"op":"open","tab":"demo","url":"http://127.0.0.1:8765/"}   createTab + attach + bindPage + navigatePage
//   {"op":"navigate","tab":"wiki","url":"..."}                  navigatePage within the bound origin
//   {"op":"actions","tab":"demo"}                               observe and list action labels
//   {"op":"wait","tab":"demo","text":"Book a demo"}             observe until the text appears
//   {"op":"fill","tab":"demo","label":"Full name","text":"..."} observe, then actPage on the labelled field
//   {"op":"click","tab":"demo","label":"Request demo"}          observe, then actPage on the labelled control
//   {"op":"move","tab":"demo","x":900,"y":600}                  moveMouse: show the agent cursor overlay
//   {"op":"turnEnded"}                                          hide the agent cursor at the end of a turn
//   {"op":"finalize","keep":[{"tab":"demo","status":"deliverable"}]}
//   {"op":"exit"}
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const state = process.env.BC_STATE, socketPath = process.env.BC_SOCKET;
if (!state || !socketPath) throw new Error("BC_STATE and BC_SOCKET are required; source env.sh");
const cmdDir = path.join(state, "cmd"), outDir = path.join(state, "out");
fs.mkdirSync(cmdDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const socket = net.createConnection(socketPath);
await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.setEncoding("utf8");
let next = 0, buffer = "";
const pending = new Map();
socket.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  }
});
socket.on("close", () => { for (const w of pending.values()) w.reject(new Error("socket closed; outcome unknown")); process.exit(3); });
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, { resolve, reject });
  socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const info = await call("host.info");
if (info.protocolVersion !== 2 || info.extensionProtocol !== "ready") throw new Error(`host not ready: ${JSON.stringify(info)}`);
const extension = await call("getInfo");
if (extension.protocolVersion !== 2 || extension.pageProtocolVersion !== 2) throw new Error("page protocol v2 required");
fs.writeFileSync(path.join(outDir, "connected.json"), JSON.stringify({ host: info, extension }, null, 2));

const tabs = new Map();
const observe = async tab => call("observePage", { tabId: tabs.get(tab), controlsOnly: false });
const find = (observation, label, kind) => {
  const action = observation.actions.find(a => a.kind === kind && a.label.trim() === label)
    ?? observation.actions.find(a => a.kind === kind && a.label.includes(label));
  if (!action) throw new Error(`no ${kind} action labelled ${label}: ${JSON.stringify(observation.actions.map(a => a.label))}`);
  return action;
};
const ops = {
  async open({ tab, url }) {
    const created = await call("createTab");
    tabs.set(tab, created.id);
    await call("attach", { tabId: created.id });
    const origin = new URL(url).origin;
    await call("bindPage", { tabId: created.id, expectedOrigin: origin, allowInsecureLoopback: origin.startsWith("http://127.0.0.1") });
    await call("navigatePage", { tabId: created.id, url });
    return { tabId: created.id };
  },
  async navigate({ tab, url }) { return call("navigatePage", { tabId: tabs.get(tab), url }); },
  async actions({ tab }) { return (await observe(tab)).actions.map(({ kind, label }) => `${kind}:${label}`); },
  async wait({ tab, text, timeoutMs = 15000 }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const o = await observe(tab);
        if (o.text.includes(text)) return { title: o.title, url: o.url, textChars: o.text.length, actions: o.actions.length, excerpt: o.text.slice(0, 300) };
      } catch (error) { if (Date.now() > deadline) throw error; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${text}`);
      await sleep(200);
    }
  },
  async fill({ tab, label, text }) {
    const o = await observe(tab);
    return call("actPage", { tabId: tabs.get(tab), snapshot: o.snapshot, actionId: find(o, label, "fill").id, text });
  },
  async click({ tab, label }) {
    const o = await observe(tab);
    return call("actPage", { tabId: tabs.get(tab), snapshot: o.snapshot, actionId: find(o, label, "click").id });
  },
  async move({ tab, x, y }) {
    return call("moveMouse", { tabId: tabs.get(tab), x, y, waitForArrival: true });
  },
  async turnEnded() { return call("turnEnded"); },
  async name({ title }) { return call("nameSession", { name: title }); },
  async tabs() { return call("getTabs"); },
  async finalize({ keep }) {
    return call("finalizeTabs", { keep: keep.map(({ tab, status }) => ({ tabId: tabs.get(tab), status })) });
  },
  async exit() { setTimeout(() => { socket.end(); process.exit(0); }, 100); return { exiting: true }; },
};

// On SIGTERM, close this session's agent tabs (finalizeTabs with no keep) before disconnecting.
process.on("SIGTERM", async () => {
  try { await Promise.race([call("finalizeTabs", { keep: [] }), sleep(5000)]); } finally { process.exit(0); }
});

for (;;) {
  const files = fs.readdirSync(cmdDir).filter(f => /^\d+\.json$/.test(f)).sort();
  for (const file of files) {
    const command = JSON.parse(fs.readFileSync(path.join(cmdDir, file), "utf8"));
    fs.renameSync(path.join(cmdDir, file), path.join(cmdDir, `${file}.taken`));
    let result;
    try { result = { ok: true, command, result: await ops[command.op](command) }; }
    catch (error) { result = { ok: false, command, error: String(error.message || error) }; }
    fs.writeFileSync(path.join(outDir, file), JSON.stringify(result, null, 2));
  }
  await sleep(100);
}
