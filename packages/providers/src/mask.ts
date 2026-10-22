/**
 * Credential masking / redaction helpers.
 *
 * These helpers are intentionally dependency-free and pure so they can be used
 * from every layer that might surface provider-controlled text (adapter errors,
 * credential store diagnostics, logs). They must never reveal a full secret.
 */

const MASK_PLACEHOLDER = '\u2026'; // horizontal ellipsis

/**
 * Build a short, non-reversible hint for a credential: `sk-\u2026abcd`.
 *
 * The full value is never returned. Values shorter than 12 characters are
 * fully masked because a prefix/suffix would reveal too much of the secret.
 */
export function maskCredential(value: string): string {
  const normalized = (value ?? '').trim();
  if (normalized.length === 0) return '';
  if (normalized.length < 12) return '\u2022\u2022\u2022\u2022\u2022\u2022';
  const prefixMatch = /^(sk|pk|rk|ak|api|key)[-_]/i.exec(normalized);
  const prefix = prefixMatch ? normalized.slice(0, prefixMatch[0].length) : '';
  return `${prefix}${MASK_PLACEHOLDER}${normalized.slice(-4)}`;
}

/**
 * Redact known secret values plus common credential shapes from arbitrary text.
 *
 * Used before a provider-controlled message is surfaced to a user, persisted in
 * an event or written to a log. Redaction is best effort but always replaces the
 * exact credential the caller knows about.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let output = text;
  for (const raw of secrets) {
    const secret = typeof raw === 'string' ? raw.trim() : '';
    if (secret.length < 4) continue;
    // Replace the exact secret plus its URL-encoded variant (providers sometimes
    // echo query strings in error messages).
    output = output.split(secret).join(maskCredential(secret));
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) output = output.split(encoded).join(maskCredential(secret));
  }
  // Common key shapes even if the caller did not pass the concrete value.
  output = output.replace(/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{6,}\b/g, (match) => maskCredential(match));
  output = output.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  output = output.replace(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi,
    '$1[redacted]',
  );
  return output;
}
