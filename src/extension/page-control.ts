import type { PageAction } from "../shared/page-protocol";
export type { PageAction } from "../shared/page-protocol";
type Target = { node: Element; root: Node; form: HTMLFormElement | null; ancestry: Node[]; marker: string; action: PageAction };
type Snapshot = { token: string; origin: string; document: Document; targets: Target[]; expires: number };
type PreparedFile = { token: string; target: Target; node: HTMLInputElement; attribute: string; expires: number; changes: number; listener: EventListener };
type World = typeof globalThis & { __opzeroSnapshot?: Snapshot; __opzeroPrivateNodes?: WeakSet<Element>; __opzeroPrivateDocument?: boolean; __opzeroPrivateForms?: Set<HTMLFormElement>; __opzeroSubmit?: { token: string; target: Target; node: HTMLButtonElement | HTMLInputElement; form: HTMLFormElement; expires: number }; __opzeroFile?: PreparedFile };
export type PageOptions = { selectors: string[]; controlsOnly: boolean };

// executeScript serializes this function without module bindings.
export function pageControl(operation: "observe" | "act" | "capture-check" | "document-check" | "prepare-submit" | "submit" | "prepare-file" | "validate-file" | "verify-file" | "cancel-file", expectedOrigin: string, token: string, actionId = "", text?: string | null, options: PageOptions = { selectors: [], controlsOnly: false }) {
  const world = globalThis as World;
  const visible = (e: Element) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const privateInput = (e: Element) => world.__opzeroPrivateNodes?.has(e) || (e instanceof HTMLInputElement && (e.type === "password" || e.autocomplete === "one-time-code"));
  const displayMask = (e: Element) => e instanceof HTMLInputElement && e.type === "password" && e.disabled
    && !world.__opzeroPrivateNodes?.has(e) && e.autocomplete !== "one-time-code" && e.value === e.defaultValue && /^•{4,64}$/.test(e.value);
  const populatedPrivate = (e: HTMLInputElement | HTMLTextAreaElement) => !!e.value && privateInput(e) && !displayMask(e);
  const snapshot = world.__opzeroSnapshot;
  if (!["capture-check", "document-check", "validate-file", "verify-file", "cancel-file"].includes(operation)) delete world.__opzeroSnapshot;
  const refused = (reason: string) => ({ status: operation === "observe" ? "refused" : "not-executed", reason, retry: false });
  if (location.origin !== expectedOrigin || window !== window.top) return refused("origin");
  if (operation === "document-check") return { status: "checked" };
  if (operation === "capture-check") {
    if (world.__opzeroPrivateDocument) return { status: "checked", allowed: false, reason: "private-quarantine" };
    if (typeof chrome === "undefined" || typeof chrome.dom?.openOrClosedShadowRoot !== "function") return { status: "checked", allowed: false, reason: "unsupported-shadow-root" };
    // Screenshots render every shadow root, including roots that observation treats as opaque.
    const captureRoots: (Document | ShadowRoot)[] = [document];
    const collect = (node: Node) => {
      const shadow = node instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(node) : null;
      if (shadow) { captureRoots.push(shadow); collect(shadow); }
      for (const child of node.childNodes) collect(child);
    };
    try { collect(document); } catch { return { status: "checked", allowed: false, reason: "unsupported-shadow-root" }; }
    const fields = (selector: string) => captureRoots.flatMap(root => [...root.querySelectorAll(selector)])
      .filter((e): e is HTMLInputElement | HTMLTextAreaElement => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement);
    try {
      const selectors: unknown = JSON.parse(text || "[]");
      if (!Array.isArray(selectors) || !selectors.every(selector => typeof selector === "string")) return { status: "checked", allowed: false, reason: "invalid-private-selectors" };
      const restored = selectors.some(selector => fields(selector).some(e => e.value));
      if (fields("input,textarea").some(populatedPrivate)) return { status: "checked", allowed: false, reason: "populated-private-input" };
      if (restored) return { status: "checked", allowed: false, reason: "restored-private-selector" };
      return { status: "checked", allowed: true };
    } catch {
      return { status: "checked", allowed: false, reason: "invalid-private-selectors" };
    }
  }

  const preparedFile = ["verify-file", "cancel-file"].includes(operation) ? world.__opzeroFile : undefined;
  if (operation === "cancel-file") {
    if (!preparedFile || preparedFile.token !== token) return refused("file-cancel-refused");
    delete world.__opzeroFile;
    try { preparedFile.node.removeEventListener("change", preparedFile.listener); } catch {}
    try { preparedFile.node.removeAttribute(preparedFile.attribute); } catch {}
    return { status: "cancelled", retry: false };
  }

  const prepared = operation === "submit" ? world.__opzeroSubmit : undefined;
  if (operation === "submit" || operation === "prepare-submit") delete world.__opzeroSubmit;
  if (operation !== "submit" && world.__opzeroPrivateDocument) return refused("private-quarantine");
  if (typeof chrome === "undefined" || typeof chrome.dom?.openOrClosedShadowRoot !== "function") return refused("unsupported-shadow-root");
  const elements = new Set<Element>();
  const roots: (Document | ShadowRoot)[] = [document];
  const opaqueSurfaces: { id: string; kind: "iframe" | "frame" | "object" | "embed" | "closed-shadow-root" }[] = [];
  let opaqueCount = 0;
  const opaque = (kind: typeof opaqueSurfaces[number]["kind"]) => {
    if (opaqueCount < 100) opaqueSurfaces.push({ id: `opaque-${opaqueCount}`, kind });
    opaqueCount++;
  };
  const walk = (node: Node) => {
    if (node instanceof Element) {
      const tag = node.localName;
      if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") { opaque(tag); return; }
      const shadow = node instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(node) : null;
      if (shadow?.mode === "closed") { opaque("closed-shadow-root"); return; }
      elements.add(node);
      if (shadow) { roots.push(shadow); walk(shadow); }
    }
    for (const child of node.childNodes) walk(child);
  };
  try { walk(document); } catch { return refused("unsupported-shadow-root"); }
  const inputs = roots.flatMap(root => [...root.querySelectorAll("input,textarea")])
    .filter((e): e is HTMLInputElement | HTMLTextAreaElement => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement);
  const privateNodes = new Set<Element>(inputs.filter(privateInput));
  const restoredNodes = new Set<Element>();
  try {
    if (!Array.isArray(options.selectors) || !options.selectors.every(s => typeof s === "string")) return refused("invalid-private-selectors");
    for (const selector of options.selectors) for (const root of roots) for (const e of root.querySelectorAll(selector)) {
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) { privateNodes.add(e); restoredNodes.add(e); }
    }
  } catch { return refused("invalid-private-selectors"); }
  const privacy = inputs.some(populatedPrivate) ? "populated-private-input"
    : inputs.some(e => e.value && restoredNodes.has(e)) ? "restored-private-selector" : null;
  if (operation !== "submit" && privacy) return refused(privacy);
  if (operation === "verify-file") {
    delete world.__opzeroFile;
    const markerPresent = preparedFile?.node.hasAttribute(preparedFile.attribute) === true;
    if (preparedFile) try { preparedFile.node.removeEventListener("change", preparedFile.listener); } catch {}
    if (preparedFile) try { preparedFile.node.removeAttribute(preparedFile.attribute); } catch {}
    if (!preparedFile || preparedFile.token !== token || preparedFile.expires < Date.now() || preparedFile.node.ownerDocument !== document
      || !preparedFile.node.isConnected || !markerPresent || preparedFile.node.type !== "file") return refused("file-verification-refused");
    let metadata: unknown;
    try { metadata = JSON.parse(text || "null"); } catch { return refused("invalid-file-metadata"); }
    if (typeof metadata !== "object" || metadata === null || !("name" in metadata) || !("size" in metadata)
      || typeof metadata.name !== "string" || typeof metadata.size !== "number") return refused("invalid-file-metadata");
    const files = preparedFile.node.files;
    if (!files || files.length !== 1) return { status: "unknown", retry: false };
    const file = files[0];
    if (file.name !== metadata.name || file.size !== metadata.size || file.type !== "application/pdf") return { status: "unknown", retry: false };
    try {
      if (preparedFile.changes === 0) {
        preparedFile.node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        preparedFile.node.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { status: "attached", retry: false };
    } catch { return { status: "unknown", retry: false }; }
  }
  const privateLabels = new Set<Element>();
  for (const e of inputs) if (privateNodes.has(e)) {
    for (const label of e.labels ?? []) privateLabels.add(label);
    for (const id of (e.getAttribute("aria-labelledby") || "").split(/\s+/)) {
      const root = e.getRootNode();
      const label = root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id);
      if (label) privateLabels.add(label);
    }
  }
  const ancestry = (node: Node) => {
    const chain: Node[] = [];
    for (let current: Node | null = node; current && !chain.includes(current);) {
      chain.push(current);
      current = (current instanceof Element || current instanceof Text) && current.assignedSlot ? current.assignedSlot
        : current instanceof ShadowRoot ? current.host : current.parentNode;
    }
    return chain;
  };
  const exposed = (e: Element) => elements.has(e) && ancestry(e).every(n => {
    if (!(n instanceof Element)) return true;
    if (!elements.has(n) || n.hasAttribute("inert") || n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(n);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    if (n.parentElement?.shadowRoot && !n.assignedSlot) return false;
    if (n.parentElement instanceof HTMLSlotElement && n.parentElement.assignedNodes().length) return false;
    return true;
  });
  const modals = [...elements].filter(e => e.matches(":modal") || e.getAttribute("aria-modal") === "true" && exposed(e));
  const available = (e: Element) => exposed(e) && visible(e) && modals.every(m => ancestry(e).includes(m));
  const safeText = (node: Node, requireVisible = true): string => {
    if (node instanceof Element && (!elements.has(node) || ancestry(node).some(n => n instanceof Element && (privateNodes.has(n) || privateLabels.has(n)))
      || ["script", "style", "template", "noscript", "input", "textarea", "select"].includes(node.localName)
      || requireVisible && !exposed(node))) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    const children = node instanceof HTMLSlotElement && node.assignedNodes().length ? node.assignedNodes()
      : node instanceof Element && node.shadowRoot ? [node.shadowRoot] : [...node.childNodes];
    const parts = children.map(child => safeText(child, requireVisible));
    return parts.join(" ");
  };
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const label = (e: Element) => {
    const labelled = (e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => e.getRootNode() instanceof ShadowRoot ? (e.getRootNode() as ShadowRoot).getElementById(id) : document.getElementById(id))
      .filter((n): n is HTMLElement => !!n && elements.has(n));
    return normalize(labelled.length ? labelled.map(n => safeText(n)).join(" ") : e.getAttribute("aria-label")
      || (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? [...(e.labels ?? [])].map(n => safeText(n)).join(" ") || e.getAttribute("placeholder") || "" : safeText(e)));
  };
  const actionLabel = (e: Element) => {
    const own = label(e);
    if (own || !(e instanceof HTMLButtonElement) || e.type !== "button" || !e.parentElement) return own;
    const siblings = [...e.parentElement.childNodes].filter((node): node is Element => node instanceof Element);
    const choices = siblings.filter(node => node.getAttribute("role") === "combobox" && available(node));
    const buttons = siblings.filter(node => node instanceof HTMLButtonElement);
    return choices.length === 1 && buttons.length === 1 && buttons[0] === e && label(choices[0])
      ? `${label(choices[0])} options` : own;
  };
  const publicFileLabel = (e: HTMLInputElement) => [...(e.labels ?? [])].find(candidate => {
    const rect = candidate.getBoundingClientRect();
    return !privateLabels.has(candidate) && available(candidate) && rect.width > 1 && rect.height > 1 && label(candidate).length > 0;
  });
  const fileAvailable = (e: HTMLInputElement) => {
    const rect = typeof e.getBoundingClientRect === "function" ? e.getBoundingClientRect() : { width: 2, height: 2 };
    const labelledContext = elements.has(e) && !e.hasAttribute("inert") && !e.hasAttribute("hidden") && e.getAttribute("aria-hidden") !== "true"
      && !e.parentElement?.shadowRoot && !(e.parentElement instanceof HTMLSlotElement && e.parentElement.assignedNodes().length)
      && ancestry(e).slice(1).every(n => !(n instanceof Element) || exposed(n)) && modals.every(m => ancestry(e).includes(m));
    return e.type === "file" && ((available(e) && rect.width > 1 && rect.height > 1 && label(e).length > 0) || labelledContext && !!publicFileLabel(e));
  };
  const kind = (e: Element): "fill" | "click" | "upload" | null => {
    if (ancestry(e).some(n => n instanceof Element && (privateNodes.has(n) || privateLabels.has(n)))) return null;
    if (e instanceof HTMLTextAreaElement) return "fill";
    if (e instanceof HTMLInputElement) return e.type === "file" && fileAvailable(e) ? "upload" : ["text", "email", "search", "tel", "url", "number"].includes(e.type) ? "fill" : ["button", "submit", "checkbox", "radio"].includes(e.type) ? "click" : null;
    return e.matches("button,a[href],[role=button],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio]") ? "click" : null;
  };
  const disabled = (e: Element) => e.matches(":disabled") || ancestry(e).some(n => n instanceof Element && n.getAttribute("aria-disabled") === "true") || (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && e.readOnly;
  const form = (e: Element) => e instanceof HTMLButtonElement || e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.form : null;
  const semantics = (e: Element, submitReadiness = false) => JSON.stringify([location.href, kind(e), actionLabel(e),
    ["role", "type", "href", "target", "disabled", "aria-disabled", "aria-checked", "aria-selected", "aria-expanded", "aria-pressed", "readonly", "min", "max", "step", "pattern", "maxlength"].map(a => submitReadiness && a === "disabled" ? null : e.getAttribute(a)),
    submitReadiness ? null : disabled(e), e instanceof HTMLInputElement ? [e.value, e.checked, e.indeterminate] : e instanceof HTMLTextAreaElement ? e.value : null,
    (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && e.form ? [e.formAction, e.form.action, e.formTarget, e.form.target, e.form.method,
      e.formMethod, e.formEnctype, e.form.enctype, e.formNoValidate, e.form.noValidate] : null,
    ancestry(e).filter((n): n is Element => n instanceof Element).map(n => [n.getAttribute("inert"), n.getAttribute("aria-hidden"), n.getAttribute("aria-disabled"), n.getAttribute("role"), submitReadiness && n === e ? null : n.getAttribute("disabled")])]);
  const target = (node: Element, id: string): Target => ({ node, root: node.getRootNode(), form: form(node), ancestry: ancestry(node), marker: semantics(node),
    action: { id, kind: kind(node)!, label: actionLabel(node).slice(0, 160), role: (node.getAttribute("role") || node.localName).slice(0, 80), disabled: disabled(node) } });
  const fresh = (t: Target, mode: "action" | "prepare-submit" | "submit" = "action") => t.node.isConnected && t.node.ownerDocument === document && elements.has(t.node) && !privateNodes.has(t.node)
    && t.root === t.node.getRootNode() && t.form === form(t.node) && (t.action.kind === "upload" && t.node instanceof HTMLInputElement ? fileAvailable(t.node) : available(t.node)) && (mode === "prepare-submit" || !disabled(t.node)) && t.marker === semantics(t.node, mode === "submit")
    && t.ancestry.length === ancestry(t.node).length && t.ancestry.every((n, i) => n === ancestry(t.node)[i]);
  const sameOriginSubmit = (node: HTMLButtonElement | HTMLInputElement) => node.type === "submit" && node.form
    && new URL(node.formAction || node.form.action).origin === expectedOrigin && (!(node.formTarget || node.form.target) || (node.formTarget || node.form.target) === "_self");
  if (operation === "submit") {
    const bound = !!prepared && prepared.token === token && prepared.expires >= Date.now() && !!world.__opzeroPrivateDocument
      && !!world.__opzeroPrivateForms?.has(prepared.form) && prepared.node.form === prepared.form && fresh(prepared.target, "submit") && !!sameOriginSubmit(prepared.node);
    if (prepared && bound) {
      try { prepared.node.click(); return { status: "executed", retry: false }; } catch { return { status: "unknown", retry: false }; }
    }
    return refused("private-submit-refused");
  }
  if (operation === "validate-file") {
    const file = world.__opzeroFile;
    if (!file || file.token !== token || file.expires < Date.now() || !file.node.hasAttribute(file.attribute) || !fresh(file.target)) return refused("file-validation-refused");
    return { status: "validated", retry: false };
  }
  if (operation === "observe") {
    const nodes = [...elements].filter(e => kind(e) && (e instanceof HTMLInputElement && kind(e) === "upload" ? fileAvailable(e) : available(e)));
    const popups = new Set([...elements].filter(e => available(e) && ["menu", "listbox", "dialog"].includes(e.getAttribute("role") || "")));
    for (const e of elements) if (available(e) && e.getAttribute("aria-expanded") === "true") {
      const root = e.getRootNode();
      for (const id of (e.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean)) {
        const popup = root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id);
        if (popup && available(popup)) popups.add(popup);
      }
    }
    const inPopup = (e: Element) => ancestry(e).some(n => n instanceof Element && popups.has(n));
    nodes.sort((a, b) => Number(inPopup(b)) - Number(inPopup(a)));
    const targets = nodes.slice(0, 100).map((node, i) => target(node, String(i)));
    const body = options.controlsOnly ? "" : normalize(document.body ? safeText(document.body) : "");
    const titleNode = document.querySelector("head > title");
    const title = normalize(titleNode ? safeText(titleNode, false) : "");
    world.__opzeroSnapshot = { token, origin: expectedOrigin, document, targets, expires: Date.now() + 30000 };
    return { status: "observed", pageProtocolVersion: 2, url: location.href, title: title.slice(0, 200), text: body.slice(0, 12000),
      actions: targets.map(t => t.action), snapshot: token, mode: options.controlsOnly ? "controls-only" : "full", partial: opaqueCount > 0, opaqueSurfaces,
      truncation: { text: body.length > 12000, actions: nodes.length > 100, opaqueSurfaces: opaqueCount > 100, labels: targets.some(t => actionLabel(t.node).length > 160 || (t.node.getAttribute("role") || "").length > 80), title: title.length > 200 } };
  }
  if (!snapshot || snapshot.token !== token || snapshot.origin !== expectedOrigin || snapshot.document !== document || snapshot.expires < Date.now()) return refused("stale");
  const t = snapshot.targets.find(t => t.action.id === actionId);
  if (!t || !fresh(t, operation === "prepare-submit" ? "prepare-submit" : "action")) return refused("stale");
  const node = t.node, action = t.action;
  if (operation === "prepare-submit") {
    if (!(node instanceof HTMLButtonElement || node instanceof HTMLInputElement) || !sameOriginSubmit(node) || !node.form) return refused("not-same-origin-submit");
    // Bound to one private credential read (60 s vault deadline) plus re-observation, fill, and readiness; never renewed.
    const submitToken = crypto.randomUUID(), expiresInMs = 90000;
    world.__opzeroSubmit = { token: submitToken, target: { ...t, marker: semantics(node, true) }, node, form: node.form, expires: Date.now() + expiresInMs };
    return { status: "prepared", submitToken, expiresInMs };
  }
  if (operation === "prepare-file") {
    if (action.kind !== "upload" || !(node instanceof HTMLInputElement) || node.type !== "file") return refused("not-file-action");
    const fileToken = crypto.randomUUID(), attribute = `data-opzero-file-${crypto.randomUUID().replace(/-/g, "")}`;
    try { node.setAttribute(attribute, ""); } catch { return refused("file-preparation-refused"); }
    const file: PreparedFile = { token: fileToken, target: t, node, attribute, expires: Date.now() + 30000, changes: 0, listener: () => { file.changes++; } };
    try { node.addEventListener("change", file.listener); } catch { try { node.removeAttribute(attribute); } catch {} return refused("file-preparation-refused"); }
    world.__opzeroFile = file;
    return { status: "prepared", fileToken, selector: `[${attribute}]` };
  }
  if (action.kind === "upload") return refused("file-requires-upload-rpc");
  if (action.kind === "fill") {
    if (typeof text !== "string" || text.length > 2000 || !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return refused("invalid-fill");
    if (node instanceof HTMLInputElement && node.type === "number" && text !== "" && (!Number.isFinite(Number(text)) || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))) return refused("invalid-fill");
    const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return refused("unsupported");
    try {
      setter.call(node, text);
      if (node.value !== text) return { status: "unknown", retry: false };
      node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } catch { return { status: "unknown", retry: false }; }
  } else {
    if (text != null) return refused("unexpected-text");
    if (node instanceof HTMLAnchorElement && (new URL(node.href).origin !== expectedOrigin || node.target && node.target !== "_self")) return refused("cross-origin-or-new-tab");
    if ((node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.type === "submit" && node.form && !sameOriginSubmit(node)) return refused("cross-origin-or-new-tab-submit");
    if (!(node instanceof HTMLElement)) return refused("unsupported");
    try { node.click(); } catch { return { status: "unknown", retry: false }; }
  }
  return { status: "executed", retry: false };
}
