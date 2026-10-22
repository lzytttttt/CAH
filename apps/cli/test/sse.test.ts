import { describe, expect, it } from 'vitest';
import { encodeSseEvent, parseSseText } from '../src/sse';

describe('SSE parser', () => {
  it('parses id/event/data fields, comments and multi-line data', async () => {
    const body = [
      ': heartbeat',
      'id: 1',
      'event: run.state_changed',
      'data: {"a":1}',
      'data: {"b":2}',
      '',
      'id: 2',
      'retry: 500',
      'data: plain text',
      '',
      '',
    ].join('\n');
    const messages = await parseSseText(body);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: '1', event: 'run.state_changed', data: '{"a":1}\n{"b":2}' });
    expect(messages[1]).toMatchObject({ id: '2', retry: 500, data: 'plain text' });
  });

  it('tolerates CRLF line endings and chunk boundaries inside a field', async () => {
    const encoder = new TextEncoder();
    const full = 'id: 7\r\nevent: step.started\r\ndata: {"x":1}\r\n\r\n';
    const cuts = [3, 10, 25, 40];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        for (const cut of cuts) {
          controller.enqueue(encoder.encode(full.slice(offset, cut)));
          offset = cut;
        }
        controller.enqueue(encoder.encode(full.slice(offset)));
        controller.close();
      },
    });
    const messages: Array<Record<string, unknown>> = [];
    for await (const message of (await import('../src/sse')).parseSse(stream)) messages.push(message as unknown as Record<string, unknown>);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '7', event: 'step.started', data: '{"x":1}' });
  });

  it('ignores unknown fields and empty dispatches', async () => {
    const messages = await parseSseText('foo: bar\n\n: comment only\n\nid: 9\ndata: hi\n\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '9', data: 'hi' });
  });

  it('encodes events back to the wire format round-trip', async () => {
    const encoded = encodeSseEvent({ id: 3, type: 'run.completed', data: { ok: true } });
    const messages = await parseSseText(encoded);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '3', event: 'run.completed', data: '{"ok":true}' });
  });
});
