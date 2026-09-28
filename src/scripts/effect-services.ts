import childProcess from "node:child_process";
import fs from "node:fs";
import { Context, Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

// Reads, process calls and output only: the one script that writes files, install-native-host.ts, writes through
// the trusted-path rule itself rather than through this service.
export type ScriptIoService = {
  exists: (file: string) => Effect.Effect<boolean, never>;
  readText: (file: string) => Effect.Effect<string, Error>;
  readdir: (dir: string) => Effect.Effect<string[], Error>;
  execFile: (command: string, args: string[], options?: childProcess.ExecFileSyncOptionsWithStringEncoding) => Effect.Effect<string, Error>;
  execFileInherit: (command: string, args: string[]) => Effect.Effect<void, Error>;
  stdout: (text: string) => Effect.Effect<void, never>;
  stderr: (text: string) => Effect.Effect<void, never>;
};

export class ScriptIo extends Context.Tag("opzero/ScriptIo")<ScriptIo, ScriptIoService>() {}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}

export const ScriptIoLive = Layer.succeed(ScriptIo, {
  exists: (file: string) => Effect.sync(() => fs.existsSync(file)),
  readText: (file: string) => Effect.try({ try: () => fs.readFileSync(file, "utf8"), catch: toError }),
  readdir: (dir: string) => Effect.try({ try: () => fs.readdirSync(dir), catch: toError }),
  execFile: (command: string, args: string[], options?: childProcess.ExecFileSyncOptionsWithStringEncoding) =>
    Effect.try({ try: () => String(childProcess.execFileSync(command, args, options)), catch: toError }),
  execFileInherit: (command: string, args: string[]) =>
    Effect.try({ try: () => { childProcess.execFileSync(command, args, { stdio: "inherit" }); }, catch: toError }),
  stdout: (text: string) => Effect.sync(() => { process.stdout.write(text); }),
  stderr: (text: string) => Effect.sync(() => { process.stderr.write(text); })
});

export function runScript<A>(program: Effect.Effect<A, Error, ScriptIo>) {
  NodeRuntime.runMain(Effect.provide(program, ScriptIoLive));
}

export function argValue(name: string, fallback?: string | null) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1];
  return fallback || null;
}
