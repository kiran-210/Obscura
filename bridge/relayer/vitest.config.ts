import { defineConfig } from "vitest/config";

// Unit tests are network-free: they exercise the pure pieces (BLS point
// decompression, storage-slot derivation, RLP proof packaging, ScVal encoding,
// update assembly). Live RPC submission is integration-only (see README) and is
// never exercised here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
