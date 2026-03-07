import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/electron/libs/scheduler/**/__tests__/**/*.test.ts",
      "src/electron/libs/__tests__/**/*.test.ts",
      "src/electron/__tests__/**/*.test.ts",
    ],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/electron/libs/scheduler/**/*.ts", "src/electron/libs/openai-proxy.ts"],
      exclude: ["src/electron/libs/scheduler/**/__tests__/**", "src/electron/libs/__tests__/**"],
    },
  },
});
