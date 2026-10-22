/**
 * Credential store tests: env/key-file resolution with masked hints and
 * AES-256-GCM encrypted file storage. No real secrets are used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStoreError,
  EncryptedFileCredentialStore,
  EnvCredentialStore,
  maskCredential,
  parseMasterKey,
} from '../src/index';
import { TEST_CREDENTIAL } from './helpers';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ca-credentials-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('EnvCredentialStore', () => {
  it('resolves a credential from the environment with a masked hint', async () => {
    const store = new EnvCredentialStore({ env: { CA_TEST_PROVIDER_KEY: TEST_CREDENTIAL } });
    const credential = await store.get('CA_TEST_PROVIDER_KEY');
    expect(credential?.value).toBe(TEST_CREDENTIAL);
    expect(credential?.hint).toBe(maskCredential(TEST_CREDENTIAL));
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status).toEqual({ configured: true, hint: maskCredential(TEST_CREDENTIAL), error: null });
  });

  it('resolves a credential from a restricted key file', async () => {
    const keyPath = join(directory, 'provider.key');
    await writeFile(keyPath, `${TEST_CREDENTIAL}\n`, 'utf8');
    const store = new EnvCredentialStore({ env: { CA_TEST_PROVIDER_KEY_FILE: keyPath } });
    const credential = await store.get('CA_TEST_PROVIDER_KEY');
    expect(credential?.value).toBe(TEST_CREDENTIAL);
    expect(credential?.hint).not.toContain('abc123456789');
    expect((await store.status('CA_TEST_PROVIDER_KEY')).configured).toBe(true);
  });

  it('prefers the direct environment variable over the key file', async () => {
    const keyPath = join(directory, 'provider.key');
    await writeFile(keyPath, 'sk-from-file-111122223333', 'utf8');
    const store = new EnvCredentialStore({
      env: { CA_TEST_PROVIDER_KEY: TEST_CREDENTIAL, CA_TEST_PROVIDER_KEY_FILE: keyPath },
    });
    expect((await store.get('CA_TEST_PROVIDER_KEY'))?.value).toBe(TEST_CREDENTIAL);
  });

  it('returns null / unconfigured status when neither source exists', async () => {
    const store = new EnvCredentialStore({ env: {} });
    expect(await store.get('CA_TEST_PROVIDER_KEY')).toBeNull();
    expect(await store.status('CA_TEST_PROVIDER_KEY')).toEqual({ configured: false, hint: null, error: null });
  });

  it('rejects invalid credential references', async () => {
    const store = new EnvCredentialStore({ env: {} });
    await expect(store.get('../etc/passwd')).rejects.toMatchObject({ code: 'invalid_reference' });
    await expect(store.get('WITH SPACE')).rejects.toMatchObject({ code: 'invalid_reference' });
    const status = await store.status('bad ref!');
    expect(status.configured).toBe(false);
    expect(status.error).not.toBeNull();
  });

  it('is read-only for UI-saved credentials', async () => {
    const store = new EnvCredentialStore({ env: {} });
    await expect(store.set('CA_TEST_PROVIDER_KEY', 'value')).rejects.toMatchObject({ code: 'read_only' });
  });

  it('rejects oversized, multiline, and missing key files without leaking the path contents', async () => {
    const oversized = join(directory, 'oversized.key');
    await writeFile(oversized, 'x'.repeat(4096), 'utf8');
    const multiline = join(directory, 'multiline.key');
    await writeFile(multiline, 'line-one\nline-two\n', 'utf8');
    const missing = join(directory, 'missing.key');

    const oversizedStore = new EnvCredentialStore({
      env: { CA_TEST_PROVIDER_KEY_FILE: oversized },
      maxFileBytes: 1024,
    });
    await expect(oversizedStore.get('CA_TEST_PROVIDER_KEY')).rejects.toMatchObject({ code: 'too_large' });

    const multilineStore = new EnvCredentialStore({ env: { CA_TEST_PROVIDER_KEY_FILE: multiline } });
    await expect(multilineStore.get('CA_TEST_PROVIDER_KEY')).rejects.toMatchObject({ code: 'invalid_value' });

    const missingStore = new EnvCredentialStore({ env: { CA_TEST_PROVIDER_KEY_FILE: missing } });
    const status = await missingStore.status('CA_TEST_PROVIDER_KEY');
    expect(status.configured).toBe(false);
    expect(status.error ?? '').not.toContain(directory);
  });

  it('rejects world-readable key files on POSIX', async () => {
    const keyPath = join(directory, 'open.key');
    const store = new EnvCredentialStore({
      env: { CA_TEST_PROVIDER_KEY_FILE: keyPath },
      platform: 'linux',
      fs: {
        stat: async () => ({
          isFile: () => true,
          size: 32,
          mode: 0o644,
        }),
        readFile: async () => TEST_CREDENTIAL,
      },
    });
    await expect(store.get('CA_TEST_PROVIDER_KEY')).rejects.toMatchObject({ code: 'permission_error' });
  });

  it('accepts a 0600 key file on POSIX', async () => {
    const store = new EnvCredentialStore({
      env: { CA_TEST_PROVIDER_KEY_FILE: join(directory, 'secure.key') },
      platform: 'linux',
      fs: {
        stat: async () => ({ isFile: () => true, size: 32, mode: 0o600 }),
        readFile: async () => `${TEST_CREDENTIAL}\n`,
      },
    });
    expect((await store.get('CA_TEST_PROVIDER_KEY'))?.value).toBe(TEST_CREDENTIAL);
  });

  it('never exposes the secret in status error text', async () => {
    const keyPath = join(directory, 'bad.key');
    await writeFile(keyPath, '', 'utf8');
    const store = new EnvCredentialStore({ env: { CA_TEST_PROVIDER_KEY_FILE: keyPath } });
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status.error ?? '').not.toContain(TEST_CREDENTIAL);
  });
});

describe('parseMasterKey', () => {
  it('accepts base64, hex and raw 32-byte keys', () => {
    const bytes = Buffer.alloc(32, 7);
    expect(parseMasterKey(bytes)).toEqual(bytes);
    expect(parseMasterKey(bytes.toString('base64'))).toEqual(bytes);
    expect(parseMasterKey(bytes.toString('hex'))).toEqual(bytes);
    expect(parseMasterKey('a'.repeat(32))).toEqual(Buffer.alloc(32, 97));
  });

  it('rejects wrong-length keys instead of stretching them', () => {
    expect(() => parseMasterKey('too-short')).toThrowError(CredentialStoreError);
    expect(() => parseMasterKey(Buffer.alloc(16))).toThrowError(CredentialStoreError);
    expect(() => parseMasterKey('')).toThrowError(CredentialStoreError);
  });
});

describe('EncryptedFileCredentialStore', () => {
  const masterKey = Buffer.alloc(32, 11);
  const storePath = (): string => join(directory, 'credentials.json');

  it('round-trips a credential with AES-256-GCM and stores no plaintext', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    const credential = await store.get('CA_TEST_PROVIDER_KEY');
    expect(credential?.value).toBe(TEST_CREDENTIAL);
    expect(credential?.hint).not.toContain('abc123456789');
    const onDisk = await readFile(storePath(), 'utf8');
    expect(onDisk).not.toContain(TEST_CREDENTIAL);
    expect(onDisk).not.toContain('abc123456789');
    const parsed = JSON.parse(onDisk) as { version: number; entries: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.entries)).toEqual(['CA_TEST_PROVIDER_KEY']);
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status.configured).toBe(true);
    expect(status.hint).toBe(maskCredential(TEST_CREDENTIAL));
  });

  it('persists across instances using the same master key', async () => {
    const first = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await first.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    const second = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    expect((await second.get('CA_TEST_PROVIDER_KEY'))?.value).toBe(TEST_CREDENTIAL);
  });

  it('clears a credential with an empty value', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    await store.set('CA_TEST_PROVIDER_KEY', '');
    expect(await store.get('CA_TEST_PROVIDER_KEY')).toBeNull();
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    await store.clear('CA_TEST_PROVIDER_KEY');
    expect(await store.get('CA_TEST_PROVIDER_KEY')).toBeNull();
  });

  it('fails closed with decrypt_failed when the master key changes', async () => {
    const first = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await first.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    const wrongKey = new EncryptedFileCredentialStore({
      filePath: storePath(),
      masterKey: Buffer.alloc(32, 12),
      env: {},
    });
    await expect(wrongKey.get('CA_TEST_PROVIDER_KEY')).rejects.toMatchObject({ code: 'decrypt_failed' });
    const status = await wrongKey.status('CA_TEST_PROVIDER_KEY');
    expect(status.configured).toBe(false);
    expect(status.error ?? '').not.toContain(TEST_CREDENTIAL);
  });

  it('uses a master key from the environment when configured', async () => {
    const env = { CA_CREDENTIALS_MASTER_KEY: masterKey.toString('base64') };
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), env });
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    const reopened = new EncryptedFileCredentialStore({ filePath: storePath(), env });
    expect((await reopened.get('CA_TEST_PROVIDER_KEY'))?.value).toBe(TEST_CREDENTIAL);
  });

  it('generates a dedicated master key file that is separate from the store', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), env: {} });
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    const keyPath = store.keyFilePath;
    expect(keyPath).not.toBe(storePath());
    const keyInfo = await stat(keyPath);
    expect(keyInfo.isFile()).toBe(true);
    expect(keyInfo.size).toBeGreaterThan(0);
    expect(keyInfo.size).toBeLessThanOrEqual(128);
    const keyText = (await readFile(keyPath, 'utf8')).trim();
    expect(Buffer.from(keyText, 'base64').length).toBe(32);
    // Another instance (e.g. next process start) reads the same key file.
    const reopened = new EncryptedFileCredentialStore({ filePath: storePath(), env: {} });
    expect((await reopened.get('CA_TEST_PROVIDER_KEY'))?.value).toBe(TEST_CREDENTIAL);
  });

  it('rejects invalid master key configuration', async () => {
    const store = new EncryptedFileCredentialStore({
      filePath: storePath(),
      env: { CA_CREDENTIALS_MASTER_KEY: 'too-short' },
    });
    await expect(store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL)).rejects.toMatchObject({
      code: 'master_key_invalid',
    });
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status.configured).toBe(false);
  });

  it('fails closed on a corrupted store file', async () => {
    await writeFile(storePath(), 'not json at all', 'utf8');
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await expect(store.get('CA_TEST_PROVIDER_KEY')).rejects.toMatchObject({ code: 'storage_error' });
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status.error ?? '').toContain('corrupted');
  });

  it('serializes concurrent writes without losing entries', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await Promise.all([
      store.set('CA_KEY_A', 'sk-aaaaaaaaaaaaaaaa1111'),
      store.set('CA_KEY_B', 'sk-bbbbbbbbbbbbbbbb2222'),
      store.set('CA_KEY_C', 'sk-cccccccccccccccc3333'),
    ]);
    expect((await store.get('CA_KEY_A'))?.value).toBe('sk-aaaaaaaaaaaaaaaa1111');
    expect((await store.get('CA_KEY_B'))?.value).toBe('sk-bbbbbbbbbbbbbbbb2222');
    expect((await store.get('CA_KEY_C'))?.value).toBe('sk-cccccccccccccccc3333');
  });

  it('validates refs and credential values', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await expect(store.set('../escape', TEST_CREDENTIAL)).rejects.toMatchObject({ code: 'invalid_reference' });
    await expect(store.set('CA_TEST_PROVIDER_KEY', 'line\r\nbreak')).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await expect(store.set('CA_TEST_PROVIDER_KEY', 'x'.repeat(9000))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('never leaks the secret in a status error', async () => {
    const store = new EncryptedFileCredentialStore({ filePath: storePath(), masterKey, env: {} });
    await store.set('CA_TEST_PROVIDER_KEY', TEST_CREDENTIAL);
    await writeFile(storePath(), '{"version":1,"entries":{"CA_TEST_PROVIDER_KEY":{"iv":"AA==","tag":"AA==","ciphertext":"AA==","hint":"x","updatedAt":"2026-01-01T00:00:00.000Z"}}}', 'utf8');
    const status = await store.status('CA_TEST_PROVIDER_KEY');
    expect(status.error ?? '').not.toContain(TEST_CREDENTIAL);
    expect(JSON.stringify(status)).not.toContain('abc123456789');
  });
});
