import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "integration",
    globals: true,
    testTimeout: 30000,
    fileParallelism: false,
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.js",
        wrangler: {
          configPath: "./wrangler.test.toml",
        }
      },
    },
    include: ["test/integration/core-integration.test.js"],
  },
});