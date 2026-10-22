/**
 * Incremental Server-Sent Events decoder for provider streaming responses.
 *
 * Works on decoded text chunks of arbitrary size, so callers can feed it
 * whatever a `ReadableStream` yields. Handles LF / CRLF / CR record separators,
 * comments, multi-line `data:` fields, the BOM and a final record without a
 * trailing blank line.
 */

export interface SseRecord {
  /** Event name from `event:` (null when absent). */
  event: string | null;
  /** Joined `data:` payload (multi-line per SSE spec). */
  data: string;
  /** Last `id:` value when present. */
  id: string | null;
  /** Last `retry:` value (milliseconds) when present and numeric. */
  retry: number | null;
}

const RECORD_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE_SEPARATOR = /\r\n|\n|\r/;

export class SseDecoder {
  #buffer = '';
  #sawBom = false;

  /** Feed a decoded text chunk; returns all complete records. */
  push(chunk: string): SseRecord[] {
    if (typeof chunk !== 'string' || chunk.length === 0) return [];
    let text = chunk;
    if (!this.#sawBom) {
      this.#sawBom = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.#buffer += text;
    return this.#drain(false);
  }

  /** Flush any pending bytes as a final record (called at end of stream). */
  end(): SseRecord[] {
    const records = this.#drain(true);
    this.#buffer = '';
    return records;
  }

  /** True when a partial record is buffered (useful diagnostics). */
  get pending(): string {
    return this.#buffer;
  }

  #drain(final: boolean): SseRecord[] {
    const records: SseRecord[] = [];
    while (true) {
      const match = RECORD_SEPARATOR.exec(this.#buffer);
      if (!match) break;
      const block = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const record = parseSseBlock(block);
      if (record) records.push(record);
    }
    if (final && this.#buffer.trim().length > 0) {
      const record = parseSseBlock(this.#buffer);
      this.#buffer = '';
      if (record) records.push(record);
    }
    return records;
  }
}

/** Parse one raw SSE block into a record; returns null for comment-only blocks. */
export function parseSseBlock(block: string): SseRecord | null {
  if (!block || block.trim().length === 0) return null;
  const dataLines: string[] = [];
  let event: string | null = null;
  let id: string | null = null;
  let retry: number | null = null;
  for (const line of block.split(LINE_SEPARATOR)) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      case 'retry': {
        const parsed = Number(value);
        retry = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
        break;
      }
      default:
        break; // unknown fields are ignored per the SSE spec
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n'), id, retry };
}
