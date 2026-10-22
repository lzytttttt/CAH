import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '../..');

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@ca/contracts': path.join(repoRoot, 'packages/contracts/src/index.ts'),
      '@ca/harness': path.join(repoRoot, 'packages/harness/src/index.ts'),
      '@ca/providers': path.join(repoRoot, 'packages/providers/src/index.ts'),
      '@ca/tools': path.join(repoRoot, 'packages/tools/src/index.ts'),
      '@ca/recipes': path.join(repoRoot, 'packages/recipes/src/index.ts'),
      '@ca/storage': path.join(repoRoot, 'packages/storage/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
