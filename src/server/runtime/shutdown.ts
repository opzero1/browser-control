import { Gate } from "../gate";
import { monotonic } from "../time";

/**
 * OpenCode's MCP client closes stdin, sends SIGTERM 2 s later and SIGKILL 2 s after that. Cleanup therefore
 * ends SHUTDOWN_SECONDS after the first of stdin EOF or SIGTERM.
 */
export const SHUTDOWN_SECONDS = 2.5;

/** The one shutdown event. begin() is idempotent; the first call fixes the cleanup deadline. */
export class Shutdown {
  private started = false;
  private end: number | null = null;
  private readonly listeners = new Set<() => void>();
  readonly seconds: number;

  constructor(seconds = SHUTDOWN_SECONDS) {
    this.seconds = seconds;
  }

  get isSet(): boolean {
    return this.started;
  }

  /** Monotonic seconds at which cleanup ends; null before shutdown begins. */
  get deadline(): number | null {
    return this.end;
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.end = monotonic() + this.seconds;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener failure must not stop the others or the shutdown.
      }
    }
    this.listeners.clear();
  }

  /** Once shutdown begins, running bodies send no further input; a call already in flight settles. */
  refuseInput(): void {
    if (this.started) throw new Gate("fast-chrome-shutting-down");
  }

  /** Event.wait(timeout): resolves after `ms`, or as soon as shutdown begins. */
  wait(ms: number): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.listeners.add(done);
    });
  }

  /** Run `listener` when shutdown begins (immediately if it already has). Returns an unsubscribe function. */
  onBegin(listener: () => void): () => void {
    if (this.started) {
      listener();
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
