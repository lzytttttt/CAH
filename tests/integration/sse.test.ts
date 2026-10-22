import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHarness, type TestHarness } from './helpers';
import { plannerOutputFor, ScriptedProviderGateway } from './fakes/scripted-provider';

const uuid = (): string => crypto.randomUUID();

async function inject(harness: TestHarness, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await harness.app.inject({ method, url, headers: harness.headers, payload: payload as never });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string | null;
}

function parseFrames(buffer: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of buffer.split('\n\n')) {
    if (!block.trim()) continue;
    const frame: SseFrame = { id: null, event: null, data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) frame.id = line.slice(4).trim();
      else if (line.startsWith('event: ')) frame.event = line.slice(7).trim();
      else if (line.startsWith('data: ')) frame.data = line.slice(6);
    }
    if (frame.id || frame.event || frame.data) frames.push(frame);
  }
  return frames;
}

async function readFor(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
    ]);
    if (result.done) break;
    if (result.value) text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

describe('SSE event stream', () => {
  it('streams committed events with seq ids, supports resume after seq and rejects unauthenticated clients', async () => {
    const provider = new ScriptedProviderGateway();
    const harness = await createHarness({ provider });
    try {
      const created = await inject(harness, 'POST', '/api/tasks', {
        commandId: uuid(),
        title: 'SSE 任务',
        intent: '验证事件流',
        artifactTitle: 'SSE 交付物',
        modules: [{ key: 'main', title: '主成果', kind: 'json', order: 0, dependsOnKeys: [], acceptanceCriteria: [] }],
      });
      const taskId = created.body.taskId as string;
      const moduleId = created.body.moduleIds[0] as string;
      provider.queuePlanner(plannerOutputFor({ moduleId, moduleKind: 'json' }));
      const planned = await inject(harness, 'POST', `/api/tasks/${taskId}/runs`, {
        commandId: uuid(),
        expectedRevision: 0,
        moduleId,
        intent: 'x',
        planFirst: true,
      });
      expect(planned.status).toBe(200);

      await harness.app.listen({ host: '127.0.0.1', port: 0 });
      const address = harness.app.server.address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}`;

      const unauthorized = await fetch(`${base}/api/tasks/${taskId}/events?afterSeq=0`);
      expect(unauthorized.status).toBe(401);

      const controller = new AbortController();
      const response = await fetch(`${base}/api/tasks/${taskId}/events?afterSeq=0`, {
        headers: { authorization: `Bearer ${harness.session.token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const firstText = await readFor(reader, 1200);
      const frames = parseFrames(firstText);
      const dataFrames = frames.filter((frame) => frame.data && frame.id);
      expect(dataFrames.length).toBeGreaterThan(0);
      for (const frame of dataFrames) {
        const event = JSON.parse(frame.data!);
        expect(String(event.seq)).toBe(frame.id);
        expect(event.type).toBe(frame.event);
        expect(event.taskId).toBe(taskId);
      }
      const maxSeq = Math.max(...dataFrames.map((frame) => Number(frame.id)));
      expect(maxSeq).toBeGreaterThanOrEqual(1);

      // Resume after the current max seq: no old frames, only future events.
      const resume = await fetch(`${base}/api/tasks/${taskId}/events`, {
        headers: { authorization: `Bearer ${harness.session.token}`, 'last-event-id': String(maxSeq) },
        signal: controller.signal,
      });
      const resumeReader = resume.body!.getReader();
      await inject(harness, 'POST', `/api/runs/${planned.body.runId}/cancel`, {
        commandId: uuid(),
        expectedRevision: (await inject(harness, 'GET', `/api/tasks/${taskId}/snapshot`)).body.task.revision,
        reason: 'SSE 测试取消',
      });
      const resumedText = await readFor(resumeReader, 1500);
      const resumedFrames = parseFrames(resumedText).filter((frame) => frame.id && frame.data);
      expect(resumedFrames.length).toBeGreaterThan(0);
      for (const frame of resumedFrames) {
        expect(Number(frame.id)).toBeGreaterThan(maxSeq);
      }
      expect(resumedText).toContain('run.cancel');
      controller.abort();
      await reader.cancel().catch(() => {});
      await resumeReader.cancel().catch(() => {});
    } finally {
      await harness.close();
    }
  }, 60_000);
});
