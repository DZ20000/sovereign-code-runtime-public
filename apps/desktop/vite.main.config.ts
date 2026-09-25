import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

export default defineConfig({
  build: {
    target: "node24",
    outDir: resolve(projectRoot, "dist", "main"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(projectRoot, "src", "main.ts"),
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external,
    },
  },
});
