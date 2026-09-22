import { expect, it, vi } from "vitest";
import { background } from "../support/background";

it("preserves fixed refusal reasons across capture and recording", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  for (const reason of ["private-quarantine", "populated-private-input", "restored-private-selector", "invalid-private-selectors", "synthetic-secret"]) {
    b.chrome.scripting.executeScript.mockImplementation((_: unknown, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: { status: "checked", allowed: false, reason } }]));
    for (const method of ["capturePage", "recordingState"]) {
      expect((await b.rpc(method, { ...owner, active: true })).error.message).toBe(reason === "synthetic-secret" ? "Capture privacy check failed" : reason);
    }
  }
  expect(b.chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

it("captures and starts recording without an author shadow tree eligibility scan", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  await b.rpc("attach", owner);
  b.chrome.scripting.executeScript.mockImplementation((_: unknown, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: { status: "checked", allowed: true } }]));
  for (const shadowRootType of ["open", "closed"]) {
    b.chrome.debugger.sendCommand.mockImplementation((_: unknown, method: string, ___: unknown, cb: Function) => cb(method === "DOM.getDocument" ? { root: { children: [{ shadowRootType }] } } : { data: "synthetic-jpeg" }));
    for (const method of ["capturePage", "recordingState"]) {
      expect((await b.rpc(method, { ...owner, active: true })).error).toBeUndefined();
    }
    expect((await b.rpc("capturePage", owner)).result.data).toBe("synthetic-jpeg");
    expect((await b.rpc("recordingState", { ...owner, active: false })).error).toBeUndefined();
  }
  expect(b.chrome.debugger.sendCommand.mock.calls.some(call => call[1] === "DOM.getDocument")).toBe(false);
});

it("discards a screenshot when its document changes during capture", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  await b.rpc("attach", owner);
  let document = 0;
  b.chrome.scripting.executeScript.mockImplementation((_: unknown, cb: Function) => cb([{ documentId: `doc-${document++}`, frameId: 0, result: { status: "checked", allowed: true } }]));
  const response = await b.rpc("capturePage", owner);
  expect(response.error.message).toBe("Document changed during capture; image discarded");
  expect(response.result).toBeUndefined();
});

it("prioritizes persisted and legacy quarantine over embedded and shadow surfaces", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid", active: true };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  b.chrome.scripting.executeScript.mockImplementation((_: unknown, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: { status: "checked", allowed: true } }]));
  for (const quarantine of ["legacy-doc", { documentId: "doc-1", selectors: [] }]) {
    b.chrome.storage.local.set({ "PRIVATE_CAPTURE_QUARANTINE:1": quarantine }, () => {});
    for (const method of ["observePage", "capturePage", "recordingState"]) {
      expect((await b.rpc(method, owner)).error.message).toBe("private-quarantine");
    }
  }
  expect(b.chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

it("observes scoped DOM without invoking capture/CDP and carries restored selectors into the exact document", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner); await b.rpc("bindPage", owner);
  b.chrome.storage.local.set({ "PRIVATE_CAPTURE_QUARANTINE:1": { documentId: "old-doc", selectors: ["#restored"] } }, () => {});
  b.chrome.scripting.executeScript.mockImplementation((request: any, cb: Function) => cb([{ documentId: "new-doc", frameId: 0, result: request.args[0] === "document-check" ? { status: "checked" } : { status: "observed", partial: true, opaqueSurfaces: [{ id: "opaque-0", kind: "iframe" }] } }]));
  expect((await b.rpc("observePage", { ...owner, controlsOnly: true })).result.partial).toBe(true);
  expect(b.chrome.scripting.executeScript.mock.calls[1][0]).toMatchObject({ target: { tabId: 1, documentIds: ["new-doc"] }, args: ["observe", owner.expectedOrigin, expect.any(String), "", null, { selectors: ["#restored"], controlsOnly: true }] });
  expect(b.chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

it("rescans restored selectors on observation and action with no public quarantine bypass", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner); await b.rpc("bindPage", owner);
  b.chrome.scripting.executeScript.mockImplementation((request: any, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: request.args[0] === "document-check" ? { status: "checked" } : { status: "observed", snapshot: request.args[2] } }]));
  const snapshot = (await b.rpc("observePage", owner)).result.snapshot;
  b.chrome.storage.local.set({ "PRIVATE_CAPTURE_QUARANTINE:1": { documentId: "doc-1", selectors: [] } }, () => {});
  expect((await b.rpc("actPage", { ...owner, snapshot, actionId: "0" })).result.status).toBe("not-executed");
  expect((await b.rpc("actPage", { ...owner, snapshot, actionId: "0" })).result.status).toBe("not-executed");
  expect(b.chrome.scripting.executeScript.mock.calls.some(([r]: any) => r.args[0] === "act")).toBe(false);
});

it("creates an inactive tab without activating a window", async () => {
  const b = await background();
  const response = await b.rpc("createTab", { session_id: "owner", turn_id: "turn" });
  expect(response.error).toBeUndefined();
  expect(b.chrome.tabs.create.mock.calls[0][0].active).toBe(false);
});

it("advertises protocol v2 and gates profile reads after revocation", async () => {
  const b = await background();
  expect((await b.rpc("getInfo")).result.protocolVersion).toBe(2);
  expect((await b.rpc("getInfo")).result.pageProtocolVersion).toBe(2);
  const params = { session_id: "owner", turn_id: "turn" };
  await b.rpc("createTab", params);
  b.port.onMessage.emit({ jsonrpc: "2.0", method: "internal.releaseClient", params });
  expect((await b.rpc("getUserTabs", params)).error).toBeDefined();
  expect((await b.rpc("getUserHistory", params)).error).toBeDefined();
  expect(b.chrome.history.search).not.toHaveBeenCalled();
  expect((await b.rpc("constructor", params)).error.message).toContain("Unsupported browser command");
});

it("refuses non-TLS private observations except opted-in loopback", async () => {
  const b = await background();
  const params = { session_id: "owner", turn_id: "turn", tabId: 1, selectors: ["#password"] };
  await b.rpc("createTab", params);
  expect((await b.rpc("observeDocument", { ...params, expectedOrigin: "http://synthetic.invalid" })).error).toBeDefined();
  expect((await b.rpc("observeDocument", { ...params, expectedOrigin: "http://127.0.0.1" })).error).toBeDefined();
  expect(b.chrome.scripting.executeScript).not.toHaveBeenCalled();
  b.chrome.scripting.executeScript.mockImplementationOnce((_: unknown, cb: Function) => cb([{ documentId: "local-doc", frameId: 0, result: { status: "observed", origin: "http://127.0.0.1", url: "http://127.0.0.1/" } }]));
  expect((await b.rpc("observeDocument", { ...params, expectedOrigin: "http://127.0.0.1", allowInsecureLoopback: true })).result.documentId).toBe("local-doc");
  expect(b.chrome.scripting.executeScript.mock.calls[0][0].args[3]).toBe(true);
});

it("binds private observation to an exact same-origin URL and returns it", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  const expectedUrl = "https://synthetic.invalid/login?flow=private#step";
  b.chrome.scripting.executeScript.mockImplementationOnce((_: unknown, cb: Function) => cb([{ documentId: "url-doc", frameId: 0, result: { status: "observed", origin: owner.expectedOrigin, url: expectedUrl } }]));
  const response = await b.rpc("observeDocument", { ...owner, expectedUrl, selectors: ["#password"] });
  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({ origin: owner.expectedOrigin, url: expectedUrl, documentId: "url-doc" });
  expect(b.chrome.scripting.executeScript.mock.calls[0][0].args[4]).toBe(expectedUrl);

  expect((await b.rpc("observeDocument", { ...owner, expectedUrl: "https://synthetic.invalid/wrong", selectors: ["#password"] })).error).toBeDefined();
  expect((await b.rpc("observeDocument", { ...owner, expectedUrl: "https://different.invalid/login", selectors: ["#password"] })).error).toBeDefined();
});

it("cleans up a conflicting tab replacement without throwing or stealing ownership", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn" };
  const other = { session_id: "other", turn_id: "turn" };
  await b.rpc("createTab", owner); await b.rpc("createTab", other);
  expect(() => b.chrome.tabs.onReplaced.emit(2, 1)).not.toThrow();
  expect((await b.rpc("attach", { ...owner, tabId: 2 })).error).toBeDefined();
  expect((await b.rpc("attach", { ...other, tabId: 2 })).result.attached).toBe(true);
});

it("enforces exact ownership for tab commands and filtered target enumeration", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1 };
  await b.rpc("createTab", owner);
  expect((await b.rpc("attach", { ...owner, session_id: "other" })).error).toBeDefined();
  expect((await b.rpc("executeCdp", { ...owner, method: "Target.getTargets" })).result.targetInfos).toEqual([{ tabId: 1 }]);
  expect((await b.rpc("executeCdp", { ...owner, method: "Target.attachToTarget", commandParams: { targetId: "other" } })).error).toBeDefined();
});

it("consumes private observations once and targets a specific Chrome document", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  const observation = (await b.rpc("observeDocument", { ...owner, selectors: ["#password"] })).result;
  b.chrome.scripting.executeScript.mockImplementationOnce((_: unknown, cb: Function) => cb([{ documentId: "doc-1", frameId: 0, result: { status: "filled" } }]));
  const params = { ...owner, ...observation, values: ["synthetic"] };
  expect((await b.rpc("privateFill", params)).result.status).toBe("filled");
  expect(b.chrome.scripting.executeScript.mock.calls[1][0]).toMatchObject({ target: { tabId: 1, documentIds: ["doc-1"] }, world: "ISOLATED" });
  expect((await b.rpc("privateFill", params)).result.status).toBe("refused");
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
});

it("invalidates private observations on navigation and disconnection", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  await b.rpc("bindPage", owner);
  const observation = (await b.rpc("observeDocument", { ...owner, selectors: ["#password"] })).result;
  b.chrome.tabs.onUpdated.emit(1, { status: "loading" });
  expect((await b.rpc("privateFill", { ...owner, ...observation, values: ["synthetic"] })).result.status).toBe("refused");
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  b.port.onMessage.emit({ jsonrpc: "2.0", method: "internal.releaseClient", params: { session_id: "owner" } });
  expect((await b.rpc("attach", owner)).error).toBeDefined();
});

it("refuses private fill before an exact origin binding exists", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  const observation = (await b.rpc("observeDocument", { ...owner, selectors: ["#password"] })).result;
  expect((await b.rpc("privateFill", { ...owner, ...observation, values: ["synthetic"] })).result.status).toBe("refused");
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
});

it("refuses an observation made before binding to a different origin", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  const observation = (await b.rpc("observeDocument", { ...owner, selectors: ["#password"] })).result;
  await b.rpc("bindPage", { ...owner, expectedOrigin: "https://different.invalid" });
  expect((await b.rpc("privateFill", { ...owner, ...observation, values: ["synthetic"] })).result.status).toBe("refused");
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
});

it("serializes nested target.tabId private input behind a pending page observation", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner); await b.rpc("attach", owner); await b.rpc("bindPage", owner);
  const observation = (await b.rpc("observeDocument", { ...owner, selectors: ["#password"] })).result;
  b.chrome.scripting.executeScript.mockClear();
  let complete: Function | undefined;
  b.chrome.scripting.executeScript.mockImplementationOnce((_: unknown, cb: Function) => { complete = cb; });
  const read = b.rpc("observePage", owner);
  await vi.waitFor(() => expect(complete).toBeDefined());
  const fill = b.rpc("privateFill", { session_id: owner.session_id, turn_id: owner.turn_id, target: { tabId: 1 }, expectedOrigin: owner.expectedOrigin, ...observation, values: ["synthetic"] });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  complete!([{ documentId: "doc-1", frameId: 0, result: { status: "checked", allowed: true } }]);
  await read; await fill;
  expect(b.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
});

it("drops queued CDP actions after navigation rather than dispatching stale input", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1 };
  await b.rpc("createTab", owner); await b.rpc("attach", owner);
  let complete: Function | undefined;
  b.chrome.debugger.sendCommand.mockImplementationOnce((_: unknown, __: unknown, ___: unknown, cb: Function) => { complete = cb; });
  const first = b.rpc("executeCdp", { ...owner, method: "Runtime.evaluate", commandParams: { expression: "1" } });
  await vi.waitFor(() => expect(complete).toBeDefined());
  const second = b.rpc("executeCdp", { ...owner, method: "Input.insertText", commandParams: { text: "synthetic" } });
  await new Promise(resolve => setTimeout(resolve, 10));
  b.chrome.tabs.onUpdated.emit(1, { status: "loading" }); complete!({});
  await first;
  expect((await second).error).toBeDefined();
  expect(b.chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
});

it("never enumerates another session's tabs by omitting session_id", async () => {
  const b = await background();
  await b.rpc("createTab", { session_id: "owner", turn_id: "turn" });
  expect((await b.rpc("getTabs")).error).toBeDefined();
});

it("tags debugger events with the exact tab owner and drops unowned events", async () => {
  const b = await background();
  await b.rpc("createTab", { session_id: "owner", turn_id: "turn" });
  b.chrome.debugger.onEvent.emit({ tabId: 1 }, "Runtime.consoleAPICalled", { value: "synthetic" });
  b.chrome.debugger.onEvent.emit({ tabId: 999 }, "Runtime.consoleAPICalled", {});
  const events = b.responses.filter(r => r.method === "onCDPEvent");
  expect(events).toHaveLength(1);
  expect(events[0].params.session_id).toBe("owner");
});
