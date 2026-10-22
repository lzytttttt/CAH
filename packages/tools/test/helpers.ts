/**
 * In-memory fake ports + fixture builders for packages/tools tests.
 *
 * Everything is deterministic: fixed ids, fixed clock, no timers, no network,
 * no filesystem. Tests assert against recorded port calls to prove that guards
 * (scope, timeout, size, evidence, no accepted-version mutation) hold.
 */
import {
  ArtifactModuleSchema,
  ArtifactVersionSchema,
  SourceItemSchema,
  type ArtifactModule,
  type ArtifactVersion,
  type JsonValue,
  type ModuleContent,
  type ModuleId,
  type PatchOperation,
  type PatchProposal,
  type RunId,
  type SourceId,
  type SourceItem,
  type SourceSpan,
  type StepId,
  type TaskId,
  type ToolCallId,
  type ToolId,
  type ToolResult,
  type ValidationReport,
  type ValidationReportId,
  type ToolScope,
} from '@ca/contracts';
import {
  contentHash,
  sha256Hex,
  utf8Encode,
  type ArtifactAccessPort,
  type ObjectWriterPort,
  type SourceReaderPort,
  type ToolContext,
  type ValidatorPort,
} from '@ca/tools';

export const TASK_ID = '11111111-1111-4111-8111-111111111111' as TaskId;
export const RUN_ID = '22222222-2222-4222-8222-222222222222' as RunId;
export const STEP_ID = '33333333-3333-4333-8333-333333333333' as StepId;
export const TOOL_CALL_ID = '44444444-4444-4444-8444-444444444444' as ToolCallId;
export const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
export const MODULE_ID = '66666666-6666-4666-8666-666666666666' as ModuleId;
export const MODULE_ID_2 = '77777777-7777-4777-8777-777777777777' as ModuleId;
export const NOW_ISO = '2026-01-01T00:00:00.000Z';

export const ALL_SCOPES: readonly ToolScope[] = [
  'sources:read',
  'artifact:read',
  'artifact:draft_write',
  'artifact:validate',
  'data:profile',
  'data:transform',
];

let uuidCounter = 0;
/** Deterministic UUID-shaped id (valid version 4 / variant 8). */
export function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export interface SourceSeed {
  id?: SourceId;
  name: string;
  mime: string;
  version?: number;
  text: string;
  availability?: SourceItem['availability'];
  origin?: SourceItem['origin'];
  trustLevel?: SourceItem['trustLevel'];
}

export function makeSourceItem(seed: SourceSeed, taskId: TaskId = TASK_ID): SourceItem {
  const bytes = utf8Encode(seed.text);
  return SourceItemSchema.parse({
    id: seed.id ?? (nextUuid() as SourceId),
    taskId,
    name: seed.name,
    mime: seed.mime,
    version: seed.version ?? 1,
    sizeBytes: bytes.length,
    hash: sha256Hex(bytes),
    origin: seed.origin ?? 'upload',
    trustLevel: seed.trustLevel ?? 'user_provided',
    availability: seed.availability ?? 'available',
    parseStatus: 'parsed',
    createdAt: NOW_ISO,
  });
}

export interface ModuleSeed {
  id?: ModuleId;
  title?: string;
  kind: ArtifactModule['kind'];
  content?: ModuleContent;
  accepted?: boolean;
}

export interface RecordedPut {
  bytes: Uint8Array;
  mime: string;
  hash: string;
  sizeBytes: number;
  text: string;
}

export interface ToolCallCounts {
  listSources: number;
  getSource: number;
  listLatestContents: number;
  listSpans: number;
  saveSpan: number;
  getModule: number;
  getVersion: number;
  getAcceptedVersion: number;
  saveProposal: number;
  saveValidationReport: number;
  put: number;
  validate: number;
}

export interface TestWorld {
  taskId: TaskId;
  runId: RunId;
  stepId: StepId;
  toolCallId: ToolCallId;
  nowIso: string;
  sources: Map<string, { source: SourceItem; bytes: Uint8Array }>;
  spans: SourceSpan[];
  modules: Map<string, ArtifactModule>;
  versions: Map<string, ArtifactVersion>;
  proposals: Array<{ patch: PatchProposal; validation: ValidationReport }>;
  validationReports: ValidationReport[];
  puts: RecordedPut[];
  calls: ToolCallCounts;
  grantedScopes: readonly ToolScope[];
  validator: ValidatorPort | null;
  abortController: AbortController;
  addSource(seed: SourceSeed): SourceItem;
  addModule(seed: ModuleSeed): { module: ArtifactModule; version: ArtifactVersion | null };
  setGrantedScopes(scopes: readonly ToolScope[]): void;
  ctx(overrides?: Partial<ToolContext>): ToolContext;
}

function contentForKind(kind: ArtifactModule['kind']): ModuleContent {
  switch (kind) {
    case 'markdown':
      return { kind: 'markdown', sections: [] };
    case 'json':
      return { kind: 'json', value: null };
    case 'csv':
      return { kind: 'csv', columns: [{ key: 'id', label: 'id', type: 'string', required: false }], rows: [] };
  }
}

export function createTestWorld(options: { validator?: boolean; nowIso?: string } = {}): TestWorld {
  const calls: ToolCallCounts = {
    listSources: 0,
    getSource: 0,
    listLatestContents: 0,
    listSpans: 0,
    saveSpan: 0,
    getModule: 0,
    getVersion: 0,
    getAcceptedVersion: 0,
    saveProposal: 0,
    saveValidationReport: 0,
    put: 0,
    validate: 0,
  };

  const world: TestWorld = {
    taskId: TASK_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    toolCallId: TOOL_CALL_ID,
    nowIso: options.nowIso ?? NOW_ISO,
    sources: new Map(),
    spans: [],
    modules: new Map(),
    versions: new Map(),
    proposals: [],
    validationReports: [],
    puts: [],
    calls,
    grantedScopes: ALL_SCOPES,
    validator: null,
    abortController: new AbortController(),
    addSource(seed: SourceSeed): SourceItem {
      const source = makeSourceItem(seed);
      world.sources.set(`${source.id}@${source.version}`, { source, bytes: utf8Encode(seed.text) });
      return source;
    },
    addModule(seed: ModuleSeed): { module: ArtifactModule; version: ArtifactVersion | null } {
      const content = seed.content ?? contentForKind(seed.kind);
      const moduleId = seed.id ?? (nextUuid() as ModuleId);
      let version: ArtifactVersion | null = null;
      let acceptedVersionId: ArtifactVersion['id'] | null = null;
      if (seed.accepted ?? true) {
        version = ArtifactVersionSchema.parse({
          id: nextUuid(),
          artifactId: ARTIFACT_ID,
          moduleId,
          moduleKind: seed.kind,
          contentHash: contentHash(content),
          content,
          parentId: null,
          baseVersionId: null,
          sourceRunId: null,
          patchId: null,
          validationReportId: null,
          acceptedBy: 'fixture',
          acceptedAt: world.nowIso,
          note: '',
          restoredFromVersionId: null,
        });
        world.versions.set(version.id, version);
        acceptedVersionId = version.id;
      }
      const module = ArtifactModuleSchema.parse({
        id: moduleId,
        artifactId: ARTIFACT_ID,
        title: seed.title ?? 'Fixture module',
        kind: seed.kind,
        order: 0,
        dependencies: [],
        acceptanceCriteria: [],
        status: version ? 'accepted' : 'empty',
        acceptedVersionId,
        createdAt: world.nowIso,
        updatedAt: world.nowIso,
      });
      world.modules.set(module.id, module);
      return { module, version };
    },
    setGrantedScopes(scopes: readonly ToolScope[]): void {
      world.grantedScopes = scopes;
    },
    ctx(overrides: Partial<ToolContext> = {}): ToolContext {
      return {
        taskId: world.taskId,
        runId: world.runId,
        stepId: world.stepId,
        toolCallId: world.toolCallId,
        grantedScopes: world.grantedScopes,
        sources: sourcePort,
        artifacts: artifactPort,
        validator: world.validator,
        objects: objectPort,
        capabilities: null,
        now: () => world.nowIso,
        signal: world.abortController.signal,
        ...overrides,
      };
    },
  };

  const latestEntries = (): Array<{ source: SourceItem; bytes: Uint8Array }> => {
    const byId = new Map<string, { source: SourceItem; bytes: Uint8Array }>();
    for (const entry of world.sources.values()) {
      const existing = byId.get(entry.source.id);
      if (!existing || entry.source.version > existing.source.version) byId.set(entry.source.id, entry);
    }
    return [...byId.values()];
  };

  const sourcePort: SourceReaderPort = {
    async listSources(taskId: TaskId): Promise<SourceItem[]> {
      calls.listSources += 1;
      return latestEntries()
        .filter((entry) => entry.source.taskId === taskId)
        .map((entry) => entry.source);
    },
    async getSource(taskId: TaskId, sourceId: SourceId, version: number) {
      calls.getSource += 1;
      const entry = world.sources.get(`${sourceId}@${version}`);
      if (!entry || entry.source.taskId !== taskId) return null;
      return { source: entry.source, bytes: entry.bytes };
    },
    async listLatestContents(taskId: TaskId) {
      calls.listLatestContents += 1;
      return latestEntries().filter((entry) => entry.source.taskId === taskId);
    },
    async listSpans(_taskId: TaskId, limit?: number): Promise<SourceSpan[]> {
      calls.listSpans += 1;
      return world.spans.slice(0, limit ?? 1000);
    },
    async saveSpan(span: SourceSpan): Promise<void> {
      calls.saveSpan += 1;
      const existing = world.spans.findIndex((candidate) => candidate.id === span.id);
      if (existing >= 0) world.spans[existing] = span;
      else world.spans.push(span);
    },
  };

  const artifactPort: ArtifactAccessPort = {
    async getModule(moduleId: ModuleId): Promise<ArtifactModule | null> {
      calls.getModule += 1;
      return world.modules.get(moduleId) ?? null;
    },
    async getAcceptedVersion(moduleId: ModuleId): Promise<ArtifactVersion | null> {
      calls.getAcceptedVersion += 1;
      const module = world.modules.get(moduleId);
      if (!module?.acceptedVersionId) return null;
      return world.versions.get(module.acceptedVersionId) ?? null;
    },
    async getVersion(versionId: string): Promise<ArtifactVersion | null> {
      calls.getVersion += 1;
      return world.versions.get(versionId) ?? null;
    },
    async saveProposal(input) {
      calls.saveProposal += 1;
      const module = world.modules.get(input.moduleId);
      if (!module) throw new Error('fixture module missing');
      const patch: PatchProposal = {
        id: nextUuid() as unknown as PatchProposal['id'],
        taskId: input.taskId,
        runId: input.runId,
        moduleId: input.moduleId,
        moduleKind: module.kind,
        baseVersionId: input.baseVersionId as PatchProposal['baseVersionId'],
        operations: input.operations as PatchOperation[],
        evidenceRefs: input.evidenceRefs,
        validationReportId: input.validation.id,
        candidateHash: contentHash(input.candidate),
        candidate: input.candidate,
        status: 'proposed',
        description: input.description,
        changeSummary: {
          addedLines: 0,
          removedLines: 0,
          changedSections: [],
          addedSections: [],
          removedSections: [],
          affectedRows: 0,
          note: 'fixture',
        },
        createdAt: world.nowIso,
        acceptedVersionId: null,
      };
      world.proposals.push({ patch, validation: input.validation });
      return { patch };
    },
    async saveValidationReport(report: ValidationReport): Promise<void> {
      calls.saveValidationReport += 1;
      world.validationReports.push(report);
    },
  };

  const objectPort: ObjectWriterPort = {
    async put(bytes: Uint8Array, mime: string) {
      calls.put += 1;
      const hash = sha256Hex(bytes);
      const record: RecordedPut = {
        bytes,
        mime,
        hash,
        sizeBytes: bytes.length,
        text: new TextDecoder().decode(bytes),
      };
      world.puts.push(record);
      return { hash, sizeBytes: bytes.length, mime };
    },
  };

  if (options.validator ?? true) {
    world.validator = createFakeValidator(world);
  }
  return world;
}

export interface FakeValidatorOptions {
  status?: ValidationReport['status'];
  /** Override the candidate hash to simulate a misbehaving validator. */
  candidateHashOverride?: (input: { candidate: ModuleContent }) => string;
}

export function createFakeValidator(world: TestWorld, options: FakeValidatorOptions = {}): ValidatorPort {
  return {
    async validate(input): Promise<ValidationReport> {
      world.calls.validate += 1;
      const reportId = nextUuid() as unknown as ValidationReportId;
      const candidateHash = options.candidateHashOverride
        ? options.candidateHashOverride({ candidate: input.candidate })
        : contentHash(input.candidate);
      const status = options.status ?? 'pass';
      return {
        id: reportId,
        taskId: input.taskId,
        runId: input.runId,
        moduleId: input.moduleId,
        baseVersionId: input.baseVersion ? input.baseVersion.id : null,
        candidateHash,
        checks: [
          {
            id: 'L0.schema',
            layer: 'L0',
            code: 'schema.valid',
            title: 'Schema validation',
            status,
            detail: status === 'pass' ? 'content matches the module schema' : 'fixture failure',
            evidenceRefs: [],
            affectedPaths: [],
          },
        ],
        status,
        summary: 'fixture validation report',
        validatorVersion: 'test-validator-1',
        createdAt: world.nowIso,
      };
    },
  };
}

/* ------------------------------ result helpers ------------------------------ */

export function succeededData<T>(result: ToolResult): T {
  if (result.status !== 'succeeded') {
    throw new Error(`expected tool success but got ${result.status}: ${JSON.stringify(result.error)}`);
  }
  return result.result as T;
}

export function failureOf(result: ToolResult): { code: string; message: string; retryable: boolean; details?: JsonValue } {
  if (result.status === 'succeeded' || !result.error) {
    throw new Error(`expected tool failure but got ${result.status}`);
  }
  return result.error as { code: string; message: string; retryable: boolean; details?: JsonValue };
}

export function jsonArg(value: unknown): string {
  return JSON.stringify(value);
}

export const KNOWN_TOOL_IDS: readonly ToolId[] = [
  'source.list',
  'source.read',
  'source.search',
  'data.profile',
  'data.transform',
  'artifact.read',
  'artifact.propose_patch',
  'artifact.validate',
];
