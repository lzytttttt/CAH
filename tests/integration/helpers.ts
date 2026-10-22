import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type ServerConfig } from '../../apps/server/src/config';
import { RuntimeManager, type RuntimeOverrides } from '../../apps/server/src/runtime-manager';
import { SessionManager } from '../../apps/server/src/session';
import { loadTemplateCatalog } from '../../apps/server/src/templates';
import { createApp } from '../../apps/server/src/app';
import { ScriptedProviderGateway } from './fakes/scripted-provider';

type ServerApp = Awaited<ReturnType<typeof createApp>>;

export const AUTH_SECRET = 'integration-test-session-secret-0123456789';

export interface TestHarness {
  config: ServerConfig;
  manager: RuntimeManager;
  session: SessionManager;
  app: ServerApp;
  provider: ScriptedProviderGateway;
  headers: Record<string, string>;
  close(): Promise<void>;
}

export interface CreateHarnessOptions {
  seedDemo?: boolean;
  provider?: ScriptedProviderGateway;
  /** Use the real LiveProviderGateway (local fake HTTP provider) instead of a scripted gateway. */
  useRealProviders?: boolean;
}

/** Boot the full server stack against a temp data dir with a scripted provider. */
export async function createHarness(options: CreateHarnessOptions = {}): Promise<TestHarness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ca-it-'));
  const base = loadConfig({
    CA_DATA_DIR: dir,
    CA_SEED_DEMO: options.seedDemo ? 'true' : 'false',
    CA_MODE: 'live',
    CA_SESSION_SECRET: AUTH_SECRET,
    CA_SESSION_TOKEN_FILE: path.join(dir, 'session-token'),
    CA_LOG_LEVEL: 'silent',
  });
  const config: ServerConfig = {
    ...base,
    dataDir: dir,
    seedDemo: options.seedDemo ?? false,
    sessionTokenFile: path.join(dir, 'session-token'),
  };
  const provider = options.provider ?? new ScriptedProviderGateway();
  const overrides: RuntimeOverrides = options.useRealProviders
    ? {}
    : {
        providersFor: (mode) => (mode === 'live' ? provider : null),
      };
  const logs: string[] = [];
  const manager = new RuntimeManager(config, (message, details) => {
    logs.push(`${message} ${details ? JSON.stringify(details) : ''}`);
  }, overrides);
  let app: ServerApp | null = null;
  try {
    await manager.init();
    const session = await SessionManager.create(config);
    const catalog = await loadTemplateCatalog(config.repoRoot);
    app = await createApp({ config, manager, session, catalog });
    await app.ready();
    return {
      config,
      manager,
      session,
      app,
      provider,
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      async close() {
        try {
          await app?.close();
        } finally {
          await manager.shutdown();
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  } catch (error) {
    if (app) await app.close().catch(() => {});
    await manager.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function waitFor<T>(
  fn: () => Promise<T | null>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${options.label ?? 'condition'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

