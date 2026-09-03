import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_ORIGIN ?? 'http://localhost:4800';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  build: { sourcemap: true },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
} as any);
