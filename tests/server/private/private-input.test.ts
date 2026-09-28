// test_private_input.py -> private/private-input.ts. A synthetic Browser stands in for the owned host
// connection; the private source is an in-memory reader with synthetic values.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate } from "../../../src/server/gate";
import type { HostConnection } from "../../../src/server/host-connection";
import type { VaultField } from "../../../src/server/private/onepassword";
import { paste, type PasteRequest, type PrivateSource, type PrivateTab } from "../../../src/server/private/private-input";
import type { JsonObject } from "../../../src/server/pyjson";
import { code } from "../support/renames";
import { exposure, watchOutput, type Watch } from "./canary";

const clock = vi.hoisted(() => ({ now: null as number | null }));

vi.mock("../../../src/server/time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/server/time")>();
  return { ...actual, monotonic: () => clock.now ?? actual.monotonic() };
});

const URL = "https://deploy-preview-1664--app.example.test/login";
const EMAIL = "synthetic@example.test";
const PASSWORD = " synthetic-private-value \t";
const OTP = "123456";
const OWNER = "ses_synthetic";

type Call = [string, JsonObject];

class Browser implements HostConnection {
  alive = true;
  url = URL;
  document = "document-one";
  calls: Call[] = [];
  fillResult: unknown = { status: "filled" };
  submitError: Error | null = null;
  actions = [{ id: "fresh-submit", kind: "click", label: "Sign in", role: "button", disabled: false }];
  prepareResult: unknown = null;
  submitLifetime: number | null = 90000;
  preparedAction: unknown = null;
  replaced = new Set<string>();
  fieldsPresent = true;

  close(): void {}

  async call(method: string, params?: JsonObject | null): Promise<unknown> {
    const args = params ?? {};
    this.calls.push([method, args]);
    if (method === "getTabs") return [{ id: 1, url: this.url }];
    if (method === "observeDocument") {
      if (!this.fieldsPresent) throw new Gate(code("opchrome-private-fields-unavailable"));
      return { origin: this.url.replace(/\/login$/, ""), url: this.url, token: "private-token", documentId: this.document };
    }
    if (method === "preparePrivateSubmit") {
      this.preparedAction = args.actionId;
      if (this.prepareResult !== null) return this.prepareResult;
      const result = { status: "prepared", submitToken: "submit-token", documentId: this.document };
      return this.submitLifetime === null ? result : { ...result, expiresInMs: this.submitLifetime };
    }
    if (method === "observePage") return { status: "observed", url: this.url, snapshot: "fresh-snapshot", actions: this.actions };
    if (method === "privateFill") return this.fillResult;
    if (method === "submitPrivate") {
      if (this.submitError) throw this.submitError;
      if (this.replaced.has(this.preparedAction as string)) return { status: "not-executed", reason: "private-submit-refused", retry: false };
      return { status: "executed" };
    }
    throw new Error(`unexpected host method ${method}`);
  }

  methods(from = 0): string[] {
    return this.calls.slice(from).map(([method]) => method);
  }
}

interface Context {
  browser: Browser;
  tab: PrivateTab;
  reads: [string, VaultField][];
  stopping: boolean;
  readAt: number;
  env: Record<string, string | undefined>;
}

let t: Context;
let watch: Watch;

function setUp(): Context {
  const browser = new Browser();
  const tab: PrivateTab = {
    id: 1,
    owner: OWNER,
    connection: browser,
    origin: URL.replace(/\/login$/, ""),
    recording: null,
    snapshot: ["public-snapshot", "extension-snapshot"],
    page: { actions: [{ id: "submit", kind: "click", label: "Sign in", role: "button", disabled: false } as { id: string; kind: string }] },
    privateIdentity: null,
    privateAttempts: new Set(),
    call: (method, params) => browser.call(method, { tabId: 1, ...params })
  };
  t = { browser, tab, reads: [], stopping: false, readAt: -1, env: {} };
  return t;
}

const read: PrivateSource = async (email, field) => {
  t.reads.push([email, field]);
  return field === "password" ? PASSWORD : OTP;
};

function refuse(): void {
  if (t.stopping) throw new Gate("fast-chrome-shutting-down");
}

function request(field: "password" | "one-time password", overrides: Partial<PasteRequest> = {}): PasteRequest {
  const base: PasteRequest = field === "password"
    ? { session: OWNER, expectedUrl: URL, email: EMAIL, field, selector: "input[type=password]", usernameSelector: "input[name=email]", snapshotId: "public-snapshot", submitActionId: "submit" }
    : { session: OWNER, expectedUrl: URL, email: EMAIL, field, selector: "input[autocomplete=one-time-code]", usernameSelector: null, snapshotId: null, submitActionId: null };
  return { ...base, ...overrides };
}

function password(reader: PrivateSource = read, overrides: Partial<PasteRequest> = {}) {
  return paste(t.tab, request("password", overrides), reader, refuse, t.env);
}

function otp(reader: PrivateSource = read, overrides: Partial<PasteRequest> = {}) {
  return paste(t.tab, request("one-time password", overrides), reader, refuse, t.env);
}

const stoppingReader: PrivateSource = async (email, field) => {
  t.stopping = true; // shutdown begins while the vault read runs
  t.readAt = t.browser.calls.length;
  return read(email, field);
};

/** Begin shutdown while a `method` call is in flight. */
function stoppingOn(method: string): void {
  const original = t.browser.call.bind(t.browser);
  t.browser.call = async (name, params) => {
    if (name === method) t.stopping = true;
    return original(name, params);
  };
}

async function gate(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Gate) return error.code;
    throw error;
  }
  throw new Error("expected a Gate");
}

beforeEach(() => {
  setUp();
  watch = watchOutput();
});

afterEach(() => {
  watch.restore();
  clock.now = null;
  // No private value is ever written to stdout, stderr or the console.
  expect(watch.text()).not.toContain(PASSWORD);
});

describe("paste", () => {
  it("fills and submits through the owned connection without exposing the value", async () => {
    const result = await password();
    expect(result.outcome).toBe("submitted");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    const fills = t.browser.calls.filter(([method]) => method === "privateFill").map(([, args]) => args);
    expect(fills[0].values).toEqual([EMAIL, PASSWORD]);
    expect(fills).toHaveLength(1);
    expect(t.browser.methods().filter((method) => method === "submitPrivate")).toHaveLength(1);
    expect(t.tab.snapshot).toBeNull();
    expect(t.tab.page).toBeNull();
    expect(t.tab.privateIdentity).toEqual([EMAIL, "document-one"]);
  });

  it("prepares an initially disabled submit before the private fill", async () => {
    (t.tab.page?.actions[0] as { disabled?: boolean }).disabled = true;
    t.browser.actions[0].disabled = true;
    const result = await password();
    expect(result.outcome).toBe("submitted");
    const methods = t.browser.methods();
    expect(methods.indexOf("preparePrivateSubmit")).toBeLessThan(methods.indexOf("privateFill"));
    expect(methods.indexOf("privateFill")).toBeLessThan(methods.indexOf("submitPrivate"));
    expect(methods.filter((method) => method === "submitPrivate")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("refuses a wrong exact URL and a running recording before the vault read", async () => {
    t.browser.url = URL.replace("1664", "1665");
    expect(await gate(password())).toBe("fast-chrome-private-url-changed");
    t.browser.url = URL;
    t.tab.recording = {};
    expect(await gate(password())).toBe("fast-chrome-stop-recording-first");
    expect(t.reads).toEqual([]);
  });

  it("does not fill after a document change during the vault read", async () => {
    const reader: PrivateSource = async (email, field) => {
      t.browser.document = "document-two";
      return read(email, field);
    };
    expect(await gate(password(reader))).toBe("fast-chrome-private-document-changed");
    expect(t.browser.methods()).not.toContain("privateFill");
  });

  it("does not fill after a URL change during the vault read", async () => {
    const reader: PrivateSource = async (email, field) => {
      t.browser.url = URL.replace("/login", "/other");
      return read(email, field);
    };
    expect(await gate(password(reader))).toBe("fast-chrome-private-url-changed");
    expect(t.browser.methods()).not.toContain("privateFill");
  });

  it("never retries or reflects an unknown submit", async () => {
    t.browser.submitError = new Error(PASSWORD);
    const result = await password();
    expect(result.outcome).toBe("unknown");
    expect(exposure(result)).not.toContain(PASSWORD);
    expect(await gate(password())).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(await gate(otp())).toBe("fast-chrome-private-account-not-bound");
    expect(t.reads).toHaveLength(1);
  });

  it("requires the account binding for an OTP and runs it only once", async () => {
    expect(await gate(otp())).toBe("fast-chrome-private-account-not-bound");
    expect(t.reads).toEqual([]);
    await password();
    const result = await otp();
    expect(result.outcome).toBe("filled");
    expect(t.browser.methods().filter((method) => method === "submitPrivate")).toHaveLength(1);
    expect(await gate(otp())).toBe("fast-chrome-private-step-already-attempted");
    expect(t.reads).toHaveLength(2);
  });

  it("rejects an old extension without the exact-URL contract", async () => {
    const original = t.browser.call.bind(t.browser);
    t.browser.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "observeDocument") delete (result as Record<string, unknown>).url;
      return result;
    };
    expect(await gate(password())).toBe("fast-chrome-private-url-binding-unavailable");
    expect(t.reads).toEqual([]);
  });

  it("binds the original submit before the vault read without reauthorizing by label", async () => {
    const reader: PrivateSource = async (email, field) => {
      expect(t.browser.calls[t.browser.calls.length - 1][0]).toBe("preparePrivateSubmit");
      return read(email, field);
    };
    expect((await password(reader)).outcome).toBe("submitted");
    expect(t.browser.calls.filter(([method]) => method === "preparePrivateSubmit").map(([, args]) => args))
      .toEqual([{ tabId: 1, snapshot: "extension-snapshot", actionId: "submit" }]);
    expect(t.browser.methods()).not.toContain("observePage");
    expect(t.browser.calls.filter(([method]) => method === "submitPrivate").map(([, args]) => args))
      .toEqual([{ tabId: 1, submitToken: "submit-token", documentId: "document-one" }]);
  });

  it("does not reauthorize a same-label replacement during the vault read", async () => {
    const reader: PrivateSource = async (email, field) => {
      t.browser.replaced.add("submit");
      t.browser.actions = [{ id: "replacement-submit", kind: "click", label: "Sign in", role: "button", disabled: false }];
      return read(email, field);
    };
    expect(await password(reader)).toEqual({ outcome: "unknown", tab_id: "1", retry: false });
    const methods = t.browser.methods();
    expect(methods).not.toContain("observePage");
    expect(methods.filter((method) => method === "preparePrivateSubmit")).toHaveLength(1);
    expect(methods.filter((method) => method === "submitPrivate")).toHaveLength(1);
  });

  it("refuses an invalid submit capability before the vault read", async () => {
    const valid = { status: "prepared", submitToken: "submit-token", documentId: "document-one", expiresInMs: 90000 };
    const { submitToken: _unused, ...withoutToken } = valid;
    const invalid: unknown[] = [
      { ...valid, status: "not-executed" }, withoutToken, { ...valid, documentId: "document-two" },
      ...[0, -1, 120001, 1.5, true, "90000"].map((lifetime) => ({ ...valid, expiresInMs: lifetime }))
    ];
    for (const prepared of invalid) {
      setUp();
      t.browser.prepareResult = prepared;
      expect(await gate(password()), JSON.stringify(prepared)).toBe("fast-chrome-private-submit-not-prepared");
      expect(t.reads).toEqual([]);
      expect(t.tab.snapshot).toBeNull();
      expect(t.browser.methods()).not.toContain("privateFill");
    }
  });

  it("refuses an expired submit capability before the private fill", async () => {
    const cases: [number | null, number, string | null][] = [[90000, 84, "submitted"], [90000, 86, null], [null, 24, "submitted"], [null, 26, null]];
    for (const [lifetime, elapsed, outcome] of cases) {
      setUp();
      t.browser.submitLifetime = lifetime;
      clock.now = 1000;
      const reader: PrivateSource = async (email, field) => {
        clock.now = (clock.now as number) + elapsed;
        return read(email, field);
      };
      if (outcome) {
        expect((await password(reader)).outcome, `${lifetime} ${elapsed}`).toBe(outcome);
        continue;
      }
      expect(await gate(password(reader)), `${lifetime} ${elapsed}`).toBe("fast-chrome-private-submit-expired");
      expect(t.browser.methods().some((method) => method === "privateFill" || method === "submitPrivate")).toBe(false);
      expect(t.tab.privateAttempts.size).toBe(0);
    }
  });

  it("treats an unknown private fill as one use and never submits", async () => {
    t.browser.fillResult = { status: "not-filled-or-unknown", debug: PASSWORD };
    const result = await password();
    expect(result.outcome).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(t.browser.methods()).not.toContain("submitPrivate");
    expect(t.tab.privateAttempts.has("document-one\u0000password")).toBe(true);
  });

  it("refuses a cross-document OTP before the source read", async () => {
    await password();
    t.browser.document = "new-document";
    expect(await gate(otp())).toBe("fast-chrome-private-account-not-bound");
    expect(t.reads).toHaveLength(1);
  });

  it("reports a host protocol not-ready fill as a known no-fill", async () => {
    t.browser.fillResult = { status: "not-ready" };
    expect((await password()).outcome).toBe("not_filled");
    expect(t.browser.methods()).not.toContain("submitPrivate");
  });

  it("sends no private input after shutdown begins during the vault read", async () => {
    for (const [field, secret] of [["password", PASSWORD], ["one-time password", OTP]] as const) {
      setUp();
      let transfer = password;
      if (field === "one-time password") {
        await password(); // binds the account for the OTP step
        transfer = otp;
      }
      const calls = t.browser.calls.length;
      expect(await gate(transfer(stoppingReader)), field).toBe("fast-chrome-shutting-down");
      const methods = t.browser.methods(calls);
      expect(methods).not.toContain("privateFill");
      expect(methods).not.toContain("submitPrivate");
      expect(t.tab.privateAttempts.has(`document-one\u0000${field}`)).toBe(false);
      expect(JSON.stringify(t.browser.calls.slice(calls))).not.toContain(secret);
      expect(t.browser.calls.slice(t.readAt)).toEqual([]); // not even a readback follows the read
    }
  });

  it("ends the OTP field wait at shutdown before another read", async () => {
    await password(); // binds the account for the OTP step
    t.browser.fieldsPresent = false; // the OTP field has not appeared, so the step would poll for 10 s
    stoppingOn("observeDocument");
    const calls = t.browser.calls.length;
    expect(await gate(otp())).toBe("fast-chrome-shutting-down");
    expect(t.browser.methods(calls)).toEqual(["getTabs", "observeDocument"]);
    expect(t.reads).toHaveLength(1);
  });

  it("sends and consumes nothing when shutdown begins before the submit is prepared", async () => {
    stoppingOn("observeDocument");
    expect(await gate(password())).toBe("fast-chrome-shutting-down");
    expect(t.browser.methods()).toEqual(["getTabs", "observeDocument"]);
    expect(t.reads).toEqual([]);
    expect(t.tab.snapshot).toEqual(["public-snapshot", "extension-snapshot"]);
    expect(t.tab.privateAttempts.size).toBe(0);
  });

  it("reports shutdown during the private fill as unknown and never submits", async () => {
    const original = t.browser.call.bind(t.browser);
    t.browser.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "privateFill") t.stopping = true; // shutdown begins while privateFill is in flight
      return result;
    };
    const result = await password();
    expect(result).toEqual({ outcome: "unknown", tab_id: "1", retry: false });
    const methods = t.browser.methods();
    expect(methods.filter((method) => method === "privateFill")).toHaveLength(1);
    expect(methods).not.toContain("submitPrivate");
    expect(t.tab.privateAttempts.has("document-one\u0000password")).toBe(true);
    expect(t.tab.privateIdentity).toBeNull();
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    t.stopping = false;
    expect(await gate(password())).toBe("fast-chrome-snapshot-consumed-or-expired");
    expect(t.reads).toHaveLength(1);
  });

  it("refuses before any private dispatch when the extension will not bind the submit", async () => {
    t.browser.prepareResult = { status: "not-executed", reason: "stale", retry: false };
    expect(await gate(password())).toBe("fast-chrome-private-submit-not-prepared");
    expect(t.reads).toEqual([]);
    expect(t.browser.methods()).not.toContain("privateFill");
  });
});

describe("tab ownership without the account-pool lease (C6)", () => {
  const steps = ["password", "one-time password"] as const;
  it.each(steps)("refuses a %s transfer from a session that does not own the tab before any page call or vault read", async (field) => {
    if (field === "one-time password") {
      await password(); // the owner binds the account and document
      t.browser.calls = [];
    }
    const snapshot = t.tab.snapshot;
    const attempts = new Set(t.tab.privateAttempts);
    const transfer = field === "password" ? password : otp;
    expect(await gate(transfer(read, { session: "ses_other" }))).toBe("fast-chrome-tab-not-owned");
    expect(t.browser.calls).toEqual([]);
    expect(t.reads).toHaveLength(field === "password" ? 0 : 1);
    expect(t.tab.snapshot).toBe(snapshot);
    expect(t.tab.privateAttempts).toEqual(attempts);
  });

  const sessions: [string, unknown][] = [["an empty", ""], ["a missing", undefined], ["a non-string", 1]];
  it.each(sessions)("refuses %s caller session", async (_name, session) => {
    expect(await gate(password(read, { session: session as string }))).toBe("fast-chrome-tab-not-owned");
    expect(t.browser.calls).toEqual([]);
    expect(t.reads).toEqual([]);
  });

  it("checks ownership before request validation, so a foreign session learns nothing about the request", async () => {
    expect(await gate(password(read, { session: "ses_other", email: "not an email" }))).toBe("fast-chrome-tab-not-owned");
    t.tab.recording = {};
    expect(await gate(password(read, { session: "ses_other" }))).toBe("fast-chrome-tab-not-owned");
    expect(t.browser.calls).toEqual([]);
  });

  it("transfers for the owning session with any account and no lease", async () => {
    const body = request("password", { email: "tester@example.test" });
    expect("leaseId" in body).toBe(false);
    const result = await paste(t.tab, body, read, refuse, t.env);
    expect(result).toEqual({ outcome: "submitted", tab_id: "1", field: "password", retry: false });
    expect(t.reads).toEqual([["tester@example.test", "password"]]);
  });
});

describe("request checks and the loopback exception", () => {
  it.each([
    ["an unsupported field", { field: "username" }],
    ["an email without @", { email: "synthetic.example.test" }],
    ["an email with two @", { email: "a@b@example.test" }],
    ["an email with Python whitespace", { email: "synthetic\u001f@example.test" }],
    ["an email with a long local part", { email: `${"a".repeat(201)}@example.test` }],
    ["an empty selector", { selector: "" }],
    ["a selector over 1024 code points", { selector: "𝐱".repeat(1025) }]
  ])("refuses %s before any page call", async (_name, overrides) => {
    expect(await gate(password(read, overrides as Partial<PasteRequest>))).toBe("fast-chrome-invalid-private-request");
    expect(t.browser.calls).toEqual([]);
  });

  it("accepts a selector of exactly 1024 code points", async () => {
    expect((await password(read, { selector: "𝐱".repeat(1024) })).outcome).toBe("submitted");
  });

  it("requires the password step's username selector, snapshot and submit action", async () => {
    for (const overrides of [{ usernameSelector: null }, { usernameSelector: "input[type=password]" }, { snapshotId: "" }, { submitActionId: null }]) {
      setUp();
      expect(await gate(password(read, overrides)), JSON.stringify(overrides)).toBe("fast-chrome-password-submit-required");
    }
    setUp();
    expect(await gate(password(read, { submitActionId: "missing" }))).toBe("fast-chrome-action-unavailable");
    expect(t.browser.calls).toEqual([]);
  });

  it("refuses submit controls on an OTP step, which auto-submits", async () => {
    await password();
    expect(await gate(otp(read, { snapshotId: "public-snapshot" }))).toBe("fast-chrome-otp-auto-submits");
  });

  it("refuses an invalid source value before any readback", async () => {
    for (const value of ["", "x".repeat(16385)]) {
      setUp();
      const calls = () => t.browser.calls.length;
      let at = -1;
      expect(await gate(password(async () => { at = calls(); return value; }))).toBe("fast-chrome-private-source-invalid");
      expect(t.browser.calls.slice(at)).toEqual([]);
    }
    setUp();
    await password();
    expect(await gate(otp(async () => "12345a"))).toBe("fast-chrome-private-source-invalid");
    expect(t.browser.methods().filter((method) => method === "privateFill")).toHaveLength(1);
  });

  it("allows insecure loopback only with FAST_CHROME_ALLOW_LOOPBACK=1 on http loopback", async () => {
    const loopback = (url: string, env: Record<string, string | undefined>) => {
      setUp();
      t.env = env;
      t.browser.url = url;
      (t.tab as { origin: string }).origin = url.replace(/\/login$/, "");
      return password(read, { expectedUrl: url }).then(() => t.browser.calls
        .filter(([method]) => method === "observeDocument").map(([, args]) => args.allowInsecureLoopback));
    };
    expect(await loopback("http://127.0.0.1:8080/login", { FAST_CHROME_ALLOW_LOOPBACK: "1" })).toEqual([true, true]);
    expect(await loopback("http://localhost:8080/login", { FAST_CHROME_ALLOW_LOOPBACK: "1" })).toEqual([true, true]);
    expect(await loopback("http://127.0.0.1:8080/login", {})).toEqual([false, false]);
    expect(await loopback("http://127.0.0.1:8080/login", { FAST_CHROME_ALLOW_LOOPBACK: "true" })).toEqual([false, false]);
    expect(await loopback("https://127.0.0.1:8080/login", { FAST_CHROME_ALLOW_LOOPBACK: "1" })).toEqual([false, false]);
    expect(await loopback("http://10.0.0.1/login", { FAST_CHROME_ALLOW_LOOPBACK: "1" })).toEqual([false, false]);
  });

  it("polls a missing OTP field, then fills once it appears", async () => {
    await password();
    t.browser.fieldsPresent = false;
    setTimeout(() => { t.browser.fieldsPresent = true; }, 250);
    const calls = t.browser.calls.length;
    expect((await otp()).outcome).toBe("filled");
    const methods = t.browser.methods(calls);
    expect(methods.filter((method) => method === "observeDocument").length).toBeGreaterThanOrEqual(3);
    expect(methods.filter((method) => method === "privateFill")).toHaveLength(1);
  });

  it("does not wait for a missing password field", async () => {
    t.browser.fieldsPresent = false;
    expect(await gate(password())).toBe("browser-control-private-fields-unavailable");
    expect(t.browser.methods()).toEqual(["getTabs", "observeDocument"]);
    expect(t.reads).toEqual([]);
  });
});
