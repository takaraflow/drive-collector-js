import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "integration",
    setupFiles: ["test/integration/vitest.setup.js"],
    disableConsoleIntercept: true,
    poolOptions: {
      workers: {
        singleWorker: true,
        remoteBindings: false,
        wrangler: {
          configPath: "./wrangler.test.toml",
        },
      },
    },
    include: [
      "test/integration/**/*.test.ts",
      "test/integration/**/*.test.js",
      "__tests__/lifecycle.unit.test.ts"
    ],
  },
});
