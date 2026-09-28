// Subprocess helper for pool tests. Every mode reads its state root from BROWSER_CONTROL_STATE_DIR and the
// Public Suffix List from BROWSER_CONTROL_TEST_PSL (the bundle cannot locate the package's data directory).
//   call <function> <json>       operate, claim, release or leaseFor; prints the JSON result or {"error": code}
//   begin <controller> <owner> <lease|-> [site] [exit|kill]
//                                Pin.open then beginTab without confirming; prints the result, then exits
//                                (default) or waits for SIGKILL
//   hold <controller> <owner> <lease|-> <barrier>
//                                Pin.open, print {"held": true} (or the error), hold until the barrier exists
//   reaper <table> <paused> <go> <pause|run|dry-run>
//                                reap isolated-1 with Chrome processes kept in a shared JSON table
//   ensure <table> <site>        ensure a shared lease with a runtime whose Chrome exists only in the table
//   cli <args...>                runPoolCommand, exiting with its code
import fs from "node:fs";
import { Gate } from "../../../src/server/gate";
import { runPoolCommand } from "../../../src/server/pool/operator";
import { claim, leaseFor, operate, Pin, poolContext, reap, release, type ReapHost } from "../../../src/server/pool/registry";
import { ensure, type StartRuntime } from "../../../src/server/pool/start";
import { usePublicSuffixListForTesting } from "../../../src/server/sites";
import { sleep } from "../../../src/server/time";

if (process.env.BROWSER_CONTROL_TEST_PSL) usePublicSuffixListForTesting(process.env.BROWSER_CONTROL_TEST_PSL);
const ctx = poolContext(process.env);

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function guarded(body: () => Promise<unknown>): Promise<unknown> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Gate) return { error: error.code };
    throw error;
  }
}

function lease(value: string): string | null {
  return value === "-" ? null : value;
}

async function call([name, json]: string[]) {
  const args = JSON.parse(json) as Record<string, unknown>;
  const functions: Record<string, () => Promise<unknown>> = {
    operate: () => operate(args.command as string, { controller: args.controller as string | undefined, owner: args.owner, lease: args.lease, ctx }),
    claim: () => claim(args.owner as string, { site: args.site as string | undefined, exclusive: args.exclusive as boolean | undefined, controller: args.controller as string | undefined, ctx }),
    release: () => release(args.owner as string, args.lease_id, ctx),
    leaseFor: () => leaseFor(args.owner as string, ctx)
  };
  print(await guarded(functions[name]));
}

async function begin([controller, owner, leaseId, site, ending]: string[]) {
  print(await guarded(async () => {
    const pin = await Pin.open(controller, owner, lease(leaseId), ctx);
    return pin.beginTab(site && site !== "-" ? site : null);
  }));
  if (ending === "kill") setInterval(() => undefined, 1000);
  else process.exit(0);
}

async function hold([controller, owner, leaseId, barrier]: string[]) {
  let pin: Pin;
  try {
    pin = await Pin.open(controller, owner, lease(leaseId), ctx);
  } catch (error) {
    if (!(error instanceof Gate)) throw error;
    print({ error: error.code });
    return;
  }
  print({ held: true });
  while (!fs.existsSync(barrier)) await sleep(10);
  pin.close();
}

function readTable(table: string): number[] {
  return JSON.parse(fs.readFileSync(table, "utf8")) as number[];
}

async function reaper([table, paused, go, mode]: string[]) {
  const terminated: number[] = [];
  // Chrome processes live in a shared table, so a Chrome started by another process is visible here.
  const host: ReapHost = {
    async processes() {
      return readTable(table);
    },
    async userTabs() {
      if (mode === "pause") {
        fs.writeFileSync(paused, "");
        while (!fs.existsSync(go)) await sleep(10);
      }
      return [];
    },
    terminate(pid) {
      terminated.push(pid);
      fs.writeFileSync(table, JSON.stringify(readTable(table).filter((item) => item !== pid)));
    },
    alive(pid) {
      return readTable(table).includes(pid);
    }
  };
  const result = await guarded(() => reap("isolated-1", { ctx, host, waitSeconds: 2, dryRun: mode === "dry-run" }));
  print({ ...(result as object), terminated });
}

async function ensureMode([table, site]: string[]) {
  // A Chrome for Testing that exists only in the shared process table.
  const runtime: StartRuntime = {
    provision() {},
    prepare() {},
    processes: () => readTable(table),
    probe: () => readTable(table).length > 0,
    configure: () => ({}),
    launch() {
      fs.writeFileSync(table, JSON.stringify([...readTable(table), 5000]));
    },
    windows: (pid) => [{ pid, window_id: 1, bounds: { width: 800, height: 600 } }]
  };
  print(await guarded(() => ensure(null, "ses_new", { ctx, runtime, exclusive: false, site })));
}

async function cli(args: string[]) {
  const code = await runPoolCommand(args, { stdout: process.stdout, stderr: process.stderr, env: process.env });
  process.stdout.write("", () => process.exit(code));
}

const [mode, ...rest] = process.argv.slice(2);
const modes: Record<string, (args: string[]) => Promise<void>> = { call, begin, hold, reaper, ensure: ensureMode, cli };
if (!modes[mode]) process.exit(2);
modes[mode](rest).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(3);
});
