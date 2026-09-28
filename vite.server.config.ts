import { resolve } from "node:path";
import { defineConfig } from "vite";

// One self-contained CJS bundle per run: BROWSER_CONTROL_SERVER_ENTRY selects `cli` or `native-host`.
const entry = process.env.BROWSER_CONTROL_SERVER_ENTRY || "cli";
const entryMap: Record<string, string> = {
  cli: "src/server/cli.ts",
  "native-host": "src/server/native-host-entry.ts"
};

export default defineConfig({
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
