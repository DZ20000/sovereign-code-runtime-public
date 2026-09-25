import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(projectRoot, "src", "renderer");

export default defineConfig({
  root: rendererRoot,
  base: "./",
  publicDir: false,
  build: {
    target: "chrome150",
    outDir: resolve(projectRoot, "dist", "renderer"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(rendererRoot, "index.html"),
        approval: resolve(rendererRoot, "approval.html"),
      },
    },
  },
});
