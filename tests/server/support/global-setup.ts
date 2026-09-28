// Bundle every tests/server/support/child-*.ts into a private temp directory for subprocess tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory holding child-<name>.js bundles. */
    serverChildren: string;
  }
}

const support = __dirname;
const repository = path.resolve(support, "../../..");

export default async function setup(project: TestProject): Promise<() => void> {
  const base = process.env.OPZERO_TEST_TMPDIR || path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(base), "fc-children-"));
  fs.chmodSync(directory, 0o700);
  const inputs = Object.fromEntries(fs.readdirSync(support)
    .filter((name) => /^child-[a-z0-9-]+\.ts$/.test(name))
    .map((name) => [name.replace(/\.ts$/, ""), path.join(support, name)]));
  for (const [name, input] of Object.entries(inputs)) {
    await build({
      configFile: false,
      root: repository,
      logLevel: "warn",
      ssr: { noExternal: true },
      build: {
        outDir: directory,
        emptyOutDir: false,
        ssr: true,
        target: "node24",
        minify: false,
        rollupOptions: {
          input: { [name]: input },
          output: { format: "cjs", entryFileNames: "[name].js", codeSplitting: false },
          external: [/^node:/]
        }
      }
    });
  }
  project.provide("serverChildren", directory);
  return () => fs.rmSync(directory, { recursive: true, force: true });
}
