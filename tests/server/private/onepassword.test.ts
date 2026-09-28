// test_onepassword.py -> private/onepassword.ts. Vault reads run against the synthetic FakeCua and an
// in-memory clipboard guard; nothing here starts 1Password, cua-driver or a real pasteboard guardian.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDirectory, type PrivateDir } from "../../../src/server/fs-private";
import { lockNow } from "../../../src/server/lock";
import { ClipboardError } from "../../../src/server/private/clipboard-guard";
import {
  ERROR_CODES, VAULT_TIMING, VaultError, accountCandidates, clearAndSearchAccount, createReadField, detailControls, mainWindow,
  menuResultMatches, ordinaryWindow, pollAccountResult, prepareAccount, readField, readWith, selectedUsernameMatches, usingCua,
  vaultDeps, withDeadline, type ClipboardGuard, type CuaCaller, type VaultDeps, type VaultField
} from "../../../src/server/private/onepassword";
import { clipboardGuardBinary } from "../../../src/server/stable-copy";
import { monotonic } from "../../../src/server/time";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";
import { exposure, watchOutput } from "./canary";
import { EMAIL, FakeCua, cloneNative, detailElements, element, fakeGuard, flatDetailElements, suggestionElements, type Row } from "./fake-cua";

const SECRET = "secret-value";
const saved = { ...VAULT_TIMING };

beforeEach(() => {
  Object.assign(VAULT_TIMING, { searchWaitSeconds: 0.02, searchPollSeconds: 0.001, selectionWaitSeconds: 0.02 });
});

afterEach(() => {
  Object.assign(VAULT_TIMING, saved);
  removeTempRoots();
});

function run(cua: FakeCua, field: VaultField = "password", options: { allowForegroundSearch?: boolean; clipboard?: ClipboardGuard; signal?: AbortSignal } = {}): Promise<string> {
  return readWith(cua, EMAIL, field, { clipboard: fakeGuard(cua), ...options });
}

async function failure(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error("expected a VaultError");
}

function withoutResult(rows: Row[]): Row[] {
  return rows.filter((row) => row.element_index !== 901);
}

function clipboardCalls(cua: FakeCua): string[] {
  return cua.names().filter((name) => name.startsWith("clipboard"));
}

function lockDir(): PrivateDir {
  return openDirectory(path.join(privateTemp(), "locks"));
}

function deps(cua: CuaCaller & { clipboard?: unknown }, options: { opened?: string[]; lock?: PrivateDir } = {}): VaultDeps {
  return {
    lockDir: options.lock ?? lockDir(),
    openCua: async () => {
      options.opened?.push("open");
      return { cua, close: async () => { options.opened?.push("close"); } };
    },
    clipboard: cua instanceof FakeCua ? fakeGuard(cua) : async (body) => body()
  };
}

/** The initial rows of test_foreground_search_and_focused_input_are_explicitly_gated. */
function foregroundInitial(): Row[] {
  const initial = withoutResult(detailElements("other@example.test"));
  initial.push(...suggestionElements().filter((row) => [41, 42, 45, 47].includes(row.element_index as number)));
  return initial;
}

/** A vault whose unique menu result only selects after a foreground search. */
class Foreground extends FakeCua {
  constructor(initial: Row[], copies: string[] = []) {
    super(structuredClone(initial), { copies });
  }

  override async call(name: string, args: Row, options: { deadline?: number } = {}): Promise<Record<string, unknown>> {
    if (name === "press_key") {
      this.calls.push([name, args, options.deadline]);
      if (args.key === "backspace") this.elements[0].value = "";
      else this.elements = detailElements();
      return { effect: "unverifiable" };
    }
    if (name === "set_value" || name === "type_text") {
      this.calls.push([name, args, options.deadline]);
      this.elements[0].value = args.value ?? args.text;
      return { effect: "unverifiable" };
    }
    if (name === "click" && args.element_token === "s0000001:42") {
      this.calls.push([name, args, options.deadline]);
      return { effect: "unverifiable" };
    }
    return super.call(name, args, options);
  }
}

/** Blocks the clipboard read that would observe the copied secret, until cancelled. */
class BlockingAfterSecretCopy extends FakeCua {
  secretCopied: Promise<void>;
  private copied!: () => void;

  constructor() {
    super(detailElements(), { copies: [EMAIL, SECRET] });
    this.secretCopied = new Promise((resolve) => { this.copied = resolve; });
  }

  override async call(name: string, args: Row, options: { deadline?: number } = {}): Promise<Record<string, unknown>> {
    if (name === "clipboard_read" && this.clipboard === SECRET && options.deadline === undefined) {
      this.copied();
      await new Promise(() => undefined);
    }
    return super.call(name, args, options);
  }
}

describe("readField and the MCP event loop", () => {
  it("reads the vault inside an MCP tool call without blocking the event loop", async () => {
    const slow = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    const lock = lockDir();
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 1);
    const paused: CuaCaller = {
      async call(name, args, options) {
        if (name === "list_apps") await new Promise((resolve) => setTimeout(resolve, 30));
        return slow.call(name, args, options);
      }
    };
    const server = new Server({ name: "synthetic", version: "0.0.0" }, { capabilities: { tools: {} } });
    const seen: string[] = [];
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const value = await readField(EMAIL, "password", {
        allow_foreground_search: request.params.arguments?.allow === true,
        deps: { lockDir: lock, openCua: async () => ({ cua: paused, close: async () => undefined }), clipboard: fakeGuard(slow) }
      });
      seen.push(value);
      return { content: [{ type: "text", text: `length ${value.length}` }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "synthetic-client", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const before = ticks;
      const result = await client.callTool({ name: "paste", arguments: { allow: true } });
      expect(ticks - before).toBeGreaterThan(0);
      expect(seen).toEqual([SECRET]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(result.content).toEqual([{ type: "text", text: `length ${SECRET.length}` }]);
      expect(slow.clipboard).toBe("before");
      expect(fs.readdirSync(lock.path)).toEqual(["onepassword.lock"]);
    } finally {
      clearInterval(ticker);
      await client.close();
      await server.close();
    }
  });
});

describe("vault state and windows", () => {
  it("refuses a locked vault without touching the clipboard", async () => {
    const cua = new FakeCua([element(1, "AXButton", "Unlock 1Password")]);
    expect((await failure(run(cua))).code).toBe("vault-locked");
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("picks the one on-screen window and ignores offscreen menus and utility windows", () => {
    const windows = [{ window_id: 9, is_on_screen: true, on_current_space: true }, { window_id: 10, is_on_screen: false, on_current_space: null }];
    expect(mainWindow(windows)).toBe(9);
    expect(() => mainWindow([...windows, { ...windows[0], window_id: 11 }])).toThrow("window-ambiguous");
  });

  it("selects the frontmost of several ordinary windows", () => {
    const windows = [
      { window_id: 70, title: "Older", subrole: "AXStandardWindow", z_index: 2, is_on_screen: true, on_current_space: true },
      { window_id: 71, title: "Frontmost", subrole: "AXStandardWindow", z_index: 7, is_on_screen: true, on_current_space: true },
      { window_id: 72, title: "Open", subrole: "AXDialog", z_index: 9, is_on_screen: true, on_current_space: true }
    ];
    expect(ordinaryWindow(windows)).toBe(71);
  });
});

describe("copying inside the clipboard guard", () => {
  it("restores the clipboard after an account mismatch", async () => {
    const cua = new FakeCua(detailElements(), { copies: ["other@example.test"] });
    expect((await failure(run(cua))).code).toBe("account-mismatch");
    expect(cua.clipboard).toBe("before");
  });

  it("restores the clipboard after an ambiguous field", async () => {
    const cua = new FakeCua(detailElements(EMAIL, { duplicatePassword: true }), { copies: [EMAIL] });
    expect((await failure(run(cua))).code).toBe("field-ambiguous");
    expect(cua.clipboard).toBe("before");
  });

  it("uses only the bracketed copy controls of the flat projection", async () => {
    const cua = new FakeCua(flatDetailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    expect(await run(cua)).toBe(SECRET);
    const clicked = cua.calls.filter(([name]) => name === "click").map(([, args]) => args.element_token);
    expect(clicked).toContain("s0000001:65");
    expect(clicked).toContain("s0000001:71");
    expect(clicked).not.toContain("s0000001:118");
  });

  const regions: [string, Row[]][] = [
    ["a duplicate copy control", flatDetailElements(EMAIL, { duplicatePasswordCopy: true })],
    ["a cross-field label", flatDetailElements(EMAIL, { crossField: true })]
  ];
  it.each(regions)("rejects a flat region with %s", (_name, elements) => {
    let caught: unknown;
    try {
      detailControls(elements, "password");
    } catch (error) {
      caught = error;
    }
    expect((caught as VaultError).code).toBe("field-ambiguous");
  });

  it("restores exact rich clipboard items and values", async () => {
    const original = [
      { "public.utf8-plain-text": Buffer.from("before\x00value", "latin1"), "public.rtf": Buffer.from("{\\rtf1 exact \\00 bytes}", "latin1") },
      { "public.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]) }
    ];
    const cua = new FakeCua(detailElements(), {
      copies: [EMAIL, SECRET, EMAIL],
      clipboard: "before",
      clipboardTypes: ["public.utf8-plain-text", "public.rtf", "public.png"],
      nativeClipboard: cloneNative(original)
    });
    expect(await run(cua)).toBe(SECRET);
    expect(cua.nativeClipboard).toEqual(original);
    expect(cua.nativeClipboard).not.toBe(original);
    expect(cua.clipboardTypes).toEqual(["public.utf8-plain-text", "public.rtf", "public.png"]);
  });

  it("restores the clipboard on success and returns only the secret", async () => {
    const cua = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    expect(await run(cua)).toBe(SECRET);
    expect(cua.clipboard).toBe("before");
  });

  it("restores the clipboard after a failure during the second copy", async () => {
    class Broken extends FakeCua {
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "click" && !this.copies.length) throw new Error("private upstream detail");
        return super.call(name, args, options);
      }
    }
    const cua = new Broken(detailElements(), { copies: [EMAIL] });
    const error = await failure(run(cua));
    expect(error.code).toBe("operation-failed");
    expect(exposure(error)).not.toContain("private upstream detail");
    expect(cua.clipboard).toBe("before");
  });

  it("masks the value with a static error when the restore fails", async () => {
    const cannotRestore: ClipboardGuard = async (body) => {
      await body();
      throw new ClipboardError("clipboard-restore-failed");
    };
    const cua = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    const error = await failure(run(cua, "password", { clipboard: cannotRestore }));
    expect(error.code).toBe("clipboard-restore-failed");
    expect(exposure(error)).not.toContain(SECRET);
  });

  it("translates a guard start failure without touching the clipboard", async () => {
    const unavailable: ClipboardGuard = async () => { throw new ClipboardError("clipboard-unavailable"); };
    const cua = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    expect((await failure(run(cua, "password", { clipboard: unavailable }))).code).toBe("clipboard-unavailable");
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("restores the clipboard before a cancellation after the secret copy propagates", async () => {
    const cua = new BlockingAfterSecretCopy();
    const controller = new AbortController();
    const task = readWith(cua, EMAIL, "password", { clipboard: fakeGuard(cua), signal: controller.signal });
    await cua.secretCopied;
    controller.abort();
    await expect(task).rejects.toBe(controller.signal.reason);
    expect(cua.clipboard).toBe("before");
    expect(cua.nativeClipboard).toEqual([{ "public.utf8-plain-text": Buffer.from("before") }]);
  });

  it("returns no wrong password when the selected item switches between the secret and the recheck", async () => {
    const wrongPassword = "wrong-item-secret";
    const cua = new FakeCua(detailElements("other@example.test"), {
      copies: [EMAIL, wrongPassword, "other@example.test"],
      snapshots: [detailElements(), detailElements(), detailElements(), detailElements("other@example.test")]
    });
    const error = await failure(run(cua));
    expect(error.code).toBe("account-mismatch");
    expect(exposure(error)).not.toContain(wrongPassword);
    expect(cua.clipboard).toBe("before");
  });
});

describe("selecting the account", () => {
  it("verifies an unverifiable search write with a fresh snapshot and never replays it", async () => {
    const rows = withoutResult(detailElements("other@example.test"));
    const search = rows.find((row) => row.element_index === 900) as Row;
    search.value = "previous public query";
    const result = element(901, "AXButton", EMAIL, { actions: ["AXPress"] });
    const cua = new FakeCua(rows, { copies: [EMAIL, SECRET, EMAIL] });
    const base = cua.call.bind(cua);
    cua.call = async (name, args, options = {}) => {
      if (name === "set_value") {
        cua.calls.push([name, args, options.deadline]);
        search.value = EMAIL;
        rows.push(result);
        return { effect: "unverifiable" };
      }
      if (name === "verify_state") {
        cua.calls.push([name, args, options.deadline]);
        return { status: "unknown" };
      }
      if (name === "click" && args.element_token === result.element_token) {
        cua.calls.push([name, args, options.deadline]);
        cua.elements = detailElements();
        return { effect: "unverifiable" };
      }
      return base(name, args, options);
    };
    expect(await run(cua)).toBe(SECRET);
    expect(cua.calls.filter(([name]) => name === "set_value").map(([, args]) => args))
      .toEqual([{ pid: 41, window_id: 9, element_token: "s0000001:900", value: EMAIL }]);
  });

  it("confirms an unverifiable result click with a fresh snapshot and never replays it", async () => {
    const rows = detailElements("other@example.test");
    const result = rows.find((row) => row.element_index === 901) as Row;
    const cua = new FakeCua(rows, { copies: [EMAIL, SECRET, EMAIL] });
    const base = cua.call.bind(cua);
    cua.call = async (name, args, options = {}) => {
      if (name === "click" && args.element_token === result.element_token) {
        cua.calls.push([name, args, options.deadline]);
        cua.elements = detailElements();
        return { effect: "unverifiable" };
      }
      return base(name, args, options);
    };
    expect(await run(cua)).toBe(SECRET);
    expect(cua.calls.filter(([name, args]) => name === "click" && args.element_token === result.element_token)).toHaveLength(1);
  });

  it("matches the unique menu result and excludes Show all matching items", () => {
    expect([...accountCandidates(suggestionElements(), EMAIL).keys()]).toEqual(["s0000001:42"]);
  });

  it("polls a delayed menu result, then selects it once", async () => {
    const initial = withoutResult(detailElements("other@example.test"));
    class Delayed extends FakeCua {
      observations = 0;
      selected = false;
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "get_window_state") {
          this.observations += 1;
          if (this.observations >= 2 && !this.selected) this.elements = suggestionElements();
        }
        if (name === "click" && args.element_token === "s0000001:42") {
          this.calls.push([name, args, options.deadline]);
          this.selected = true;
          this.elements = detailElements();
          return { effect: "confirmed" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new Delayed(initial);
    const result = await prepareAccount(cua, 41, 9, EMAIL, initial);
    expect(selectedUsernameMatches(result, EMAIL)).toBe(true);
    expect(cua.observations).toBeGreaterThanOrEqual(3);
    expect(cua.calls.filter(([name, args]) => name === "click" && args.element_token === "s0000001:42")).toHaveLength(1);
    expect(cua.names()).not.toContain("press_key");
  });

  it("gates the foreground search and focused input on explicit permission", async () => {
    const initial = foregroundInitial();
    const blocked = new Foreground(initial);
    expect((await failure(prepareAccount(blocked, 41, 9, EMAIL, initial))).code).toBe("action-unconfirmed");
    expect(blocked.names()).not.toContain("press_key");

    const allowed = new Foreground(initial);
    const result = await prepareAccount(allowed, 41, 9, EMAIL, initial, { allowForegroundSearch: true });
    expect(selectedUsernameMatches(result, EMAIL)).toBe(true);
    const presses = allowed.calls.filter(([name]) => name === "press_key").map(([, args]) => args);
    expect(presses.map((press) => press.key)).toEqual(["backspace", "return"]);
    expect(presses.every((press) => press.delivery_mode === "foreground" && !("x" in press))).toBe(true);
    const types = allowed.calls.filter(([name]) => name === "type_text").map(([, args]) => args);
    expect(types).toHaveLength(1);
    expect("x" in types[0]).toBe(false);
    const hotkeys = allowed.calls.filter(([name]) => name === "hotkey").map(([, args]) => args);
    expect(hotkeys).toHaveLength(1);
    expect("x" in hotkeys[0]).toBe(true);
    expect(allowed.calls.some(([name, args]) => name === "click" && "x" in args)).toBe(false);
    expect(allowed.calls.some(([name, args]) => name === "click" && args.element_token === "s0000001:42")).toBe(true);
  });

  it("skips search and foreground actions when the selected detail already matches", async () => {
    const cua = new FakeCua(detailElements());
    const elements = detailElements();
    const result = await prepareAccount(cua, 41, 9, EMAIL.toUpperCase(), elements, { allowForegroundSearch: true });
    expect(result).toBe(elements);
    expect(cua.calls).toEqual([]);
  });

  const placeholders = ["Search", "Search in Test Vault"];
  it.each(placeholders)("clears the %s placeholder, types, then presses return in a cold search", async (placeholder) => {
    const initial = withoutResult(detailElements("other@example.test"));
    initial[0].frame = { x: 110, y: 210, w: 300, h: 24 };
    class ClearSearch extends FakeCua {
      cleared = false;
      typed = false;
      selectionActive = false;
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "hotkey") {
          this.calls.push([name, args, options.deadline]);
          this.selectionActive = true;
          return { effect: "unverifiable" };
        }
        if (name === "type_text") {
          this.calls.push([name, args, options.deadline]);
          expect(this.cleared && !("x" in args)).toBe(true);
          this.typed = true;
          this.elements[0].value = EMAIL;
          return { effect: "unverifiable" };
        }
        if (name === "press_key") {
          this.calls.push([name, args, options.deadline]);
          if (args.key === "backspace") {
            if ("x" in args) {
              this.selectionActive = false;
              this.elements[0].value = String(this.elements[0].value).slice(0, -1);
              return { effect: "unverifiable" };
            }
            expect(this.selectionActive).toBe(true);
            this.cleared = true;
            this.elements[0].value = placeholder;
            this.elements[0].label = placeholder;
          } else {
            expect(this.typed && !("x" in args)).toBe(true);
            this.elements = detailElements();
          }
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new ClearSearch(initial, { nativeClipboard: [{ "public.html": Buffer.from("<b>original</b>") }, { "public.png": Buffer.from("image") }] });
    const before = cloneNative(cua.nativeClipboard);
    const result = await prepareAccount(cua, 41, 9, EMAIL, initial, { allowForegroundSearch: true });
    expect(selectedUsernameMatches(result, EMAIL)).toBe(true);
    expect(cua.clipboard).toBe("before");
    expect(cua.nativeClipboard).toEqual(before);
    expect(cua.names().filter((name) => name === "type_text" || name === "press_key")).toEqual(["press_key", "type_text", "press_key"]);
    expect(cua.calls.filter(([name]) => name === "type_text" || name === "press_key").every(([, args]) => !("x" in args))).toBe(true);
    expect(cua.names().some((name) => name === "click" || name.startsWith("clipboard"))).toBe(false);
  });

  it("selects the unique result when return leaves the suggestions open", async () => {
    VAULT_TIMING.selectionWaitSeconds = 0.01;
    const initial = withoutResult(detailElements("other@example.test"));
    class SuggestionRemains extends FakeCua {
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "press_key" || name === "type_text" || name === "click") {
          this.calls.push([name, args, options.deadline]);
          if (name === "press_key" && args.key === "backspace") this.elements[0].value = "";
          else if (name === "type_text") this.elements[0].value = args.text;
          else if (name === "press_key" && args.key === "return") this.elements = suggestionElements();
          else if (name === "click" && args.element_token === "s0000001:42" && args.delivery_mode === "foreground") this.elements = detailElements();
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new SuggestionRemains(initial);
    const [rows] = await clearAndSearchAccount(cua, 41, 9, EMAIL);
    expect(selectedUsernameMatches(rows, EMAIL)).toBe(true);
    expect(cua.calls.filter(([name]) => name === "click").map(([, args]) => args))
      .toEqual([{ pid: 41, window_id: 9, element_token: "s0000001:42", delivery_mode: "foreground" }]);
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("does not treat a child of Show all matching items as an account result", () => {
    const rows = suggestionElements();
    rows.push(element(48, "AXStaticText", EMAIL, { parent: 47 }));
    expect([...accountCandidates(rows, EMAIL).keys()]).toEqual(["s0000001:42"]);
  });

  it("recovers with a foreground search when the background query does not stick", async () => {
    const initial = withoutResult(detailElements("other@example.test"));
    initial[0].value = "Search";
    initial[0].label = "Search";
    class BackgroundNoop extends FakeCua {
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "set_value") {
          this.calls.push([name, args, options.deadline]);
          return { effect: "unverifiable" };
        }
        if (name === "type_text") {
          this.calls.push([name, args, options.deadline]);
          this.elements[0].value = args.text;
          return { effect: "unverifiable" };
        }
        if (name === "press_key") {
          this.calls.push([name, args, options.deadline]);
          if (args.key === "backspace") this.elements[0].value = "";
          else this.elements = detailElements();
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new BackgroundNoop(initial);
    const result = await prepareAccount(cua, 41, 9, EMAIL, initial, { allowForegroundSearch: true });
    expect(selectedUsernameMatches(result, EMAIL)).toBe(true);
    const writes = cua.calls.filter(([name]) => ["set_value", "type_text", "press_key"].includes(name));
    expect(writes.map(([name]) => name)).toEqual(["set_value", "press_key", "type_text", "press_key"]);
    expect(writes[2][1].text).toBe(EMAIL);
    expect(writes[2][1].delivery_mode).toBe("foreground");
    expect("x" in writes[2][1]).toBe(false);
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("recovers in a cold search when the background clear does not stick", async () => {
    const initial = detailElements("other@example.test");
    initial[0].value = "previous public query";
    initial[0].frame = { x: 110, y: 210, w: 300, h: 24 };
    class ForegroundClear extends FakeCua {
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (["set_value", "hotkey", "press_key", "type_text"].includes(name)) {
          this.calls.push([name, args, options.deadline]);
          if (name === "press_key" && args.key === "backspace") this.elements[0].value = "";
          else if (name === "type_text") this.elements[0].value = args.text;
          else if (name === "press_key" && args.key === "return") this.elements = detailElements();
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new ForegroundClear(initial);
    const [rows] = await clearAndSearchAccount(cua, 41, 9, EMAIL);
    expect(selectedUsernameMatches(rows, EMAIL)).toBe(true);
    expect(cua.calls.some(([name, args]) => name === "hotkey" && JSON.stringify(args.keys) === JSON.stringify(["cmd", "a"]) && args.delivery_mode === "foreground")).toBe(true);
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("stops a cold search when the old query does not clear", async () => {
    const initial = detailElements("other@example.test");
    initial[0].value = "previous public query";
    initial[0].frame = { x: 110, y: 210, w: 300, h: 24 };
    class FailedClear extends FakeCua {
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (["set_value", "hotkey", "press_key"].includes(name)) {
          this.calls.push([name, args, options.deadline]);
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new FailedClear(initial);
    expect((await failure(clearAndSearchAccount(cua, 41, 9, EMAIL))).code).toBe("action-unconfirmed");
    expect(cua.calls.some(([name, args]) => name === "type_text" || name.startsWith("clipboard") || (name === "press_key" && args.key === "return"))).toBe(false);
  });

  it("requires the exact selected detail after a foreground search and restores the prior app", async () => {
    const initial = withoutResult(detailElements("other@example.test"));
    class PriorApp extends FakeCua {
      activePid = 77;
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "list_apps") {
          this.calls.push([name, args, options.deadline]);
          return { apps: [
            { name: "1Password", running: true, active: this.activePid === 41, pid: 41 },
            { name: "Chrome", running: true, active: this.activePid === 77, pid: 77 }
          ] };
        }
        if (name === "list_windows" && args.pid === 77) {
          this.calls.push([name, args, options.deadline]);
          return { windows: [
            { window_id: 70, title: "Open", subrole: "AXDialog", z_index: 9, is_on_screen: true, on_current_space: true },
            { window_id: 72, title: "GoToWindow", role: "AXSheet", z_index: 8, is_on_screen: true, on_current_space: true },
            { window_id: 71, title: "Browser", subrole: "AXStandardWindow", z_index: 3, is_on_screen: true, on_current_space: true }
          ] };
        }
        if (name === "bring_to_front") {
          this.calls.push([name, args, options.deadline]);
          this.activePid = args.pid as number;
          return { exact_window_effect: { verified: true } };
        }
        if (name === "press_key") {
          this.calls.push([name, args, options.deadline]);
          if (args.key === "backspace") this.elements[0].value = "";
          else this.elements = suggestionElements();
          return { effect: "unverifiable" };
        }
        if (name === "type_text") {
          this.calls.push([name, args, options.deadline]);
          this.elements[0].value = args.text;
          return { effect: "unverifiable" };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new PriorApp(initial);
    expect((await failure(clearAndSearchAccount(cua, 41, 9, EMAIL))).code).toBe("action-unconfirmed");
    expect(cua.calls.filter(([name]) => name === "bring_to_front").map(([, args]) => args)).toEqual([{ pid: 41, window_id: 9 }, { pid: 77, window_id: 71 }]);
    expect(cua.activePid).toBe(77);
    expect(cua.calls.filter(([name]) => name === "click").map(([, args]) => args))
      .toEqual([{ pid: 41, window_id: 9, element_token: "s0000001:42", delivery_mode: "foreground" }]);
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("blocks input when the exact vault focus is unverified and still attempts the restore", async () => {
    const initial = withoutResult(detailElements("other@example.test"));
    class UnverifiedFocus extends FakeCua {
      activePid = 77;
      override async call(name: string, args: Row, options: { deadline?: number } = {}) {
        if (name === "list_apps") {
          this.calls.push([name, args, options.deadline]);
          return { apps: [
            { name: "1Password", running: true, active: this.activePid === 41, pid: 41 },
            { name: "Chrome", running: true, active: this.activePid === 77, pid: 77 }
          ] };
        }
        if (name === "list_windows" && args.pid === 77) {
          this.calls.push([name, args, options.deadline]);
          return { windows: [{ window_id: 71, title: "Browser", subrole: "AXStandardWindow", z_index: 4, is_on_screen: true, on_current_space: true }] };
        }
        if (name === "bring_to_front") {
          this.calls.push([name, args, options.deadline]);
          this.activePid = args.pid as number;
          return { exact_window_effect: { verified: args.pid === 77 } };
        }
        return super.call(name, args, options);
      }
    }
    const cua = new UnverifiedFocus(initial);
    expect((await failure(clearAndSearchAccount(cua, 41, 9, EMAIL))).code).toBe("action-unconfirmed");
    expect(cua.calls.filter(([name]) => name === "bring_to_front").map(([, args]) => args)).toEqual([{ pid: 41, window_id: 9 }, { pid: 77, window_id: 71 }]);
    expect(cua.activePid).toBe(77);
    expect(cua.names().some((name) => ["hotkey", "press_key", "type_text"].includes(name))).toBe(false);
  });

  it("waits for transient duplicate results to settle", async () => {
    const duplicated = detailElements("other@example.test");
    duplicated.push(element(902, "AXButton", EMAIL, { actions: ["AXPress"] }));
    const cua = new FakeCua(detailElements(), { snapshots: [duplicated, detailElements()] });
    const [rows] = await pollAccountResult(cua, 41, 9, EMAIL, monotonic() + 1);
    expect(selectedUsernameMatches(rows, EMAIL)).toBe(true);
    expect(cua.names()).not.toContain("click");
  });

  it("keeps persistent duplicate results blocked", async () => {
    const duplicated = detailElements("other@example.test");
    duplicated.push(element(902, "AXButton", EMAIL, { actions: ["AXPress"] }));
    const cua = new FakeCua(duplicated);
    expect((await failure(pollAccountResult(cua, 41, 9, EMAIL, monotonic() + 0.01))).code).toBe("account-ambiguous");
    expect(cua.names()).not.toContain("click");
  });

  it("does not match a composite menu result that only ends with the email", () => {
    const row = element(42, "AXMenuItem", `synthetic — prefix${EMAIL} example.test`, { actions: ["AXPress"] });
    expect(menuResultMatches(row, EMAIL)).toBe(false);
  });

  it("refuses an ambiguous account target before touching the clipboard", async () => {
    const rows = [
      element(1, "AXTextField", "Search", { value: EMAIL }),
      element(2, "AXButton", EMAIL, { actions: ["AXPress"] }),
      element(3, "AXButton", EMAIL, { actions: ["AXPress"] })
    ];
    const cua = new FakeCua(rows);
    expect((await failure(run(cua))).code).toBe("account-ambiguous");
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("fails closed when a search has no unique matching result", async () => {
    const cua = new FakeCua(withoutResult(detailElements("other@example.test")));
    expect((await failure(run(cua))).code).toBe("account-not-found");
    expect(clipboardCalls(cua)).toEqual([]);
  });

  it("fails closed on a cyclic accessibility tree instead of walking it forever", () => {
    const rows = [
      element(1, "AXTextField", "Search", { value: EMAIL }),
      element(2, "AXStaticText", EMAIL, { parent: 3 }),
      element(3, "AXGroup", "loop", { parent: 2 })
    ];
    let caught: unknown;
    try {
      accountCandidates(rows, EMAIL);
    } catch (error) {
      caught = error;
    }
    expect((caught as VaultError).code).toBe("observation-unavailable");
  });

  it("compares accessibility values with Python str(), so a list label never equals a plain label", async () => {
    const rows = detailElements().map((row) => (row.element_index === 4 ? { ...row, label: ["Copy"] } : row));
    const cua = new FakeCua(rows, { copies: [EMAIL, SECRET, EMAIL] });
    expect((await failure(run(cua))).code).toBe("field-ambiguous");
    // An unhashable index is Python's TypeError, which the public API reports as operation-failed.
    const unhashable = detailElements().map((row) => (row.element_index === 3 ? { ...row, parent_index: [10] } : row));
    const other = new FakeCua(unhashable, { copies: [EMAIL, SECRET, EMAIL] });
    await expect(run(other)).rejects.toBeInstanceOf(TypeError);
    expect((await failure(readField(EMAIL, "password", { deps: deps(other) }))).code).toBe("operation-failed");
    expect(clipboardCalls(other)).toEqual([]);
  });
});

describe("deadlines, errors and the public API", () => {
  it("restores through the guard when the deadline cancels a read", async () => {
    const cua = new BlockingAfterSecretCopy();
    const error = await failure(withDeadline(0.01, (signal) => readWith(cua, EMAIL, "password", { clipboard: fakeGuard(cua), signal })));
    expect(error.code).toBe("deadline-exceeded");
    expect(cua.clipboard).toBe("before");
    expect(cua.nativeClipboard).toEqual([{ "public.utf8-plain-text": Buffer.from("before") }]);
  });

  it("sanitizes an arbitrary transport exception to a static error", async () => {
    const detail = "vault item title and private detail";
    const cua: CuaCaller = { call: async () => { throw new Error(detail); } };
    const watch = watchOutput();
    let error: VaultError;
    try {
      error = await failure(readField(EMAIL, "password", { deps: deps(cua) }));
    } finally {
      watch.restore();
    }
    expect(error.code).toBe("operation-failed");
    expect(error.message).toBe("operation-failed");
    expect(exposure(error)).not.toContain(detail);
    expect(watch.text()).not.toContain(detail);
  });

  it("has no native effect for invalid inputs", async () => {
    const opened: string[] = [];
    const lock = lockDir();
    expect((await failure(readField("bad email", "password", { deps: deps(new FakeCua([]), { opened, lock }) }))).code).toBe("invalid-email");
    expect((await failure(readField(EMAIL, "recovery code" as VaultField, { deps: deps(new FakeCua([]), { opened, lock }) }))).code).toBe("unsupported-field");
    expect((await failure(readField(EMAIL, "password", { allow_foreground_search: "yes" as unknown as boolean, deps: deps(new FakeCua([]), { opened, lock }) }))).code).toBe("operation-failed");
    expect(opened).toEqual([]);
    expect(fs.readdirSync(lock.path)).toEqual([]);
  });

  it("passes the explicit foreground search permission through the public API", async () => {
    const plain = new Foreground(foregroundInitial(), [EMAIL, SECRET, EMAIL]);
    expect((await failure(readField(EMAIL, "password", { deps: deps(plain) }))).code).toBe("action-unconfirmed");
    expect(plain.names()).not.toContain("press_key");
    expect(plain.names()).not.toContain("hotkey");

    const allowed = new Foreground(foregroundInitial(), [EMAIL, SECRET, EMAIL]);
    expect(await readField(EMAIL, "password", { allow_foreground_search: true, deps: deps(allowed) })).toBe(SECRET);
    expect(allowed.calls.filter(([name]) => name === "press_key").map(([, args]) => args.key)).toEqual(["backspace", "return"]);
    expect(allowed.clipboard).toBe("before");
  });

  it("maps an arbitrary code to operation-failed", () => {
    const error = new VaultError("private arbitrary text");
    expect(error.code).toBe("operation-failed");
    expect(error.message).toBe("operation-failed");
    expect(exposure(error)).not.toContain("private arbitrary text");
    expect(ERROR_CODES.has("deadline-exceeded")).toBe(true);
    expect(ERROR_CODES.size).toBe(21);
  });

  it("keeps a body VaultError apart from the transport and closes the connection after the body", async () => {
    const events: string[] = [];
    const error = await failure(usingCua({
      openCua: async () => {
        events.push("open");
        return { cua: new FakeCua([]), close: async (...args: unknown[]) => { events.push(`close:${args.length}`); } };
      }
    }, monotonic() + 1, new AbortController().signal, async () => {
      events.push("body");
      throw new VaultError("account-mismatch");
    }));
    expect(error.code).toBe("account-mismatch");
    expect(events).toEqual(["open", "body", "close:0"]);
  });

  it("reports an open or close failure of the private connection as transport-unavailable", async () => {
    const signal = new AbortController().signal;
    expect((await failure(usingCua({ openCua: async () => { throw new Error("spawn detail"); } }, monotonic() + 1, signal, async () => "unused"))).code)
      .toBe("transport-unavailable");
    expect((await failure(usingCua({
      openCua: async () => ({ cua: new FakeCua([]), close: async () => { throw new Error("close detail"); } })
    }, monotonic() + 1, signal, async () => SECRET))).code).toBe("transport-unavailable");
  });
});

describe("the bounded vault lock", () => {
  it("waits for another holder and reports vault-busy at the deadline without opening the vault", async () => {
    VAULT_TIMING.timeoutSeconds = 0.2;
    const lock = lockDir();
    const held = lockNow(lock, "onepassword.lock", true);
    const opened: string[] = [];
    const started = monotonic();
    try {
      expect((await failure(readField(EMAIL, "password", { deps: deps(new FakeCua(detailElements()), { opened, lock }) }))).code).toBe("vault-busy");
    } finally {
      held.release();
    }
    expect(monotonic() - started).toBeGreaterThanOrEqual(0.19);
    expect(opened).toEqual([]);
    const cua = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    expect(await readField(EMAIL, "password", { deps: deps(cua, { opened, lock }) })).toBe(SECRET);
    expect(opened).toEqual(["open", "close"]);
    expect(fs.statSync(path.join(lock.path, "onepassword.lock")).mode & 0o777).toBe(0o600);
  });

  it("fails closed on an unsafe vault lock file without opening the vault", async () => {
    for (const unsafe of ["symlink", "hardlink", "mode"] as const) {
      const lock = lockDir();
      const file = path.join(lock.path, "onepassword.lock");
      const other = path.join(path.dirname(lock.path), `other-${unsafe}`);
      fs.writeFileSync(other, "", { mode: 0o600 });
      if (unsafe === "symlink") fs.symlinkSync(other, file);
      else if (unsafe === "hardlink") fs.linkSync(other, file);
      else fs.writeFileSync(file, "", { mode: 0o644 });
      const opened: string[] = [];
      const error = await readField(EMAIL, "password", { deps: deps(new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] }), { opened, lock }) })
        .then(() => null, (caught: unknown) => caught);
      expect(error, unsafe).toBeInstanceOf(Error);
      expect(error, unsafe).not.toBeInstanceOf(VaultError);
      expect(exposure(error)).not.toContain(SECRET);
      expect(opened, unsafe).toEqual([]);
    }
  });

  it("serializes concurrent reads in one process", async () => {
    const lock = lockDir();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = new FakeCua(detailElements(), { copies: [EMAIL, SECRET, EMAIL] });
    const second = new FakeCua(detailElements(), { copies: [EMAIL, "second-secret", EMAIL] });
    const opening = (name: string, cua: FakeCua, wait?: Promise<void>): VaultDeps => ({
      lockDir: lock,
      clipboard: fakeGuard(cua),
      openCua: async () => {
        events.push(`${name}:open`);
        await wait;
        return { cua, close: async () => { events.push(`${name}:close`); } };
      }
    });
    const a = readField(EMAIL, "password", { deps: opening("a", first, gate) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = readField(EMAIL, "password", { deps: opening("b", second) });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(events).toEqual(["a:open"]);
    release();
    expect(await a).toBe(SECRET);
    expect(await b).toBe("second-secret");
    expect(events).toEqual(["a:open", "a:close", "b:open", "b:close"]);
  });
});

describe("production dependencies", () => {
  it("keeps the lock and the clipboard guard under the state root", async () => {
    const root = privateTemp();
    const env = testEnv(root);
    const production = vaultDeps(env);
    expect(production.lockDir.path).toBe(path.join(root, "state", "locks"));
    expect(fs.statSync(production.lockDir.path).mode & 0o777).toBe(0o700);
    const guardian = clipboardGuardBinary(env);
    expect(path.dirname(guardian)).toBe(path.join(root, "state", "bin"));
    fs.mkdirSync(path.dirname(guardian), { recursive: true, mode: 0o700 });
    const marker = path.join(root, "restored.marker");
    fs.writeFileSync(guardian, `#!/bin/sh\necho ready\nread line\nprintf done > '${marker}'\necho restored\n`, { mode: 0o700 });
    expect(await production.clipboard(async () => "public-result")).toBe("public-result");
    expect(fs.readFileSync(marker, "utf8")).toBe("done");
    expect(fs.existsSync(path.join(root, "home"))).toBe(false);
  });

  it("refuses the clipboard when the state root has no trusted guardian", async () => {
    const production = vaultDeps(testEnv(privateTemp()));
    let ran = false;
    await expect(production.clipboard(async () => { ran = true; })).rejects.toThrow("clipboard-unavailable");
    expect(ran).toBe(false);
  });

  it("builds a ReadField that validates before opening anything", async () => {
    const root = privateTemp();
    const read = createReadField(testEnv(root));
    await expect(read("bad email", "password")).rejects.toThrow("invalid-email");
    expect(fs.existsSync(path.join(root, "state"))).toBe(false);
  });
});
