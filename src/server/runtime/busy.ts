import { monotonic } from "../time";

/**
 * A tab's busy flag, the port of its threading.Lock. tryAcquire is synchronous, so a lookup that takes the
 * flag is one run-to-completion step. Waiters are served in order when the holder releases.
 */
export class BusyFlag {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  get busy(): boolean {
    return this.held;
  }

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  release(): void {
    if (!this.held) throw new Error("BusyFlag released while free");
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }

  /** Wait for the flag until a monotonic deadline (seconds); false when the deadline passes first. */
  acquireBy(deadline: number): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    const remaining = deadline - monotonic();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      // Timers run on the loop's millisecond clock and can fire just before the monotonic deadline; re-arm then.
      const expire = () => {
        const left = deadline - monotonic();
        if (left > 0) {
          timer = setTimeout(expire, Math.max(1, left * 1000));
          return;
        }
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      };
      timer = setTimeout(expire, remaining * 1000);
      this.waiters.push(grant);
    });
  }
}
