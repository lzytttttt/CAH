import { describe, expect, it } from 'vitest';
import { canonicalJsonHash, contentHash, sha256Hex, utf8ByteLength } from '@ca/tools';

describe('sha256', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('hashes UTF-8 bytes, not code units', () => {
    expect(sha256Hex('中文')).toBe(sha256Hex(new TextEncoder().encode('中文')));
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('abc')).toBe(3);
  });

  it('is stable across calls', () => {
    expect(sha256Hex('stable input')).toBe(sha256Hex('stable input'));
  });
});

describe('canonical hashes', () => {
  it('sorts object keys so hashes are insertion-order independent', () => {
    const a = { b: 2, a: 1, nested: { z: [1, 2], y: null } };
    const b = { nested: { y: null, z: [1, 2] }, a: 1, b: 2 };
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
    expect(canonicalJsonHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes module content deterministically', () => {
    const content = { kind: 'markdown' as const, sections: [{ id: 'intro', title: 'Intro', markdown: 'hello' }] };
    expect(contentHash(content)).toBe(canonicalJsonHash(content));
    expect(contentHash(content)).not.toBe(canonicalJsonHash({ ...content, sections: [] }));
  });
});
