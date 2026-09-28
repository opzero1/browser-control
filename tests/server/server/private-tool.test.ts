// test_private_tool.py -> paste_1password_field: ownership, the busy flag and the exact origin are checked
// before the private transfer runs; only fixed statuses leave it; the foreground permission reaches the vault
// read only when enabled. Synthetic values only; the vault and the transfer are replaced.
import { afterEach, describe, expect, it, vi } from "vitest";
import { origin } from "../../../src/server/page";
import { VaultError } from "../../../src/server/private/onepassword";
import type { Tab } from "../../../src/server/tabs";
import { removeTempRoots } from "../support/temp";
import { FakeConnection, fixture, meta, refusal, type Fixture } from "./helpers";

afterEach(() => removeTempRoots());

const URL = "https://deploy-preview-1664--app.example.test/login";

function setup(): { f: Fixture; tab: Tab; paste: ReturnType<typeof vi.fn> } {
  const f = fixture();
  const tab = f.server.newTab("ses_owner", new FakeConnection(), 1, origin(URL, {}), false);
  f.server.registry.tabs.set("1", tab);
  const paste = vi.fn(async () => ({}));
  f.server.paste = paste;
  return { f, tab, paste };
}

function transfer(f: Fixture, owner = "ses_owner", url = URL, extra: Record<string, unknown> = {}) {
  return f.server.paste1PasswordField({
    tab_id: "1", expected_url: url, expected_email: "synthetic@example.test", field: "password", selector: "#password",
    username_selector: "#email", snapshot_id: "snapshot", submit_action_id: "submit", ...extra
  }, meta(owner, "sessionID"));
}

describe("paste_1password_field", () => {
  it("keeps a foreign owner from reaching the source", async () => {
    const { f, paste } = setup();
    expect(await refusal(transfer(f, "ses_other"))).toBe("fast-chrome-tab-not-owned");
    expect(paste).not.toHaveBeenCalled();
  });

  it("refuses a concurrent transfer on a busy tab", async () => {
    const { f, tab, paste } = setup();
    tab.operation.tryAcquire();
    expect(await refusal(transfer(f))).toBe("fast-chrome-tab-busy");
    expect(paste).not.toHaveBeenCalled();
  });

  it("refuses another origin before the source", async () => {
    const { f, paste } = setup();
    expect(await refusal(transfer(f, "ses_owner", URL.replace("1664", "1665")))).toBe("fast-chrome-origin-change-refused");
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([[new VaultError("vault-locked"), "blocked"], [new Error("synthetic-secret"), "unknown"]])(
    "lets only fixed errors escape (%s)", async (failure, expected) => {
      const { f, tab } = setup();
      f.server.paste = async () => { throw failure; };
      const result = await transfer(f);
      expect(result.outcome).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(result).toEqual(expected === "blocked"
        ? { outcome: "blocked", tab_id: "1", reason: "vault-locked", retry: false }
        : { outcome: "unknown", tab_id: "1", reason: "private-transfer-unconfirmed", retry: false });
      expect(tab.operation.tryAcquire()).toBe(true);
      tab.operation.release();
    });

  it.each([false, true])("passes the foreground permission to the private source only when enabled (%s)", async (allowed) => {
    const { f } = setup();
    const source = vi.fn(async () => "synthetic-private-value");
    f.server.readField = source;
    f.server.paste = async (_tab, request, read) => {
      await read("synthetic@example.test", "password");
      expect(request).not.toHaveProperty("leaseId");
      return { outcome: "submitted" };
    };
    const result = await transfer(f, "ses_owner", URL, { allow_foreground_search: allowed });
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith("synthetic@example.test", "password", ...(allowed ? [{ allow_foreground_search: true }] : []));
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  });

  it("passes the caller's session and public request to the transfer, with no lease (C6, Q2)", async () => {
    const { f, tab, paste } = setup();
    await transfer(f);
    expect(paste).toHaveBeenCalledTimes(1);
    const [held, request, , refuse] = paste.mock.calls[0] as unknown as [Tab, Record<string, unknown>, unknown, () => void];
    expect(held).toBe(tab);
    expect(request).toEqual({
      session: "ses_owner", expectedUrl: URL, email: "synthetic@example.test", field: "password", selector: "#password",
      usernameSelector: "#email", snapshotId: "snapshot", submitActionId: "submit"
    });
    f.shutdown.begin();
    expect(refuse).toThrow("fast-chrome-shutting-down");
  });
});
