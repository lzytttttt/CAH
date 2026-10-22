/**
 * Minimal ZIP writer/reader (store method, UTF-8 names, no compression).
 *
 * Used by task-package export/import. Import treats archives as untrusted:
 * size, entry count, names and hashes are validated before any state is created.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
}

export function writeZip(entries: readonly ZipEntryInput[], now = new Date()): Uint8Array {
  if (entries.length > 5000) throw new Error('archive too many entries');
  const { time, date } = dosDateTime(now);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`duplicate zip entry: ${entry.name}`);
    seen.add(entry.name);
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 name
    view.setUint16(8, 0, true); // store
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint16(10, 0, true);
    cview.setUint16(12, time, true);
    cview.setUint16(14, date, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, entry.data.length, true);
    cview.setUint32(24, entry.data.length, true);
    cview.setUint16(28, nameBytes.length, true);
    cview.setUint16(30, 0, true);
    cview.setUint16(32, 0, true);
    cview.setUint16(34, 0, true);
    cview.setUint16(36, 0, true);
    cview.setUint32(38, 0, true);
    cview.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length;
  }
  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(4, 0, true);
  eview.setUint16(6, 0, true);
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);
  eview.setUint16(20, 0, true);

  return concat([...localChunks, ...centralChunks, end]);
}

export interface ReadZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export function readZip(bytes: Uint8Array, limits: ReadZipLimits): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(view);
  if (eocdOffset < 0) throw new Error('invalid zip: missing end of central directory');
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (entryCount > limits.maxEntries) throw new Error(`too many zip entries: ${entryCount}`);
  let cursor = centralOffset;
  const entries: ZipEntry[] = [];
  let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length) throw new Error('invalid zip: truncated central directory');
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('invalid zip: bad central directory header');
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (method !== 0) throw new Error(`unsupported zip compression method: ${method}`);
    if (compressedSize !== uncompressedSize) throw new Error('invalid zip: stored entry size mismatch');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    assertSafeEntryName(name);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + uncompressedSize > bytes.length) throw new Error('invalid zip: entry data out of bounds');
    const data = bytes.slice(dataStart, dataStart + uncompressedSize);
    if (crc32(data) !== crc) throw new Error(`invalid zip: crc mismatch for ${name}`);
    total += data.length;
    if (total > limits.maxTotalBytes) throw new Error('zip unzipped size limit exceeded');
    entries.push({ name, data, crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

export function assertSafeEntryName(name: string): void {
  if (!name || name.length > 300) throw new Error('invalid zip entry name length');
  if (name.includes('\\')) throw new Error(`invalid zip entry name: ${name}`);
  if (name.startsWith('/')) throw new Error(`absolute zip entry name: ${name}`);
  if (name.includes('\0')) throw new Error('invalid zip entry name: NUL byte');
  for (const part of name.split('/')) {
    if (part === '..' || part === '.') throw new Error(`path traversal in zip entry: ${name}`);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
