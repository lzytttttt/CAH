/**
 * Local token estimation.
 *
 * Used only when a provider omits usage. The result is an explicit local
 * estimate (never presented as provider data): it is intentionally a simple
 * deterministic heuristic, not a tokenizer, and is marked `source: 'estimated'`
 * in every `ModelUsage` produced from it.
 */
import type { ModelRequest, PriceTable } from '@ca/contracts';

/** True for the CJK / Kana / Hangul code-point ranges where 1 char ~= 1 token. */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
    (codePoint >= 0xff00 && codePoint <= 0xffef) // Full-width forms
  );
}

/**
 * Deterministic token estimate: ~4 ASCII chars/token, 1 CJK char/token,
 * ~2 other non-ASCII chars/token. Empty text is 0 tokens.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) ascii += 1;
    else if (isCjkCodePoint(codePoint)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk + other / 2));
}

/** Estimate prompt tokens for a serialized model request (framing included). */
export function estimateRequestTokens(request: ModelRequest): number {
  const payload = {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    responseFormat: request.responseFormat,
  };
  return estimateTokens(JSON.stringify(payload)) + 8;
}

/**
 * Compute a dollar cost from a price table. Returns null when the price table
 * is missing/incomplete or either token count is unknown — a zero is never
 * fabricated for unknown pricing.
 */
export function computeCostUsd(
  priceTable: PriceTable | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  if (!priceTable) return null;
  const inputRate = priceTable.inputPerMillionUsd;
  const outputRate = priceTable.outputPerMillionUsd;
  if (inputRate === null || inputRate === undefined) return null;
  if (outputRate === null || outputRate === undefined) return null;
  if (inputTokens === null || inputTokens === undefined) return null;
  if (outputTokens === null || outputTokens === undefined) return null;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
  if (!Number.isFinite(cost) || cost < 0) return null;
  // Round to sub-cent precision without claiming fake accuracy.
  return Math.round(cost * 1e9) / 1e9;
}
