// `browser-control pool <status|claim|ensure|release|reap|reset>` (D15): browser_pool.main without `migrate`.
// The argument parser reproduces the argparse behavior of the Python CLI (checked against a captured corpus):
// unique long-option prefixes, `--opt=value`, `--`, negative-number values, the --exclusive/--shared group,
// and exit code 2 with "error: ..." on stderr.
import type { Env } from "../config";
import { Gate } from "../gate";
import { pyDumps } from "../pyjson";
import { pyStrip } from "../pystr";
import { controllerNumber, operate, poolContext, reap, reset } from "./registry";
import { ensure } from "./start";

const PROGRAM = "browser-control pool";

interface OptionSpec { flag: string; dest: string; kind: "value" | "true" | "false"; required?: boolean; type?: "float"; group?: string }
interface CommandSpec { positional?: { name: string; required: boolean }; options: OptionSpec[]; defaults: Record<string, unknown> }

const COMMANDS: Record<string, CommandSpec> = {
  status: { options: [], defaults: {} },
  claim: {
    positional: { name: "controller", required: false },
    options: [{ flag: "--owner", dest: "owner", kind: "value", required: true }],
    defaults: { controller: null, owner: null }
  },
  ensure: {
    positional: { name: "controller", required: false },
    options: [
      { flag: "--owner", dest: "owner", kind: "value", required: true },
      { flag: "--timeout", dest: "timeout", kind: "value", type: "float" },
      { flag: "--site", dest: "site", kind: "value" },
      { flag: "--exclusive", dest: "exclusive", kind: "true", group: "mode" },
      { flag: "--shared", dest: "exclusive", kind: "false", group: "mode" }
    ],
    defaults: { controller: null, owner: null, timeout: 30, site: null, exclusive: true }
  },
  release: {
    options: [{ flag: "--owner", dest: "owner", kind: "value", required: true }, { flag: "--lease", dest: "lease", kind: "value", required: true }],
    defaults: { owner: null, lease: null }
  },
  reap: {
    positional: { name: "controller", required: false },
    options: [{ flag: "--dry-run", dest: "dry_run", kind: "true" }],
    defaults: { controller: null, dry_run: false }
  },
  reset: {
    positional: { name: "controller", required: true },
    options: [{ flag: "--confirm", dest: "confirm", kind: "true" }],
    defaults: { controller: null, confirm: false }
  }
};

class UsageError extends Error {}
class HelpRequested extends Error {}

const HELP_FLAGS = ["-h", "--help"];

/** argparse's _negative_number_matcher: such strings are values, not options, in these parsers. */
function negativeNumber(arg: string): boolean {
  return /^-\d+$|^-\d*\.\d+$/.test(arg);
}

type Kind = { option: OptionSpec | "help"; explicit: string | null } | { ambiguous: string } | "positional" | "unknown" | "separator";

/** argparse's _parse_optional: an option (exact, `--name=value` or a unique `--` prefix), unknown, or positional. */
function classify(options: readonly OptionSpec[], arg: string): Kind {
  if (!arg.startsWith("-") || arg === "-") return "positional";
  const lookup = (name: string): OptionSpec | "help" | null => HELP_FLAGS.includes(name) ? "help" : options.find((option) => option.flag === name) ?? null;
  const exact = lookup(arg);
  if (exact) return { option: exact, explicit: null };
  const equals = arg.indexOf("=");
  if (equals >= 0) {
    const named = lookup(arg.slice(0, equals));
    if (named) return { option: named, explicit: arg.slice(equals + 1) };
  }
  if (arg.startsWith("--")) {
    const prefix = equals >= 0 ? arg.slice(0, equals) : arg;
    const flags = ["--help", ...options.map((option) => option.flag)].filter((flag) => flag.startsWith(prefix));
    // Raised only when the option is reached, as argparse does since 3.12.
    if (flags.length > 1) return { ambiguous: `ambiguous option: ${arg} could match ${flags.join(", ")}` };
    if (flags.length === 1) return { option: lookup(flags[0]) as OptionSpec | "help", explicit: equals >= 0 ? arg.slice(equals + 1) : null };
  }
  if (negativeNumber(arg) || arg.includes(" ")) return "positional";
  return "unknown";
}

/** Python float(): surrounding whitespace, `_` between digits, inf, infinity and nan in any case. */
function pyFloat(text: string): number | null {
  const value = pyStrip(text).toLowerCase();
  const special = /^([+-]?)(inf|infinity|nan)$/.exec(value);
  if (special) return special[2] === "nan" ? NaN : special[1] === "-" ? -Infinity : Infinity;
  const digits = String.raw`\d(?:_?\d)*`;
  const decimal = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:e[+-]?${digits})?$`);
  return decimal.test(value) ? Number(value.replaceAll("_", "")) : null;
}

function controllerArgument(value: string): string {
  try {
    controllerNumber(value);
  } catch {
    throw new UsageError("argument controller: expected isolated-1 to isolated-8");
  }
  return value;
}

function classifyAll(options: readonly OptionSpec[], argv: readonly string[]): Kind[] {
  const kinds: Kind[] = [];
  let literal = false;
  for (const arg of argv) {
    if (!literal && arg === "--") {
      literal = true;
      kinds.push("separator");
    } else {
      kinds.push(literal ? "positional" : classify(options, arg));
    }
  }
  return kinds;
}

function parseCommand(spec: CommandSpec, argv: readonly string[], extras: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = { ...spec.defaults };
  const kinds = classifyAll(spec.options, argv);
  const seen = new Set<OptionSpec>();
  let positionals = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const kind = kinds[i];
    if (kind === "separator") {
      // The first `--` belongs to the positional's span; without a positional left it is unrecognized.
      if (!(spec.positional && positionals === 0)) extras.push(argv[i]);
      continue;
    }
    if (kind === "positional") {
      if (spec.positional && positionals === 0) values[spec.positional.name] = controllerArgument(argv[i]);
      else extras.push(argv[i]);
      positionals += 1;
      continue;
    }
    if (kind === "unknown") {
      extras.push(argv[i]);
      continue;
    }
    if ("ambiguous" in kind) throw new UsageError(kind.ambiguous);
    const { option, explicit } = kind;
    if (option === "help") throw new HelpRequested();
    let value: unknown;
    if (option.kind !== "value") {
      if (explicit !== null) throw new UsageError(`argument ${option.flag}: ignored explicit argument '${explicit}'`);
      value = option.kind === "true";
    } else {
      let text: string;
      if (explicit !== null) {
        text = explicit;
      } else {
        if (kinds[i + 1] !== "positional") throw new UsageError(`argument ${option.flag}: expected one argument`);
        i += 1;
        text = argv[i];
      }
      value = text;
      if (option.type === "float") {
        value = pyFloat(text);
        if (value === null) throw new UsageError(`argument ${option.flag}: invalid float value: '${text}'`);
      }
    }
    const conflict = option.group ? [...seen].find((other) => other.group === option.group && other !== option) : undefined;
    if (conflict) throw new UsageError(`argument ${option.flag}: not allowed with argument ${conflict.flag}`);
    seen.add(option);
    values[option.dest] = value;
  }
  const missing = [
    ...(spec.positional?.required && positionals === 0 ? [spec.positional.name] : []),
    ...spec.options.filter((option) => option.required && !seen.has(option)).map((option) => option.flag)
  ];
  if (missing.length) throw new UsageError(`the following arguments are required: ${missing.join(", ")}`);
  return values;
}

/** Parse argv into the command and its values, or throw UsageError / HelpRequested. */
export function parsePoolArguments(argv: readonly string[]): { command: string; values: Record<string, unknown> } {
  const extras: string[] = [];
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    const kind = classify([], arg);
    if (kind === "positional") break;
    if (typeof kind === "object" && "option" in kind && kind.option === "help") throw new HelpRequested();
    extras.push(arg);
  }
  const command = argv[index];
  if (command === undefined) throw new UsageError("the following arguments are required: command");
  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) throw new UsageError(`argument command: invalid choice: '${command}' (choose from ${Object.keys(COMMANDS).join(", ")})`);
  const values = parseCommand(spec, argv.slice(index + 1), extras);
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return { command, values };
}

const HELP = `usage: ${PROGRAM} [-h] {${Object.keys(COMMANDS).join(",")}} ...

  status                          List controllers, leases, pending tabs and limits
  claim [controller] --owner ID   Claim an exclusive lease without starting Chrome
  ensure [controller] --owner ID [--timeout S] [--site URL] [--exclusive | --shared]
                                  Claim a lease and ensure its exact Chrome profile is ready
  release --owner ID --lease ID   Release one exact lease
  reap [controller] [--dry-run]   Stop the Chrome of verified idle controllers
  reset controller [--confirm]    Delete and re-provision an idle, stopped profile
`;

export async function runPoolCommand(argv: readonly string[], io: { stdout: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; env?: Env } = { stdout: process.stdout }): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  let parsed: { command: string; values: Record<string, unknown> };
  try {
    parsed = parsePoolArguments(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.stdout.write(HELP);
      return 0;
    }
    if (error instanceof UsageError) {
      stderr.write(`usage: ${PROGRAM} [-h] {${Object.keys(COMMANDS).join(",")}} ...\n${PROGRAM}: error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const { command, values } = parsed;
  let result: unknown;
  try {
    const ctx = poolContext(io.env ?? process.env);
    const controller = values.controller as string | null;
    if (command === "ensure") {
      result = await ensure(controller, values.owner as string, { timeout: values.timeout, site: values.site as string | null, exclusive: values.exclusive as boolean, ctx });
    } else if (command === "reap") {
      result = await reap(controller, { dryRun: values.dry_run as boolean, ctx });
    } else if (command === "reset") {
      result = await reset(controller as string, { confirm: values.confirm, ctx });
    } else {
      result = await operate(command, { controller, owner: values.owner, lease: values.lease, ctx });
    }
  } catch (error) {
    if (error instanceof Gate) {
      io.stdout.write(`${pyDumps({ error: error.code })}\n`);
      return 1;
    }
    stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 1;
  }
  io.stdout.write(`${pyDumps(result, { indent: 2 })}\n`);
  const failed = typeof result === "object" && result !== null && (result as Record<string, unknown>).error;
  return failed ? 1 : 0;
}
