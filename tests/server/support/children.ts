import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { inject } from "vitest";

export interface Child {
  readonly process: ChildProcess;
  /** Resolves with the next stdout line. */
  line(timeoutMs?: number): Promise<string>;
  stderr(): string;
  /** Resolves with the exit code (or signal name) once the child exits. */
  exited: Promise<number | string>;
}

const running = new Set<ChildProcess>();

export function childPath(name: string): string {
  return path.join(inject("serverChildren"), `${name}.js`);
}

/** Start a bundled tests/server/support/<name>.ts child with Node. */
export function startChild(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): Child {
  const child = spawn(process.execPath, [childPath(name), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  running.add(child);
  let buffer = "";
  let errors = "";
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  const exited = new Promise<number | string>((resolve) => {
    child.on("exit", (code, signal) => {
      running.delete(child);
      resolve(code ?? signal ?? -1);
    });
  });
  return {
    process: child,
    exited,
    stderr: () => errors,
    line(timeoutMs = 5000) {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no line from ${name} within ${timeoutMs} ms; stderr: ${errors}`)), timeoutMs);
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    }
  };
}

export function killChildren(): void {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
}
