// scripts/check-parity.mjs on synthetic parity trees: completeness, the approved removals only, running titles
// only, and it.each for parametrized Python tests.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateTemp, removeTempRoots } from "../support/temp";

const SCRIPT = path.resolve(__dirname, "../../../scripts/check-parity.mjs");
const APPROVED = "test_browser_start.py::test_legacy_wrapper_is_accepted_until_migrate";

afterEach(() => removeTempRoots());

interface Tree { functions: Array<{ id: string; cases?: number }>; parity: string; tests: string }

function check(tree: Tree, ...flags: string[]): { status: number | null; output: string } {
  const root = privateTemp();
  fs.mkdirSync(path.join(root, "tests/server/parity"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/server/slice"), { recursive: true });
  const functions = tree.functions.map(({ id, cases = 1 }) => ({ id, cases, subtest_blocks: 0 }));
  fs.writeFileSync(path.join(root, "tests/server/parity/python-inventory.json"), JSON.stringify({ functions }));
  fs.writeFileSync(path.join(root, "tests/server/parity/slice.md"), tree.parity);
  fs.writeFileSync(path.join(root, "tests/server/slice/a.test.ts"), tree.tests);
  const run = spawnSync(process.execPath, [SCRIPT, ...flags], { cwd: root, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const ported = (id: string, title: string) => `${id} -> tests/server/slice/a.test.ts::${title}\n`;

describe("check-parity", () => {
  it("passes a complete mapping with an approved removal", () => {
    const result = check({
      functions: [{ id: "test_x.py::test_one" }, { id: "test_x.py::test_cases", cases: 2 }, { id: APPROVED }],
      parity: ported("test_x.py::test_one", "does one") + ported("test_x.py::test_cases", "does case %s")
        + `${APPROVED} -> not ported: \`migrate\` is not ported (C8)\n`,
      tests: "it(\"does one\", () => {});\nconst CASES = [1, 2];\nit.each(CASES)(\"does case %s\", () => {});\n"
    }, "--complete");
    expect(result.output).toContain("Parity check OK: 3 of 3 Python tests listed (2 ported, 1 not ported), complete");
    expect(result.status).toBe(0);
  });

  it("refuses an unmapped test under --complete", () => {
    const result = check({ functions: [{ id: "test_x.py::test_one" }, { id: "test_x.py::test_two" }], parity: ported("test_x.py::test_one", "does one"), tests: "it(\"does one\", () => {});\n" }, "--complete");
    expect(result.status).toBe(1);
    expect(result.output).toContain("unmapped: test_x.py::test_two");
  });

  it("refuses a removal that is not approved, or one that cites the wrong decision", () => {
    const result = check({
      functions: [{ id: "test_x.py::test_one" }, { id: APPROVED }],
      parity: "test_x.py::test_one -> not ported: too hard\n" + `${APPROVED} -> not ported: removed with the pool (C6)\n`,
      tests: ""
    }, "--complete");
    expect(result.status).toBe(1);
    expect(result.output).toContain("test_x.py::test_one is not an approved removal");
    expect(result.output).toContain("the reason must cite C8");
  });

  it("does not count skipped or todo titles, or any title in a file with a skipped or focused suite", () => {
    const functions = [{ id: "test_x.py::test_one" }, { id: "test_x.py::test_two" }];
    const parity = ported("test_x.py::test_one", "does one") + ported("test_x.py::test_two", "does two");
    const skipped = check({ functions, parity, tests: "it.skip(\"does one\", () => {});\nit.todo(\"does two\");\n" }, "--complete");
    expect(skipped.status).toBe(1);
    expect(skipped.output).toContain("\"does one\" in tests/server/slice/a.test.ts is skipped or todo");
    expect(skipped.output).toContain("\"does two\" in tests/server/slice/a.test.ts is skipped or todo");
    const suite = check({ functions, parity, tests: "describe.skip(\"s\", () => { it(\"does one\", () => {}); it(\"does two\", () => {}); });\n" }, "--complete");
    expect(suite.status).toBe(1);
    expect(suite.output).toContain("uses describe.skip, so its titles do not count");
    const focused = check({ functions, parity, tests: "it.only(\"does one\", () => {});\nit(\"does two\", () => {});\n" }, "--complete");
    expect(focused.status).toBe(1);
    expect(focused.output).toContain("uses it.only");
  });

  it("requires an it.each test for a parametrized Python test", () => {
    const result = check({ functions: [{ id: "test_x.py::test_cases", cases: 3 }], parity: ported("test_x.py::test_cases", "does cases"), tests: "it(\"does cases\", () => {});\n" }, "--complete");
    expect(result.status).toBe(1);
    expect(result.output).toContain("test_x.py::test_cases has 3 cases; map it to an it.each test");
  });
});
