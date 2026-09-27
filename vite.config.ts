import { defineConfig } from 'vite';

// Binance futures REST doesn't allow browser (CORS) calls, so the dev/preview server forwards
// /bx/fapi → mainnet and /bx/ftest → testnet. The Android app calls Binance directly instead.
const binanceProxy = {
  '/bx/fapi': { target: 'https://fapi.binance.com', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/bx\/fapi/, '') },
  '/bx/ftest': { target: 'https://testnet.binancefuture.com', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/bx\/ftest/, '') },
};

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  server: { proxy: binanceProxy },
  preview: { proxy: binanceProxy },
  test: { environment: 'node' },
} as never);
