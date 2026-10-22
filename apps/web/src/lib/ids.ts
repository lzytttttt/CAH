/** Small pure helpers shared by the API layer and UI. */

/** RFC 4122 v4 UUID from the platform crypto; fails loudly when unavailable. */
export function randomUuid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('crypto.randomUUID / crypto.getRandomValues 不可用，无法生成命令 ID');
}

export interface CommandIds {
  commandId: string;
  expectedRevision?: number;
}

/** Build the idempotency envelope for a mutating command. */
export function commandEnvelope(expectedRevision?: number): { commandId: string } & { expectedRevision?: number } {
  if (expectedRevision == null) return { commandId: randomUuid() };
  return { commandId: randomUuid(), expectedRevision };
}

/** Short id for compact display without hiding identity from tooltips/aria labels. */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}

/** Deterministic bytes -> base64 without Node Buffer (browser-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Human byte size for helper text (<= 12px helper font is fine). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
