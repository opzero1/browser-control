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
    response.end('<!doctype html><title>Synthetic only</title><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style><input id="user"><input id="password" type="password"><button>Test</button><label id="upload-trigger">Upload Invoice<input id="invoice" class="sr-only" type="file"></label><output id="upload-state">unchanged</output><script>document.getElementById("invoice").addEventListener("change",()=>{const state=document.getElementById("upload-state");state.textContent="changed";state.dataset.changes=String(Number(state.dataset.changes||0)+1)})</script>');
  });
  async function isolated() {
    const tree = await cdp.send("Page.getFrameTree");
    contextId = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "private-test" })).executionContextId;
  }
  async function run(fn: Function, args: unknown[]) {
    const result = await cdp.send("Runtime.callFunctionOn", {
      executionContextId: contextId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true
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

  it("rejects a public fill after its input value changes without a DOM mutation", async () => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    const snapshot = await run(pageControl, ["observe", origin, "public-snapshot"]);
    const input = snapshot.actions.find((action: { kind: string }) => action.kind === "fill");
    await page.evaluate(() => { (document.querySelector("#user") as HTMLInputElement).value = "changed-outside-driver"; });
    expect(await run(pageControl, ["act", origin, "public-snapshot", input.id, "replacement"])).toMatchObject({ status: "not-executed", reason: "stale" });
    expect(await page.locator("#user").inputValue()).toBe("changed-outside-driver");
  });

  it("discovers and dispatches native fallback controls in Chromium", async () => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    const labels = ["option", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio"];
    await page.evaluate(roles => {
      for (const role of roles) {
        const item = document.createElement("div");
        item.role = role;
        item.textContent = `Select ${role}`;
        item.addEventListener("click", () => { item.dataset.clicked = "true"; });
        document.body.append(item);
      }
      for (const type of ["checkbox", "radio"]) {
        const item = document.createElement("input");
        item.type = type;
        item.setAttribute("aria-label", `Select native ${type}`);
        document.body.append(item);
      }
    }, labels);
    for (const label of [...labels.map(role => `Select ${role}`), "Select native checkbox", "Select native radio"]) {
      const token = `control-${label}`;
      const snapshot = await run(pageControl, ["observe", origin, token]);
      const action = snapshot.actions.find((candidate: { label: string }) => candidate.label === label);
      expect(action).toMatchObject({ kind: "click", label });
      expect(await run(pageControl, ["act", origin, token, action.id])).toMatchObject({ status: "executed", retry: false });
    }
    expect(await page.evaluate(() => ({
      aria: [...document.querySelectorAll("[role]")].every(item => (item as HTMLElement).dataset.clicked === "true"),
      native: [...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')].every(item => (item as HTMLInputElement).checked)
    }))).toEqual({ aria: true, native: true });
  });

  it("opens and selects an Admin-shaped Rule dropdown from observed actions", async () => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(() => {
      const form = document.createElement("div");
      form.innerHTML = '<label id="rule-label">Rule</label><div class="MuiInputBase-root"><div role="combobox" aria-labelledby="rule-label rule-value"><span id="rule-value">Deny</span></div><input class="MuiSelect-nativeInput" aria-hidden="true"><button type="button" tabindex="-1"><svg aria-hidden="true"></svg></button></div>';
      const caret = form.querySelector("button")!;
      caret.addEventListener("click", () => {
        const menu = document.createElement("div");
        menu.setAttribute("role", "menu");
        for (const choice of ["Allow", "Deny"]) {
          const item = document.createElement("div");
          item.setAttribute("role", "menuitem");
          item.textContent = choice;
          item.addEventListener("click", () => { form.querySelector("#rule-value")!.textContent = choice; menu.remove(); });
          menu.append(item);
        }
        document.body.append(menu);
      });
      document.body.append(form);
    });
    const before = await run(pageControl, ["observe", origin, "rule-closed"]);
    const caret = before.actions.filter((action: { label: string }) => action.label === "Rule Deny options");
    expect(caret).toHaveLength(1);
    expect(caret[0]).toMatchObject({ kind: "click", role: "button" });
    expect(await run(pageControl, ["act", origin, "rule-closed", caret[0].id])).toMatchObject({ status: "executed" });
    const opened = await run(pageControl, ["observe", origin, "rule-opened"]);
    const allow = opened.actions.filter((action: { label: string }) => action.label === "Allow");
    expect(allow).toHaveLength(1);
    expect(await run(pageControl, ["act", origin, "rule-opened", allow[0].id])).toMatchObject({ status: "executed" });
    const selected = await run(pageControl, ["observe", origin, "rule-selected"]);
    expect(selected.actions).toContainEqual(expect.objectContaining({ label: "Rule Allow options" }));
    expect(await page.locator("#rule-value").textContent()).toBe("Allow");
  });

  it("keeps an expanded filter's portaled options ahead of a long table", async () => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(() => {
      document.body.innerHTML = '<button aria-expanded="true" aria-controls="cardholders">Cardholder</button>';
      for (let i = 0; i < 120; i++) {
        const row = document.createElement("button"); row.textContent = `Transaction ${i}`; document.body.append(row);
      }
      const popup = document.createElement("div"); popup.id = "cardholders"; popup.setAttribute("role", "dialog");
      popup.innerHTML = '<button type="button" aria-pressed="false">afif test</button>';
      popup.querySelector("button")!.addEventListener("click", event => (event.currentTarget as HTMLElement).setAttribute("aria-pressed", "true"));
      document.body.append(popup);
    });
    const snapshot = await run(pageControl, ["observe", origin, "filter-open"]);
    expect(snapshot.truncation.actions).toBe(true);
    const option = snapshot.actions.find((action: { label: string }) => action.label === "afif test");
    expect(option).toBeDefined();
    expect(await run(pageControl, ["act", origin, "filter-open", option.id])).toMatchObject({ status: "executed" });
    expect(await page.locator("#cardholders button").getAttribute("aria-pressed")).toBe("true");
  });

  it("observes a disabled display-only password mask without exposing or enabling its field", async () => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(() => {
      const password = document.querySelector("#password") as HTMLInputElement;
      password.defaultValue = "••••••••"; password.disabled = true;
      const title = document.createElement("h1"); title.textContent = "Personal settings"; document.body.append(title);
    });
    const snapshot = await run(pageControl, ["observe", origin, "masked-settings"]);
    expect(snapshot).toMatchObject({ status: "observed", text: expect.stringContaining("Personal settings") });
    expect(snapshot.actions.some((action: { role: string }) => action.role === "password")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("••••••••");
    expect(await run(pageControl, ["capture-check", origin, ""])).toMatchObject({ allowed: true });
    await page.evaluate(() => { (document.querySelector("#password") as HTMLInputElement).value = "PRIVATE_CANARY"; });
    expect(await run(pageControl, ["observe", origin, "changed"])).toMatchObject({ reason: "populated-private-input" });
    expect(await run(pageControl, ["capture-check", origin, ""])).toMatchObject({ allowed: false });
  });

  it.each(["enabled", "transferred", "restored"])("still blocks a %s password mask", async mode => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(disabled => {
      const password = document.querySelector("#password") as HTMLInputElement;
      password.defaultValue = "••••••••"; password.disabled = disabled;
    }, mode !== "enabled");
    if (mode === "transferred") await cdp.send("Runtime.evaluate", { contextId, expression: 'globalThis.__opzeroPrivateNodes = new WeakSet([document.querySelector("#password")])' });
    const selectors = mode === "restored" ? ["#password"] : [];
    expect(await run(pageControl, ["observe", origin, "blocked", "", null, { selectors, controlsOnly: false }])).toMatchObject({ status: "refused" });
    expect(await run(pageControl, ["capture-check", origin, "", "", JSON.stringify(selectors)])).toMatchObject({ allowed: false });
  });

  it.each(["enabled", "still-disabled", "replaced", "form-changed"])("binds a private submit that starts disabled: %s", async outcome => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(() => {
      const form = document.createElement("form"); form.action = location.href;
      const button = document.querySelector("button")!; button.type = "submit"; button.disabled = true;
      form.append(document.querySelector("#user")!, document.querySelector("#password")!, button);
      form.addEventListener("submit", event => { event.preventDefault(); form.dataset.submitted = "true"; });
      document.body.append(form);
    });
    const before = await run(pageControl, ["observe", origin, "disabled-login"]);
    const button = before.actions.find((action: { label: string }) => action.label === "Test");
    expect(button.disabled).toBe(true);
    const prepared = await run(pageControl, ["prepare-submit", origin, "disabled-login", button.id]);
    expect(prepared).toMatchObject({ status: "prepared" });
    expect(await observe()).toMatchObject({ status: "observed" });
    expect(await fill()).toMatchObject({ status: "filled" });
    await page.evaluate(mode => {
      const button = document.querySelector("button")!;
      if (mode !== "still-disabled") button.disabled = false;
      if (mode === "replaced") button.replaceWith(button.cloneNode(true));
      if (mode === "form-changed") button.form!.action = "https://other.invalid/login";
    }, outcome);
    const submitted = await run(pageControl, ["submit", origin, prepared.submitToken]);
    expect(submitted.status).toBe(outcome === "enabled" ? "executed" : "not-executed");
    expect(await page.locator("form").getAttribute("data-submitted")).toBe(outcome === "enabled" ? "true" : null);
    expect((await run(pageControl, ["submit", origin, prepared.submitToken])).status).toBe("not-executed");
  });

  async function preparedLogin(token: string, setup: (disabled: boolean) => void, disabled = false) {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    await page.evaluate(setup, disabled);
    const before = await run(pageControl, ["observe", origin, token]);
    const button = before.actions.find((action: { label: string }) => action.label === "Test");
    const prepared = await run(pageControl, ["prepare-submit", origin, token, button.id]);
    expect(prepared).toMatchObject({ status: "prepared" });
    expect(await observe()).toMatchObject({ status: "observed" });
    expect(await fill()).toMatchObject({ status: "filled" });
    return prepared;
  }
  const loginForm = (disabled: boolean) => {
    const form = document.createElement("form"); form.action = location.href; form.method = "post";
    const button = document.querySelector("button")!; button.type = "submit"; button.disabled = disabled;
    form.append(document.querySelector("#user")!, document.querySelector("#password")!, button);
    form.addEventListener("submit", event => { event.preventDefault(); form.dataset.submitted = String(Number(form.dataset.submitted || 0) + 1); });
    document.body.append(form);
    if (disabled) document.querySelector("#password")!.addEventListener("input", () => setTimeout(() => { button.disabled = false; }, 600));
  };

  it.each(["unchanged", "formmethod", "formenctype", "formnovalidate", "method", "enctype", "novalidate"])("binds a prepared login POST to its effective submission: %s", async change => {
    const prepared = await preparedLogin(`effective-${change}`, loginForm);
    await page.evaluate(change => {
      const button = document.querySelector("button")!, form = button.form!;
      if (change === "formmethod") button.formMethod = "get";
      if (change === "formenctype") button.formEnctype = "text/plain";
      if (change === "formnovalidate") button.formNoValidate = true;
      if (change === "method") form.method = "get";
      if (change === "enctype") form.enctype = "multipart/form-data";
      if (change === "novalidate") form.noValidate = true;
    }, change);
    expect((await run(pageControl, ["submit", origin, prepared.submitToken])).status).toBe(change === "unchanged" ? "executed" : "not-executed");
    expect(await page.locator("form").getAttribute("data-submitted")).toBe(change === "unchanged" ? "1" : null);
  });

  it("refuses delayed validation and consumes the prepared login without replay", async () => {
    const prepared = await preparedLogin("delayed-login", loginForm, true);
    expect(prepared.expiresInMs).toBe(90000);
    expect(await page.locator("form button").isDisabled()).toBe(true);
    expect((await run(pageControl, ["submit", origin, prepared.submitToken])).status).toBe("not-executed");
    expect(await page.locator("form").getAttribute("data-submitted")).toBe(null);
    await page.waitForTimeout(750);
    expect(await page.locator("form button").isEnabled()).toBe(true);
    expect((await run(pageControl, ["submit", origin, prepared.submitToken])).status).toBe("not-executed");
    expect(await page.locator("form").getAttribute("data-submitted")).toBe(null);
  });

  it.each(["password", "otp", "restored", "nested-otp", "closed-password", "display-mask"])("checks a %s control inside shadow roots before capture without returning values", async mode => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.__closedRoots = new WeakMap(); globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot ?? globalThis.__closedRoots.get(element) ?? null } }" });
    await page.evaluate(mode => {
      let root: ShadowRoot | null = null;
      if (mode !== "closed-password") { const host = document.createElement("x-login"); document.body.append(host); root = host.attachShadow({ mode: "open" }); }
      if (root && mode === "nested-otp") { const inner = document.createElement("x-otp"); root.append(inner); root = inner.attachShadow({ mode: "open" }); }
      if (!root) return;
      const input = document.createElement("input"); input.id = "shadow-private";
      if (mode === "password" || mode === "display-mask") input.type = "password";
      if (mode === "otp" || mode === "nested-otp") input.autocomplete = "one-time-code";
      if (mode === "display-mask") { input.defaultValue = "••••••••"; input.disabled = true; } else input.value = "PRIVATE_CANARY";
      root.append(input);
    }, mode);
    if (mode === "closed-password") await cdp.send("Runtime.evaluate", { contextId, expression: 'const host = document.createElement("x-closed"); document.body.append(host); const root = host.attachShadow({ mode: "closed" }); globalThis.__closedRoots.set(host, root); const input = document.createElement("input"); input.type = "password"; input.value = "PRIVATE_CANARY"; root.append(input);' });
    const checked = await run(pageControl, ["capture-check", origin, "", "", JSON.stringify(mode === "restored" ? ["#shadow-private"] : [])]);
    expect(checked).toEqual(mode === "display-mask" ? { status: "checked", allowed: true }
      : { status: "checked", allowed: false, reason: mode === "restored" ? "restored-private-selector" : "populated-private-input" });
    expect(JSON.stringify(checked)).not.toContain("CANARY");
  });

  it.each([0, 64 * 1024 * 1024])("attaches a harmless PDF through a Direct-shaped wrapping upload label (%i padding bytes)", async (padding) => {
    await reset();
    await cdp.send("Runtime.evaluate", { contextId, expression: "globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } }" });
    const pdf = path.join(directory, "public-invoice.pdf");
    const bytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
    fs.writeFileSync(pdf, bytes, { mode: 0o600 });
    const size = bytes.length + padding;
    fs.truncateSync(pdf, size);
    const snapshot = await run(pageControl, ["observe", origin, "upload-snapshot"]);
    const action = snapshot.actions.find((candidate: { label: string }) => candidate.label === "Upload Invoice");
    expect(action).toMatchObject({ kind: "upload", role: "input", disabled: false });
    const prepared = await run(pageControl, ["prepare-file", origin, "upload-snapshot", action.id]);
    expect(prepared).toMatchObject({ status: "prepared" });
    const root = await cdp.send("DOM.getDocument", { depth: 0, pierce: true });
    const matches = await cdp.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: prepared.selector });
    expect(matches.nodeIds).toHaveLength(1);
    expect(await run(pageControl, ["validate-file", origin, prepared.fileToken])).toMatchObject({ status: "validated" });
    await cdp.send("DOM.setFileInputFiles", { nodeId: matches.nodeIds[0], files: [pdf] });
    expect(await run(pageControl, ["verify-file", origin, prepared.fileToken, "", JSON.stringify({ name: path.basename(pdf), size })])).toEqual({ status: "attached", retry: false });
    expect(await page.evaluate(() => {
      const input = document.querySelector("#invoice") as HTMLInputElement;
      const state = document.querySelector("#upload-state") as HTMLOutputElement;
      return { count: input.files?.length, name: input.files?.[0]?.name, size: input.files?.[0]?.size, type: input.files?.[0]?.type, state: state.textContent, changes: state.dataset.changes };
    })).toEqual({ count: 1, name: "public-invoice.pdf", size, type: "application/pdf", state: "changed", changes: "1" });
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
