import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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
  sessionSecret: string;
  allowedOrigins: string[];
  allowHttpLoopback: boolean;
  allowedProviderHosts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  seedDemo: boolean;
  webDistDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(root, env.CA_DATA_DIR ?? './data');
  return {
    repoRoot: root,
    host: env.CA_HOST ?? '127.0.0.1',
    port: int(env.CA_PORT, 4310),
    dataDir,
    sessionSecret: env.CA_SESSION_SECRET ?? '',
    allowedOrigins: list(env.CA_ALLOWED_ORIGINS).length
      ? list(env.CA_ALLOWED_ORIGINS)
      : ['http://127.0.0.1:4310', 'http://localhost:4310', 'http://127.0.0.1:5173'],
    allowHttpLoopback: bool(env.CA_ALLOW_HTTP_LOOPBACK, true),
    allowedProviderHosts: list(env.CA_ALLOWED_PROVIDER_HOSTS),
    logLevel: (env.CA_LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    seedDemo: bool(env.CA_SEED_DEMO, true),
    webDistDir: path.join(root, 'apps/web/dist'),
  };
}
