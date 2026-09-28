import { performance } from "node:perf_hooks";

/** Seconds on a monotonic clock, like Python's time.monotonic(). */
export function monotonic(): number {
  return performance.now() / 1000;
}

/** Resolves after `ms`, or early (without rejecting) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The exact value of a finite double as mantissa * 2 ** exponent. */
function exactParts(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const sign = bits >> 63n ? -1n : 1n;
  if (biased === 0) return { mantissa: sign * fraction, exponent: -1074 };
  return { mantissa: sign * (fraction | (1n << 52n)), exponent: biased - 1075 };
}

/**
 * Python round(value, digits) for a float: round the exact binary value half-to-even at `digits` decimals,
 * then return the nearest double. digits must be a non-negative integer.
 */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0) return value;
  const { mantissa, exponent } = exactParts(value);
  if (exponent >= 0) return value;
  const negative = mantissa < 0n;
  const numerator = (negative ? -mantissa : mantissa) * 10n ** BigInt(digits);
  const denominator = 1n << BigInt(-exponent);
  let quotient = numerator / denominator;
  const twice = 2n * (numerator % denominator);
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const result = Number(`${quotient}e-${digits}`);
  return negative ? -result : result;
}

/** time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) */
export function utcStamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
