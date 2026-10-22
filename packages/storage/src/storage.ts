import type { EngineMode, WorkspaceSettings } from '@ca/contracts';
import type { StoragePort } from './types';

export interface OpenStorageOptions {
  dataDir: string;
  mode: EngineMode;
  workspaceName: string;
  settings?: Partial<WorkspaceSettings>;
}

/**
 * Placeholder implementation replaced by the storage workstream.
 * It throws immediately so no server path can silently run without persistence.
 */
export function openStorage(_options: OpenStorageOptions): StoragePort {
  throw new Error('storage not implemented yet (openStorage)');
}
