// Secret canaries for the private slice: capture everything the process writes and render results and errors
// the way a caller, a log or a snapshot could see them, so a test can assert a synthetic secret never appears.
import { vi } from "vitest";

export interface Watch { text(): string; restore(): void }

/** Record process.stdout, process.stderr and console output until restore(). Output still passes through. */
export function watchOutput(): Watch {
  const chunks: string[] = [];
  const record = (chunk: unknown) => chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { record(chunk); return true; }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { record(chunk); return true; }) as typeof process.stderr.write),
    ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => { record(args.map(exposure).join(" ")); }))
  ];
  return {
    text: () => chunks.join(""),
    restore: () => { for (const spy of spies) spy.mockRestore(); }
  };
}

/** Everything a value exposes: an error's name, message, stack, cause and own fields; any other value as JSON. */
export function exposure(value: unknown): string {
  if (value instanceof Error) {
    const fields = Object.fromEntries(Object.entries(value));
    return [value.name, value.message, value.stack ?? "", String(value), JSON.stringify(fields), value.cause === undefined ? "" : exposure(value.cause)].join("\n");
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item.values()];
    if (item instanceof Error) return exposure(item);
    return item;
  }) ?? String(value);
}

/** The settled outcome of a promise, as a value or an error. */
export async function settled<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}
