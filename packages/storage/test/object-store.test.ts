import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileObjectStore } from '../src/object-store';
import { sha256Hex } from '../src/hash';
import { StorageError } from '../src/types';

const tempDirs: string[] = [];

async function makeStore(options: { maxObjectBytes?: number; fsync?: boolean } = {}): Promise<{
  root: string;
  store: FileObjectStore;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ca-objects-'));
  tempDirs.push(root);
  const store = new FileObjectStore(path.join(root, 'objects'), options);
  await store.init();
  return { root, store };
}

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listAllFiles(full)));
    else out.push(full);
  }
  return out;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('FileObjectStore', () => {
  it('stores bytes by sha256 address with mime metadata', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('hello object 世界');
    const ref = await store.put(bytes, 'text/plain');
    expect(ref.hash).toBe(sha256Hex(bytes));
    expect(ref.sizeBytes).toBe(bytes.byteLength);
    expect(ref.mime).toBe('text/plain');

    expect(await store.has(ref.hash)).toBe(true);
    const loaded = await store.get(ref.hash);
    expect(new Uint8Array(loaded!.bytes)).toEqual(bytes);
    expect(loaded!.mime).toBe('text/plain');
    expect(store.pathFor(ref.hash)).toBe(path.join(store.root, ref.hash.slice(0, 2), ref.hash));
    expect(await store.has('b'.repeat(64))).toBe(false);
    expect(await store.get('b'.repeat(64))).toBeNull();
  });

  it('is idempotent for duplicate and concurrent writes of identical content', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('same content');
    const first = await store.put(bytes, 'application/json');
    const second = await store.put(bytes, 'application/json');
    expect(second.hash).toBe(first.hash);
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => store.put(bytes, 'application/json')));
    expect(new Set(concurrent.map((ref) => ref.hash)).size).toBe(1);
    expect(await store.has(first.hash)).toBe(true);
    // No temp files remain after writes (crash leftovers are swept on init).
    const files = await listAllFiles(store.root);
    expect(files.some((file) => path.basename(file).startsWith('.tmp-'))).toBe(false);
  });

  it('handles empty content and rejects invalid mime types', async () => {
    const { store } = await makeStore();
    const empty = await store.put(new Uint8Array(0), 'application/octet-stream');
    expect(empty.sizeBytes).toBe(0);
    expect((await store.get(empty.hash))!.bytes.byteLength).toBe(0);

    await expect(store.put(new TextEncoder().encode('x'), '')).rejects.toMatchObject({ code: 'invalid_mime' });
    await expect(store.put(new TextEncoder().encode('x'), 'bad\nmime')).rejects.toMatchObject({ code: 'invalid_mime' });
  });

  it('enforces the configured size limit before writing', async () => {
    const { store } = await makeStore({ maxObjectBytes: 8 });
    await expect(store.put(new TextEncoder().encode('123456789'), 'text/plain')).rejects.toMatchObject({
      code: 'payload_too_large',
    });
    expect(await store.listObjects()).toEqual([]);
    const ok = await store.put(new TextEncoder().encode('12345678'), 'text/plain');
    expect(await store.has(ok.hash)).toBe(true);
  });

  it('rejects path traversal and malformed hashes instead of touching the filesystem', async () => {
    const { store } = await makeStore();
    for (const bad of ['..', '../etc/passwd', 'a'.repeat(63), 'A'.repeat(64), '/absolute', 'zz'.repeat(32)]) {
      expect(() => store.pathFor(bad)).toThrow(StorageError);
      await expect(store.get(bad)).rejects.toBeInstanceOf(StorageError);
      await expect(store.has(bad)).rejects.toBeInstanceOf(StorageError);
    }
    await expect(store.put(new TextEncoder().encode('x'), 'text/plain')).resolves.toBeTruthy();
  });

  it('lists objects with metadata for backup manifests', async () => {
    const { store } = await makeStore();
    const a = await store.put(new TextEncoder().encode('a'), 'text/markdown');
    const b = await store.put(new TextEncoder().encode('bb'), 'application/json');
    const listing = await store.listObjects();
    expect(listing.map((entry) => entry.hash)).toEqual([a.hash, b.hash].sort());
    const entry = listing.find((candidate) => candidate.hash === b.hash)!;
    expect(entry.sizeBytes).toBe(2);
    expect(entry.mime).toBe('application/json');
    expect(entry.path.startsWith(store.root)).toBe(true);
  });

  it('recovers readable objects whose metadata sidecar is missing and repairs it on rewrite', async () => {
    const { store } = await makeStore();
    const bytes = new TextEncoder().encode('sidecarless');
    const ref = await store.put(bytes, 'text/plain');
    await fs.rm(`${store.pathFor(ref.hash)}.meta.json`, { force: true });
    const loaded = await store.get(ref.hash);
    expect(new Uint8Array(loaded!.bytes)).toEqual(bytes);
    expect(loaded!.mime).toBe('application/octet-stream');
    // Re-put is idempotent and restores the sidecar.
    await store.put(bytes, 'text/plain');
    expect((await store.get(ref.hash))!.mime).toBe('text/plain');
  });

  it('sweeps crash-left temp files from the root and shard directories only', async () => {
    const { store } = await makeStore();
    const ref = await store.put(new TextEncoder().encode('kept'), 'text/plain');
    const shardDir = path.dirname(store.pathFor(ref.hash));
    await fs.writeFile(path.join(shardDir, '.tmp-crash-1'), 'partial');
    await fs.writeFile(path.join(store.root, '.tmp-crash-2'), 'partial');
    const removed = await store.sweepTempFiles();
    expect(removed).toBe(2);
    expect(await store.has(ref.hash)).toBe(true);
    expect((await store.get(ref.hash))!.bytes.byteLength).toBe(4);
    const leftovers = (await listAllFiles(store.root)).filter((file) => path.basename(file).startsWith('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to follow symbolic links at an object path', async () => {
    const { store } = await makeStore();
    const target = path.join(store.root, 'target.bin');
    await fs.writeFile(target, 'real bytes');
    const hash = sha256Hex('real bytes');
    const objectPath = store.pathFor(hash);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    try {
      await fs.symlink(target, objectPath);
    } catch (error) {
      // Windows without developer mode cannot create symlinks; nothing to assert there.
      if ((error as { code?: string }).code === 'EPERM') return;
      throw error;
    }
    await expect(store.get(hash)).rejects.toMatchObject({ code: 'object_symlink' });
    await expect(store.has(hash)).rejects.toMatchObject({ code: 'object_symlink' });
  });
});
