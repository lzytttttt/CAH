/**
 * Pure SHA-256 + UTF-8 helpers.
 *
 * No Node.js built-ins: the same code runs in the browser bundle and in tests,
 * and hashes are stable across platforms. Used for evidence quote hashes,
 * content-addressed object hashes and normalized tool-result hashes.
 */
import { canonicalJson, type ModuleContent } from '@ca/contracts';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const UTF8_ENCODER = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

export function utf8ByteLength(text: string): number {
  // TextEncoder is a platform primitive available in Node and browsers, and is
  // what actually defines the byte size; no locale dependence.
  return UTF8_ENCODER.encode(text).length;
}

/** Lowercase hex SHA-256 of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  return toHex(sha256Bytes(bytes));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  // message + 0x80 + zero padding + 8-byte big-endian length, multiple of 64
  const paddedLength = (((input.length + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  const tail = paddedLength - 8;
  padded[tail] = (high >>> 24) & 0xff;
  padded[tail + 1] = (high >>> 16) & 0xff;
  padded[tail + 2] = (high >>> 8) & 0xff;
  padded[tail + 3] = high & 0xff;
  padded[tail + 4] = (low >>> 24) & 0xff;
  padded[tail + 5] = (low >>> 16) & 0xff;
  padded[tail + 6] = (low >>> 8) & 0xff;
  padded[tail + 7] = low & 0xff;

  const w = new Uint32Array(64);
  const h = INITIAL_HASH.slice();

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((padded[j]! << 24) | (padded[j + 1]! << 16) | (padded[j + 2]! << 8) | padded[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const value = h[i]!;
    out[i * 4] = (value >>> 24) & 0xff;
    out[i * 4 + 1] = (value >>> 16) & 0xff;
    out[i * 4 + 2] = (value >>> 8) & 0xff;
    out[i * 4 + 3] = value & 0xff;
  }
  return out;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 of the contract-canonical JSON encoding (sorted keys, no spaces). */
export function canonicalJsonHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Content hash of a module content value: sha256 of canonical JSON.
 * This is the same definition used for `PatchProposal.candidateHash` and
 * `ArtifactVersion.contentHash`.
 */
export function contentHash(content: ModuleContent): string {
  return canonicalJsonHash(content);
}
