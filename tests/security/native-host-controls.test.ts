import { expect, it, vi } from "vitest";
import { background } from "../support/background";

const reconnectAlarm = { name: "native-transport-reconnect:com.opzero.chrome" };
const heartbeatAlarm = { name: "client-heartbeat-alarm" };
const hostProbe = { jsonrpc: "2.0", id: "protocol:test", method: "getInfo", params: {} };
const handshakeTimeoutMs = 15000;

type Harness = Awaited<ReturnType<typeof background>>;

function hostState(b: Harness) {
  return b.storage.NATIVE_HOST_STATUS as { state: string; error?: string } | undefined;
}

function capturingHandshake() {
  const handshakes: (() => void)[] = [];
  const timer = ((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === handshakeTimeoutMs) { handshakes.push(callback); return 0; }
    return setTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  return { handshakes, timer };
}

it("keeps the native host paused across reconnect alarms and worker restarts until resumed", async () => {
  const b = await background();
  expect(b.chrome.runtime.connectNative).toHaveBeenCalledTimes(1);

  const paused = await b.popup("PAUSE_NATIVE_HOST");
  expect(paused.status.state).toBe("paused");
  expect(b.ports[0].disconnect).toHaveBeenCalledTimes(1);
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
  expect(b.ports[0].disconnect).toHaveBeenCalledTimes(1);
  expect(b.ports).toHaveLength(2);
  expect(b.storage.NATIVE_HOST_PAUSED).toBe(false);
  expect((await b.rpc("bindPage", owner)).error).toBeDefined();
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));

  b.ports[0].onMessage.emit(hostProbe);
  b.ports[0].onDisconnect.emit();
  expect(hostState(b)?.state).toBe("connected");

  b.port.onDisconnect.emit();
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("disconnected"));
  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect(b.ports).toHaveLength(3);
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

it("drops a host that never answers and reconnects on the next alarm", async () => {
  const { handshakes, timer } = capturingHandshake();
  const b = await background({}, { setTimeout: timer });
  expect(handshakes).toHaveLength(1);
  expect(hostState(b)?.state).toBe("connecting");

  handshakes[0]();
  await vi.waitFor(() => expect(hostState(b)).toMatchObject({ state: "disconnected", error: "Native host did not respond" }));
  expect(b.ports[0].disconnect).toHaveBeenCalledTimes(1);

  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect(b.ports).toHaveLength(2);
  b.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));
  handshakes[1]();
  expect(hostState(b)?.state).toBe("connected");
  expect(b.ports[1].disconnect).not.toHaveBeenCalled();
});

it("replaces a host that stops answering the heartbeat", async () => {
  const b = await background();
  b.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));

  b.chrome.alarms.onAlarm.emit(heartbeatAlarm);
  const ping = await vi.waitFor(() => {
    const request = b.responses.find(message => message.method === "ping");
    expect(request).toBeDefined();
    return request;
  });
  b.port.onMessage.emit({ jsonrpc: "2.0", id: ping.id, error: { code: -32000, message: "Native heartbeat timed out" } });
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("disconnected"));
  expect(b.ports[0].disconnect).toHaveBeenCalledTimes(1);

  b.chrome.alarms.onAlarm.emit(reconnectAlarm);
  expect(b.ports).toHaveLength(2);
});

it("ignores a heartbeat that fails after the host was reloaded", async () => {
  const b = await background();
  b.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));

  b.chrome.alarms.onAlarm.emit(heartbeatAlarm);
  await vi.waitFor(() => expect(b.ports[0].sent.some((message: any) => message.method === "ping")).toBe(true));
  await b.popup("RELOAD_NATIVE_HOST");
  b.port.onMessage.emit(hostProbe);
  await vi.waitFor(() => expect(hostState(b)?.state).toBe("connected"));
  await new Promise(resolve => setTimeout(resolve, 50));

  expect(b.ports[1].sent.some((message: any) => message.method === "onControlStopped")).toBe(false);
  expect(b.ports[1].disconnect).not.toHaveBeenCalled();
  expect(hostState(b)?.state).toBe("connected");
});
