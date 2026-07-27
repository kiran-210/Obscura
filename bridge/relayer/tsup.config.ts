import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // The relayer is a service/CLI, not a published library: emitting JS is enough
  // and keeps the build fast. The CLI entry gets a node shebang banner so the
  // `wraith-relayer` bin is directly executable.
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  // Keep heavy runtime deps external — resolved from node_modules at runtime.
  external: ["@stellar/stellar-sdk", "viem", "@noble/curves"],
});
