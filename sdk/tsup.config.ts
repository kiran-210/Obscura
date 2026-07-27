import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Heavy runtime-only deps are kept external; they are loaded lazily by prover.ts
  // and stellar.ts so importing @wraith/sdk stays cheap.
  external: ["@aztec/bb.js", "@noir-lang/noir_js", "@stellar/stellar-sdk"],
});
