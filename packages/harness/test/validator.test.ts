import { describe, expect, it } from 'vitest';
import {
  isCommitAllowed,
  newSourceSpanId,
  newUuid as uuid,
  type ModuleContent,
} from '@ca/contracts';
import { createArtifactValidator } from '../src/validator';
import { contentHash, sha256Hex } from '../src/hashing';
import {
  createFixture,
  csvCandidate,
  markdownCandidate,
  seedAcceptedVersion,
  sourceSpanEvidence,
} from './fixtures';
import { constraintConflictDecisionKey, detectConstraintConflicts } from '../src/risk-rules';

function codes(report: { checks: Array<{ code: string; status: string }> }): string[] {
  return report.checks.filter((check) => check.status !== 'pass' && check.status !== 'not_applicable').map((check) => check.code);
}

function checkStatus(report: { checks: Array<{ code: string; status: string }> }, code: string): string | undefined {
  return report.checks.find((check) => check.code === code)?.status;
}

describe('deterministic artifact validator (L0-L4)', () => {
  it('passes a valid markdown candidate and keeps L4 human review as needs_review', async () => {
    const fixture = await createFixture({ modules: [{ title: '校验模块', kind: 'markdown' }] });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const candidate = markdownCandidate([{ id: 's1', title: '第一节', markdown: '正文内容，可读。' }]);
      const report = await validator.validate({
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        candidate,
        evidenceRefs: [],
        baseVersion: null,
      });
      expect(report.status).toBe('needs_review');
      expect(isCommitAllowed(report)).toBe(true);
      expect(checkStatus(report, 'human_review')).toBe('needs_review');
      expect(report.candidateHash).toBe(contentHash(candidate));
      expect(report.validatorVersion).toBe('harness-validator-1');
      // Deterministic candidate hash across runs.
      const again = await validator.validate({
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        candidate,
        evidenceRefs: [],
        baseVersion: null,
      });
      expect(again.candidateHash).toBe(report.candidateHash);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('fails duplicated markdown section ids, empty sections, raw scripts and TODO placeholders', async () => {
    const fixture = await createFixture({ modules: [{ title: 'Markdown 规则', kind: 'markdown' }] });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        evidenceRefs: [] as never[],
        baseVersion: null,
      };
      const duplicate = await validator.validate({
        ...base,
        candidate: markdownCandidate([
          { id: 'dup', title: '一', markdown: '正文一' },
          { id: 'dup', title: '二', markdown: '正文二' },
        ]),
      });
      expect(checkStatus(duplicate, 'markdown_section_ids_unique')).toBe('fail');
      expect(isCommitAllowed(duplicate)).toBe(false);

      const empty = await validator.validate({
        ...base,
        candidate: markdownCandidate([{ id: 'a', title: '空', markdown: '   ' }]),
      });
      expect(checkStatus(empty, 'markdown_sections_nonempty')).toBe('fail');

      const script = await validator.validate({
        ...base,
        candidate: markdownCandidate([{ id: 'a', title: '脚本', markdown: '<script>alert(1)</script>正文' }]),
      });
      expect(checkStatus(script, 'render_safety')).toBe('fail');

      const placeholder = await validator.validate({
        ...base,
        candidate: markdownCandidate([{ id: 'a', title: '占位', markdown: '这里待补充：TODO' }]),
      });
      expect(checkStatus(placeholder, 'completeness')).toBe('needs_review');
      expect(isCommitAllowed(placeholder)).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('checks CSV columns, required values, declared types and duplicate rows', async () => {
    const fixture = await createFixture({ modules: [{ title: 'CSV 规则', kind: 'csv' }] });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        evidenceRefs: [] as never[],
        baseVersion: null,
      };
      const columns = [
        { key: 'id', label: 'ID', type: 'string' as const, required: true },
        { key: 'amount', label: '金额', type: 'number' as const, required: true },
      ];
      const valid = await validator.validate({
        ...base,
        candidate: csvCandidate(columns, [
          { id: '1', amount: 12 },
          { id: '2', amount: 34 },
        ]),
      });
      expect(isCommitAllowed(valid)).toBe(true);

      const missingRequired = await validator.validate({
        ...base,
        candidate: csvCandidate(columns, [{ id: '1', amount: null }]),
      });
      expect(checkStatus(missingRequired, 'csv_required_values')).toBe('fail');
      expect(missingRequired.checks.find((check) => check.code === 'csv_required_values')!.detail).toContain('第 1 行');

      const badType = await validator.validate({
        ...base,
        candidate: csvCandidate(columns, [{ id: '1', amount: 'not-a-number' }]),
      });
      expect(checkStatus(badType, 'csv_column_types')).toBe('fail');

      const duplicates = await validator.validate({
        ...base,
        candidate: csvCandidate(columns, [
          { id: '1', amount: 12 },
          { id: '1', amount: 12 },
        ]),
      });
      expect(checkStatus(duplicates, 'csv_duplicate_rows')).toBe('needs_review');
      expect(isCommitAllowed(duplicates)).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('checks JSON depth, unsafe keys, id uniqueness and dependency cycles', async () => {
    const fixture = await createFixture({ modules: [{ title: 'JSON 规则', kind: 'json' }] });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        evidenceRefs: [] as never[],
        baseVersion: null,
      };
      let deep: unknown = 'leaf';
      for (let index = 0; index < 40; index += 1) deep = { child: deep };
      const deepReport = await validator.validate({ ...base, candidate: { kind: 'json', value: deep as never } });
      expect(checkStatus(deepReport, 'json_depth')).toBe('fail');

      const unsafe = JSON.parse('{"__proto__": {"x": 1}, "ok": 2}') as ModuleContent;
      const unsafeReport = await validator.validate({ ...base, candidate: { kind: 'json', value: unsafe as never } });
      expect(checkStatus(unsafeReport, 'json_safe_keys')).toBe('fail');

      const duplicateIds = { kind: 'json', value: { components: [{ id: 'a' }, { id: 'a' }] } } as ModuleContent;
      const dupReport = await validator.validate({ ...base, candidate: duplicateIds });
      expect(checkStatus(dupReport, 'json_ids_unique')).toBe('fail');

      const cycle = {
        kind: 'json',
        value: { components: [{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['a'] }] },
      } as ModuleContent;
      const cycleReport = await validator.validate({ ...base, candidate: cycle });
      expect(checkStatus(cycleReport, 'json_dependency_acyclic')).toBe('fail');

      const valid = { kind: 'json', value: { components: [{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: [] }] } } as ModuleContent;
      const validReport = await validator.validate({ ...base, candidate: valid });
      expect(checkStatus(validReport, 'json_dependency_acyclic')).toBe('pass');
      expect(isCommitAllowed(validReport)).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('fails module dependency integrity until upstream modules have accepted versions', async () => {
    const fixture = await createFixture({
      modules: [
        { title: '上游', kind: 'markdown' },
        { title: '下游', kind: 'markdown', dependencies: [0] },
      ],
    });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        evidenceRefs: [] as never[],
        baseVersion: null,
      };
      const candidate = markdownCandidate([{ id: 's', title: 'S', markdown: '下游正文' }]);
      const before = await validator.validate({ ...base, moduleId: fixture.modules[1]!.id, candidate });
      expect(checkStatus(before, 'dependency_integrity')).toBe('fail');
      await seedAcceptedVersion(fixture, 0, markdownCandidate([{ id: 'u', title: 'U', markdown: '上游已接受' }]));
      const after = await validator.validate({ ...base, moduleId: fixture.modules[1]!.id, candidate });
      expect(checkStatus(after, 'dependency_integrity')).toBe('pass');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('verifies evidence refs against real spans and requires evidence when the module declares L2 criteria', async () => {
    const fixture = await createFixture({
      modules: [
        {
          title: '证据模块',
          kind: 'markdown',
          acceptanceCriteria: [{ text: '关键事实引用资料证据', layer: 'L2' }],
        },
      ],
    });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        baseVersion: null,
      };
      const candidate = markdownCandidate([{ id: 's', title: 'S', markdown: '关键事实如下。' }]);
      const noEvidence = await validator.validate({ ...base, candidate, evidenceRefs: [] });
      expect(checkStatus(noEvidence, 'evidence_required')).toBe('needs_review');

      const fakeSpanId = newSourceSpanId();
      const fake = await validator.validate({
        ...base,
        candidate,
        evidenceRefs: [
          sourceSpanEvidence({
            id: fakeSpanId,
            sourceId: uuid(),
            version: 1,
            locator: { kind: 'text_lines', startLine: 1, endLine: 1 },
            quoteHash: sha256Hex('真实证据片段'),
            excerpt: '真实证据片段',
          }),
        ],
      });
      expect(checkStatus(fake, 'source_spans_exist')).toBe('fail');

      const realSpanId = newSourceSpanId();
      const sourceId = uuid();
      const quoteHash = sha256Hex('真实证据片段');
      await fixture.storage.insertSpans([
        {
          id: realSpanId,
          sourceId: sourceId as never,
          version: 1,
          locator: { kind: 'text_lines', startLine: 1, endLine: 1 },
          quoteHash,
          excerpt: '真实证据片段',
          createdAt: fixture.clock.now(),
        },
      ]);
      const real = await validator.validate({
        ...base,
        candidate,
        evidenceRefs: [
          sourceSpanEvidence({
            id: realSpanId,
            sourceId,
            version: 1,
            locator: { kind: 'text_lines', startLine: 1, endLine: 1 },
            quoteHash,
            excerpt: '真实证据片段',
          }),
        ],
      });
      expect(checkStatus(real, 'source_spans_exist')).toBe('pass');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('fails L3 when real hard constraints conflict and no user decision exists', async () => {
    const fixture = await createFixture({
      modules: [{ title: '约束模块', kind: 'markdown' }],
      constraints: [
        { text: '首版必须支持完全离线私有化部署，业务数据不离开客户内网。', kind: 'hard' },
        { text: '核心交互必须依赖云端实时大模型服务完成生成。', kind: 'hard' },
      ],
    });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const candidate = markdownCandidate([{ id: 's', title: 'S', markdown: '部署说明正文。' }]);
      const base = {
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        candidate,
        evidenceRefs: [] as never[],
        baseVersion: null,
      };
      const unresolved = await validator.validate(base);
      expect(checkStatus(unresolved, 'constraint_conflicts')).toBe('fail');
      const conflict = detectConstraintConflicts(
        (await fixture.storage.getTask(fixture.task.id))!.constraints,
      )[0]!;
      await fixture.storage.insertDecision({
        id: uuid() as never,
        taskId: fixture.task.id,
        runId: uuid() as never,
        blockerId: null,
        planVersion: null,
        key: constraintConflictDecisionKey(conflict),
        valueJson: JSON.stringify({ resolution: '混合部署' }),
        note: '用户显式选择',
        actor: 'user',
        createdAt: fixture.clock.now(),
      });
      const resolved = await validator.validate(base);
      expect(checkStatus(resolved, 'constraint_conflicts')).toBe('pass');
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it('never reports a self-score: every finding has a stable machine code and readable detail', async () => {
    const fixture = await createFixture({ modules: [{ title: '可读性模块', kind: 'markdown' }] });
    try {
      const validator = createArtifactValidator({ storage: fixture.storage, clock: fixture.clock });
      const report = await validator.validate({
        taskId: fixture.task.id,
        runId: uuid(),
        moduleId: fixture.modules[0]!.id,
        candidate: markdownCandidate([{ id: 'x', title: 'X', markdown: '内容' }]),
        evidenceRefs: [],
        baseVersion: null,
      });
      expect(report.checks.length).toBeGreaterThan(0);
      for (const check of report.checks) {
        expect(check.code.length).toBeGreaterThan(0);
        expect(check.title.length).toBeGreaterThan(0);
        expect(['L0', 'L1', 'L2', 'L3', 'L4']).toContain(check.layer);
        expect(['pass', 'fail', 'needs_review', 'not_applicable']).toContain(check.status);
      }
      expect(report.summary).toContain('确定性校验');
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

void codes;
