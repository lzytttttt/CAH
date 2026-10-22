/**
 * Server-Sent Events parser for `events tail` and run watching.
 *
 * Implements the SSE wire format we freeze in the design (section 18.2):
 *   id: <seq>
 *   event: <type>
 *   data: <HarnessEvent JSON>
 *   : heartbeat comment
 *
 * The parser is transport-only: duplicate `seq` suppression and gap recovery
 * happen in the command layer, where the task snapshot is available.
 */

export interface SseMessage {
  id: string | null;
  event: string | null;
  data: string;
  retry: number | null;
}

/** TextDecoder-based incremental parser; tolerates arbitrary chunk boundaries. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pendingId: string | null = null;
  let pendingEvent: string | null = null;
  let pendingRetry: number | null = null;
  let dataLines: string[] = [];

  const dispatch = (): SseMessage | null => {
    if (dataLines.length === 0) {
      pendingId = null;
      pendingEvent = null;
      pendingRetry = null;
      return null;
    }
    const message: SseMessage = {
      id: pendingId,
      event: pendingEvent,
      data: dataLines.join('\n'),
      retry: pendingRetry,
    };
    pendingId = null;
    pendingEvent = null;
    pendingRetry = null;
    dataLines = [];
    return message;
  };

  try {
    for (;;) {
      if (options.signal?.aborted) {
        throw abortError(options.signal.reason);
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const message = dispatch();
          if (message) yield message;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / heartbeat
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
          case 'id':
            pendingId = value;
            break;
          case 'event':
            pendingEvent = value;
            break;
          case 'data':
            dataLines.push(value);
            break;
          case 'retry': {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 0) pendingRetry = parsed;
            break;
          }
          default:
            // Unknown fields are ignored per the SSE spec.
            break;
        }
      }
    }
    buffer += decoder.decode();
    // A final line without trailing newline is still a field.
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line !== '' && !line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        else if (field === 'id') pendingId = value;
        else if (field === 'event') pendingEvent = value;
      }
    }
    // The spec dispatches only on a blank line; a well-formed server always sends
    // one. Dispatching a trailing message without it keeps a truncated-but-valid
    // JSON event from being silently lost.
    const last = dispatch();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** Parse a complete SSE response body (used by tests and non-streaming debug). */
export async function parseSseText(text: string): Promise<SseMessage[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const messages: SseMessage[] = [];
  for await (const message of parseSse(stream)) messages.push(message);
  return messages;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Encode one SSE event (fake-server helper and future client-side tests). */
export function encodeSseEvent(event: { id?: string | number; type?: string; data: unknown }): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.type !== undefined) lines.push(`event: ${event.type}`);
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  for (const line of data.split('\n')) lines.push(`data: ${line}`);
  lines.push('');
  return lines.join('\n');
}
