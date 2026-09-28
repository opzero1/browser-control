// runtime/shutdown.ts, runtime/busy.ts, runtime/mutex.ts and time.ts.
import { describe, expect, it } from "vitest";
import { Gate } from "../../../src/server/gate";
import { BusyFlag } from "../../../src/server/runtime/busy";
import { AsyncMutex } from "../../../src/server/runtime/mutex";
import { SHUTDOWN_SECONDS, Shutdown } from "../../../src/server/runtime/shutdown";
import { monotonic, pyRound, sleep, utcStamp } from "../../../src/server/time";

describe("shutdown", () => {
  it("starts once, fixes the deadline, refuses input and wakes waits", async () => {
    expect(SHUTDOWN_SECONDS).toBe(2.5);
    const shutdown = new Shutdown();
    expect(shutdown.isSet).toBe(false);
    expect(shutdown.deadline).toBeNull();
    expect(() => shutdown.refuseInput()).not.toThrow();
    const calls: string[] = [];
    const unsubscribe = shutdown.onBegin(() => calls.push("dropped"));
    unsubscribe();
    shutdown.onBegin(() => calls.push("begin"));
    shutdown.onBegin(() => { throw new Error("listener failure"); });
    const start = monotonic();
    const waiting = shutdown.wait(10000);
    shutdown.begin();
    await waiting;
    expect(monotonic() - start).toBeLessThan(0.5);
    const deadline = shutdown.deadline as number;
    expect(deadline - start).toBeGreaterThan(2.4);
    shutdown.begin();
    expect(shutdown.deadline).toBe(deadline);
    expect(calls).toEqual(["begin"]);
    expect(() => shutdown.refuseInput()).toThrow(Gate);
    expect(() => shutdown.refuseInput()).toThrow("fast-chrome-shutting-down");
    await shutdown.wait(10000);
    shutdown.onBegin(() => calls.push("late"));
    expect(calls).toEqual(["begin", "late"]);
  });

  it("waits the full time when shutdown never begins", async () => {
    const start = monotonic();
    await new Shutdown().wait(40);
    expect(monotonic() - start).toBeGreaterThanOrEqual(0.035);
  });
});

describe("busy flag", () => {
  it("takes the flag synchronously and serves waiters in order until their deadline", async () => {
    const flag = new BusyFlag();
    expect(flag.tryAcquire()).toBe(true);
    expect(flag.busy).toBe(true);
    expect(flag.tryAcquire()).toBe(false);
    const order: string[] = [];
    const first = flag.acquireBy(monotonic() + 1).then((ok) => { order.push(`first:${ok}`); return ok; });
    const second = flag.acquireBy(monotonic() + 1).then((ok) => { order.push(`second:${ok}`); return ok; });
    const late = flag.acquireBy(monotonic() + 0.03).then((ok) => { order.push(`late:${ok}`); return ok; });
    expect(await late).toBe(false);
    flag.release();
    expect(await first).toBe(true);
    flag.release();
    expect(await second).toBe(true);
    flag.release();
    expect(flag.busy).toBe(false);
    expect(order).toEqual(["late:false", "first:true", "second:true"]);
    expect(await flag.acquireBy(monotonic() - 1)).toBe(true);
    flag.release();
    expect(() => flag.release()).toThrow();
  });
});

describe("async mutex", () => {
  it("serializes in FIFO order and gives up after its timeout", async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire(10);
    expect(release).not.toBeNull();
    const order: number[] = [];
    const waiters = [1, 2, 3].map((index) => mutex.acquire(1000).then((next) => { order.push(index); return next; }));
    expect(await mutex.acquire(20)).toBeNull();
    release?.();
    release?.();
    for (const waiter of waiters) (await waiter)?.();
    expect(order).toEqual([1, 2, 3]);
    const again = await mutex.acquire(0);
    expect(again).not.toBeNull();
    again?.();
  });
});

describe("time helpers", () => {
  it("rounds like Python round()", () => {
    const cases: Array<[number, number, number]> = [
      [0.5, 0, 0], [1.5, 0, 2], [2.5, 0, 2], [-0.5, 0, -0], [-1.5, 0, -2], [2.675, 2, 2.67], [1.0005, 3, 1.0],
      [0.125, 2, 0.12], [0.375, 2, 0.38], [1.23456, 3, 1.235], [12.3445, 3, 12.345], [5e-324, 3, 0], [123.456, 0, 123]
    ];
    for (const [value, digits, expected] of cases) expect(pyRound(value, digits), `${value} ${digits}`).toBe(expected);
  });

  it("formats UTC stamps and sleeps until aborted", async () => {
    expect(utcStamp(new Date(Date.UTC(2026, 8, 28, 1, 2, 3, 456)))).toBe("2026-09-28T01:02:03Z");
    const controller = new AbortController();
    const start = monotonic();
    const sleeping = sleep(10000, controller.signal);
    controller.abort();
    await sleeping;
    expect(monotonic() - start).toBeLessThan(0.5);
  });
});
