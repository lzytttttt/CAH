import {
  newProviderProfileId,
  type ModelEvent,
  type ModelRequest,
  type ModuleContent,
  type ProviderCapabilities,
  type ProviderProfile,
} from '@ca/contracts';
import type { ProviderGateway } from '@ca/harness';

export interface PlannerOutput {
  goal: string;
  skeleton: Array<{ moduleId: string; moduleKind?: string; sections: string[]; expectedContentSummary: string }>;
  steps: Array<{
    id: string;
    title: string;
    kind: 'tool' | 'model' | 'validate' | 'compose';
    dependencies: string[];
    toolId: string | null;
    description: string;
    expectedOutput: string;
  }>;
  tools: Array<{ toolId: string; reason: string; effect: 'read' | 'draft_write' | 'external_write' }>;
  assumptions: Array<{ id: string; text: string; needsConfirmation: boolean }>;
  openQuestions: Array<{ id: string; question: string; blocking: boolean; reason: string }>;
  risks: Array<{
    id: string;
    type: string;
    basis: string;
    title: string;
    detail: string;
    severity: 'info' | 'warning' | 'blocking';
    affectedModuleIds: string[];
    evidenceRefs: unknown[];
    handlingOptions: Array<{ id: string; label: string; description: string }>;
    resolvedByDecisionId: null;
  }>;
  rationale: string;
}

export type ModelHandler = (request: ModelRequest, signal: AbortSignal) => ModelEvent[] | Promise<ModelEvent[]>;

/**
 * Scripted provider gateway: deterministic ModelEvents, no network. Used by
 * server integration tests to exercise the real harness/tools/storage stack.
 */
export class ScriptedProviderGateway implements ProviderGateway {
  readonly profile: ProviderProfile;
  private readonly handlers: ModelHandler[] = [];
  readonly calls: ModelRequest[] = [];

  constructor(profileName = '脚本化测试模型') {
    const now = new Date().toISOString();
    const capabilities: ProviderCapabilities = {
      streaming: 'verified',
      toolCalling: 'verified',
      structuredOutput: 'verified',
      vision: 'unsupported',
      usageReporting: 'verified',
      contextWindow: 64_000,
      checkedAt: now,
      testedServiceLabel: 'in-process scripted gateway',
      testedModel: 'scripted-1',
    };
    this.profile = {
      id: newProviderProfileId(),
      profileName,
      adapterType: 'openai_compatible',
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'scripted-1',
      credentialRef: 'SCRIPTED_TEST_KEY',
      enabled: true,
      timeouts: {},
      contextWindowOverride: null,
      priceTable: null,
      capabilities,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getProfile(profileId: string): Promise<ProviderProfile | null> {
    return profileId === this.profile.id ? this.profile : this.profile;
  }

  async listEnabledProfiles(): Promise<ProviderProfile[]> {
    return [this.profile];
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.profile.capabilities;
  }

  async *stream(_profileId: string, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.calls.push(request);
    const handler = this.handlers.shift();
    if (!handler) throw new Error('scripted provider: no queued handler for model request');
    const events = await handler(request, signal);
    for (const event of events) {
      if (signal.aborted) throw new Error('scripted provider: aborted');
      yield event;
    }
  }

  push(handler: ModelHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Queue a planner response emitting a single text delta with the JSON plan. */
  queuePlanner(plan: PlannerOutput): this {
    return this.push(async () => [
      { type: 'text_delta', text: JSON.stringify(plan) },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, source: 'provider', costUsd: null } },
      { type: 'finish', reason: 'stop' },
    ]);
  }

  /** Queue an execution round that calls artifact.propose_patch natively. */
  queueProposePatch(input: {
    callId?: string;
    moduleId: string;
    baseVersionId: string | null;
    content: ModuleContent;
    description?: string;
  }): this {
    return this.push(async () => [
      {
        type: 'tool_call_complete',
        index: 0,
        callId: input.callId ?? 'call_propose_1',
        name: 'artifact.propose_patch',
        argumentsJson: JSON.stringify({
          moduleId: input.moduleId,
          baseVersionId: input.baseVersionId,
          description: input.description ?? '脚本化候选成果',
          operations: [{ kind: 'replace_module', content: input.content }],
          evidenceRefs: [],
        }),
      },
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 300, totalTokens: 420, source: 'provider', costUsd: null } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  }

  /** Queue a final assistant round with the candidate JSON envelope. */
  queueCandidateEnvelope(content: ModuleContent, evidenceRefs: unknown[] = [], description = '脚本化候选成果'): this {
    return this.push(async () => [
      { type: 'text_delta', text: JSON.stringify({ candidate: content, evidenceRefs, description }) },
      { type: 'usage', usage: { inputTokens: 80, outputTokens: 120, totalTokens: 200, source: 'provider', costUsd: null } },
      { type: 'finish', reason: 'stop' },
    ]);
  }

  /** Queue a repair response with a corrected candidate envelope. */
  queueRepair(content: ModuleContent): this {
    return this.queueCandidateEnvelope(content);
  }
}

/** Build a valid planner output for a single-module task. */
export function plannerOutputFor(input: {
  moduleId: string;
  moduleKind: 'markdown' | 'json' | 'csv';
  goal?: string;
  steps?: PlannerOutput['steps'];
  tools?: PlannerOutput['tools'];
  risks?: PlannerOutput['risks'];
  openQuestions?: PlannerOutput['openQuestions'];
  assumptions?: PlannerOutput['assumptions'];
}): PlannerOutput {
  return {
    goal: input.goal ?? '生成测试成果',
    skeleton: [
      {
        moduleId: input.moduleId,
        moduleKind: input.moduleKind,
        sections: [],
        expectedContentSummary: '脚本化最小成果',
      },
    ],
    steps:
      input.steps ??
      [
        {
          id: 's1',
          title: '读取任务资料',
          kind: 'tool',
          dependencies: [],
          toolId: 'source.read',
          description: '读取已授权资料片段',
          expectedOutput: '资料片段',
        },
        {
          id: 's2',
          title: '生成候选成果',
          kind: 'model',
          dependencies: ['s1'],
          toolId: null,
          description: '生成模块候选内容',
          expectedOutput: '候选成果',
        },
        {
          id: 's3',
          title: '确定性验证',
          kind: 'validate',
          dependencies: ['s2'],
          toolId: null,
          description: '运行 L0-L3 校验',
          expectedOutput: '验证报告',
        },
      ],
    tools:
      input.tools ??
      [
        { toolId: 'source.read', reason: '读取任务资料', effect: 'read' },
        { toolId: 'artifact.propose_patch', reason: '生成隔离草稿', effect: 'draft_write' },
      ],
    assumptions: input.assumptions ?? [],
    openQuestions: input.openQuestions ?? [],
    risks: input.risks ?? [],
    rationale: '脚本化模型的计划摘要（用于集成测试）',
  };
}
