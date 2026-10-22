import { describe, expect, it } from 'vitest';
import {
  type ArtifactModule,
  type ArtifactReadResult,
  type ArtifactValidateArgs,
  type CsvContent,
  type EvidenceRef,
  type ModuleContent,
  type ProposePatchResult,
  type SourceLocator,
} from '@ca/contracts';
import {
  createToolRuntime,
  contentHash,
  sha256Hex,
  sourceSpanIdFor,
  type ValidateToolResult,
} from '@ca/tools';
import { createTestWorld, failureOf, jsonArg, succeededData, type TestWorld } from './helpers';
import { SOURCE_ID_A } from './source-ids';

const runtime = createToolRuntime();

async function call(world: TestWorld, toolId: Parameters<typeof runtime.execute>[0], args: unknown) {
  return runtime.execute(toolId, jsonArg(args), world.ctx());
}

const MARKDOWN: ModuleContent = {
  kind: 'markdown',
  sections: [
    { id: 'intro', title: '简介', markdown: '原始简介内容' },
    { id: 'detail', title: '细节', markdown: '原始细节内容' },
  ],
};

const SOURCE_TEXT = ['# 约束', '延迟预算为 200ms', '离线模式必须可用'].join('\n');

interface Fixture {
  world: TestWorld;
  module: ArtifactModule;
  versionId: string;
  evidence: EvidenceRef;
}

function makeFixture(): Fixture {
  const world = createTestWorld();
  const { module, version } = world.addModule({ kind: 'markdown', title: '架构说明', content: MARKDOWN });
  world.addSource({ id: SOURCE_ID_A, name: 'constraints.md', mime: 'text/markdown', text: SOURCE_TEXT });
  const excerpt = '延迟预算为 200ms';
  const locator: SourceLocator = { kind: 'text_lines', startLine: 2, endLine: 2 };
  const quoteHash = sha256Hex(excerpt);
  const spanId = sourceSpanIdFor(SOURCE_ID_A, 1, locator, quoteHash);
  world.spans.push({
    id: spanId,
    sourceId: SOURCE_ID_A,
    version: 1,
    locator,
    quoteHash,
    excerpt,
    createdAt: world.nowIso,
  });
  const evidence: EvidenceRef = {
    kind: 'source_span',
    span: { spanId, sourceId: SOURCE_ID_A, version: 1, locator, quoteHash, excerpt },
  };
  return { world, module, versionId: version!.id, evidence };
}

describe('artifact.read', () => {
  it('reads the accepted version of a module', async () => {
    const { world, module, versionId } = makeFixture();
    const result = succeededData<ArtifactReadResult>(
      await call(world, 'artifact.read', { moduleId: module.id, versionId: null }),
    );
    expect(result.versionId).toBe(versionId);
    expect(result.moduleKind).toBe('markdown');
    expect(result.content).toEqual(MARKDOWN);
    expect(result.contentHash).toBe(contentHash(MARKDOWN));
    expect(result.dependencies).toEqual([]);
  });

  it('reads an explicitly requested version and rejects versions of other modules', async () => {
    const { world, module } = makeFixture();
    const other = world.addModule({
      kind: 'json',
      title: 'other',
      content: { kind: 'json', value: { a: 1 } },
    });
    const own = succeededData<ArtifactReadResult>(
      await call(world, 'artifact.read', { moduleId: module.id, versionId: module.acceptedVersionId }),
    );
    expect(own.content).toEqual(MARKDOWN);

    const mismatch = failureOf(
      await call(world, 'artifact.read', { moduleId: module.id, versionId: other.version!.id }),
    );
    expect(mismatch.code).toBe('version_not_found');
  });

  it('returns empty content when nothing is accepted yet', async () => {
    const world = createTestWorld();
    const { module } = world.addModule({ kind: 'csv', accepted: false });
    const result = succeededData<ArtifactReadResult>(
      await call(world, 'artifact.read', { moduleId: module.id, versionId: null }),
    );
    expect(result.versionId).toBeNull();
    expect(result.contentHash).toBeNull();
    expect(result.content).toEqual({
      kind: 'csv',
      columns: [{ key: 'id', label: 'id', type: 'string', required: false }],
      rows: [],
    });
  });

  it('fails predictably for unknown modules and versions', async () => {
    const { world } = makeFixture();
    expect(
      failureOf(
        await call(world, 'artifact.read', {
          moduleId: '99999999-9999-4999-8999-999999999999',
          versionId: null,
        }),
      ).code,
    ).toBe('module_not_found');
    expect(
      failureOf(
        await call(world, 'artifact.read', {
          moduleId: '88888888-8888-4888-8888-888888888888',
          versionId: '77777777-7777-4777-8777-777777777777',
        }),
      ).code,
    ).toBe('module_not_found');
  });
});

describe('artifact.propose_patch', () => {
  it('creates an isolated proposed patch with a candidate hash and validation report', async () => {
    const { world, module, versionId, evidence } = makeFixture();
    const operations = [
      { kind: 'markdown.replace_section' as const, sectionId: 'intro', markdown: '新的简介内容', title: '新简介' },
    ];
    const result = succeededData<ProposePatchResult>(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: versionId,
        description: '更新简介',
        operations,
        evidenceRefs: [evidence as never],
      }),
    );

    const expectedCandidate: ModuleContent = {
      kind: 'markdown',
      sections: [
        { id: 'intro', title: '新简介', markdown: '新的简介内容' },
        { id: 'detail', title: '细节', markdown: '原始细节内容' },
      ],
    };
    expect(result.patch.status).toBe('proposed');
    expect(result.patch.baseVersionId).toBe(versionId);
    expect(result.patch.moduleId).toBe(module.id);
    expect(result.patch.candidate).toEqual(expectedCandidate);
    expect(result.patch.candidateHash).toBe(contentHash(expectedCandidate));
    expect(result.patch.evidenceRefs).toHaveLength(1);
    expect(result.patch.acceptedVersionId).toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.patch.validationReportId).toBe(result.validation!.id);
    expect(result.validation!.status).toBe('pass');

    // Accepted state is untouched and only a draft is persisted.
    expect(world.modules.get(module.id)!.acceptedVersionId).toBe(versionId);
    expect(world.versions.size).toBe(1);
    expect(world.calls.saveProposal).toBe(1);
    expect(world.calls.saveValidationReport).toBe(0);
    expect(world.proposals).toHaveLength(1);
  });

  it('rejects a base version that is not the current accepted version', async () => {
    const { world, module, versionId } = makeFixture();
    const failure = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: '77777777-7777-4777-8777-777777777777',
        description: 'stale base',
        operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
        evidenceRefs: [],
      }),
    );
    expect(failure.code).toBe('version_conflict');
    expect(world.calls.saveProposal).toBe(0);
    expect(world.modules.get(module.id)!.acceptedVersionId).toBe(versionId);
  });

  it('rejects unknown sections and wrong module kinds without persisting', async () => {
    const { world, module, versionId } = makeFixture();
    const unknownSection = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: versionId,
        description: 'bad section',
        operations: [{ kind: 'markdown.replace_section', sectionId: 'nope', markdown: 'x' }],
        evidenceRefs: [],
      }),
    );
    expect(unknownSection.code).toBe('patch_invalid');
    expect((unknownSection.details as { patchCode?: string }).patchCode).toBe('section_not_found');

    const csv = world.addModule({
      kind: 'csv',
      title: 'csv module',
      content: {
        kind: 'csv',
        columns: [{ key: 'id', label: 'id', type: 'string', required: false }],
        rows: [{ id: '1' }],
      },
    });
    const wrongKind = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: csv.module.id,
        baseVersionId: csv.version!.id,
        description: 'wrong kind',
        operations: [{ kind: 'markdown.replace_section', sectionId: 'intro', markdown: 'x' }],
        evidenceRefs: [],
      }),
    );
    expect(wrongKind.code).toBe('patch_invalid');
    expect((wrongKind.details as { patchCode?: string }).patchCode).toBe('module_kind_mismatch');
    expect(world.calls.saveProposal).toBe(0);
  });

  it('accepts JSON pointer patches on json modules', async () => {
    const world = createTestWorld();
    const { module, version } = world.addModule({ kind: 'json', title: 'json', content: { kind: 'json', value: { a: 1 } } });
    const result = succeededData<ProposePatchResult>(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: version!.id,
        description: 'set b',
        operations: [{ kind: 'json.patch', operations: [{ op: 'add', path: '/b', value: 2 }] }],
        evidenceRefs: [],
      }),
    );
    expect(result.patch.candidate).toEqual({ kind: 'json', value: { a: 1, b: 2 } });
    expect(result.patch.candidateHash).toBe(contentHash({ kind: 'json', value: { a: 1, b: 2 } }));

    const unknownPath = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: version!.id,
        description: 'bad path',
        operations: [{ kind: 'json.patch', operations: [{ op: 'replace', path: '/missing', value: 1 }] }],
        evidenceRefs: [],
      }),
    );
    expect(unknownPath.code).toBe('patch_invalid');
    expect((unknownPath.details as { patchCode?: string }).patchCode).toBe('path_not_found');
  });

  it('creates a first proposal for a module without an accepted version', async () => {
    const world = createTestWorld();
    const { module } = world.addModule({ kind: 'csv', accepted: false });
    const content: CsvContent = {
      kind: 'csv',
      columns: [{ key: 'id', label: 'id', type: 'string', required: true }],
      rows: [{ id: '1' }],
    };
    const result = succeededData<ProposePatchResult>(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: null,
        description: 'initial data',
        operations: [{ kind: 'replace_module', content }],
        evidenceRefs: [],
      }),
    );
    expect(result.patch.baseVersionId).toBeNull();
    expect(result.patch.candidate).toEqual(content);
  });

  it('rejects fabricated source-span evidence', async () => {
    const { world, module, versionId, evidence } = makeFixture();
    const forgedHash: EvidenceRef = {
      ...evidence,
      kind: 'source_span',
      span: { ...(evidence as Extract<EvidenceRef, { kind: 'source_span' }>).span, quoteHash: sha256Hex('different') },
    };
    const hashFailure = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: versionId,
        description: 'forged hash',
        operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
        evidenceRefs: [forgedHash as never],
      }),
    );
    expect(hashFailure.code).toBe('evidence_invalid');

    const forgedExcerpt: EvidenceRef = {
      ...evidence,
      kind: 'source_span',
      span: { ...(evidence as Extract<EvidenceRef, { kind: 'source_span' }>).span, excerpt: '这句话不在来源里' },
    };
    const excerptFailure = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: versionId,
        description: 'forged excerpt',
        operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
        evidenceRefs: [forgedExcerpt as never],
      }),
    );
    expect(excerptFailure.code).toBe('evidence_invalid');

    const missingVersion: EvidenceRef = {
      kind: 'source_span',
      span: {
        ...(evidence as Extract<EvidenceRef, { kind: 'source_span' }>).span,
        version: 9,
      },
    };
    const versionFailure = failureOf(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: versionId,
        description: 'missing source version',
        operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
        evidenceRefs: [missingVersion as never],
      }),
    );
    expect(versionFailure.code).toBe('evidence_invalid');
    expect(world.calls.saveProposal).toBe(0);
  });

  it('accepts artifact_version evidence and rejects unknown versions', async () => {
    const { world, module, versionId } = makeFixture();
    const accepted: EvidenceRef = { kind: 'artifact_version', versionId: versionId as never, moduleId: module.id };
    const result = succeededData<ProposePatchResult>(
      await call(world, 'artifact.propose_patch', {
        moduleId: module.id,
        baseVersionId: null,
        description: 'from accepted baseline',
        operations: [{ kind: 'markdown.replace_section', sectionId: 'intro', markdown: 'y' }],
        evidenceRefs: [accepted as never],
      }),
    );
    expect(result.patch.evidenceRefs).toHaveLength(1);

    const unknown: EvidenceRef = {
      kind: 'artifact_version',
      versionId: '77777777-7777-4777-8777-777777777777' as never,
      moduleId: module.id,
    };
    expect(
      failureOf(
        await call(world, 'artifact.propose_patch', {
          moduleId: module.id,
          baseVersionId: null,
          description: 'unknown baseline',
          operations: [{ kind: 'markdown.replace_section', sectionId: 'intro', markdown: 'z' }],
          evidenceRefs: [unknown as never],
        }),
      ).code,
    ).toBe('evidence_invalid');
  });

  it('requires a validator to be configured', async () => {
    const { world, module, versionId } = makeFixture();
    world.validator = null;
    expect(
      failureOf(
        await call(world, 'artifact.propose_patch', {
          moduleId: module.id,
          baseVersionId: versionId,
          description: 'no validator',
          operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
          evidenceRefs: [],
        }),
      ).code,
    ).toBe('validator_unavailable');
    expect(world.calls.saveProposal).toBe(0);
  });

  it('rejects proposals when the validator hashes a different candidate', async () => {
    const { world, module, versionId } = makeFixture();
    world.validator = {
      async validate(input) {
        return {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
          taskId: input.taskId,
          runId: input.runId,
          moduleId: input.moduleId,
          baseVersionId: input.baseVersion ? input.baseVersion.id : null,
          candidateHash: sha256Hex('wrong candidate'),
          checks: [],
          status: 'pass',
          summary: 'wrong hash',
          validatorVersion: 'test',
          createdAt: world.nowIso,
        };
      },
    };
    expect(
      failureOf(
        await call(world, 'artifact.propose_patch', {
          moduleId: module.id,
          baseVersionId: versionId,
          description: 'misbehaving validator',
          operations: [{ kind: 'markdown.remove_section', sectionId: 'detail' }],
          evidenceRefs: [],
        }),
      ).code,
    ).toBe('validation_mismatch');
    expect(world.calls.saveProposal).toBe(0);
  });
});

describe('artifact.validate', () => {
  it('validates a candidate, persists the report and returns its status', async () => {
    const { world, module, versionId, evidence } = makeFixture();
    const candidate: ModuleContent = {
      kind: 'markdown',
      sections: [{ id: 'intro', title: '简介', markdown: '候选内容' }],
    };
    const args: ArtifactValidateArgs = {
      moduleId: module.id,
      baseVersionId: versionId,
      candidate,
      evidenceRefs: [evidence as never],
    };
    const result = succeededData<ValidateToolResult>(await call(world, 'artifact.validate', args));
    expect(result.status).toBe('pass');
    expect(result.reportId).toBe(result.validation.id);
    expect(result.validation.candidateHash).toBe(contentHash(candidate));
    expect(result.validation.moduleId).toBe(module.id);
    expect(result.validation.baseVersionId).toBe(versionId);
    expect(world.calls.validate).toBe(1);
    expect(world.calls.saveValidationReport).toBe(1);
    expect(world.validationReports).toHaveLength(1);
  });

  it('fails when no validator is configured', async () => {
    const { world, module } = makeFixture();
    world.validator = null;
    expect(
      failureOf(
        await call(world, 'artifact.validate', {
          moduleId: module.id,
          baseVersionId: null,
          candidate: MARKDOWN,
          evidenceRefs: [],
        }),
      ).code,
    ).toBe('validator_unavailable');
  });

  it('rejects a base version from another module', async () => {
    const { world, module } = makeFixture();
    const other = world.addModule({ kind: 'json', title: 'other', content: { kind: 'json', value: 1 } });
    expect(
      failureOf(
        await call(world, 'artifact.validate', {
          moduleId: module.id,
          baseVersionId: other.version!.id,
          candidate: MARKDOWN,
          evidenceRefs: [],
        }),
      ).code,
    ).toBe('version_not_found');
  });
});
