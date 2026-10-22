/**
 * Credential stores (design section 6.1).
 *
 * - `EnvCredentialStore` resolves logical refs from the server process
 *   environment (`REF` or `REF_FILE` pointing at a restricted key file).
 * - `EncryptedFileCredentialStore` persists UI-saved credentials encrypted with
 *   AES-256-GCM; the master key comes from the environment or a key file that is
 *   kept separate from the database.
 *
 * Invariants: secrets never appear in status strings, error messages or thrown
 * errors; only masked hints leave the store.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CredentialStatus, CredentialStore, ProviderCredentials } from './types';
import { maskCredential } from './mask';

export type CredentialStoreErrorCode =
  | 'invalid_reference'
  | 'invalid_value'
  | 'read_only'
  | 'read_error'
  | 'permission_error'
  | 'too_large'
  | 'master_key_missing'
  | 'master_key_invalid'
  | 'decrypt_failed'
  | 'storage_error';

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;
  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_CREDENTIAL_BYTES = 8_192;
const DEFAULT_MAX_KEY_FILE_BYTES = 64 * 1024;
const MIN_MASTER_KEY_BYTES = 32;

export interface CredentialStoreFs {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number; mode: number }>;
}

const defaultFs: CredentialStoreFs = {
  readFile: (path) => readFile(path, 'utf8'),
  stat: async (path) => {
    const result = await stat(path);
    return { isFile: () => result.isFile(), size: result.size, mode: result.mode };
  },
};

export interface EnvCredentialStoreOptions {
  /** Injectable environment (defaults to `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable restricted-key-file reader for tests. */
  fs?: CredentialStoreFs;
  /** Defaults to `process.platform`; POSIX permission checks are skipped on win32. */
  platform?: NodeJS.Platform;
  /** Maximum accepted key-file size in bytes. Default 64 KiB. */
  maxFileBytes?: number;
}

/** Validate a logical credential reference so it cannot escape the env namespace. */
export function assertCredentialRef(ref: string): string {
  const normalized = typeof ref === 'string' ? ref.trim() : '';
  if (!CREDENTIAL_REF_PATTERN.test(normalized)) {
    throw new CredentialStoreError(
      'invalid_reference',
      'invalid credential reference: expected an env-var style name such as CA_OPENAI_API_KEY',
    );
  }
  return normalized;
}

function validateCredentialValue(value: string, source: string): string {
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (trimmed.length === 0) {
    throw new CredentialStoreError('invalid_value', `credential ${source} is empty`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new CredentialStoreError('invalid_value', `credential ${source} contains control characters`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new CredentialStoreError('invalid_value', `credential ${source} must be a single line`);
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CREDENTIAL_BYTES) {
    throw new CredentialStoreError('too_large', `credential ${source} exceeds the maximum size`);
  }
  return trimmed;
}

function describeCredentialError(error: unknown): string {
  if (error instanceof CredentialStoreError) return error.message;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return `credential store operation failed (${code})`;
  }
  return 'credential store operation failed';
}

function mapFileReadError(error: unknown, maxBytes: number): CredentialStoreError {
  const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new CredentialStoreError('read_error', 'credential key file does not exist or is not readable');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new CredentialStoreError('permission_error', 'credential key file is not readable by the server process');
  }
  if (code === 'EFBIG' || code === 'EISDIR') {
    return new CredentialStoreError('read_error', 'credential key file has an invalid type or size');
  }
  void maxBytes;
  return new CredentialStoreError('read_error', `failed to read credential key file${code ? ` (${code})` : ''}`);
}

/**
 * Resolve credentials from the process environment.
 *
 * Resolution order for ref `R`:
 * 1. `process.env[R]`
 * 2. restricted key file referenced by `process.env[R_FILE]`
 *
 * `set()` is not supported (environment variables are managed by the operator);
 * use `EncryptedFileCredentialStore` for credentials saved from the UI.
 */
export class EnvCredentialStore implements CredentialStore {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fs: CredentialStoreFs;
  readonly #platform: NodeJS.Platform;
  readonly #maxFileBytes: number;

  constructor(options: EnvCredentialStoreOptions = {}) {
    this.#env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
    this.#fs = options.fs ?? defaultFs;
    this.#platform = options.platform ?? process.platform;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_KEY_FILE_BYTES;
  }

  async get(ref: string): Promise<ProviderCredentials | null> {
    const normalizedRef = assertCredentialRef(ref);
    const direct = this.#env[normalizedRef];
    if (typeof direct === 'string' && direct.trim().length > 0) {
      const value = validateCredentialValue(direct, `environment variable ${normalizedRef}`);
      return { value, hint: maskCredential(value) };
    }
    const filePathRaw = this.#env[`${normalizedRef}_FILE`];
    if (typeof filePathRaw !== 'string' || filePathRaw.trim().length === 0) return null;
    const filePath = resolve(filePathRaw.trim());
    const value = await this.#readRestrictedFile(filePath);
    return { value, hint: maskCredential(value) };
  }

  async status(ref: string): Promise<CredentialStatus> {
    try {
      const credentials = await this.get(ref);
      if (!credentials) return { configured: false, hint: null, error: null };
      return { configured: true, hint: credentials.hint, error: null };
    } catch (error) {
      return { configured: false, hint: null, error: describeCredentialError(error) };
    }
  }

  async set(_ref: string, _value: string): Promise<void> {
    throw new CredentialStoreError(
      'read_only',
      'environment credentials are read-only; set the process environment variable or key file instead',
    );
  }

  async #readRestrictedFile(filePath: string): Promise<string> {
    let info: { isFile(): boolean; size: number; mode: number };
    try {
      info = await this.#fs.stat(filePath);
    } catch (error) {
      throw mapFileReadError(error, this.#maxFileBytes);
    }
    if (!info.isFile()) {
      throw new CredentialStoreError('read_error', 'credential key file is not a regular file');
    }
    if (info.size > this.#maxFileBytes) {
      throw new CredentialStoreError('too_large', 'credential key file exceeds the maximum allowed size');
    }
    if (this.#platform !== 'win32') {
      // Reject world/group readable key files on POSIX.
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new CredentialStoreError(
          'permission_error',
          'credential key file permissions are too open; expected 0600',
        );
      }
    }
    let raw: string;
    try {
      raw = await this.#fs.readFile(filePath);
    } catch (error) {
      throw mapFileReadError(error, this.#maxFileBytes);
    }
    if (Buffer.byteLength(raw, 'utf8') > this.#maxFileBytes) {
      throw new CredentialStoreError('too_large', 'credential key file exceeds the maximum allowed size');
    }
    // Key files conventionally end with a newline; only the first non-empty line
    // is the secret, and no further content is silently accepted.
    const lines = raw.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new CredentialStoreError('invalid_value', 'credential key file is empty');
    }
    if (lines.length > 1) {
      throw new CredentialStoreError('invalid_value', 'credential key file must contain exactly one line');
    }
    return validateCredentialValue(lines[0] ?? '', 'key file');
  }
}

/* ------------------------------------------------------------------ */
/* Encrypted file store                                                */
/* ------------------------------------------------------------------ */

interface EncryptedEntry {
  iv: string;
  tag: string;
  ciphertext: string;
  hint: string;
  updatedAt: string;
}

interface StoreDocument {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

export interface EncryptedFileCredentialStoreOptions {
  /** Path of the encrypted credentials JSON file (must not be the database). */
  filePath: string;
  /** Master key bytes/strings; when omitted env/key file are used. */
  masterKey?: Uint8Array | string;
  /** Key file path; defaults to `${filePath}.key`. */
  keyFilePath?: string;
  /** Injectable environment (defaults to `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Environment variable holding the master key. Default CA_CREDENTIALS_MASTER_KEY. */
  masterKeyEnvVar?: string;
  now?: () => number;
}

/**
 * Parse a master key from env/key-file text: base64 (32 bytes), hex (64 chars)
 * or raw 32-byte UTF-8. Anything else is rejected rather than stretched.
 */
export function parseMasterKey(value: Uint8Array | string, sourceLabel = 'master key'): Buffer {
  let buffer: Buffer;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new CredentialStoreError('master_key_invalid', `${sourceLabel} is empty`);
    }
    const bufferFromBase64 = Buffer.from(trimmed, 'base64');
    if (bufferFromBase64.length === MIN_MASTER_KEY_BYTES) return bufferFromBase64;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
    buffer = Buffer.from(trimmed, 'utf8');
  } else {
    buffer = Buffer.from(value);
  }
  if (buffer.length !== MIN_MASTER_KEY_BYTES) {
    throw new CredentialStoreError(
      'master_key_invalid',
      `${sourceLabel} must contain exactly 32 bytes (base64, hex or raw)`,
    );
  }
  return buffer;
}

/**
 * AES-256-GCM encrypted credential store. The file holds per-entry random IVs,
 * auth tags and ciphertexts; the master key is never written to the store file.
 */
export class EncryptedFileCredentialStore implements CredentialStore {
  readonly #filePath: string;
  readonly #keyFilePath: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #masterKeyEnvVar: string;
  readonly #explicitMasterKey: Uint8Array | string | undefined;
  readonly #now: () => number;
  #masterKey: Buffer | null = null;
  #lock: Promise<void> = Promise.resolve();

  constructor(options: EncryptedFileCredentialStoreOptions) {
    if (!options || typeof options.filePath !== 'string' || options.filePath.trim().length === 0) {
      throw new CredentialStoreError('storage_error', 'encrypted credential store requires a file path');
    }
    this.#filePath = resolve(options.filePath);
    this.#keyFilePath = resolve(options.keyFilePath ?? `${options.filePath}.key`);
    this.#env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
    this.#masterKeyEnvVar = options.masterKeyEnvVar ?? 'CA_CREDENTIALS_MASTER_KEY';
    this.#explicitMasterKey = options.masterKey;
    this.#now = options.now ?? (() => Date.now());
  }

  get filePath(): string {
    return this.#filePath;
  }

  get keyFilePath(): string {
    return this.#keyFilePath;
  }

  async get(ref: string): Promise<ProviderCredentials | null> {
    const normalizedRef = assertCredentialRef(ref);
    return this.#withLock(() => this.#getLocked(normalizedRef));
  }

  async status(ref: string): Promise<CredentialStatus> {
    try {
      const credentials = await this.get(ref);
      if (!credentials) return { configured: false, hint: null, error: null };
      return { configured: true, hint: credentials.hint, error: null };
    } catch (error) {
      return { configured: false, hint: null, error: describeCredentialError(error) };
    }
  }

  async set(ref: string, value: string): Promise<void> {
    const normalizedRef = assertCredentialRef(ref);
    await this.#withLock(async () => {
      const document = await this.#readDocument();
      if (typeof value !== 'string' || value.trim().length === 0) {
        delete document.entries[normalizedRef];
        await this.#writeDocument(document);
        return;
      }
      const secret = validateCredentialValue(value, 'value');
      const key = await this.#resolveMasterKey();
      document.entries[normalizedRef] = encryptEntry(key, normalizedRef, secret, this.#now());
      await this.#writeDocument(document);
    });
  }

  /** Remove a stored credential (same as `set(ref, '')`). */
  async clear(ref: string): Promise<void> {
    await this.set(ref, '');
  }

  async #getLocked(ref: string): Promise<ProviderCredentials | null> {
    const document = await this.#readDocument();
    const entry = document.entries[ref];
    if (!entry) return null;
    const key = await this.#resolveMasterKey();
    const value = decryptEntry(key, ref, entry);
    return { value, hint: maskCredential(value) };
  }

  async #readDocument(): Promise<StoreDocument> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      if (code === 'ENOENT') return { version: 1, entries: {} };
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CredentialStoreError('permission_error', 'encrypted credential store is not readable');
      }
      throw new CredentialStoreError('storage_error', `encrypted credential store could not be read (${code || 'IO error'})`);
    }
    if (raw.trim().length === 0) return { version: 1, entries: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialStoreError('storage_error', 'encrypted credential store file is corrupted');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CredentialStoreError('storage_error', 'encrypted credential store file is corrupted');
    }
    const document = parsed as Partial<StoreDocument>;
    if (document.version !== 1) {
      throw new CredentialStoreError('storage_error', 'encrypted credential store version is not supported');
    }
    const entries = document.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new CredentialStoreError('storage_error', 'encrypted credential store file is corrupted');
    }
    return { version: 1, entries: entries as Record<string, EncryptedEntry> };
  }

  async #writeDocument(document: StoreDocument): Promise<void> {
    const directory = dirname(this.#filePath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      /* directory already exists or cannot be created; writeFile below reports */
    }
    const tempPath = `${this.#filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const payload = `${JSON.stringify(document)}\n`;
    try {
      await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.#filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        /* best effort cleanup */
      }
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CredentialStoreError('permission_error', 'encrypted credential store is not writable');
      }
      throw new CredentialStoreError('storage_error', `encrypted credential store could not be written (${code || 'IO error'})`);
    }
  }

  async #resolveMasterKey(): Promise<Buffer> {
    if (this.#masterKey) return this.#masterKey;
    const explicitPresent =
      this.#explicitMasterKey !== undefined &&
      (typeof this.#explicitMasterKey === 'string'
        ? this.#explicitMasterKey.trim().length > 0
        : this.#explicitMasterKey.length > 0);
    const envValue = this.#env[this.#masterKeyEnvVar];
    const envPresent = typeof envValue === 'string' && envValue.trim().length > 0;
    if (explicitPresent) {
      this.#masterKey = parseMasterKey(this.#explicitMasterKey as Uint8Array | string, 'configured master key');
      return this.#masterKey;
    }
    if (envPresent) {
      this.#masterKey = parseMasterKey(envValue as string, `environment variable ${this.#masterKeyEnvVar}`);
      return this.#masterKey;
    }
    // Fall back to a dedicated key file next to (but separate from) the store.
    try {
      const existing = await readFile(this.#keyFilePath, 'utf8');
      this.#masterKey = parseMasterKey(existing, 'credential master key file');
      return this.#masterKey;
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      if (code !== 'ENOENT') {
        throw new CredentialStoreError('master_key_missing', 'credential master key file could not be read');
      }
    }
    // Generate a new key file (0600) atomically. If two processes race, the
    // loser reads back the winner's key instead of overwriting it.
    const generated = randomBytes(MIN_MASTER_KEY_BYTES);
    const directory = dirname(this.#keyFilePath);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(this.#keyFilePath, 'wx', 0o600);
      try {
        await handle.writeFile(`${generated.toString('base64')}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      this.#masterKey = generated;
      return generated;
    } catch (error) {
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      if (code === 'EEXIST') {
        const existing = await readFile(this.#keyFilePath, 'utf8');
        this.#masterKey = parseMasterKey(existing, 'credential master key file');
        return this.#masterKey;
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CredentialStoreError('permission_error', 'credential master key file is not writable');
      }
      throw new CredentialStoreError('master_key_missing', 'credential master key is not configured and no key file could be created');
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function encryptEntry(key: Buffer, ref: string, value: string, nowMs: number): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ref, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    hint: maskCredential(value),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function decryptEntry(key: Buffer, ref: string, entry: EncryptedEntry): string {
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(entry.iv, 'base64');
    tag = Buffer.from(entry.tag, 'base64');
    ciphertext = Buffer.from(entry.ciphertext, 'base64');
  } catch {
    throw new CredentialStoreError('decrypt_failed', 'stored credential is malformed');
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new CredentialStoreError('decrypt_failed', 'stored credential is malformed');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(ref, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return validateCredentialValue(plaintext, 'stored value');
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError(
      'decrypt_failed',
      'stored credential could not be decrypted; the master key may have changed or the store file is corrupted',
    );
  }
}
