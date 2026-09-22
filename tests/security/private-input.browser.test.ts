import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { background } from "../support/background";
import { testTemp } from "../support/temp";
import { pageControl } from "../../src/extension/page-control";

const executablePath = process.env.OPZERO_SYNTHETIC_CHROME;
describe.skipIf(!executablePath)("private guard in disposable headless Chrome (loopback only)", () => {
  let browser: BrowserContext;
  let page: Page;
  let cdp: CDPSession;
  let contextId: number;
  let origin: string;
  let directory: string;
  let observePrivateFields: Function;
  let fillPrivateFields: Function;
  const server = http.createServer((_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><title>Synthetic only</title><input id="user"><input id="password" type="password"><button>Test</button>');
  });
  async function isolated() {
    const tree = await cdp.send("Page.getFrameTree");
    contextId = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "private-test" })).executionContextId;
  }
  async function run(fn: Function, args: unknown[]) {
    const result = await cdp.send("Runtime.callFunctionOn", {
      executionContextId: contextId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true
    });
    if (result.exceptionDetails) throw new Error("Synthetic isolated script failed");
    return result.result.value;
  }
  async function reset() { await page.goto(origin); await isolated(); }
  const observe = (token = "one-use", expectedUrl?: string) => run(observePrivateFields, [origin, ["#user", "#password"], token, true, expectedUrl]);
  const fill = (expected = origin, token = "one-use") => run(fillPrivateFields, [expected, token, ["synthetic-user", "synthetic-private-value"]]);

  beforeAll(async () => {
    const bundle = await background();
    const owner = { session_id: "bundle-test", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
    await bundle.rpc("createTab", owner);
    await bundle.rpc("bindPage", owner);
    const observed = (await bundle.rpc("observeDocument", { ...owner, selectors: ["#user", "#password"] })).result;
    await bundle.rpc("privateFill", { ...owner, ...observed, values: ["synthetic-user", "synthetic-private-value"] });
    observePrivateFields = bundle.chrome.scripting.executeScript.mock.calls[0][0].func;
    fillPrivateFields = bundle.chrome.scripting.executeScript.mock.calls[1][0].func;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    origin = `http://127.0.0.1:${address.port}`;
    directory = testTemp("chrome-");
    browser = await chromium.launchPersistentContext(path.join(directory, "profile"), {
      executablePath, headless: true,
      env: { ...process.env, TMPDIR: directory },
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"]
    });
    await browser.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    page = browser.pages()[0];
    cdp = await browser.newCDPSession(page);
    await reset();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("fills observed controls in an isolated world without returning values", async () => {
    await reset();
    expect(await observe()).toEqual({ status: "observed", origin, url: `${origin}/` });
    expect(await fill()).toEqual({ status: "filled" });
    expect(await page.evaluate(() => (document.querySelector("#password") as HTMLInputElement).value === "synthetic-private-value")).toBe(true);
    expect(await fill()).toEqual({ status: "refused" });
  });

  it("rejects a public action after an input value changes without a DOM mutation", async () => {
    await reset();
    const snapshot = await run(pageControl, ["observe", origin, "public-snapshot"]);
    const button = snapshot.actions.find((action: { label: string }) => action.label === "Test");
    await page.evaluate(() => { (document.querySelector("#user") as HTMLInputElement).value = "changed-outside-driver"; });
    expect(await run(pageControl, ["act", origin, "public-snapshot", button.id])).toMatchObject({ status: "not-executed", reason: "stale" });
  });

  it("atomically rejects a mismatching origin even with an otherwise valid observation", async () => {
    await reset(); await observe();
    expect(await fill("https://not-this-origin.invalid")).toEqual({ status: "refused" });
    expect(await page.evaluate(() => (document.querySelector("#password") as HTMLInputElement).value.length)).toBe(0);
  });

  it("rejects a same-origin wrong expected path before any input", async () => {
    await reset();
    expect(await observe("wrong-path", `${origin}/expected`)).toEqual({ status: "refused" });
    expect(await fill(origin, "wrong-path")).toEqual({ status: "refused" });
    expect(await page.evaluate(() => [...document.querySelectorAll("input")].every(input => input.value.length === 0))).toBe(true);
  });

  it("rejects same-document SPA drift before any input", async () => {
    await reset(); await observe("spa-drift", `${origin}/`);
    await page.evaluate(() => history.pushState(null, "", "/next"));
    expect(await fill(origin, "spa-drift")).toEqual({ status: "refused" });
    expect(await page.evaluate(() => [...document.querySelectorAll("input")].every(input => input.value.length === 0))).toBe(true);
  });

  it("rejects replaced controls, stale documents, and wrong tokens without replay", async () => {
    await reset(); await observe();
    await page.evaluate(() => { const input = document.querySelector("#password")!; input.replaceWith(input.cloneNode()); });
    expect(await fill()).toEqual({ status: "refused" });
    await reset(); await observe();
    expect(await fill(origin, "wrong")).toEqual({ status: "refused" });
    expect(await fill()).toEqual({ status: "refused" });
    await observe(); await page.reload(); await isolated();
    expect(await fill()).toEqual({ status: "refused" });
  });

  it("does not continue into a field replaced by synchronous input handlers", async () => {
    await reset(); await observe();
    await page.evaluate(() => document.querySelector("#user")!.addEventListener("input", () => {
      const password = document.querySelector("#password")!; password.replaceWith(password.cloneNode());
    }));
    expect(await fill()).toEqual({ status: "unknown" });
    expect(await page.evaluate(() => (document.querySelector("#password") as HTMLInputElement).value.length)).toBe(0);
    expect(await fill()).toEqual({ status: "refused" });
  });

  it("rejects duplicate, ambiguous, hidden, disabled, and non-input selectors", async () => {
    await reset();
    for (const selectors of [["input"], ["button"], ["#user", "#user"], ["#missing"]]) {
      expect(await run(observePrivateFields, [origin, selectors, "token", true])).toEqual({ status: "refused" });
    }
    await page.evaluate(() => { (document.querySelector("#user") as HTMLInputElement).disabled = true; });
    expect(await observe()).toEqual({ status: "refused" });
  });

  it("requires explicit loopback HTTP opt-in and rejects transparent or inert fields", async () => {
    await reset();
    expect(await run(observePrivateFields, [origin, ["#user"], "token"])).toEqual({ status: "refused" });
    await page.evaluate(() => { (document.querySelector("#password") as HTMLElement).style.opacity = "0"; });
    expect(await observe()).toEqual({ status: "refused" });
    await reset();
    await page.evaluate(() => { document.body.inert = true; });
    expect(await observe()).toEqual({ status: "refused" });
  });

  it("records bounded synthetic guard latency without a speedup claim", async () => {
    await reset();
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      expect((await observe(`sample-${i}`)).status).toBe("observed");
      expect((await fill(origin, `sample-${i}`)).status).toBe("filled");
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const result = { surface: "two CDP calls: isolated observation + fill; loopback headless; not extension/native transport", n: samples.length, medianMs: samples[15], p95Ms: samples[28] };
    fs.writeFileSync("dist/synthetic-metrics.json", JSON.stringify(result, null, 2));
    expect(samples.every(Number.isFinite)).toBe(true);
  });
});
