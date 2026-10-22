import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ServerConfig {
  repoRoot: string;
  host: string;
  port: number;
  dataDir: string;
  /** Workspace mode selected at boot when no session override exists. */
  defaultMode: 'live' | 'demo';
  sessionSecret: string;
  allowedOrigins: string[];
  allowHttpLoopback: boolean;
  allowedProviderHosts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  seedDemo: boolean;
  webDistDir: string;
  sessionTokenFile: string;
  credentialsMasterKey: string;
  providerEnv: {
    baseURL: string;
    model: string;
    credentialRef: string;
  };
  runConcurrency: number;
  demoResetOnBoot: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(root, env.CA_DATA_DIR ?? './data');
  const model = env.CA_OPENAI_MODEL ?? '';
  const defaultMode = env.CA_MODE === 'demo' ? 'demo' : 'live';
  return {
    repoRoot: root,
    host: env.CA_HOST ?? '127.0.0.1',
    port: int(env.CA_PORT, 4310),
    dataDir,
    defaultMode,
    sessionSecret: env.CA_SESSION_SECRET ?? '',
    allowedOrigins: list(env.CA_ALLOWED_ORIGINS).length
      ? list(env.CA_ALLOWED_ORIGINS)
      : [
          `http://127.0.0.1:${int(env.CA_PORT, 4310)}`,
          `http://localhost:${int(env.CA_PORT, 4310)}`,
          'http://127.0.0.1:5173',
          'http://localhost:5173',
        ],
    allowHttpLoopback: bool(env.CA_ALLOW_HTTP_LOOPBACK, true),
    allowedProviderHosts: list(env.CA_ALLOWED_PROVIDER_HOSTS),
    logLevel: (env.CA_LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    seedDemo: bool(env.CA_SEED_DEMO, true),
    webDistDir: path.join(root, 'apps/web/dist'),
    sessionTokenFile: env.CA_SESSION_TOKEN_FILE
      ? path.resolve(root, env.CA_SESSION_TOKEN_FILE)
      : path.join(dataDir, 'session-token'),
    credentialsMasterKey: env.CA_CREDENTIALS_MASTER_KEY ?? '',
    providerEnv: {
      baseURL: env.CA_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model,
      credentialRef: env.CA_OPENAI_CREDENTIAL_REF ?? 'CA_OPENAI_API_KEY',
    },
    runConcurrency: int(env.CA_RUN_CONCURRENCY, 2),
    demoResetOnBoot: bool(env.CA_DEMO_RESET_ON_BOOT, false),
  };
}

/** Provider URL policy derived from config. */
export function urlPolicyFor(config: ServerConfig): {
  allowHttpLoopback: boolean;
  allowedProviderHosts: readonly string[];
} {
  return {
    allowHttpLoopback: config.allowHttpLoopback,
    allowedProviderHosts: [
      ...config.allowedProviderHosts,
      ...safeHostOf(config.providerEnv.baseURL),
    ].filter(Boolean),
  };
}

function safeHostOf(url: string): string[] {
  try {
    const parsed = new URL(url);
    return [parsed.host];
  } catch {
    return [];
  }
}
