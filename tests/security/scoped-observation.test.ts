import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pageControl } from "../../src/extension/page-control";
import { parseObservation } from "../../src/shared/page-protocol";
import { dom, Element, Input, Textarea, Button, Form, Slot, Text } from "../support/scoped-dom";
import { background } from "../support/background";

let doc: ReturnType<typeof dom>;
const origin = "https://synthetic.invalid";
const observe = (controlsOnly = false, selectors: string[] = []) => pageControl("observe", origin, "fresh", "", null, { controlsOnly, selectors });
const act = (id = "0", text?: string) => pageControl("act", origin, "fresh", id, text);
beforeEach(() => { doc = dom(); });
afterEach(() => { vi.useRealTimers(); for (const key of ["__opzeroSnapshot", "__opzeroSubmit", "__opzeroFile", "__opzeroPrivateDocument", "__opzeroPrivateForms", "__opzeroPrivateNodes"]) Reflect.deleteProperty(globalThis, key); vi.unstubAllGlobals(); });

it("excludes embed fallback and closed hosts from text, labels, inventory and markers", () => {
  const button = new Button("Public");
  for (const kind of ["iframe", "frame", "object", "embed", "x-closed"]) {
    const opaque = new Element(kind, "OPAQUE_CANARY"); opaque.setAttribute("title", "OPAQUE_CANARY");
    opaque.append(new Button("OPAQUE_CANARY"));
    if (kind === "x-closed") opaque.attachShadow("closed").append(new Button("OPAQUE_CANARY"));
    button.append(opaque);
  }
  doc.body.append(button);
  const raw = observe(); const result = parseObservation(raw);
  expect(result.partial).toBe(true); expect(result.opaqueSurfaces).toHaveLength(5);
  expect(result.actions).toHaveLength(1); expect(result.actions[0].label).toBe("Public");
  expect(JSON.stringify(raw)).not.toContain("CANARY");
  expect((globalThis as any).__opzeroSnapshot.targets[0].marker).not.toContain("CANARY");
  expect(act().status).toBe("executed"); expect(button.clicks).toBe(1);
  expect(act().status).toBe("not-executed");
});

it("fills public input next to embeds and tolerates unrelated text updates", () => {
  const input = new Input(), status = new Element("p", "Loading");
  doc.body.append(input, status, new Element("iframe"));
  expect(observe().status).toBe("observed"); status.append(new Text("Ready"));
  expect(act("0", "Public value").status).toBe("executed"); expect(input.value).toBe("Public value");
});

it("discovers only named visible or visibly labelled file inputs", () => {
  const hidden = new Input(), labelled = new Input(), label = new Element("label", "Upload statement"), visible = new Input(), tiny = new Input();
  const emptyLabelled = new Input(), emptyLabel = new Element("label"), hiddenParent = new Element("div"), nested = new Input(), nestedLabel = new Element("label", "Hidden ancestor");
  hidden.type = labelled.type = visible.type = tiny.type = emptyLabelled.type = nested.type = "file"; hidden.style.display = labelled.style.display = emptyLabelled.style.display = nested.style.display = "none";
  labelled.labels = [label]; label.append(labelled); visible.setAttribute("aria-label", "Upload invoice"); tiny.setAttribute("aria-label", "Tiny generic input"); tiny.getBoundingClientRect = () => ({ width: 1, height: 1 });
  emptyLabelled.labels = [emptyLabel]; emptyLabel.append(emptyLabelled); nested.labels = [nestedLabel]; hiddenParent.setAttribute("inert", ""); hiddenParent.append(nested); doc.body.append(hidden, label, visible, tiny, emptyLabel, hiddenParent, nestedLabel);
  expect(parseObservation(observe()).actions).toEqual([
    expect.objectContaining({ kind: "upload", label: "Upload statement" }),
    expect.objectContaining({ kind: "upload", label: "Upload invoice" })
  ]);
});

it("keeps file attachment behind a fresh single-use prepared capability", () => {
  const input = new Input(); input.type = "file"; input.setAttribute("aria-label", "Upload PDF"); doc.body.append(input);
  const observation = parseObservation(observe()); expect(observation.actions[0].kind).toBe("upload");
  expect(act().reason).toBe("file-requires-upload-rpc");
  const fresh = parseObservation(observe());
  const prepared = pageControl("prepare-file", origin, fresh.snapshot, "0");
  expect(prepared.status).toBe("prepared"); expect(pageControl("validate-file", origin, prepared.fileToken!).status).toBe("validated");
  input.files = { 0: { name: "invoice.pdf", size: 12, type: "application/pdf" }, length: 1 };
  expect(pageControl("verify-file", origin, prepared.fileToken!, "", JSON.stringify({ name: "invoice.pdf", size: 12 })).status).toBe("attached");
  expect(pageControl("verify-file", origin, prepared.fileToken!, "", JSON.stringify({ name: "invoice.pdf", size: 12 })).status).toBe("not-executed");
});

it("returns unknown when prepared file metadata does not match", () => {
  const input = new Input(); input.type = "file"; input.setAttribute("aria-label", "Upload PDF"); doc.body.append(input);
  const snapshot = parseObservation(observe()); const prepared = pageControl("prepare-file", origin, snapshot.snapshot, "0");
  input.files = { 0: { name: "other.pdf", size: 12, type: "application/pdf" }, length: 1 };
  expect(pageControl("verify-file", origin, prepared.fileToken!, "", JSON.stringify({ name: "invoice.pdf", size: 12 }))).toEqual({ status: "unknown", retry: false });
});

it("rechecks privacy before file metadata readback and token-binds cleanup", () => {
  const input = new Input(), password = new Input(); input.type = "file"; input.setAttribute("aria-label", "Upload PDF"); password.type = "password"; doc.body.append(input, password);
  const snapshot = parseObservation(observe()); const prepared = pageControl("prepare-file", origin, snapshot.snapshot, "0");
  password.value = "PRIVATE_CANARY";
  const verified = pageControl("verify-file", origin, prepared.fileToken!, "", JSON.stringify({ name: "invoice.pdf", size: 12 }));
  expect(verified.reason).toBe("populated-private-input"); expect(JSON.stringify(verified)).not.toContain("CANARY");
  expect(pageControl("cancel-file", origin, "wrong").reason).toBe("file-cancel-refused");
  expect(pageControl("cancel-file", origin, prepared.fileToken!).status).toBe("cancelled");
});

it.each(["option", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio"])("observes and executes an ARIA %s", role => {
  const item = new Element("div", `Select ${role}`); item.setAttribute("role", role); doc.body.append(item);
  const result = parseObservation(observe());
  expect(result.actions).toEqual([expect.objectContaining({ id: "0", kind: "click", label: `Select ${role}`, role })]);
  expect(act().status).toBe("executed");
  expect(item.clicks).toBe(1);
});

it("labels and clicks the unique caret beside a custom combobox", () => {
  const fieldLabel = new Element("label", "Rule"), current = new Element("span", "Deny");
  fieldLabel.setAttribute("id", "rule-label"); current.setAttribute("id", "rule-value");
  const combobox = new Element("div");
  combobox.setAttribute("role", "combobox");
  combobox.setAttribute("aria-labelledby", "rule-label rule-value");
  combobox.setAttribute("aria-expanded", "false");
  combobox.append(current);
  const caret = new Button("");
  const wrapper = new Element("div"); wrapper.append(combobox, caret);
  doc.body.append(fieldLabel, wrapper);
  const result = parseObservation(observe());
  expect(result.actions).toEqual([
    expect.objectContaining({ id: "0", kind: "click", label: "Rule Deny options", role: "button" })
  ]);
  expect(act("0").status).toBe("executed");
  expect(combobox.clicks).toBe(0);
  expect(caret.clicks).toBe(1);
});

it("refuses a custom caret action after its adjacent value changes", () => {
  const combobox = new Element("div", "Deny"), caret = new Button("");
  combobox.setAttribute("role", "combobox");
  const wrapper = new Element("div"); wrapper.append(combobox, caret); doc.body.append(wrapper);
  observe();
  combobox.append(new Text("Allow"));
  expect(act().status).toBe("not-executed");
  expect(caret.clicks).toBe(0);
});

it("leaves an anonymous caret unnamed when its combobox sibling is ambiguous", () => {
  const wrapper = new Element("div"), first = new Element("div", "Rule"), second = new Element("div", "Other"), caret = new Button("");
  first.setAttribute("role", "combobox"); second.setAttribute("role", "combobox");
  wrapper.append(first, second, caret); doc.body.append(wrapper);
  expect(parseObservation(observe()).actions[0].label).toBe("");
});

it("exposes Direct's stay-signed-in role checkbox before private transfer", () => {
  const checkbox = new Element("div", "Stay signed in for 2 weeks"); checkbox.setAttribute("role", "checkbox"); checkbox.setAttribute("aria-checked", "false"); doc.body.append(checkbox);
  const result = parseObservation(observe());
  expect(result.actions).toEqual([expect.objectContaining({ id: "0", kind: "click", label: "Stay signed in for 2 weeks", role: "checkbox" })]);
  expect(act().status).toBe("executed");
  expect(checkbox.clicks).toBe(1);
});

it.each(["checkbox", "radio"])("observes and executes a native %s input", type => {
  const item = new Input(); item.type = type; item.setAttribute("aria-label", `Select ${type}`); doc.body.append(item);
  const result = parseObservation(observe());
  expect(result.actions).toEqual([expect.objectContaining({ id: "0", kind: "click", label: `Select ${type}`, role: "input" })]);
  expect(act().status).toBe("executed");
  expect(item.clicks).toBe(1);
  expect(item.checked).toBe(true);
});

it.each(["aria-selected", "checked", "indeterminate"])("invalidates changed fallback-control %s state", state => {
  const item = state === "aria-selected" ? new Element("div", "Option") : new Input();
  if (state === "aria-selected") { item.setAttribute("role", "option"); item.setAttribute("aria-selected", "false"); }
  else { (item as Input).type = "checkbox"; item.setAttribute("aria-label", "Check"); }
  doc.body.append(item); observe();
  if (state === "aria-selected") item.setAttribute("aria-selected", "true");
  else (item as Input)[state] = true;
  expect(act().status).toBe("not-executed");
  expect(item.clicks).toBe(0);
});

it.each(["closed", "object", "nested-open"])("keeps global light-root private checks outside the output scope: %s", surface => {
  const host = new Element(surface === "object" ? "object" : "x-component"), input = new Input();
  input.type = "password"; input.value = "PRIVATE_CANARY"; host.append(input, new Text("OPAQUE_CANARY"));
  if (surface === "closed") host.attachShadow("closed");
  if (surface === "nested-open") { input.remove(); const nested = new Element("x-nested"); host.attachShadow("open").append(nested); nested.attachShadow("open").append(input); }
  doc.body.append(host, new Button());
  expect(observe().reason).toBe("populated-private-input");
  input.value = ""; const result = parseObservation(observe()); expect(result.actions).toHaveLength(1);
  if (surface !== "nested-open") { expect(result.opaqueSurfaces).toHaveLength(1); expect(result.text).not.toContain("CANARY"); }
});

it("checks restored selectors in object fallback without including its public controls", () => {
  const object = new Element("object"), input = new Input(); input.setAttribute("id", "restored"); input.value = "PRIVATE_CANARY"; object.append(input, new Button("OPAQUE_CANARY")); doc.body.append(object, new Button());
  expect(observe(false, ["#restored"]).reason).toBe("restored-private-selector");
  const result = parseObservation(observe()); expect(result.actions).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("CANARY");
});

it.each(["password", "otp", "weak", "restored"])("scans hidden inert open-root %s controls globally before output", mode => {
  const host = new Element("x-open"), input = new Input();
  host.setAttribute("inert", ""); input.style.display = "none"; input.value = "PRIVATE_CANARY"; input.setAttribute("id", "private");
  if (mode === "password") input.type = "password";
  if (mode === "otp") input.autocomplete = "one-time-code";
  if (mode === "weak") vi.stubGlobal("__opzeroPrivateNodes", new WeakSet([input]));
  host.attachShadow("open").append(input); doc.body.append(new Button(), new Element("iframe"), host);
  const result = observe(false, mode === "restored" ? ["#private"] : []);
  expect(result.reason).toBe(mode === "restored" ? "restored-private-selector" : "populated-private-input");
  expect(JSON.stringify(result)).not.toContain("CANARY"); expect((globalThis as any).__opzeroSnapshot).toBeUndefined();
});

it("omits empty private controls and all associated labels, including aria references", () => {
  const password = new Input(), label = new Element("label", "PRIVATE_LABEL_CANARY"), aria = new Element("span", "ARIA_CANARY");
  password.type = "password"; password.labels = [label]; aria.setAttribute("id", "private-name"); password.setAttribute("aria-labelledby", "private-name");
  doc.body.append(password, label, aria, new Button());
  expect(JSON.stringify(observe())).not.toContain("CANARY");
});

it("does not recover a private label through a public aria-labelledby descendant", () => {
  const password = new Input(), label = new Element("label"), nested = new Element("span", "PRIVATE_LABEL_CANARY"), button = new Button("");
  password.type = "password"; password.labels = [label]; nested.setAttribute("id", "nested"); label.append(nested); button.setAttribute("aria-labelledby", "nested");
  doc.body.append(password, label, button); expect(JSON.stringify(observe())).not.toContain("CANARY");
});

it("traverses open roots and slots while enforcing composed inert ancestry", () => {
  const host = new Element("x-open"), slot = new Slot(), button = new Button("Slotted");
  host.attachShadow("open").append(slot); host.append(button); button.assignedSlot = slot; slot.nodes = [button]; doc.body.append(host);
  expect(parseObservation(observe()).actions[0].label).toBe("Slotted");
  slot.setAttribute("inert", ""); expect(act().status).toBe("not-executed");
  expect(parseObservation(observe()).actions).toEqual([]);
});

it.each(["replace", "label", "role", "private", "reparent", "root", "disabled", "modal", "value", "form"])("invalidates %s target changes and consumes the ref", change => {
  const host = new Element("x-open"), input = new Input(); const root = host.attachShadow("open"); root.append(input); doc.body.append(host);
  observe();
  if (change === "replace") { input.remove(); root.append(new Input()); }
  if (change === "label") input.setAttribute("aria-label", "Changed");
  if (change === "role") input.setAttribute("role", "changed");
  if (change === "private") input.type = "password";
  if (change === "reparent") { const parent = new Element("div"); root.append(parent); parent.append(input); }
  if (change === "root") doc.body.append(input);
  if (change === "disabled") input.setAttribute("disabled", "");
  if (change === "modal") { const dialog = new Element("dialog"); dialog.modal = true; doc.body.append(dialog); }
  if (change === "value") input.value = "Changed";
  if (change === "form") input.form = new Form();
  expect(act("0", "Test").status).toBe("not-executed"); expect(act("0", "Test").status).toBe("not-executed");
});

it("reports composed ancestor aria-disabled state", () => {
  const host = new Element("x-open"), button = new Button(); host.attachShadow("open").append(button); host.setAttribute("aria-disabled", "true"); doc.body.append(host);
  expect(parseObservation(observe()).actions[0].disabled).toBe(true); expect(act().status).toBe("not-executed");
});

it("rescans unrelated private inputs before dispatch and retains document quarantine", () => {
  const button = new Button(), privateField = new Input(); privateField.type = "password"; doc.body.append(button, privateField); observe(); privateField.value = "PRIVATE_CANARY";
  expect(act().reason).toBe("populated-private-input"); expect(button.clicks).toBe(0);
  privateField.value = ""; vi.stubGlobal("__opzeroPrivateDocument", true); expect(observe().reason).toBe("private-quarantine");
});

it("keeps only the prepared single-use private submit exception", () => {
  const form = new Form(), button = new Button(); button.type = "submit"; button.form = form; form.append(button); doc.body.append(form);
  observe(); const prepared = pageControl("prepare-submit", origin, "fresh", "0");
  expect(prepared.status).toBe("prepared"); vi.stubGlobal("__opzeroPrivateDocument", true); vi.stubGlobal("__opzeroPrivateForms", new Set([form]));
  expect(act().status).toBe("not-executed");
  expect(pageControl("submit", origin, prepared.submitToken!).status).toBe("executed");
  expect(pageControl("submit", origin, prepared.submitToken!).status).toBe("not-executed"); expect(button.clicks).toBe(1);
});

const privateSubmit = (disabled = false) => {
  const form = new Form(), button = new Button(); button.type = "submit"; button.form = form; form.append(button); doc.body.append(form);
  if (disabled) button.setAttribute("disabled", "");
  Object.assign(button, { formMethod: "", formEnctype: "", formNoValidate: false }); Object.assign(form, { enctype: "application/x-www-form-urlencoded", noValidate: false });
  observe(); const prepared = pageControl("prepare-submit", origin, "fresh", "0");
  vi.stubGlobal("__opzeroPrivateDocument", true); vi.stubGlobal("__opzeroPrivateForms", new Set([form]));
  return { form, button, prepared };
};

it.each([
  ["submitter formMethod", "button", { formMethod: "get" }], ["submitter formEnctype", "button", { formEnctype: "text/plain" }],
  ["submitter formNoValidate", "button", { formNoValidate: true }], ["form method", "form", { method: "get" }],
  ["form enctype", "form", { enctype: "multipart/form-data" }], ["form noValidate", "form", { noValidate: true }]
] as const)("refuses a prepared private submit after its %s changes", (_, owner, change) => {
  const { form, button, prepared } = privateSubmit();
  expect(prepared.status).toBe("prepared");
  Object.assign(owner === "button" ? button : form, change);
  expect(pageControl("submit", origin, prepared.submitToken!)).toMatchObject({ status: "not-executed" }); expect(button.clicks).toBe(0);
});

it.each([[60000, "executed"], [90001, "not-executed"]] as const)("bounds a prepared private submit across the credential read: %i ms", (elapsed, status) => {
  vi.useFakeTimers();
  const { button, prepared } = privateSubmit();
  expect(prepared).toMatchObject({ status: "prepared", expiresInMs: 90000 });
  vi.advanceTimersByTime(elapsed);
  expect(pageControl("submit", origin, prepared.submitToken!)).toMatchObject({ status }); expect(button.clicks).toBe(status === "executed" ? 1 : 0);
});

it.each(["enabled-later", "still-disabled", "changed-while-pending"])("refuses a disabled private submit synchronously without replay: %s", async outcome => {
  vi.useFakeTimers();
  const { form, button, prepared } = privateSubmit(true);
  setTimeout(() => { if (outcome === "enabled-later") button.removeAttribute("disabled"); else if (outcome === "changed-while-pending") form.action = "https://synthetic.invalid/other"; }, 300);
  const submitted = pageControl("submit", origin, prepared.submitToken!);
  expect(submitted).toMatchObject({ status: "not-executed" });
  await vi.advanceTimersByTimeAsync(2500);
  expect(button.clicks).toBe(0);
  expect(pageControl("submit", origin, prepared.submitToken!)).toMatchObject({ status: "not-executed" }); expect(button.clicks).toBe(0);
});

it.each(["password", "otp", "restored", "nested", "closed"])("blocks capture for a populated %s control inside a shadow root without returning it", mode => {
  const host = new Element("x-login"), input = new Input(); input.setAttribute("id", "private"); input.value = "PRIVATE_CANARY";
  if (mode === "otp") input.autocomplete = "one-time-code"; else if (mode !== "restored") input.type = "password";
  const root = host.attachShadow(mode === "closed" ? "closed" : "open");
  if (mode === "nested") { const inner = new Element("x-inner"); root.append(inner); inner.attachShadow("open").append(input); } else root.append(input);
  doc.body.append(host, new Button());
  const result = pageControl("capture-check", origin, "", "", JSON.stringify(mode === "restored" ? ["#private"] : []));
  expect(result).toEqual({ status: "checked", allowed: false, reason: mode === "restored" ? "restored-private-selector" : "populated-private-input" });
  expect(JSON.stringify(result)).not.toContain("CANARY");
});

it("allows capture beside a disabled display-only password mask inside a shadow root", () => {
  const host = new Element("x-settings"), mask = new Input(); mask.type = "password"; mask.value = "••••••••"; Object.assign(mask, { disabled: true, defaultValue: "••••••••" });
  host.attachShadow("open").append(mask); doc.body.append(host);
  expect(pageControl("capture-check", origin, "")).toEqual({ status: "checked", allowed: true });
  mask.value = "PRIVATE_CANARY";
  expect(pageControl("capture-check", origin, "")).toEqual({ status: "checked", allowed: false, reason: "populated-private-input" });
});

it("fails capture closed without the shadow-root detection primitive", () => {
  vi.stubGlobal("chrome", {});
  expect(pageControl("capture-check", origin, "")).toEqual({ status: "checked", allowed: false, reason: "unsupported-shadow-root" });
});

it("refuses a disabled submit in the serialized built bundle without a delayed click", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: origin };
  await b.rpc("createTab", owner); await b.rpc("bindPage", owner);
  const form = new Form(), button = new Button(); button.type = "submit"; button.form = form; button.setAttribute("disabled", ""); form.append(button); doc.body.append(form);
  b.chrome.scripting.executeScript.mockImplementation((request: any, cb: Function) => {
    const injected = new Function(`return (${request.func.toString()})`)();
    void Promise.resolve(injected(...request.args)).then(result => cb([{ documentId: "doc-1", frameId: 0, result }]));
  });
  const observed = parseObservation((await b.rpc("observePage", owner)).result);
  const prepared = (await b.rpc("preparePrivateSubmit", { ...owner, snapshot: observed.snapshot, actionId: "0" })).result;
  expect(prepared).toMatchObject({ status: "prepared", expiresInMs: 90000, documentId: "doc-1" });
  vi.stubGlobal("__opzeroPrivateDocument", true); vi.stubGlobal("__opzeroPrivateForms", new Set([form]));
  setTimeout(() => button.removeAttribute("disabled"), 200);
  expect((await b.rpc("submitPrivate", { ...owner, submitToken: prepared.submitToken, documentId: prepared.documentId })).result).toMatchObject({ status: "not-executed" });
  expect(button.clicks).toBe(0);
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(button.clicks).toBe(0);
  expect((await b.rpc("submitPrivate", { ...owner, submitToken: prepared.submitToken, documentId: prepared.documentId })).result).toMatchObject({ status: "not-executed" });
});

it("reports controls-only and all output bounds without treating labels as private-safe", () => {
  doc.body.append(new Element("p", "BODY_CANARY " + "a".repeat(13000)));
  for (let i = 0; i < 101; i++) doc.body.append(new Button("L".repeat(170)), new Element("iframe"));
  const full = parseObservation(observe()); expect(full.truncation).toMatchObject({ text: true, labels: true, actions: true, opaqueSurfaces: true });
  const controls = parseObservation(observe(true)); expect(controls.text).toBe(""); expect(controls.mode).toBe("controls-only"); expect(controls.actions[0].label).toHaveLength(160);
});

it("reads only the scoped HTML head title and reports its truncation", () => {
  doc.body.append(new Element("title", "SVG_TITLE_CANARY")); expect(parseObservation(observe()).title).toBe("");
  const head = new Element("head"); head.style.display = "none"; head.append(new Element("title", "T".repeat(210))); doc.append(head);
  const result = parseObservation(observe()); expect(result.title).toHaveLength(200); expect(result.truncation.title).toBe(true);
});

it("fails closed without the documented closed-root detection primitive", () => {
  vi.stubGlobal("chrome", {}); expect(observe().reason).toBe("unsupported-shadow-root");
});

it.each(["origin", "document", "expiry", "token"])("binds freshness to %s", change => {
  const button = new Button(); doc.body.append(button); observe();
  if (change === "origin") vi.stubGlobal("location", { origin: "https://other.invalid", href: "https://other.invalid/" });
  if (change === "document") vi.stubGlobal("document", dom());
  if (change === "expiry") (globalThis as any).__opzeroSnapshot.expires = 0;
  expect(pageControl("act", origin, change === "token" ? "wrong" : "fresh", "0").status).toBe("not-executed");
  expect(button.clicks).toBe(0);
});

it("rechecks restored selectors before acting and refuses malformed selectors content-free", () => {
  const button = new Button(), input = new Input(); input.setAttribute("id", "restored"); doc.body.append(button, input); observe(); input.value = "PRIVATE_CANARY";
  const result = pageControl("act", origin, "fresh", "0", null, { selectors: ["#restored"], controlsOnly: false });
  expect(result.reason).toBe("restored-private-selector"); expect(button.clicks).toBe(0); expect(JSON.stringify(result)).not.toContain("CANARY");
  expect(observe(false, ["["]).reason).toBe("invalid-private-selectors");
});

it("serializes injection without runtime module dependencies", () => {
  doc.body.append(new Button());
  const injected = new Function(`return (${pageControl.toString()})`)();
  expect(parseObservation(injected("observe", origin, "fresh")).actions[0].kind).toBe("click");
});

it("executes the built background's serialized injection through observe and fill", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: origin };
  await b.rpc("createTab", owner); await b.rpc("bindPage", owner);
  const input = new Input(); doc.body.append(input, new Element("iframe", "OPAQUE_CANARY"));
  b.chrome.scripting.executeScript.mockImplementation((request: any, cb: Function) => {
    const injected = new Function(`return (${request.func.toString()})`)();
    cb([{ documentId: "doc-1", frameId: 0, result: injected(...request.args) }]);
  });
  const result = parseObservation((await b.rpc("observePage", owner)).result);
  expect(result.partial).toBe(true); expect(JSON.stringify(result)).not.toContain("CANARY");
  expect((await b.rpc("actPage", { ...owner, snapshot: result.snapshot, actionId: "0", text: "Public" })).result.status).toBe("executed");
  expect(input.value).toBe("Public");
});

it("returns unknown on post-dispatch failure and never replays", () => {
  const button = new Button(); button.click = () => { button.clicks++; throw new Error("PRIVATE_CANARY"); }; doc.body.append(button); observe();
  expect(act()).toEqual({ status: "unknown", retry: false }); expect(act().status).toBe("not-executed"); expect(button.clicks).toBe(1);
});

it("supports bounded native number fill, rejects invalid text before mutation", () => {
  const input = new Input(); input.type = "number"; doc.body.append(input); observe(); expect(act("0", "12.5").status).toBe("executed"); expect(input.value).toBe("12.5");
  observe(); expect(act("0", "abc").reason).toBe("invalid-fill"); expect(input.value).toBe("12.5");
});

it("fills textarea through its native setter and refuses newly readonly controls", () => {
  const textarea = new Textarea(); doc.body.append(textarea); observe();
  expect(act("0", "Public\ntext").status).toBe("executed"); expect(textarea.value).toBe("Public\ntext");
  observe(); textarea.readOnly = true; expect(act("0", "replacement").status).toBe("not-executed");
});

it.each(["version", "partial", "kind", "kind-array", "extra", "flags", "mode", "disabled"])("validates v2 metadata: %s", change => {
  doc.body.append(new Button(), new Element("iframe")); const raw: any = observe();
  if (change === "version") raw.pageProtocolVersion = 1;
  if (change === "partial") raw.partial = false;
  if (change === "kind") raw.opaqueSurfaces[0].kind = "CANARY";
  if (change === "kind-array") raw.opaqueSurfaces[0].kind = ["iframe"];
  if (change === "extra") raw.opaqueSurfaces[0].title = "CANARY";
  if (change === "flags") raw.truncation.text = "false";
  if (change === "mode") raw.mode = "controls-only";
  if (change === "disabled") raw.actions[0].disabled = 0;
  expect(() => parseObservation(raw)).toThrow("Invalid page protocol");
});
