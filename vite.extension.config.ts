import { basename, dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const entry = process.env.BROWSER_CONTROL_EXTENSION_ENTRY || "background";
const entryMap: Record<string, string> = {
  background: "src/extension/background.ts",
  "content-scripts/opzero-chrome": "src/extension/content-scripts/opzero-chrome.ts",
  popup: "src/extension/popup.ts"
};

export default defineConfig({
  build: {
    outDir: "dist/extension",
    emptyOutDir: process.env.BROWSER_CONTROL_EXTENSION_EMPTY === "1",
    sourcemap: false,
    target: "es2022",
    lib: {
      entry: resolve(__dirname, entryMap[entry]),
      name: `OpzeroChrome${entry.replace(/[^a-zA-Z0-9]/g, "")}`,
      formats: ["iife"],
      fileName: () => `${entry}.js`
    },
    rollupOptions: {
      output: {
        dir: resolve(__dirname, "dist/extension", dirname(entry)),
        entryFileNames: basename(entry) + ".js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
