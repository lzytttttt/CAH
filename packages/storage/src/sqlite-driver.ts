/**
 * Runtime loader for Node's built-in `node:sqlite`.
 *
 * `node:sqlite` is loaded through `createRequire` on purpose: Vite/Vitest (used by
 * the test runner) does not externalize the newer `node:sqlite` builtin, so a
 * static `import { DatabaseSync } from 'node:sqlite'` is rewritten into a failed
 * module resolution. A plain runtime require keeps the same synchronous driver
 * API and works in every Node 22.5+ process.
 *
 * This module is the ONLY place that loads the driver at runtime; the rest of the
 * package imports the constructor from here and uses `import type` for types.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type DatabaseSyncConstructor = new (
  path: string,
  options?: {
    open?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    readOnly?: boolean;
  },
) => DatabaseSync;

let cached: DatabaseSyncConstructor | null = null;

export function loadDatabaseSync(): DatabaseSyncConstructor {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const module = require('node:sqlite') as { DatabaseSync?: DatabaseSyncConstructor };
  if (!module || typeof module.DatabaseSync !== 'function') {
    throw new Error(
      'node:sqlite is unavailable in this Node.js runtime; Cognitive Atrium requires Node >= 22.5.0',
    );
  }
  cached = module.DatabaseSync;
  return cached;
}

/** Shared constructor used by the storage layer (synchronous by design). */
export const DatabaseSyncCtor: DatabaseSyncConstructor = loadDatabaseSync();
