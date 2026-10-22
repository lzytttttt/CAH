import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  '@ca/contracts': path.join(root, 'packages/contracts/src/index.ts'),
  '@ca/harness': path.join(root, 'packages/harness/src/index.ts'),
  '@ca/providers': path.join(root, 'packages/providers/src/index.ts'),
  '@ca/tools': path.join(root, 'packages/tools/src/index.ts'),
  '@ca/recipes': path.join(root, 'packages/recipes/src/index.ts'),
  '@ca/storage': path.join(root, 'packages/storage/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
