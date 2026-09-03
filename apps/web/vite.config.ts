import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.API_ORIGIN ?? 'http://localhost:4800';

/** Release number from the root package.json; the same value the release script bumps. */
const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** Short commit hash: GIT_SHA when set (Docker builds have no .git), otherwise from the checkout. */
function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(gitSha()),
  },
  server: {
    proxy: {
      '/api': { target: API, changeOrigin: false },
    },
  },
  build: { sourcemap: true },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
} as any);
