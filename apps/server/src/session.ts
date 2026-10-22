import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { ServerConfig } from './config';
import { fail } from './errors';

export const SESSION_COOKIE = 'ca_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthResult {
  ok: boolean;
  via: 'cookie' | 'bearer' | null;
  csrfValid: boolean;
  originAllowed: boolean;
}

/**
 * Local single-user session protection:
 * - a random 256-bit token lives in `<dataDir>/session-token` (never in the DB);
 * - browsers receive it as an HttpOnly SameSite=Strict cookie;
 * - CLI sends it as `Authorization: Bearer`;
 * - cookie-authenticated writes additionally require the CSRF header;
 * - every API request with an Origin header is checked against the allow-list,
 *   because "running on localhost" is not authentication.
 */
export class SessionManager {
  readonly token: string;
  readonly csrfToken: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly tokenFile: string;

  private constructor(token: string, config: ServerConfig) {
    this.token = token;
    this.csrfToken = deriveCsrfToken(token);
    this.allowedOrigins = new Set(config.allowedOrigins);
    this.tokenFile = config.sessionTokenFile;
  }

  static async create(config: ServerConfig): Promise<SessionManager> {
    const token = await ensureTokenFile(config.sessionTokenFile, config.sessionSecret);
    return new SessionManager(token, config);
  }

  get tokenFilePath(): string {
    return this.tokenFile;
  }

  originAllowed(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // same-origin navigations / CLI / tests have no Origin
    return this.allowedOrigins.has(origin);
  }

  authenticate(request: FastifyRequest): AuthResult {
    const originAllowed = this.originAllowed(request);
    const auth = request.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const provided = auth.slice('Bearer '.length).trim();
      if (constantTimeEqual(provided, this.token)) {
        return { ok: true, via: 'bearer', csrfValid: true, originAllowed };
      }
    }
    const cookieToken = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (cookieToken && constantTimeEqual(cookieToken, this.token)) {
      const header = request.headers[CSRF_HEADER];
      const csrf = Array.isArray(header) ? header[0] : header;
      return {
        ok: true,
        via: 'cookie',
        csrfValid: typeof csrf === 'string' && constantTimeEqual(csrf, this.csrfToken),
        originAllowed,
      };
    }
    return { ok: false, via: null, csrfValid: false, originAllowed };
  }

  /** Throw the correct HTTP failure for an unauthorized request. */
  requireAuthorized(request: FastifyRequest, opts: { write: boolean }): void {
    const result = this.authenticate(request);
    if (!result.originAllowed) {
      throw fail.originNotAllowed(request.headers.origin ?? '');
    }
    if (!result.ok) {
      throw fail.sessionRequired(
        '需要本地会话。请在同一浏览器打开界面，或让 CLI 读取 data/session-token 并通过 Authorization: Bearer 发送。',
      );
    }
    if (opts.write && result.via === 'cookie' && !result.csrfValid) {
      throw fail.forbidden('写命令缺少有效的 CSRF 令牌（x-csrf-token）');
    }
  }

  cookieHeader(): string {
    // Loopback HTTP: SameSite=Strict is enough without Secure for the local P0 threat model.
    return `${SESSION_COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`;
  }
}

function deriveCsrfToken(token: string): string {
  return createHmac('sha256', token).update('cognitive-atrium-csrf').digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key?.trim() === name) return decodeURIComponent(rest.join('=').trim());
  }
  return null;
}

async function ensureTokenFile(file: string, explicitSecret: string): Promise<string> {
  if (explicitSecret.trim().length >= 32) return explicitSecret.trim();
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through and generate
  }
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${token}\n`, { mode: 0o600, encoding: 'utf8' });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows may not support chmod; the file lives in the local data dir.
  }
  return token;
}
