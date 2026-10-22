import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal local OpenAI-compatible Chat Completions server for offline Live-path
 * integration tests. It never reaches the network; it emits real SSE frames in
 * the same wire shape a provider would, so the production adapter is exercised.
 */
export interface FakeOpenAiConfig {
  moduleId: string;
  plannerJson: string;
  candidateJson: string;
  model?: string;
}

export interface FakeOpenAiServer {
  baseURL: string;
  close(): Promise<void>;
  readonly requests: Array<Record<string, unknown>>;
  config: FakeOpenAiConfig;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textCompletion(model: string, content: string, finishReason = 'stop'): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

export async function startFakeOpenAiServer(initial: FakeOpenAiConfig): Promise<FakeOpenAiServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      requests.push(body);
      const model = String(body.model ?? 'fake-model');
      const messages = (body.messages as Array<{ role: string; content?: string; tool_call_id?: string }>) ?? [];
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content ?? '')
        .join('\n');
      const isPlannerPrompt = /planner\.v1/.test(systemText) || systemText.includes('规划');
      const isRepairPrompt = /repair\.v1/.test(systemText);
      const hasToolTurn = messages.some((message) => message.role === 'tool');
      const config = fake.config;
      // Planning (and plan-structure repair before any tool turn) returns the plan JSON;
      // after a tool result the executor returns the candidate envelope;
      // otherwise the executor requests a native artifact.propose_patch tool call.
      const plannerLike = isPlannerPrompt || (isRepairPrompt && !hasToolTurn);

      if (body.stream !== true) {
        const content = plannerLike || !hasToolTurn ? config.plannerJson : config.candidateJson;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(textCompletion(model, content)));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, withUsage = false): void => {
        res.write(
          sseChunk({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(withUsage ? { usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } } : {}),
          }),
        );
      };

      if (plannerLike || hasToolTurn) {
        const content = plannerLike ? config.plannerJson : config.candidateJson;
        // Stream in a few deltas to exercise real incremental parsing.
        const size = Math.max(1, Math.ceil(content.length / 3));
        for (let i = 0; i < content.length; i += size) {
          chunk({ content: content.slice(i, i + size) });
        }
        chunk({}, 'stop', true);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Executor round: emit a native tool call in fragments.
      const args = JSON.stringify({
        moduleId: config.moduleId,
        baseVersionId: null,
        description: '本地假服务候选成果',
        operations: [{ kind: 'replace_module', content: JSON.parse(config.candidateJson) }],
        evidenceRefs: [],
      });
      const toolName = 'artifact.propose_patch';
      chunk({ tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: toolName, arguments: '' } }] });
      const step = Math.max(1, Math.ceil(args.length / 4));
      for (let i = 0; i < args.length; i += step) {
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + step) } }] });
      }
      chunk({}, 'tool_calls', true);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  const fake: FakeOpenAiServer = {
    baseURL: '',
    config: initial,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  fake.baseURL = `http://127.0.0.1:${address.port}/v1`;
  return fake;
}
