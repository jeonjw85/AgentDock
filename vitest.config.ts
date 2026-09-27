import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.{test,spec}.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.{test,spec}.ts", "packages/*/src/index.ts"]
    }
  }
});
