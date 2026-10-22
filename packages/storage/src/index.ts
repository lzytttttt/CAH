/**
 * @ca/storage — SQLite (WAL) + content-addressed object store.
 *
 * Implementation contract: see ./types.ts. The class implementing StoragePort
 * lives in ./storage.ts (owned by the storage workstream). Side-effect free
 * tests use a temporary directory.
 */
export * from './types';
export * from './storage';
