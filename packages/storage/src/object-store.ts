/**
 * Content-addressed object store (design document section 19.1).
 *
 * Layout: `<root>/<hash[0..2]>/<hash>` plus a small `<hash>.meta.json` sidecar
 * holding the mime type and byte size. Writes are crash safe:
 *
 *   1. write bytes to a temp file in the *same directory*
 *   2. fsync the temp file (and best-effort fsync the directory)
 *   3. atomically rename temp -> final
 *   4. write/rename the mime sidecar
 *
 * A crash can therefore leave a temp file (garbage-collected by `sweepTempFiles`)
 * or a complete, hash-verified object, never a half-written object under a final
 * name. The database only ever references objects after `put()` resolved.
 *
 * The hash is validated as lowercase sha256 hex before it is joined into a path,
 * so `../` traversal is rejected by construction; `pathFor` additionally asserts
 * the resolved path stays inside the store root. Symbolic links at the object
 * path are rejected instead of followed.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, readdirSync, rmSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LIMITS } from '@ca/contracts';
import { StorageError } from './types';
import type { ContentObjectRef, ObjectStorePort } from './types';

const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MIME = 'application/octet-stream';
const MIME_RE = /^[\x21-\x7e][\x20-\x7e]*$/;
const SIDECAR_SUFFIX = '.meta.json';
const TEMP_PREFIX = '.tmp-';

export interface FileObjectStoreOptions {
  /** Maximum accepted object size in bytes. Defaults to LIMITS.maxExportBytes (64 MiB). */
  maxObjectBytes?: number;
  /** fsync object files before rename. Disabling loses crash safety; tests may opt out. */
  fsync?: boolean;
}

export interface StoredObjectInfo {
  hash: string;
  sizeBytes: number;
  mime: string;
  path: string;
}

export interface SweepOptions {
  /**
   * Only delete temp files older than this many milliseconds. `init()` uses a
   * generous age so a concurrent writer in another process is never harmed; an
   * explicit maintenance call defaults to 0 (delete all leftovers).
   */
  minAgeMs?: number;
}

let tempCounter = 0;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function assertHash(hash: string): string {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new StorageError('invalid_hash', `invalid content hash: ${JSON.stringify(hash)}`);
  }
  return hash;
}

function assertMime(mime: string): string {
  const trimmed = typeof mime === 'string' ? mime.trim() : '';
  if (!MIME_RE.test(trimmed) || trimmed.length > 200) {
    throw new StorageError('invalid_mime', `invalid mime type: ${JSON.stringify(mime)}`);
  }
  return trimmed;
}

interface Sidecar {
  hash: string;
  sizeBytes: number;
  mime: string;
}

export class FileObjectStore implements ObjectStorePort {
  readonly root: string;
  readonly maxObjectBytes: number;
  private readonly fsyncEnabled: boolean;
  private initialised = false;

  constructor(rootDir: string, options: FileObjectStoreOptions = {}) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      throw new StorageError('invalid_path', 'object store root must be a non-empty path');
    }
    this.root = path.resolve(rootDir);
    this.maxObjectBytes = options.maxObjectBytes ?? LIMITS.maxExportBytes;
    this.fsyncEnabled = options.fsync ?? true;
  }

  /** Create the store root and clean up temp files from interrupted writes. */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    this.initialised = true;
    // Only reclaim temp files that cannot belong to an in-flight write.
    await this.sweepTempFiles({ minAgeMs: 5 * 60_000 });
  }

  /**
   * Delete leftover temp files from interrupted writes (called at startup and by
   * maintenance tooling). Temp files are created in the shard directory next to
   * the final object, so both the store root and every two-character shard
   * directory are swept. By default, in-flight temp files are skipped by age so a
   * concurrent writer is never corrupted.
   */
  async sweepTempFiles(options: SweepOptions = {}): Promise<number> {
    const minAgeMs = options.minAgeMs ?? 0;
    let removed = 0;
    const sweepDirectory = async (dir: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.startsWith(TEMP_PREFIX)) continue;
        const filePath = path.join(dir, entry);
        if (minAgeMs > 0) {
          const stat = await fs.stat(filePath).catch(() => null);
          if (!stat || Date.now() - stat.mtimeMs < minAgeMs) continue;
        }
        try {
          await fs.rm(filePath, { force: true });
          removed += 1;
        } catch {
          /* best effort */
        }
      }
    };
    await sweepDirectory(this.root);
    let shards: string[] = [];
    try {
      shards = await fs.readdir(this.root);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return removed;
      throw error;
    }
    for (const shard of shards) {
      if (shard.length !== 2 || !/^[0-9a-f]{2}$/.test(shard)) continue;
      await sweepDirectory(path.join(this.root, shard));
    }
    return removed;
  }

  /**
   * Synchronous variant used by the storage constructor (which is synchronous).
   * Safe at startup because no write from this store is in flight yet.
   */
  sweepTempFilesSync(): number {
    let removed = 0;
    const scan = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.startsWith(TEMP_PREFIX)) continue;
        const filePath = path.join(dir, entry);
        try {
          const stat = statSync(filePath);
          if (stat.isFile()) {
            rmSync(filePath, { force: true });
            removed += 1;
          }
        } catch {
          /* best effort */
        }
      }
    };
    scan(this.root);
    let shards: string[] = [];
    try {
      shards = readdirSync(this.root);
    } catch {
      return removed;
    }
    for (const shard of shards) {
      if (shard.length !== 2 || !/^[0-9a-f]{2}$/.test(shard)) continue;
      scan(path.join(this.root, shard));
    }
    return removed;
  }

  async put(bytes: Uint8Array, mime: string): Promise<ContentObjectRef> {
    if (!(bytes instanceof Uint8Array)) {
      throw new StorageError('invalid_content', 'object content must be a Uint8Array');
    }
    const safeMime = assertMime(mime);
    if (bytes.byteLength > this.maxObjectBytes) {
      throw new StorageError(
        'payload_too_large',
        `object is ${bytes.byteLength} bytes which exceeds the ${this.maxObjectBytes} byte limit`,
      );
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const finalPath = this.objectPath(hash);
    const sidecarPath = this.sidecarPath(hash);
    const dir = path.dirname(finalPath);
    await fs.mkdir(dir, { recursive: true });

    const existing = await this.statFile(finalPath);
    if (existing) {
      if (existing.size !== bytes.byteLength) {
        throw new StorageError(
          'object_corrupt',
          `object ${hash} already exists with ${existing.size} bytes (expected ${bytes.byteLength}); the store is corrupt`,
        );
      }
      const sidecar = await this.readSidecar(hash);
      if (!sidecar) {
        await this.writeSidecar(hash, { hash, sizeBytes: bytes.byteLength, mime: safeMime }, sidecarPath);
      }
      return { hash, sizeBytes: bytes.byteLength, mime: sidecar?.mime ?? safeMime };
    }

    const tempPath = path.join(
      dir,
      `${TEMP_PREFIX}${process.pid}-${Date.now().toString(36)}-${(tempCounter += 1)}-${hash.slice(0, 12)}`,
    );
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tempPath, 'wx', 0o644);
      await handle.writeFile(bytes);
      if (this.fsyncEnabled) await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw this.wrapFsError(error, 'write object');
    }
    await handle.close();
    try {
      await fs.rename(tempPath, finalPath);
    } catch (error) {
      // Another writer (or a retried write after a crash) won the race; the
      // content address guarantees identical bytes.
      if (isErrno(error, 'EEXIST') || isErrno(error, 'EPERM')) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        const after = await this.statFile(finalPath);
        if (!after || after.size !== bytes.byteLength) {
          throw new StorageError('object_corrupt', `object ${hash} race resolved to an unexpected file`);
        }
      } else {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw this.wrapFsError(error, 'rename object');
      }
    }
    if (this.fsyncEnabled) await this.syncDirectory(dir);
    await this.writeSidecar(hash, { hash, sizeBytes: bytes.byteLength, mime: safeMime }, sidecarPath);
    return { hash, sizeBytes: bytes.byteLength, mime: safeMime };
  }

  async get(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    assertHash(hash);
    const filePath = this.objectPath(hash);
    await this.assertNotSymlink(filePath);
    let buffer: Buffer;
    try {
      buffer = await this.readFileNoFollow(filePath);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
      if (isErrno(error, 'ELOOP')) {
        throw new StorageError('object_symlink', `refusing to follow symbolic link at ${filePath}`);
      }
      if (isErrno(error, 'EISDIR')) {
        throw new StorageError('object_corrupt', `object path is not a regular file: ${filePath}`);
      }
      throw this.wrapFsError(error, 'read object');
    }
    const sidecar = await this.readSidecar(hash);
    if (sidecar && sidecar.sizeBytes !== buffer.byteLength) {
      throw new StorageError(
        'object_corrupt',
        `object ${hash} has ${buffer.byteLength} bytes but its metadata records ${sidecar.sizeBytes}`,
      );
    }
    if (sidecar && sidecar.hash !== hash) {
      throw new StorageError('object_corrupt', `object ${hash} metadata hash mismatch`);
    }
    return { bytes: new Uint8Array(buffer), mime: sidecar?.mime ?? DEFAULT_MIME };
  }

  async has(hash: string): Promise<boolean> {
    assertHash(hash);
    const info = await this.statFile(this.objectPath(hash));
    return info !== null && info.isFile;
  }

  pathFor(hash: string): string {
    assertHash(hash);
    return this.objectPath(hash);
  }

  /** All complete objects, sorted by hash. Used by backup and diagnostics. */
  async listObjects(): Promise<StoredObjectInfo[]> {
    const out: StoredObjectInfo[] = [];
    let shards: string[];
    try {
      shards = await fs.readdir(this.root);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return out;
      throw error;
    }
    for (const shard of shards.sort()) {
      if (!/^[0-9a-f]{2}$/.test(shard) || shard.length !== 2) continue;
      const shardDir = path.join(this.root, shard);
      let entries: string[];
      try {
        entries = await fs.readdir(shardDir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (!HASH_RE.test(entry)) continue;
        const filePath = path.join(shardDir, entry);
        const info = await this.statFile(filePath);
        if (!info || !info.isFile) continue;
        const sidecar = await this.readSidecar(entry);
        out.push({
          hash: entry,
          sizeBytes: info.size,
          mime: sidecar?.mime ?? DEFAULT_MIME,
          path: filePath,
        });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  private objectPath(hash: string): string {
    const candidate = path.resolve(this.root, hash.slice(0, 2), hash);
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new StorageError('invalid_hash', `object path escapes the store root: ${hash}`);
    }
    return candidate;
  }

  private sidecarPath(hash: string): string {
    return `${this.objectPath(hash)}${SIDECAR_SUFFIX}`;
  }

  private async statFile(filePath: string): Promise<{ size: number; isFile: boolean } | null> {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new StorageError('object_symlink', `refusing to follow symbolic link at ${filePath}`);
      }
      return { size: stat.size, isFile: stat.isFile() };
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
      throw error;
    }
  }

  /**
   * Read an object without following a final-component symlink. `O_NOFOLLOW` is
   * only defined on some platforms (not Windows); there the lstat check in
   * `assertNotSymlink` is the guard and this falls back to a plain read.
   */
  private async readFileNoFollow(filePath: string): Promise<Buffer> {
    const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
    const flags = fsConstants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0);
    const handle = await fs.open(filePath, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new StorageError('object_corrupt', `object path is not a regular file: ${filePath}`);
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private async assertNotSymlink(filePath: string): Promise<void> {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new StorageError('object_symlink', `refusing to follow symbolic link at ${filePath}`);
      }
      if (!stat.isFile()) {
        throw new StorageError('object_corrupt', `object path is not a regular file: ${filePath}`);
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return;
      throw error;
    }
  }

  private async readSidecar(hash: string): Promise<Sidecar | null> {
    try {
      const raw = await fs.readFile(this.sidecarPath(hash), 'utf8');
      const parsed = JSON.parse(raw) as Partial<Sidecar>;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.hash === 'string' &&
        typeof parsed.sizeBytes === 'number' &&
        typeof parsed.mime === 'string'
      ) {
        return { hash: parsed.hash, sizeBytes: parsed.sizeBytes, mime: parsed.mime };
      }
      throw new StorageError('object_corrupt', `metadata sidecar for ${hash} is malformed`);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
      if (error instanceof StorageError) throw error;
      throw new StorageError('object_corrupt', `metadata sidecar for ${hash} is not valid JSON`);
    }
  }

  private async writeSidecar(hash: string, sidecar: Sidecar, sidecarPath: string): Promise<void> {
    const dir = path.dirname(sidecarPath);
    const tempPath = path.join(dir, `${TEMP_PREFIX}meta-${process.pid}-${(tempCounter += 1)}-${hash.slice(0, 12)}`);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tempPath, 'wx', 0o644);
      await handle.writeFile(JSON.stringify(sidecar));
      if (this.fsyncEnabled) await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tempPath, sidecarPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw this.wrapFsError(error, 'write object metadata');
    }
  }

  private async syncDirectory(dir: string): Promise<void> {
    try {
      const handle = await fs.open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* Windows/other platforms may not allow fsync on directories; durability still holds for the file itself. */
    }
  }

  private wrapFsError(error: unknown, action: string): StorageError {
    if (error instanceof StorageError) return error;
    const code = (error as { code?: string }).code ?? 'unknown';
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      return new StorageError('disk_full', `${action}: no space left on device`);
    }
    return new StorageError('object_io_error', `${action} failed: ${(error as Error)?.message ?? String(error)}`);
  }
}

/** Exported for tests: the raw sha256 of a byte buffer (same address as put). */
export function contentAddress(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when the given string looks like a lowercase sha256 address. */
export function isContentHash(value: string): boolean {
  return HASH_RE.test(value);
}
