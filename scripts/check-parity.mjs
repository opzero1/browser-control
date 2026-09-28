#!/usr/bin/env node
// Check tests/server/parity/*.md against the Python test inventory.
//
// A mapping line is "<python_file>::[Class::]<test> -> <ts_file>::<exact test title>" or
// "<python_file>::[Class::]<test> -> not ported: <reason>". Every Python test may appear at most once across
// all files, every named TS test must exist, and with --complete every inventory entry must appear.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const parity = path.join(root, "tests/server/parity");
const complete = process.argv.includes("--complete");
const inventory = JSON.parse(fs.readFileSync(path.join(parity, "python-inventory.json"), "utf8"));
const known = new Map(inventory.functions.map((item) => [item.id, item]));
const failures = [];
const seen = new Map();
const titles = new Map();

function testTitles(file) {
  if (!titles.has(file)) {
    const source = fs.readFileSync(file, "utf8");
    const found = new Set();
    const pattern = /\b(?:it|test)(?:\.(?:each|skip|only|todo|concurrent))*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const match of source.matchAll(pattern)) found.add(match[2].replace(/\\(.)/g, "$1"));
    titles.set(file, found);
  }
  return titles.get(file);
}

const files = fs.existsSync(parity) ? fs.readdirSync(parity).filter((name) => name.endsWith(".md")).sort() : [];
let mapped = 0;
let notPorted = 0;
for (const name of files) {
  const lines = fs.readFileSync(path.join(parity, name), "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!/^test_[a-z_]+\.py::/.test(line)) return;
    const where = `${name}:${index + 1}`;
    const match = /^(test_[a-z_]+\.py::(?:[A-Za-z_][A-Za-z0-9_]*::)?test[A-Za-z0-9_]*) -> (.+)$/.exec(line);
    if (!match) {
      failures.push(`${where}: malformed mapping`);
      return;
    }
    const [, id, target] = match;
    if (!known.has(id)) failures.push(`${where}: ${id} is not in python-inventory.json`);
    if (seen.has(id)) failures.push(`${where}: ${id} is already mapped at ${seen.get(id)}`);
    seen.set(id, where);
    if (target.startsWith("not ported: ")) {
      if (!target.slice("not ported: ".length).trim()) failures.push(`${where}: not ported without a reason`);
      notPorted += 1;
      return;
    }
    const separator = target.indexOf("::");
    if (separator < 0) {
      failures.push(`${where}: target needs <file>::<title> or "not ported: <reason>"`);
      return;
    }
    const file = target.slice(0, separator);
    const title = target.slice(separator + 2);
    const absolute = path.join(root, file);
    if (!/^tests\/server\/.+\.test\.ts$/.test(file) || !fs.existsSync(absolute)) {
      failures.push(`${where}: ${file} does not exist under tests/server`);
      return;
    }
    if (!testTitles(absolute).has(title)) failures.push(`${where}: no test titled "${title}" in ${file}`);
    mapped += 1;
  });
}

if (complete) {
  for (const id of known.keys()) if (!seen.has(id)) failures.push(`unmapped: ${id}`);
}

if (failures.length) {
  process.stderr.write(`Parity check failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Parity check OK: ${seen.size} of ${known.size} Python tests listed (${mapped} ported, ${notPorted} not ported)${complete ? ", complete" : ""}\n`);
