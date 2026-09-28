import { expect, it, vi } from "vitest";
import { background } from "../support/background";

const reconnectAlarm = { name: "native-transport-reconnect:com.opzero.chrome" };
const hostProbe = { jsonrpc: "2.0", id: "protocol:test", method: "getInfo", params: {} };

function hostState(b: Awaited<ReturnType<typeof background>>) {
  return (b.storage.NATIVE_HOST_STATUS as { state: string; error?: string } | undefined);
}

it("keeps the native host paused across reconnect alarms and worker restarts until resumed", async () => {
  const b = await background();
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);

  const paused = await b.popup("PAUSE_NATIVE_HOST");
  expect(paused.status.state).toBe("paused");
  expect(b.port.disconnect).toHaveBeenCalledTimes(1);
  expect(b.storage.NATIVE_HOST_PAUSED).toBe(true);
  expect(b.chrome.alarms.clear).toHaveBeenCalledWith(reconnectAlarm.name);

  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect((await b.popup("GET_NATIVE_HOST_STATUS")).status.state).toBe("paused");
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);

  const restarted = await background({ NATIVE_HOST_PAUSED: true });
  expect(restarted.chrome.runtime.connectNative).not.toHaveBeenCalled();
  expect((await restarted.popup("GET_NATIVE_HOST_STATUS")).status.state).toBe("paused");

  const resumed = await restarted.popup("RESUME_NATIVE_HOST");
  expect(resumed.status.state).toBe("connecting");
  expect(restarted.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);
  expect(restarted.storage.NATIVE_HOST_PAUSED).toBe(false);
  restarted.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(restarted)?.state).toBe("connected"));
});

it("reloads the native host on a fresh port and reconnects after the host exits", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  expect((await b.rpc("bindPage", owner)).error).toBeUndefined();

  const reloaded = await b.popup("RELOAD_NATIVE_HOST");
  expect(reloaded.status.state).toBe("connecting");
  expect(b.port.disconnect).toHaveBeenCalledTimes(1);
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
  expect(b.storage.NATIVE_HOST_PAUSED).toBe(false);
  expect((await b.rpc("bindPage", owner)).error).toBeDefined();
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));

  b.port.onDisconnect.emit();
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("disconnected"));
  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(3);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connecting"));
  b.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));
});

it("never reports a missing native host as connected", async () => {
  const b = await background();
  const states: string[] = [];
  const set = b.chrome.storage.local.set;
  b.chrome.storage.local.set = (value: Record<string, any>, cb: Function) => {
    if (value.NATIVE_HOST_STATUS) states.push(value.NATIVE_HOST_STATUS.state);
    set(value, cb);
  };
  const reloaded = await b.popup("RELOAD_NATIVE_HOST");
  expect(reloaded.status.state).toBe("connecting");
  (b.chrome.runtime as { lastError?: { message: string } }).lastError = { message: "Specified native messaging host not found." };
  b.port.onDisconnect.emit();
  await vi.waitFor(() => expect(hostState(b)).toMatchObject({ state: "disconnected", error: "Specified native messaging host not found." }));
  expect(states).not.toContain("connected");
});
