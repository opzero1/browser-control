// The server, its tests, the shipped skills and the server docs name no organization, account pool or user
// (C5, C6, C8), and nothing points into an agent client's configuration or a fixed per-user path (C1, C2, C4).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { userSocket } from "../../../src/server/config";

const repository = path.resolve(__dirname, "../../..");
const self = path.relative(repository, __filename);

/** Python test identifiers the parity files must name exactly; they are the only allowed matches. */
const PYTHON_TEST_IDS = [
  "test_reap_global_lease_never_shares_in_either_direction",
  "test_shared_tenant_cannot_add_reap_global_beside_another_tenant"
];

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["organization site", /reap\.global|reap_global|reapdirect|reaphq/i],
  ["organization name", /\bReap\b|\bREAP\b/],
  ["account-pool product", /\bDirect\b|direct-(?:pool|login|navigation|fe|isolated)/],
  ["pool account", /\bagent[1-3]\b/],
  ["user home path", /\/Users\//],
  ["fixed Node manager", /\bmise\b/],
  ["agent client configuration", /\.config\/opencode|\.local\/state\/opencode/]
];

function shippedSkills(): string[] {
  const files = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).files as string[];
  return files.flatMap((entry) => /^skills\/([a-z0-9-]+)\/$/.exec(entry)?.[1] ?? []);
}

function walk(relative: string): string[] {
  const absolute = path.join(repository, relative);
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs.readdirSync(absolute).sort().flatMap((name) => walk(path.join(relative, name)));
}

describe("references in the server, its tests, skills and docs", () => {
  it("name no organization, account pool, user path, Node manager or agent client configuration", () => {
    const roots = ["README.md", "src/server", "tests/server", "docs/server", ...shippedSkills().map((name) => `skills/${name}`)];
    const found: string[] = [];
    let scanned = 0;
    for (const file of roots.flatMap(walk)) {
      if (file === self) continue;
      scanned += 1;
      let text = fs.readFileSync(path.join(repository, file), "utf8");
      for (const id of PYTHON_TEST_IDS) text = text.split(id).join("");
      text.split("\n").forEach((line, index) => {
        for (const [kind, pattern] of FORBIDDEN) if (pattern.test(line)) found.push(`${file}:${index + 1}: ${kind}`);
      });
    }
    expect(scanned).toBeGreaterThan(100);
    expect(found).toEqual([]);
  });

  it("keep the user's Chrome socket under the state root and say so", () => {
    // The user route's default follows BROWSER_CONTROL_STATE_DIR, like every other runtime path (C4).
    expect(userSocket({ HOME: "/h", BROWSER_CONTROL_STATE_DIR: "/custom/state" })).toBe("/custom/state/sockets/user.sock");
    for (const file of ["skills/browser-control/references/setup.md", "docs/server/INSTALL.md"]) {
      const text = fs.readFileSync(path.join(repository, file), "utf8");
      expect(text, file).not.toMatch(/\ball (?:its|the|runtime) (?:runtime )?state\b/i);
      expect(text, file).toContain("sockets/user.sock");
      expect(text, file).toContain("even when `BROWSER_CONTROL_STATE_DIR` is set to another directory");
      expect(text, file).not.toMatch(/Default `~\/\.opzero-chrome\/default\.sock`/);
    }
  });

  it("ship skills whose frontmatter names their directory", () => {
    const skills = shippedSkills();
    expect(skills.sort()).toEqual(["browser-control", "create-verification-skill", "onepassword-session"]);
    for (const name of skills) {
      const text = fs.readFileSync(path.join(repository, "skills", name, "SKILL.md"), "utf8");
      const frontmatter = /^---\nname: ([^\n]+)\ndescription: "((?:[^"\\]|\\.)+)"\n---\n/.exec(text);
      expect(frontmatter?.[1], name).toBe(name);
      expect(frontmatter?.[2].length, name).toBeLessThanOrEqual(1024);
    }
  });
});
