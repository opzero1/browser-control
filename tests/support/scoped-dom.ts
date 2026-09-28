import { vi } from "vitest";

export class Node {
  static TEXT_NODE = 3;
  nodeType = 1;
  nodeValue: string | null = null;
  childNodes: Node[] = [];
  parentNode: Node | null = null;
  get parentElement(): Element | null { return this.parentNode instanceof Element ? this.parentNode : null; }
  get ownerDocument(): Document { return this.getRootNode() instanceof ShadowRoot ? (this.getRootNode() as ShadowRoot).host.ownerDocument : this.getRootNode() as Document; }
  get isConnected(): boolean { return this.getRootNode() instanceof Document || this.getRootNode() instanceof ShadowRoot && (this.getRootNode() as ShadowRoot).host.isConnected; }
  getRootNode(): Node { return this.parentNode?.getRootNode() ?? this; }
  append(...nodes: Node[]) { for (const node of nodes) { node.remove(); this.childNodes.push(node); node.parentNode = this; } }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this); this.parentNode = null; }
  querySelectorAll(selector: string): Element[] {
    if (selector === "[") throw new Error("INVALID_SELECTOR_CANARY");
    return this.childNodes.flatMap(n => [...(n instanceof Element && n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
}
export class Text extends Node {
  nodeType = 3;
  assignedSlot: Slot | null = null;
  constructor(value: string) { super(); this.nodeValue = value; }
}
export class Element extends Node {
  attrs = new Map<string, string>();
  assignedSlot: Slot | null = null;
  root: ShadowRoot | null = null;
  style = { display: "block", visibility: "visible", opacity: "1" };
  clicks = 0;
  modal = false;
  listeners = new Map<string, Set<EventListener>>();
  constructor(public localName: string, text = "") { super(); if (text) this.append(new Text(text)); }
  get shadowRoot() { return this.root?.mode === "open" ? this.root : null; }
  attachShadow(mode: "open" | "closed") { return this.root = new ShadowRoot(this, mode); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  hasAttribute(name: string) { return this.attrs.has(name); }
  checkVisibility() { return this.style.display !== "none"; }
  getBoundingClientRect() { return { width: 20, height: 20 }; }
  matches(selector: string): boolean { return selector.split(",").some(s => s === ":modal" ? this.modal : s === ":disabled" ? this.hasAttribute("disabled") : s.startsWith("#") ? this.getAttribute("id") === s.slice(1) : ["[role=button]", "[role=option]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]", "[role=checkbox]", "[role=radio]"].includes(s) ? this.getAttribute("role") === s.slice(6, -1) : s === "a[href]" ? this.localName === "a" && this.hasAttribute("href") : s === "head > title" ? this.localName === "title" && this.parentElement?.localName === "head" : this.localName === s); }
  addEventListener(type: string, listener: EventListener) { const listeners = this.listeners.get(type) ?? new Set<EventListener>(); listeners.add(listener); this.listeners.set(type, listeners); }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  click() { this.clicks++; }
  dispatchEvent(event: Event) { for (const listener of this.listeners.get(event.type) ?? []) listener.call(this as unknown as EventTarget, event); return true; }
}
export class Input extends Element {
  constructor() { super("input"); }
  private content = "";
  get value() { return this.content; }
  set value(value: string) { this.content = value; }
  get type() { return this.getAttribute("type") ?? "text"; }
  set type(value: string) { this.setAttribute("type", value); }
  autocomplete = "";
  readOnly = false;
  checked = false;
  indeterminate = false;
  labels: Element[] = [];
  files: { length: number; [index: number]: { name: string; size: number; type: string } } | null = null;
  form: Form | null = null;
  formAction = "";
  formTarget = "";
  override click() {
    super.click();
    if (this.type === "checkbox") this.checked = !this.checked;
    if (this.type === "radio") this.checked = true;
    if (this.type === "checkbox" || this.type === "radio") this.indeterminate = false;
  }
}
export class Textarea extends Element {
  constructor() { super("textarea"); }
  private content = "";
  get value() { return this.content; }
  set value(value: string) { this.content = value; }
  readOnly = false;
  labels: Element[] = [];
  form: Form | null = null;
}
export class Button extends Element { type = "button"; form: Form | null = null; formAction = ""; formTarget = ""; constructor(text = "Continue") { super("button", text); } }
export class Anchor extends Element { href = "https://synthetic.invalid/"; target = ""; }
export class Form extends Element { action = "https://synthetic.invalid/"; target = ""; method = "post"; constructor() { super("form"); } }
export class Slot extends Element { nodes: Node[] = []; constructor() { super("slot"); } assignedNodes() { return this.nodes; } }
export class ShadowRoot extends Node { constructor(public host: Element, public mode: "open" | "closed") { super(); } }
export class Document extends Node { body = new Element("body"); constructor() { super(); this.append(this.body); } }

export function dom() {
  const document = new Document();
  const win: Record<string, unknown> = {}; win.top = win;
  for (const [name, value] of Object.entries({ Node, Text, Element, HTMLElement: Element, HTMLInputElement: Input,
    HTMLTextAreaElement: Textarea, HTMLButtonElement: Button, HTMLAnchorElement: Anchor, HTMLSlotElement: Slot,
    ShadowRoot, Document, document, window: win, location: { origin: "https://synthetic.invalid", href: "https://synthetic.invalid/" },
    getComputedStyle: (e: Element) => e.style, chrome: { dom: { openOrClosedShadowRoot: (e: Element) => e.root } } })) vi.stubGlobal(name, value);
  return document;
}
