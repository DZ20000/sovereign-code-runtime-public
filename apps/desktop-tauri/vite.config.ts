import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(projectRoot, "..", "..");

export default defineConfig({
  root: projectRoot,
  base: "./",
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    fs: {
      allow: [workspaceRoot],
    },
  },
  build: {
    target: "es2022",
    outDir: resolve(projectRoot, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        approval: resolve(projectRoot, "approval.html"),
      },
    },
  },
});
