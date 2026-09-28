import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Bundled dependencies (cross-spawn in the MCP SDK's stdio client) load bare builtins such as "fs"; load them as
// "node:" builtins so the bundle requires nothing outside Node.
const builtins = new Set(builtinModules);
const nodeBuiltins: Plugin = {
  name: "browser-control-node-builtins",
  enforce: "pre",
  resolveId(id) {
    const bare = id.startsWith("node:") ? id.slice(5) : id;
    return builtins.has(bare) ? { id: `node:${bare}`, external: true } : null;
  }
};

// One self-contained CJS bundle per run: BROWSER_CONTROL_SERVER_ENTRY selects `cli` or `native-host`.
const entry = process.env.BROWSER_CONTROL_SERVER_ENTRY || "cli";
const entryMap: Record<string, string> = {
  cli: "src/server/cli.ts",
  "native-host": "src/server/native-host-entry.ts"
};

export default defineConfig({
  plugins: [nodeBuiltins],
  ssr: {
    noExternal: true
  },
  build: {
    outDir: "dist/server",
    emptyOutDir: false,
    sourcemap: false,
    target: "node24",
    ssr: true,
    minify: false,
    rollupOptions: {
      input: { [entry]: resolve(__dirname, entryMap[entry]) },
      output: {
        format: "cjs",
        entryFileNames: "[name].js",
        codeSplitting: false,
        banner: entry === "cli" ? "#!/usr/bin/env node" : undefined
      },
      external: [/^node:/]
    }
  }
});
