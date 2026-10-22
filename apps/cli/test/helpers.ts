/**
 * Test helpers: a real local HTTP fake server (127.0.0.1:0, no external
 * network), a CLI invocation harness capturing stdout/stderr, and contract-valid
 * fixtures for every response the commands consume.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { EVENT_CATEGORY_BY_TYPE } from '@ca/contracts';
import { runCli } from '../src/main';

/* ------------------------------------------------------------------ */
/* Fake HTTP server                                                    */
/* ------------------------------------------------------------------ */

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
}

export type FakeHandler = (request: FakeRequest, response: http.ServerResponse) => void | Promise<void>;

export interface FakeServer {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
  handler: FakeHandler;
}

export async function startFakeServer(initialHandler: FakeHandler): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = rawBody === '' ? undefined : JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const fakeRequest: FakeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        rawBody,
      };
      requests.push(fakeRequest);
      void Promise.resolve(initialHandler(fakeRequest, res)).catch((error: unknown) => {
        if (!res.headersSent) json(res, 500, { code: 'internal_error', message: String(error), retryable: false, traceId: 'test' });
        else res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    handler: initialHandler,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  response.end(payload);
}

export function apiError(
  response: http.ServerResponse,
  status: number,
  code: string,
  message = code,
  extra: Record<string, unknown> = {},
): void {
  json(response, status, { code, message, retryable: false, traceId: 'trace-test', ...extra });
}

/* ------------------------------------------------------------------ */
/* SSE helpers                                                         */
/* ------------------------------------------------------------------ */

export function sseStart(response: http.ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.flushHeaders();
}

export function sseEvent(response: http.ServerResponse, event: { id?: string | number; type?: string; data: unknown }): void {
  if (event.id !== undefined) response.write(`id: ${event.id}\n`);
  if (event.type !== undefined) response.write(`event: ${event.type}\n`);
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  for (const line of data.split('\n')) response.write(`data: ${line}\n`);
  response.write('\n');
}

export function sseHeartbeat(response: http.ServerResponse): void {
  response.write(': heartbeat\n\n');
}

/** Run a CLI invocation with captured output and test-isolated environment. */
export interface RunCommandOptions {
  server?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  tokenFile?: string;
  /** Extra global options prepended before the command. */
  globals?: string[];
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(argv: readonly string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CA_SESSION_TOKEN: 'test-token',
    CA_DATA_DIR: undefined,
    CA_TOKEN_FILE: undefined,
    CA_SERVER_URL: undefined,
    CA_CLI_TIMEOUT_MS: undefined,
    NO_COLOR: '1',
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const args: string[] = [];
  if (options.server) args.push('--server', options.server);
  args.push('--timeout', String(options.timeoutMs ?? 5000));
  if (options.tokenFile) args.push('--token-file', options.tokenFile);
  args.push(...(options.globals ?? []));
  args.push(...argv);
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd: options.cwd ?? process.cwd(),
    env,
    stdoutIsTTY: false,
    retryBaseDelayMs: 1,
  });
  return { code, stdout, stderr };
}

export function parseJsonOutput(result: RunCommandResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`stdout is not a single JSON document: ${result.stdout}\n${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures (minimal but contract-valid; zod fills documented defaults) */
/* ------------------------------------------------------------------ */

export const NOW = '2026-10-22T12:00:00.000Z';
export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const TASK_ID = '22222222-2222-4222-8222-222222222222';
export const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
export const MODULE_ID = '44444444-4444-4444-8444-444444444444';
export const MODULE_ID_B = '55555555-5555-4555-8555-555555555555';
export const RUN_ID = '66666666-6666-4666-8666-666666666666';
export const RUN_ID_B = '77777777-7777-4777-8777-777777777777';
export const PATCH_ID = '88888888-8888-4888-8888-888888888888';
export const VALIDATION_ID = '99999999-9999-4999-8999-999999999999';
export const VERSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const VERSION_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PROFILE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const RECIPE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const SOURCE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const BLOCKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const HEX = 'a'.repeat(64);

export function uuidFor(seq: number): string {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export function makeUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelRequests: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    usdCost: null,
    elapsedActiveMs: 0,
    startedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeModuleView(moduleId = MODULE_ID, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    module: {
      id: moduleId,
      artifactId: ARTIFACT_ID,
      title: moduleId === MODULE_ID ? '执行摘要' : '数据表',
      kind: moduleId === MODULE_ID ? 'markdown' : 'csv',
      order: 0,
      dependencies: [],
      acceptanceCriteria: [],
      status: 'empty',
      blockedFrom: null,
      acceptedVersionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    acceptance: {
      moduleId,
      status: 'empty',
      acceptedVersionId: null,
      acceptedAt: null,
      acceptedSummary: null,
      acceptedContentHash: null,
      pendingPatchId: null,
      pendingValidationReportId: null,
      pendingValidationStatus: null,
      staleReason: null,
      openBlockerIds: [],
    },
    acceptedContent: null,
    acceptedVersion: null,
    pendingCandidateSummary: null,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshotSeq: 7,
    serverTime: NOW,
    workspace: {
      workspaceId: WORKSPACE_ID,
      mode: 'live',
      name: 'Live Workspace',
      settings: {},
      policyVersion: 'p0-policy-1',
    },
    task: {
      id: TASK_ID,
      workspaceId: WORKSPACE_ID,
      title: '客户反馈整理',
      intent: '汇总反馈并给出优先级',
      constraints: [],
      artifactId: ARTIFACT_ID,
      revision: 3,
      templateId: null,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
    artifact: {
      id: ARTIFACT_ID,
      taskId: TASK_ID,
      title: '反馈报告',
      moduleIds: [MODULE_ID],
      acceptedVersionId: null,
      status: 'draft',
      createdAt: NOW,
      updatedAt: NOW,
    },
    modules: [makeModuleView()],
    plan: null,
    runs: [],
    activeRun: null,
    blockers: [],
    patches: [],
    validations: [],
    sources: [],
    spans: [],
    prospects: [],
    recipes: [],
    spatial: {
      nodes: [],
      edges: [],
      stage: { phase: 'idle', label: '空闲', completedSteps: null, totalSteps: null, activeStepTitle: null, note: '' },
      counts: { branchCount: 0, nodeCount: 0, edgeCount: 0, collapsedNodes: 0, byKind: {} },
      activeBranchId: null,
      focusHint: '',
    },
    control: {
      runId: null,
      state: null,
      canPause: false,
      canResume: false,
      canCancel: false,
      budgetLabel: '',
      providerLabel: '',
      connectionStatus: 'unknown',
      queuePosition: null,
      unsavedDraft: false,
    },
    usage: null,
    events: [],
    limits: { maxSpatialBranches: 3, maxSpatialNodes: 12, maxSpatialEdges: 16 },
    ...overrides,
  };
}

export function makeResolutionOption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'opt-choice',
    kind: 'choose',
    label: '选择处理方式',
    detail: '',
    options: [
      { value: 'keep', label: '保留', description: '' },
      { value: 'drop', label: '丢弃', description: '' },
    ],
    ...overrides,
  };
}

export function makeBlocker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BLOCKER_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    type: 'info_missing',
    severity: 'blocking',
    title: '缺少客户名称',
    detail: '资料中没有客户名称，需要补充后才能继续。',
    evidenceRefs: [],
    affectedSteps: [],
    affectedModuleIds: [MODULE_ID],
    resolutions: [makeResolutionOption()],
    status: 'open',
    resolution: null,
    returnState: 'READY',
    createdAt: NOW,
    resolvedAt: null,
    clearedAt: null,
    ...overrides,
  };
}

export function makeRunDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: {
      runId: RUN_ID,
      taskId: TASK_ID,
      moduleId: MODULE_ID,
      state: 'RUNNING',
      revision: 1,
      attempt: 1,
      planVersion: 1,
      contextSnapshotId: null,
      budgetUsage: makeUsage({ modelRequests: 2, toolCalls: 1, inputTokens: 120, outputTokens: 40, elapsedActiveMs: 1500 }),
      error: null,
      interrupted: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      finishedAt: null,
    },
    plan: null,
    steps: [],
    blockers: [],
    contextSnapshot: null,
    validationReport: null,
    ...overrides,
  };
}

export function makePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    version: 1,
    goal: '补齐交付物',
    targetModuleId: MODULE_ID,
    artifactSkeleton: [],
    inputRefs: [],
    constraintRefs: [],
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        id: 's1',
        title: '读取资料',
        kind: 'tool',
        dependencies: [],
        toolId: 'source.read',
        description: '',
        expectedOutput: '',
        inputRefs: [],
      },
    ],
    tools: [{ toolId: 'source.read', reason: '读取资料', effect: 'read' }],
    validators: [],
    budget: {},
    risks: [],
    promptVersion: 'planner.v1',
    modelProfileId: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeCreateRunResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(900),
    duplicate: false,
    runId: RUN_ID,
    state: 'READY',
    revision: 4,
    plan: makePlan(),
    ...overrides,
  };
}

export function makeRunControlResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(901),
    duplicate: false,
    runId: RUN_ID,
    state: 'RUNNING',
    revision: 5,
    ...overrides,
  };
}

export function makeValidationReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALIDATION_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    moduleId: MODULE_ID,
    baseVersionId: null,
    candidateHash: HEX,
    checks: [
      { id: 'c1', layer: 'L1', code: 'structure', title: '结构检查', status: 'pass', detail: 'ok', evidenceRefs: [], affectedPaths: [] },
    ],
    status: 'pass',
    summary: '全部通过',
    validatorVersion: 'v1',
    createdAt: NOW,
    ...overrides,
  };
}

export function makePatchReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patch: {
      id: PATCH_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      moduleId: MODULE_ID,
      moduleKind: 'markdown',
      baseVersionId: null,
      operations: [
        {
          kind: 'replace_module',
          content: { kind: 'markdown', sections: [{ id: 'summary', title: '摘要', markdown: '新内容' }] },
        },
      ],
      evidenceRefs: [],
      validationReportId: VALIDATION_ID,
      candidateHash: HEX,
      candidate: { kind: 'markdown', sections: [{ id: 'summary', title: '摘要', markdown: '新内容' }] },
      status: 'proposed',
      description: '根据资料生成候选摘要',
      changeSummary: {
        addedLines: 2,
        removedLines: 1,
        changedSections: ['summary'],
        addedSections: [],
        removedSections: [],
        affectedRows: 0,
        note: '',
      },
      createdAt: NOW,
      acceptedVersionId: null,
    },
    diff: {
      moduleId: MODULE_ID,
      moduleKind: 'markdown',
      baseVersionId: null,
      candidateHash: HEX,
      entries: [
        { sectionId: 'summary', title: '摘要', change: 'changed', beforeExcerpt: '旧内容', afterExcerpt: '新内容', summary: '更新摘要' },
        { sectionId: 'risks', title: '风险', change: 'added', beforeExcerpt: null, afterExcerpt: '风险 A', summary: '新增风险章节' },
      ],
      stats: { added: 1, removed: 0, changed: 1, unchanged: 0 },
    },
    validation: makeValidationReport(),
    baseContent: null,
    ...overrides,
  };
}

export function makeAcceptResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(902),
    duplicate: false,
    patchId: PATCH_ID,
    versionId: VERSION_ID,
    moduleId: MODULE_ID,
    runState: 'COMPLETED',
    artifactRevision: 4,
    ...overrides,
  };
}

export function makeRestoreResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(903),
    duplicate: false,
    versionId: VERSION_ID_B,
    moduleId: MODULE_ID,
    artifactRevision: 5,
    ...overrides,
  };
}

export function makeTaskList(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [
      {
        taskId: TASK_ID,
        artifactId: ARTIFACT_ID,
        title: '客户反馈整理',
        status: 'active',
        revision: 3,
        createdAt: NOW,
        updatedAt: NOW,
        moduleCount: 1,
        activeRunState: 'RUNNING',
        acceptedCount: 0,
      },
    ],
    ...overrides,
  };
}

export function makeWorkspaceView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: {
      id: WORKSPACE_ID,
      mode: 'live',
      name: 'Live Workspace',
      settings: {},
      policyVersion: 'p0-policy-1',
      createdAt: NOW,
      updatedAt: NOW,
    },
    providerProfiles: [
      {
        id: PROFILE_ID,
        profileName: '本地模型',
        adapterType: 'openai_compatible',
        baseURL: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5',
        enabled: true,
        timeouts: {},
        contextWindowOverride: null,
        priceTable: null,
        capabilities: { streaming: 'unknown', toolCalling: 'unknown', structuredOutput: 'unknown', vision: 'unknown', usageReporting: 'unknown' },
        createdAt: NOW,
        updatedAt: NOW,
        credentialConfigured: true,
        credentialHint: 'sk-…abc',
        credentialError: null,
      },
    ],
    demoAvailable: true,
    liveAvailable: false,
    appVersion: '0.1.0',
    policyVersion: 'p0-policy-1',
    limits: {},
    ...overrides,
  };
}

export function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authenticated: true,
    mode: 'live',
    availableModes: ['live', 'demo'],
    csrfToken: 'csrf-token',
    serverVersion: '0.1.0',
    policyVersion: 'p0-policy-1',
    liveProviderConfigured: false,
    demoAvailable: true,
    serverTime: NOW,
    uptimeSeconds: 42,
    ...overrides,
  };
}

export function makeCapabilityReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileId: PROFILE_ID,
    serviceLabel: '本地 OpenAI 兼容服务',
    testedModel: 'qwen2.5',
    probes: [
      {
        capability: 'auth_and_text',
        status: 'verified',
        detail: '返回文本',
        latencyMs: 120,
        testedModel: 'qwen2.5',
        testedAt: NOW,
        error: null,
      },
    ],
    capabilities: {
      streaming: 'verified',
      toolCalling: 'unknown',
      structuredOutput: 'unknown',
      vision: 'unknown',
      usageReporting: 'verified',
    },
    requestCount: 1,
    estimatedCostUsd: null,
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

export function makeRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECIPE_ID,
    version: 1,
    name: '反馈归类',
    description: '',
    kind: 'deterministic',
    status: 'validated',
    dslVersion: '1',
    inputParameters: [{ name: 'input', type: 'string', required: true, description: '', pattern: null, enumValues: [], acceptsMime: [] }],
    steps: [
      {
        id: 'read',
        title: '读取',
        when: null,
        kind: 'artifact.read',
        module: { kind: 'literal', value: MODULE_ID },
      },
    ],
    outputArtifactKind: 'markdown',
    validators: [],
    permissions: { tools: [], scopes: [], allowModelCalls: false, maxModelCalls: 0 },
    budget: { maxModelCalls: 0, maxToolCalls: 20, maxRuntimeMs: 60000 },
    testCases: [
      {
        id: 't1',
        label: '原始输入',
        kind: 'original',
        inputs: { input: 'a' },
        expectation: 'accept',
        status: 'passed',
        detail: '',
        normalizedOutputHash: null,
        lastRunAt: null,
      },
    ],
    fingerprint: HEX,
    fingerprintInputs: {
      dslVersion: '1',
      stepFingerprint: HEX,
      toolVersions: {},
      promptHashes: {},
      validatorVersion: 'v1',
      parserVersion: 'v1',
    },
    sourceRunId: RUN_ID,
    sourceTaskId: TASK_ID,
    sourceModuleId: null,
    applicability: '',
    staleReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeProposeRecipeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(904),
    duplicate: false,
    proposal: {
      runId: RUN_ID,
      name: '反馈归类',
      description: '',
      kind: 'deterministic',
      inputParameters: [{ name: 'input', type: 'string', required: true, description: '', pattern: null, enumValues: [], acceptsMime: [] }],
      steps: [
        { id: 'read', title: '读取', when: null, kind: 'artifact.read', module: { kind: 'literal', value: MODULE_ID } },
      ],
      testCases: [
        {
          id: 't1',
          label: '原始输入',
          kind: 'original',
          inputs: { input: 'a' },
          expectation: 'accept',
          status: 'untested',
          detail: '',
          normalizedOutputHash: null,
          lastRunAt: null,
        },
      ],
      applicability: '',
    },
    sourceRunId: RUN_ID,
    traceStepCount: 3,
    ...overrides,
  };
}

export function makeCreateRecipeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(905),
    duplicate: false,
    recipeId: RECIPE_ID,
    version: 1,
    status: 'candidate',
    recipe: makeRecipe({ status: 'candidate' }),
    ...overrides,
  };
}

export function makeValidateRecipeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(906),
    duplicate: false,
    recipeId: RECIPE_ID,
    version: 1,
    status: 'validated',
    testCases: makeRecipe().testCases,
    ...overrides,
  };
}

export function makeRecipeRunResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipeId: RECIPE_ID,
    recipeVersion: 1,
    runId: RUN_ID,
    cacheState: 'executed',
    outputs: [
      { name: 'result.md', moduleKind: 'markdown', objectHash: HEX, preview: '结果预览', rowCount: null },
    ],
    normalizedOutputHash: HEX,
    llmCalls: 0,
    toolCalls: 3,
    durationMs: 42,
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

export function makeRunRecipeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(907),
    duplicate: false,
    recipeId: RECIPE_ID,
    runId: RUN_ID,
    cacheState: 'executed',
    result: makeRecipeRunResult(),
    ...overrides,
  };
}

export function makeExportResponse(content: Buffer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    commandId: uuidFor(908),
    fileName: 'export.md',
    mime: 'text/markdown',
    contentBase64: content.toString('base64'),
    sha256,
    bytes: content.byteLength,
    redacted: false,
    warnings: [],
    ...overrides,
  };
}

export function makeImportResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(909),
    duplicate: false,
    taskId: TASK_ID,
    warnings: [],
    sourcesNeedRebinding: false,
    ...overrides,
  };
}

export function makeSourceImportResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: uuidFor(910),
    duplicate: false,
    sourceId: SOURCE_ID,
    version: 1,
    parseStatus: 'parsed',
    parseNote: '',
    warnings: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Event fixtures                                                      */
/* ------------------------------------------------------------------ */

type PayloadBuilder = Record<string, unknown>;

export function makeEvent(seq: number, type: string, payload: PayloadBuilder, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    eventId: uuidFor(seq),
    taskId: TASK_ID,
    runId: RUN_ID,
    stepId: null,
    seq,
    causationId: null,
    type,
    category: EVENT_CATEGORY_BY_TYPE[type as keyof typeof EVENT_CATEGORY_BY_TYPE],
    payload,
    timestamp: NOW,
    ...overrides,
  };
}

export function stateChangedEvent(seq: number, from: string, to: string): Record<string, unknown> {
  return makeEvent(seq, 'run.state_changed', { from, to, reason: '' });
}

export function stepStartedEvent(seq: number, title = '读取资料'): Record<string, unknown> {
  return makeEvent(seq, 'step.started', { stepId: uuidFor(1000 + seq), kind: 'tool', title, attempt: 1 });
}

export function runCompletedEvent(seq: number): Record<string, unknown> {
  return makeEvent(seq, 'run.completed', { runId: RUN_ID, versionId: VERSION_ID, moduleId: MODULE_ID });
}
