import { expect, it, vi } from "vitest";
import { background } from "../support/background";

const reconnectAlarm = { name: "native-transport-reconnect:com.opzero.chrome" };

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
  expect(resumed.status.state).toBe("connected");
  expect(restarted.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);
  expect(restarted.storage.NATIVE_HOST_PAUSED).toBe(false);
});

it("reloads the native host on a fresh port and reconnects after the host exits", async () => {
  const b = await background();
  const owner = { session_id: "owner", turn_id: "turn", tabId: 1, expectedOrigin: "https://synthetic.invalid" };
  await b.rpc("createTab", owner);
  expect((await b.rpc("bindPage", owner)).error).toBeUndefined();

  const reloaded = await b.popup("RELOAD_NATIVE_HOST");
  expect(reloaded.status.state).toBe("connected");
  expect(b.port.disconnect).toHaveBeenCalledTimes(1);
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
  expect(b.storage.NATIVE_HOST_PAUSED).toBe(false);
  expect((await b.rpc("bindPage", owner)).error).toBeDefined();

  b.port.onDisconnect.emit();
  await vi.waitFor(() => expect((b.storage.NATIVE_HOST_STATUS as { state: string }).state).toBe("disconnected"));
  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(3);
  await vi.waitFor(() => expect((b.storage.NATIVE_HOST_STATUS as { state: string }).state).toBe("connected"));
});
