import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // The matcher is a service, not a published library: emitting JS is enough and keeps
  // the build fast and resolution-error-free (the SDK ships its own .d.ts).
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Keep the workspace SDK and heavy runtime deps external — they are resolved at
  // runtime from node_modules, not bundled into the matcher.
  external: ["@obscura/sdk", "@stellar/stellar-sdk", "@aztec/bb.js", "@noir-lang/noir_js"],
});
