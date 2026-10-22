/**
 * @ca/storage — SQLite (WAL) + content-addressed object store.
 *
 * Implementation contract: see ./types.ts. The class implementing StoragePort
 * lives in ./storage.ts. Side-effect free tests use a temporary directory.
 *
 * Public surface:
 * - `openStorage(options)` / `openStorageWithDiagnostics(options)` factory
 * - `SqliteStorage` (StoragePort plus diagnostics helpers used by tests)
 * - `FileObjectStore` (atomic, sha256-addressed object store)
 * - migration helpers, hash helpers and the shared error classes
 */
export * from './types';
export * from './storage';
export * from './object-store';
export * from './migrate';
export * from './hash';
