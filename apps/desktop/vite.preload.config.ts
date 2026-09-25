import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const external = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    target: "node24",
    outDir: resolve(projectRoot, "dist", "preload"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(projectRoot, "src", "preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload",
    },
    rollupOptions: {
      external,
      output: { entryFileNames: "preload.cjs" },
    },
  },
});
