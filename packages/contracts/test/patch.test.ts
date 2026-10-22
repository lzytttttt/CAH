import { describe, expect, it } from 'vitest';
import {
  applyPatchOperations,
  diffModuleContent,
  PatchApplyError,
  MarkdownContentSchema,
  CsvContentSchema,
  ModuleIdSchema,
  ArtifactVersionIdSchema,
  Sha256HexSchema,
  type MarkdownContent,
  type PatchOperation,
} from '../src/index';

const moduleId = ModuleIdSchema.parse('0b6d0f2e-2ad4-4f0e-8a2f-6a0d3f2e9c11');
const sha = 'a'.repeat(64);

function markdown(): MarkdownContent {
  return MarkdownContentSchema.parse({
    kind: 'markdown',
    sections: [
      { id: 'overview', title: '概览', markdown: '# 概览\n旧内容' },
      { id: 'architecture', title: '架构', markdown: '# 架构\n组件 A' },
    ],
  });
}

describe('patch application', () => {
  it('replaces a markdown section by stable id', () => {
    const ops: PatchOperation[] = [
      { kind: 'markdown.replace_section', sectionId: 'architecture', markdown: '# 架构\n组件 A 与 B' },
    ];
    const result = applyPatchOperations(markdown(), 'markdown', ops);
    expect(result.kind).toBe('markdown');
    if (result.kind !== 'markdown') throw new Error('unreachable');
    expect(result.sections[1]!.markdown).toContain('组件 A 与 B');
    expect(result.sections[0]!.markdown).toContain('旧内容');
  });

  it('rejects unknown section ids instead of silently creating them', () => {
    expect(() =>
      applyPatchOperations(markdown(), 'markdown', [
        { kind: 'markdown.replace_section', sectionId: 'missing', markdown: 'x' },
      ]),
    ).toThrow(PatchApplyError);
  });

  it('inserts a section with an explicit id, or a deterministic slug', () => {
    const explicit = applyPatchOperations(markdown(), 'markdown', [
      { kind: 'markdown.insert_section', afterSectionId: 'overview', title: '约束', markdown: '## 约束', id: 'constraints' },
    ]);
    if (explicit.kind !== 'markdown') throw new Error('unreachable');
    expect(explicit.sections.map((s) => s.id)).toEqual(['overview', 'constraints', 'architecture']);

    const slugged = applyPatchOperations(markdown(), 'markdown', [
      { kind: 'markdown.insert_section', afterSectionId: null, title: 'Risks & Constraints', markdown: '## risks' },
    ]);
    if (slugged.kind !== 'markdown') throw new Error('unreachable');
    expect(slugged.sections[slugged.sections.length - 1]!.id).toBe('risks-constraints');
  });

  it('removes a section', () => {
    const result = applyPatchOperations(markdown(), 'markdown', [
      { kind: 'markdown.remove_section', sectionId: 'overview' },
    ]);
    if (result.kind !== 'markdown') throw new Error('unreachable');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.id).toBe('architecture');
  });

  it('applies restricted JSON patch operations', () => {
    const base = { kind: 'json' as const, value: { architecture: { modules: ['a'], version: 1 } } };
    const result = applyPatchOperations(base, 'json', [
      { kind: 'json.patch', operations: [{ op: 'replace', path: '/architecture/version', value: 2 }] },
      { kind: 'json.patch', operations: [{ op: 'add', path: '/architecture/modules/-', value: 'b' }] },
    ]);
    expect(result).toEqual({ kind: 'json', value: { architecture: { modules: ['a', 'b'], version: 2 } } });
  });

  it('rejects forbidden JSON pointer segments', () => {
    const base = { kind: 'json' as const, value: { a: 1 } };
    expect(() =>
      applyPatchOperations(base, 'json', [
        { kind: 'json.patch', operations: [{ op: 'add', path: '/__proto__/polluted', value: true }] },
      ]),
    ).toThrow(/forbidden/i);
  });

  it('rejects replacing an unknown JSON path', () => {
    const base = { kind: 'json' as const, value: { a: 1 } };
    expect(() =>
      applyPatchOperations(base, 'json', [
        { kind: 'json.patch', operations: [{ op: 'replace', path: '/missing', value: 2 }] },
      ]),
    ).toThrow(/does not resolve|not found/i);
  });

  it('replaces csv rows while keeping the declared columns', () => {
    const base = CsvContentSchema.parse({
      kind: 'csv',
      columns: [
        { key: 'id', label: 'ID', type: 'string', required: true },
        { key: 'name', label: '名称', type: 'string', required: true },
      ],
      rows: [{ id: '1', name: 'a' }],
    });
    const result = applyPatchOperations(base, 'csv', [
      { kind: 'csv.replace_rows', columns: [{}, {}], rows: [['1', 'b'], ['2', 'c']] },
    ]);
    if (result.kind !== 'csv') throw new Error('unreachable');
    expect(result.rows).toEqual([
      { id: '1', name: 'b' },
      { id: '2', name: 'c' },
    ]);
  });
});

describe('content diff', () => {
  it('reports changed sections with stats', () => {
    const base = markdown();
    const next = MarkdownContentSchema.parse({
      kind: 'markdown',
      sections: [
        { id: 'overview', title: '概览', markdown: '# 概览\n旧内容' },
        { id: 'architecture', title: '架构', markdown: '# 架构\n新内容' },
        { id: 'risks', title: '风险', markdown: '# 风险' },
      ],
    });
    const diff = diffModuleContent(moduleId, 'markdown', base, next, {
      baseVersionId: ArtifactVersionIdSchema.parse('5c1a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'),
      candidateHash: sha,
    });
    expect(diff.stats.added).toBe(1);
    expect(diff.stats.changed).toBe(1);
    expect(diff.stats.unchanged).toBe(1);
    expect(diff.entries.find((e) => e.sectionId === 'risks')?.change).toBe('added');
    expect(Sha256HexSchema.parse(sha)).toBe(sha);
  });

  it('reports added content for an empty base', () => {
    const diff = diffModuleContent(moduleId, 'markdown', null, markdown(), {
      baseVersionId: null,
      candidateHash: sha,
    });
    expect(diff.stats.added).toBe(2);
    expect(diff.baseVersionId).toBeNull();
  });
});
