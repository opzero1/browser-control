// A synthetic Cua Driver for vault tests, ported from test_onepassword.FakeCua: accessibility rows for a
// 1Password Login detail, a pasteboard with rich items, and a call log. Every value is synthetic.
import type { ClipboardGuard, CuaCaller } from "../../../src/server/private/onepassword";

export const EMAIL = "agent@example.test";

export type Row = Record<string, unknown>;
export type Call = [name: string, args: Row, deadline: number | undefined];
export type NativeClipboard = Record<string, Buffer>[];

export function element(index: number, role: string, label: string, options: { value?: string; actions?: string[]; parent?: number; frame?: Row } = {}): Row {
  const row: Row = { element_index: index, element_token: `s0000001:${index}`, role, label };
  if (options.value !== undefined) row.value = options.value;
  if (options.actions !== undefined) row.actions = options.actions;
  if (options.parent !== undefined) row.parent_index = options.parent;
  if (options.frame !== undefined) row.frame = options.frame;
  return row;
}

export function detailElements(username = EMAIL, options: { duplicatePassword?: boolean } = {}): Row[] {
  const rows = [
    element(900, "AXTextField", "Search", { value: EMAIL, actions: ["AXSetValue"], frame: { x: 110, y: 210, w: 300, h: 24 } }),
    element(901, "AXButton", EMAIL, { actions: ["AXPress"] }),
    element(100, "AXGroup", "Login details"),
    element(10, "AXGroup", "username", { parent: 100 }),
    element(1, "AXButton", "Copy", { actions: ["AXPress"], parent: 10 }),
    element(2, "AXPopUpButton", "username. More Actions", { parent: 10 }),
    element(3, "AXStaticText", username, { parent: 10 }),
    element(20, "AXGroup", "password", { parent: 100 }),
    element(4, "AXButton", "Copy", { actions: ["AXPress"], parent: 20 }),
    element(5, "AXPopUpButton", "password. More Actions", { parent: 20 }),
    element(30, "AXGroup", "one-time password", { parent: 100 }),
    element(6, "AXButton", "Copy", { actions: ["AXPress"], parent: 30 }),
    element(7, "AXPopUpButton", "one-time password. More Actions", { parent: 30 })
  ];
  if (options.duplicatePassword) {
    rows.push(
      element(40, "AXGroup", "password", { parent: 100 }),
      element(8, "AXButton", "Copy", { actions: ["AXPress"], parent: 40 }),
      element(9, "AXPopUpButton", "password. More Actions", { parent: 40 })
    );
  }
  return rows;
}

export function flatDetailElements(username = EMAIL, options: { duplicatePasswordCopy?: boolean; crossField?: boolean } = {}): Row[] {
  const rows = [
    element(900, "AXTextField", "Search items", { value: EMAIL, actions: ["AXSetValue"], parent: 1 }),
    element(901, "AXButton", EMAIL, { actions: ["AXPress"], parent: 1 }),
    element(1, "AXWebArea", "1Password"),
    element(63, "AXStaticText", "username", { parent: 1 }),
    element(64, "AXStaticText", "", { value: username, parent: 1 })
  ];
  if (options.crossField) rows.push(element(62, "AXStaticText", "password", { parent: 1 }));
  rows.push(
    element(65, "AXButton", "Copy", { actions: ["AXPress"], parent: 1 }),
    element(66, "AXPopUpButton", "username. More Actions", { parent: 1 }),
    element(67, "AXStaticText", "password", { parent: 1 }),
    element(68, "AXStaticText", "", { value: "••••••", parent: 1 }),
    element(69, "AXStaticText", "password information", { parent: 1 }),
    element(70, "AXImage", "concealed", { parent: 1 }),
    element(71, "AXButton", "Copy", { actions: ["AXPress"], parent: 1 })
  );
  if (options.duplicatePasswordCopy) rows.push(element(711, "AXButton", "Copy", { actions: ["AXPress"], parent: 1 }));
  rows.push(
    element(72, "AXPopUpButton", "password. More Actions", { parent: 1 }),
    element(73, "AXStaticText", "one-time password", { parent: 1 }),
    element(74, "AXStaticText", "OTP information", { parent: 1 }),
    element(75, "AXStaticText", "30 seconds", { parent: 1 }),
    element(76, "AXStaticText", "code", { parent: 1 }),
    element(77, "AXButton", "Copy", { actions: ["AXPress"], parent: 1 }),
    element(78, "AXPopUpButton", "one-time password. More Actions", { parent: 1 }),
    element(118, "AXButton", "Copy", { actions: ["AXPress"], parent: 1 })
  );
  for (const row of rows) {
    if (row.role === "AXStaticText" || row.role === "AXImage") row.actions = ["AXShowMenu", "AXScrollToVisible"];
  }
  return rows;
}

/** The search suggestion menu: one result for EMAIL and the "Show all matching items" entry. */
export function suggestionElements(): Row[] {
  const rows = detailElements("other@example.test").filter((row) => row.element_index !== 900 && row.element_index !== 901);
  rows.push(
    element(41, "AXMenu", "Suggestions"),
    element(42, "AXMenuItem", `synthetic vault: login 1 — ${EMAIL} app.example.test`, { actions: ["AXPress"], parent: 41, frame: { x: 110, y: 220, w: 300, h: 24 } }),
    element(45, "AXStaticText", `synthetic vault: login 1 — ${EMAIL} app.example.test`, { parent: 42 }),
    element(47, "AXMenuItem", `${EMAIL} ― Show all matching items`, { actions: ["AXPress"], parent: 41 })
  );
  return rows;
}

export function cloneNative(native: NativeClipboard): NativeClipboard {
  return native.map((item) => Object.fromEntries(Object.entries(item).map(([type, data]) => [type, Buffer.from(data)])));
}

export interface FakeCuaOptions { copies?: string[]; clipboard?: string; clipboardTypes?: string[]; snapshots?: Row[][]; nativeClipboard?: NativeClipboard }

export class FakeCua implements CuaCaller {
  elements: Row[];
  snapshots: Row[][];
  copies: string[];
  clipboard: string;
  clipboardTypes: string[];
  nativeClipboard: NativeClipboard;
  calls: Call[] = [];

  constructor(elements: Row[], options: FakeCuaOptions = {}) {
    this.elements = elements;
    this.snapshots = [...(options.snapshots ?? [])];
    this.copies = [...(options.copies ?? [])];
    this.clipboard = options.clipboard ?? "before";
    this.clipboardTypes = options.clipboardTypes ?? ["public.utf8-plain-text"];
    this.nativeClipboard = options.nativeClipboard ?? [{ "public.utf8-plain-text": Buffer.from(this.clipboard, "utf8") }];
  }

  async call(name: string, args: Row, options: { deadline?: number } = {}): Promise<Record<string, unknown>> {
    this.calls.push([name, args, options.deadline]);
    if (name === "list_apps") return { apps: [{ name: "1Password", bundle_id: "com.1password.1password", running: true, active: true, pid: 41 }] };
    if (name === "list_windows") return { windows: [{ window_id: 9, is_on_screen: true, on_current_space: true }] };
    if (name === "get_window_state") {
      const observed = this.snapshots.length ? this.snapshots.shift() as Row[] : this.elements;
      const payload: Row = { snapshot_id: "s0000001", elements: observed };
      if (args.include_screenshot === true) {
        Object.assign(payload, { window_bounds: { x: 100, y: 200, width: 500, height: 400 }, screenshot_width: 1000, screenshot_height: 800 });
      }
      return payload;
    }
    if (name === "clipboard_read") return { types: this.clipboardTypes, text: this.clipboard };
    if (name === "clipboard_write") {
      this.clipboard = args.text as string;
      this.clipboardTypes = ["public.utf8-plain-text"];
      this.nativeClipboard = [{ "public.utf8-plain-text": Buffer.from(this.clipboard, "utf8") }];
      return { supported: true, types: this.clipboardTypes };
    }
    if (name === "click") {
      if (args.element_token !== "s0000001:901" && this.copies.length) {
        this.clipboard = this.copies.shift() as string;
        this.clipboardTypes = ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"];
        this.nativeClipboard = [{ "public.utf8-plain-text": Buffer.from(this.clipboard, "utf8"), "org.nspasteboard.ConcealedType": Buffer.alloc(0) }];
      }
      return { effect: "confirmed" };
    }
    if (name === "type_text") return { effect: "confirmed" };
    if (name === "bring_to_front") return { exact_window_effect: { verified: true } };
    if (name === "hotkey" || name === "press_key") return { effect: "confirmed" };
    if (name === "verify_state") return { status: "satisfied" };
    throw new Error(`unexpected cua call ${name}`);
  }

  /** The names of calls made so far. */
  names(): string[] {
    return this.calls.map(([name]) => name);
  }
}

/** The Python autouse fake: preserve_clipboard snapshots the fake pasteboard and restores it in finally. */
export function fakeGuard(cua: FakeCua): ClipboardGuard {
  return async <T>(body: () => Promise<T>): Promise<T> => {
    const saved = [cua.clipboard, [...cua.clipboardTypes], cloneNative(cua.nativeClipboard)] as const;
    try {
      return await body();
    } finally {
      cua.clipboard = saved[0];
      cua.clipboardTypes = [...saved[1]];
      cua.nativeClipboard = cloneNative(saved[2]);
    }
  };
}
