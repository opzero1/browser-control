#!/usr/bin/env node
// Check tests/server/parity/*.md against the Python test inventory.
//
// A mapping line is "<python_file>::[Class::]<test> -> <ts_file>::<exact test title>" or
// "<python_file>::[Class::]<test> -> not ported: <reason>". Every Python test may appear at most once across
// all files, every named TS test must exist and run (a skip or todo title does not count), and with --complete
// every inventory entry must appear. `pnpm run check` passes --complete.
//
// Only the approved removals may be "not ported", and a parametrized Python test must map to an it.each test
// unless it is listed in CASES_IN_ONE_TEST.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** The approved removals (docs/server/DESIGN.md C6, C8), with the decision each reason must cite. */
const APPROVED_REMOVALS = new Map([
  // migrate and legacy_host (C8).
  ["test_browser_start.py::test_legacy_wrapper_is_accepted_until_migrate", "C8"],
  ["test_controller_factory.py::test_migrate_rewrites_only_stopped_legacy_manifests", "C8"],
  // The fixed FAST_CHROME_CONTROLLER_ID route (C8).
  ["test_native_server.py::test_controller_denies_foreign_session_before_any_page_or_vault_call", "C8"],
  ["test_native_server.py::test_numbered_entry_refusal_creates_no_registry_directory_or_lock", "C8"],
  ["test_native_server.py::test_controller_status_reports_only_readiness_and_availability", "C8"],
  ["test_native_server.py::test_controller_config_cannot_route_a_lease_to_another_socket", "C8"],
  ["test_native_server.py::test_controller_listing_holds_lease_until_call_returns", "C8"],
  ["test_native_server.py::test_claim_browser_is_refused_on_a_fixed_numbered_entry", "C8"],
  // The account pool's lease for the private transfer (C6).
  ["test_private_input.py::PoolBindingTests::test_account_requires_exact_owned_lease", "C6"]
]);

/**
 * Parametrized Python tests that map to one TS test rather than an it.each. `merged` is the one approved case
 * reduction: test_standard_library_only ran under two interpreters and runs once under Node.
 */
const CASES_IN_ONE_TEST = new Map([
  ["test_sites.py::test_standard_library_only", "merged"],
  ["test_native_server.py::test_numbered_entry_owner_is_refused_an_unknown_tab_before_any_pin", "loop"],
  ["test_native_server.py::test_another_tenant_cannot_use_a_lease_tab_before_any_call_or_registry_write", "loop"]
]);

const root = process.cwd();
const parity = path.join(root, "tests/server/parity");
const complete = process.argv.includes("--complete");
const inventory = JSON.parse(fs.readFileSync(path.join(parity, "python-inventory.json"), "utf8"));
const known = new Map(inventory.functions.map((item) => [item.id, item]));
const failures = [];
const seen = new Map();
const titles = new Map();

/** Titles of the tests a file runs: it/test titles, split into it.each tables and single tests. */
function testTitles(file) {
  if (!titles.has(file)) {
    const source = fs.readFileSync(file, "utf8");
    const found = { each: new Set(), single: new Set(), skipped: new Set(), disabled: null };
    // A skipped, todo or focused describe changes which tests run, so no title in that file counts.
    const disabled = /\b(?:describe|suite)\.(skip|todo|only)\b|\b(?:it|test)\.only\b/.exec(source);
    if (disabled) found.disabled = disabled[0];
    const pattern = /\b(?:it|test)((?:\.(?:each|skip|only|todo|concurrent))*)(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
    for (const match of source.matchAll(pattern)) {
      const modifiers = match[1].split(".");
      const title = match[3].replace(/\\(.)/g, "$1");
      if (modifiers.includes("skip") || modifiers.includes("todo")) found.skipped.add(title);
      else if (modifiers.includes("each")) found.each.add(title);
      else found.single.add(title);
    }
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
      const reason = target.slice("not ported: ".length).trim();
      const decision = APPROVED_REMOVALS.get(id);
      if (!reason) failures.push(`${where}: not ported without a reason`);
      else if (!decision) failures.push(`${where}: ${id} is not an approved removal (migrate/legacy_host, the fixed route, the account pool)`);
      else if (!new RegExp(`\\b${decision}\\b`).test(reason)) failures.push(`${where}: the reason must cite ${decision}`);
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
    const found = testTitles(absolute);
    if (found.disabled) failures.push(`${where}: ${file} uses ${found.disabled}, so its titles do not count`);
    else if (found.skipped.has(title) && !found.each.has(title) && !found.single.has(title)) failures.push(`${where}: "${title}" in ${file} is skipped or todo`);
    else if (!found.each.has(title) && !found.single.has(title)) failures.push(`${where}: no test titled "${title}" in ${file}`);
    else if ((known.get(id)?.cases ?? 1) > 1 && !found.each.has(title) && !CASES_IN_ONE_TEST.has(id)) {
      failures.push(`${where}: ${id} has ${known.get(id).cases} cases; map it to an it.each test`);
    }
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
