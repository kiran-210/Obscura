import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  define: {
    // @stellar/stellar-sdk (stellar-base) references `global` in the browser.
    global: 'globalThis',
  },
  optimizeDeps: {
    // bb.js breaks esbuild's dev pre-bundle (WASM + workers), so keep it native-ESM in dev.
    // It must still be bundled for production (the swap/withdraw proof paths dynamic-import
    // the prover), so it is NOT marked rollup-external — otherwise the browser gets a bare
    // `@noir-lang/noir_js` specifier it can't resolve.
    exclude: ['@aztec/bb.js', '@noir-lang/noir_js'],
  },
})
