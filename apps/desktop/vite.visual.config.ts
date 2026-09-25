import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist/visual",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/visual-test.ts"),
      formats: ["es"],
      fileName: () => "visual-test.mjs",
    },
    rollupOptions: {
      external: [
        "electron",
        "node:crypto",
        "node:fs/promises",
        "node:path",
        "node:url",
      ],
    },
  },
});
