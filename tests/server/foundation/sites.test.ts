// Port of test_sites.py.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageAssets } from "../../../src/server/assets";
import { Gate } from "../../../src/server/gate";
import { cookieSite, loadPublicSuffixList, PSL_SHA256, usePublicSuffixListForTesting, validSite } from "../../../src/server/sites";
import { privateTemp, removeTempRoots } from "../support/temp";

afterEach(() => {
  usePublicSuffixListForTesting();
  removeTempRoots();
});

function refused(body: () => unknown, code: string) {
  let error: unknown;
  try {
    body();
  } catch (failure) {
    error = failure;
  }
  expect(error).toBeInstanceOf(Gate);
  expect((error as Gate).code).toBe(code);
}

describe("cookie sites (test_sites.py)", () => {
  const REGISTRABLE: Array<[string, string]> = [
    ["https://deploy-preview-1704--reapdirect.netlify.app/login", "deploy-preview-1704--reapdirect.netlify.app"],
    ["https://deploy-preview-1705--reapdirect.netlify.app/", "deploy-preview-1705--reapdirect.netlify.app"],
    ["https://staging.dashboard.reap.global/", "reap.global"],
    ["https://dashboard.reap.global/x?y=1", "reap.global"],
    ["reap.global", "reap.global"],
    ["https://netlify.app/", "netlify.app"],
    ["https://a.b.example.co.uk/", "example.co.uk"],
    ["https://foo.github.io/", "foo.github.io"],
    ["https://a.unlisted-tld/", "a.unlisted-tld"],
    ["https://intranet/", "intranet"]
  ];
  it.each(REGISTRABLE)("maps %s to its registrable domain", (value, site) => {
    expect(cookieSite(value)).toBe(site);
  });

  const WILDCARDS: Array<[string, string]> = [
    ["https://a.b.ck/", "a.b.ck"],
    ["https://b.ck/", "b.ck"],
    ["https://www.ck/", "www.ck"],
    ["https://x.www.ck/", "www.ck"],
    ["https://x.y.kawasaki.jp/", "x.y.kawasaki.jp"],
    ["https://city.kawasaki.jp/", "city.kawasaki.jp"],
    ["https://a.city.kawasaki.jp/", "city.kawasaki.jp"]
  ];
  it.each(WILDCARDS)("applies wildcard and exception rules to %s", (value, site) => {
    expect(cookieSite(value)).toBe(site);
  });

  const IDN: Array<[string, string]> = [
    ["https://münchen.de/", "xn--mnchen-3ya.de"],
    ["https://xn--mnchen-3ya.de/", "xn--mnchen-3ya.de"],
    ["https://www.公司.cn/", "www.xn--55qx5d.cn"],
    ["https://公司.cn/", "xn--55qx5d.cn"]
  ];
  it.each(IDN)("uses punycode for the IDN host %s", (value, site) => {
    expect(cookieSite(value)).toBe(site);
  });

  it("keeps the IDNA 2003 mapping of sharp s", () => {
    expect(cookieSite("https://straße.de/")).toBe("strasse.de");
  });

  const HOSTS: Array<[string, string]> = [
    ["http://127.0.0.1:8080/", "127.0.0.1"],
    ["127.0.0.1", "127.0.0.1"],
    ["http://[::1]:3000/x", "::1"],
    ["http://[2001:DB8::1]/", "2001:db8::1"],
    ["::1", "::1"],
    ["http://localhost:5173/", "localhost"],
    ["localhost", "localhost"]
  ];
  it.each(HOSTS)("maps the IP literal or localhost %s to the host", (value, site) => {
    expect(cookieSite(value)).toBe(site);
  });

  const NORMALIZED = ["https://STAGING.Dashboard.REAP.global.:443/", "staging.dashboard.reap.global.", "https://staging.dashboard.reap.global:8443/"];
  it.each(NORMALIZED)("ignores case, a trailing dot and the port in %s", (value) => {
    expect(cookieSite(value)).toBe("reap.global");
  });

  const INVALID: unknown[] = [null, 5, "", "https://", "https://a..b/", "https://-a.com/", "https://ex ample.com/",
    "https://a.com\\@b.com/", "x".repeat(9000), `https://${"a".repeat(64)}.com/`, `https://${"a.".repeat(127)}com/`];
  const INVALID_CASES = INVALID.map((value, index) => ({ value, index }));
  it.each(INVALID_CASES)("refuses invalid host #$index", ({ value }) => {
    refused(() => cookieSite(value), "fast-chrome-site-invalid");
  });

  it("accepts only canonical keys as valid sites", () => {
    expect(validSite("reap.global") && validSite("::1") && validSite("localhost")).toBe(true);
    expect(validSite("staging.reap.global") || validSite("[::1]")).toBe(false);
    expect(validSite("Reap.Global") || validSite(null)).toBe(false);
  });

  it("vendors a list that matches its pin", () => {
    const data = fs.readFileSync(packageAssets().publicSuffixList);
    expect(createHash("sha256").update(data).digest("hex")).toBe(PSL_SHA256);
    expect(data.length).toBe(334786);
    expect(data.includes("// VERSION: 2026-09-24_13-26-36_UTC")).toBe(true);
    const { rules, wildcards, exceptions } = loadPublicSuffixList();
    expect(rules.has("netlify.app") && rules.has("global") && wildcards.has("ck")).toBe(true);
    expect(exceptions.has("www.ck")).toBe(true);
  });

  it("refuses a tampered or missing list", () => {
    const root = privateTemp();
    const copy = path.join(root, "public_suffix_list.dat");
    fs.writeFileSync(copy, fs.readFileSync(packageAssets().publicSuffixList).toString("latin1").replace("\nnetlify.app\n", "\n"), "latin1");
    refused(() => loadPublicSuffixList(copy), "fast-chrome-public-suffix-list-mismatch");
    refused(() => loadPublicSuffixList(path.join(root, "missing.dat")), "fast-chrome-public-suffix-list-unavailable");
  });

  it("checks the hash when the list first loads (D14)", () => {
    const root = privateTemp();
    const copy = path.join(root, "public_suffix_list.dat");
    fs.writeFileSync(copy, Buffer.concat([fs.readFileSync(packageAssets().publicSuffixList), Buffer.from("\nexample\n")]));
    usePublicSuffixListForTesting(copy);
    refused(() => cookieSite("https://example.com/"), "fast-chrome-public-suffix-list-mismatch");
    // A failed load is not cached as success; the next lookup checks again.
    refused(() => validSite("example.com"), "fast-chrome-public-suffix-list-mismatch");
    usePublicSuffixListForTesting(path.join(root, "missing.dat"));
    refused(() => cookieSite("https://example.com/"), "fast-chrome-public-suffix-list-unavailable");
  });

  it("depends on Node built-ins only", () => {
    // The Python module ran under a bare system python3; the port's site code must not pull in the MCP SDK,
    // zod or any other package, so the pool CLI and native host bundles stay small and self-contained.
    const root = path.resolve(__dirname, "../../../src/server");
    const seen = new Set<string>();
    const external = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), `${specifier}.ts`));
        else external.add(specifier);
      }
    };
    visit(path.join(root, "sites.ts"));
    expect([...external].filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });
});
