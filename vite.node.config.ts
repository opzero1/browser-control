import { resolve } from "node:path";
import { defineConfig } from "vite";

const nodeEntries = {
  "native-host/host": resolve(__dirname, "src/native-host/host.ts"),
  "native-host/client": resolve(__dirname, "src/native-host/client.ts"),
  "native-host/transport": resolve(__dirname, "src/native-host/transport.ts"),
  "scripts/install-native-host": resolve(__dirname, "src/scripts/install-native-host.ts"),
  "scripts/check-extension-installed": resolve(__dirname, "src/scripts/check-extension-installed.ts"),
  "scripts/check-native-host-manifest": resolve(__dirname, "src/scripts/check-native-host-manifest.ts"),
  "scripts/chrome-is-running": resolve(__dirname, "src/scripts/chrome-is-running.ts"),
  "scripts/installed-browsers": resolve(__dirname, "src/scripts/installed-browsers.ts"),
  "scripts/open-chrome-window": resolve(__dirname, "src/scripts/open-chrome-window.ts")
};

export default defineConfig({
  ssr: {
    noExternal: ["effect", "@effect/platform-node"]
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    target: "node18",
    ssr: true,
    rollupOptions: {
      input: nodeEntries,
      output: {
        format: "cjs",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js"
      },
      external: [
        "node:child_process",
        "node:fs",
        "node:net",
        "node:os",
        "node:path",
        "node:process"
      ]
    }
  }
});
