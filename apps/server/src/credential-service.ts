import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CredentialStatus, CredentialStore, ProviderCredentials } from '@ca/providers';
import type { ServerConfig } from './config';

interface SecretsFile {
  version: 1;
  entries: Record<string, { iv: string; tag: string; ciphertext: string; hint: string; updatedAt: string }>;
}

/**
 * Server-side credential access (design 6.1):
 * - env var `REF` or restricted file env `REF_FILE`;
 * - optional encrypted-at-rest store for UI-saved credentials, encrypted with a
 *   master key kept outside the database (CA_CREDENTIALS_MASTER_KEY).
 * Values never leave the server: only masked hints/status are exposed.
 */
export class ServerCredentialStore implements CredentialStore {
  private readonly secretsFile: string;
  private readonly masterKey: string | null;
  private cache: SecretsFile | null = null;

  constructor(config: ServerConfig) {
    this.secretsFile = path.join(config.dataDir, 'credentials.enc.json');
    this.masterKey = config.credentialsMasterKey.trim().length >= 16 ? config.credentialsMasterKey.trim() : null;
  }

  async get(ref: string): Promise<ProviderCredentials | null> {
    const fromEnv = resolveEnv(ref);
    if (fromEnv) return { value: fromEnv, hint: maskCredential(fromEnv) };
    const stored = await this.readStored(ref);
    if (!stored) return null;
    try {
      const decrypted = this.decrypt(stored);
      return { value: decrypted, hint: stored.hint };
    } catch {
      return null;
    }
  }

  async status(ref: string): Promise<CredentialStatus> {
    const fromEnv = resolveEnv(ref);
    if (fromEnv) return { configured: true, hint: maskCredential(fromEnv), error: null };
    const stored = await this.readStored(ref);
    if (!stored) {
      return {
        configured: false,
        hint: null,
        error: `凭据 ${ref} 未配置（可设置环境变量 ${ref}，或在设置中保存）`,
      };
    }
    if (!this.masterKey) {
      return {
        configured: true,
        hint: stored.hint,
        error: '凭据已保存，但当前进程未配置主密钥，无法解密',
      };
    }
    return { configured: true, hint: stored.hint, error: null };
  }

  async set(ref: string, value: string): Promise<void> {
    if (value.trim().length === 0) {
      const file = await this.readFile();
      delete file.entries[ref];
      await this.writeFile(file);
      return;
    }
    if (!this.masterKey) {
      throw new Error('未配置主密钥 CA_CREDENTIALS_MASTER_KEY，拒绝在明文/无密钥状态下保存凭据');
    }
    const file = await this.readFile();
    const encrypted = this.encrypt(value);
    file.entries[ref] = {
      ...encrypted,
      hint: maskCredential(value),
      updatedAt: new Date().toISOString(),
    };
    await this.writeFile(file);
  }

  private async readStored(ref: string): Promise<SecretsFile['entries'][string] | null> {
    if (!this.masterKey) return null;
    const file = await this.readFile();
    return file.entries[ref] ?? null;
  }

  private async readFile(): Promise<SecretsFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.secretsFile, 'utf8')) as SecretsFile;
      if (raw.version !== 1 || typeof raw.entries !== 'object') throw new Error('bad secrets file');
      this.cache = raw;
      return raw;
    } catch {
      this.cache = { version: 1, entries: {} };
      return this.cache;
    }
  }

  private async writeFile(file: SecretsFile): Promise<void> {
    await fs.mkdir(path.dirname(this.secretsFile), { recursive: true });
    const tmp = `${this.secretsFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600, encoding: 'utf8' });
    await fs.rename(tmp, this.secretsFile);
    this.cache = file;
  }

  private key(): Buffer {
    if (!this.masterKey) throw new Error('missing master key');
    return scryptSync(this.masterKey, 'cognitive-atrium-credentials-v1', 32);
  }

  private encrypt(value: string): { iv: string; tag: string; ciphertext: string } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(entry: { iv: string; tag: string; ciphertext: string }): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Demo mode never resolves real credentials. */
export class NoopCredentialStore implements CredentialStore {
  async get(): Promise<ProviderCredentials | null> {
    return null;
  }
  async status(ref: string): Promise<CredentialStatus> {
    return { configured: false, hint: null, error: `演示模式不读取真实凭据（${ref}）` };
  }
  async set(): Promise<void> {
    throw new Error('演示模式不允许保存真实凭据');
  }
}

function resolveEnv(ref: string): string | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) return null;
  const direct = process.env[ref];
  if (direct && direct.trim().length > 0) return direct.trim();
  const fileVar = process.env[`${ref}_FILE`];
  if (fileVar) {
    try {
      // Synchronous read is acceptable for startup/credential resolution only.
      const fsSync = require('node:fs') as typeof import('node:fs');
      const value = fsSync.readFileSync(fileVar, 'utf8').trim();
      if (value.length > 0) return value;
    } catch {
      return null;
    }
  }
  return null;
}

export function maskCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
