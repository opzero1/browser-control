/** A FIFO async mutex with a bounded wait, like threading.Lock.acquire(timeout=...). */
export class AsyncMutex {
  private locked = false;
  private readonly queue: Array<(release: () => void) => void> = [];

  /** Resolves with a one-shot release function, or null when `timeoutMs` passes first. */
  acquire(timeoutMs: number): Promise<(() => void) | null> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const grant = (release: () => void) => {
        clearTimeout(timer);
        resolve(release);
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.queue.push(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(this.releaser());
      else this.locked = false;
    };
  }
}
