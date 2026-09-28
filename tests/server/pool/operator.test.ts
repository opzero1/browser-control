// The operator CLI's argument parser against browser_pool.main's argparse, captured over an argv corpus by
// fixtures/capture-argparse.py. `migrate` is not ported (C8, D15), so it is an invalid choice here.
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parsePoolArguments, runPoolCommand } from "../../../src/server/pool/operator";

interface Case { argv: string[]; code: number; namespace: Record<string, unknown> | null; help: boolean; error: string | null }

const capture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/python-argparse.json"), "utf8")) as { python: string; cases: Case[] };
const CHOICES = "(choose from status, claim, ensure, release, reap, reset, migrate)";

function expected(item: Case): Case {
  if (item.argv[0] !== "migrate" || item.code !== 0) {
    return item.error?.includes(CHOICES) ? { ...item, error: item.error.replace(", migrate)", ")") } : item;
  }
  return { ...item, code: 2, namespace: null, error: "argument command: invalid choice: 'migrate' (choose from status, claim, ensure, release, reap, reset)" };
}

function actual(argv: string[]): Case {
  try {
    const { command, values } = parsePoolArguments(argv);
    const namespace: Record<string, unknown> = { command };
    for (const [key, value] of Object.entries(values)) {
      namespace[key] = typeof value === "number" && !Number.isFinite(value) ? (Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf") : value;
    }
    return { argv, code: 0, namespace, help: false, error: null };
  } catch (error) {
    const name = (error as Error).constructor.name;
    if (name === "HelpRequested") return { argv, code: 0, namespace: null, help: true, error: null };
    if (name === "UsageError") return { argv, code: 2, namespace: null, help: false, error: (error as Error).message };
    throw error;
  }
}

describe("operator CLI arguments", () => {
  it("parses every captured argv like the Python argparse CLI", () => {
    expect(capture.cases.length).toBeGreaterThan(90);
    for (const item of capture.cases) expect(actual(item.argv), JSON.stringify(item.argv)).toEqual(expected(item));
  });

  it("exits 2 with an argparse error and 0 with help", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk) => { out += chunk; });
    stderr.on("data", (chunk) => { err += chunk; });
    expect(await runPoolCommand(["claim", "isolated-9", "--owner", "ses_a"], { stdout, stderr, env: {} })).toBe(2);
    expect(err).toContain("browser-control pool: error: argument controller: expected isolated-1 to isolated-8\n");
    expect(out).toBe("");
    expect(await runPoolCommand(["--help"], { stdout, stderr, env: {} })).toBe(0);
    expect(out).toContain("usage: browser-control pool");
  });
});
