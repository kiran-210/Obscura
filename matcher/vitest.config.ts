import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve `@obscura/sdk` to its TypeScript source so the matcher's unit tests run
// without first building the SDK (and without loading the heavy bb.js / noir_js
// proving stack, which the SDK only imports lazily). The mocked prover/submitter in
// tests never touch the real proving backend.
const sdkSource = fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@obscura/sdk": sdkSource,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
