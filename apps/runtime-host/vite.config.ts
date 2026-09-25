import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import { readGitSource } from "../desktop-tauri/scripts/release-metadata.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig(async () => {
  const source = await readGitSource(resolve(projectRoot, "../.."));
  return {
  define: { __SCR_RUNTIME_BUILD_SOURCE__: JSON.stringify({ commit: source.commit, dirty: source.dirty }) },
  build: {
    target: "node24",
    outDir: resolve(projectRoot, "dist", "bundle"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(projectRoot, "src", "main.ts"),
      formats: ["cjs"],
      fileName: () => "runtime-host",
    },
    rollupOptions: {
      external,
      output: {
        entryFileNames: "runtime-host.cjs",
      },
    },
  },
  };
});
