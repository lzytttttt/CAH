import { describe, expect, it } from 'vitest';
import { writeZip, readZip } from '../src/zip';
import { createZipFixture } from './zip-fixture';

describe('zip writer/reader', () => {
  it('round-trips stored entries with UTF-8 names and crc verification', () => {
    const entries = [
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'artifacts/模块.md', data: new TextEncoder().encode('# 内容\n中文') },
    ];
    const zip = writeZip(entries);
    const out = readZip(zip, { maxEntries: 100, maxTotalBytes: 1024 * 1024 });
    expect(out.map((entry) => entry.name)).toEqual(['manifest.json', 'artifacts/模块.md']);
    expect(new TextDecoder().decode(out[1]!.data)).toBe('# 内容\n中文');
  });

  it('rejects path traversal, absolute paths and oversized archives', () => {
    const evil = createZipFixture([{ name: '../evil.txt', data: new TextEncoder().encode('x') }]);
    expect(() => readZip(evil, { maxEntries: 10, maxTotalBytes: 1024 })).toThrow(/traversal|invalid/i);
    const absolute = createZipFixture([{ name: '/etc/passwd', data: new TextEncoder().encode('x') }]);
    expect(() => readZip(absolute, { maxEntries: 10, maxTotalBytes: 1024 })).toThrow(/absolute/i);
    const big = createZipFixture([{ name: 'a.txt', data: new Uint8Array(200) }]);
    expect(() => readZip(big, { maxEntries: 10, maxTotalBytes: 100 })).toThrow(/limit/i);
  });

  it('is byte-stable for the same entries and timestamp', () => {
    const entries = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }];
    const now = new Date('2026-01-01T00:00:00Z');
    const a = writeZip(entries, now);
    const b = writeZip(entries, now);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });
});
