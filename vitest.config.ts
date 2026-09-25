import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: [...configDefaults.exclude, ".worktrees/**", ".local-research/**"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
