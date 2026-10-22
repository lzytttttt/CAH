import { describe, expect, it } from 'vitest';
import {
  type SearchHit,
  type SourceListResult,
  type SourceReadResult,
  type SourceSearchResult,
} from '@ca/contracts';
import { createToolRuntime, sha256Hex, spanRefFromHit } from '@ca/tools';
import {
  failureOf,
  jsonArg,
  makeSourceItem,
  succeededData,
  createTestWorld,
  type TestWorld,
} from './helpers';
import { SOURCE_ID_A, SOURCE_ID_B, SOURCE_ID_C } from './source-ids';

const runtime = createToolRuntime();

async function call(world: TestWorld, toolId: Parameters<typeof runtime.execute>[0], args: unknown) {
  return runtime.execute(toolId, jsonArg(args), world.ctx());
}

const MARKDOWN = ['# 产品简报', '预算约束：延迟预算 200ms', '离线模式必须可用', '预算需要复核'].join('\n');

const CSV = [
  'id,name,budget',
  'S-1001,ERP 财务核心,1200',
  'S-1002,CRM 客户关系,860',
  'S-1003,预算工具,430',
].join('\n');

function makeWorld(): TestWorld {
  const world = createTestWorld();
  world.addSource({ id: SOURCE_ID_A, name: 'product-brief.md', mime: 'text/markdown', text: MARKDOWN });
  world.addSource({ id: SOURCE_ID_B, name: 'legacy-systems.csv', mime: 'text/csv', text: CSV });
  return world;
}

describe('source.list', () => {
  it('lists available sources sorted by name and hides unavailable ones by default', async () => {
    const world = makeWorld();
    world.addSource({
      id: SOURCE_ID_C,
      name: 'broken.csv',
      mime: 'text/csv',
      text: 'a\n1\n',
      availability: 'missing',
    });
    const visible = succeededData<SourceListResult>(await call(world, 'source.list', {}));
    expect(visible.items.map((item) => item.name)).toEqual(['legacy-systems.csv', 'product-brief.md']);
    const all = succeededData<SourceListResult>(await call(world, 'source.list', { includeUnavailable: true }));
    expect(all.items.map((item) => item.name)).toEqual(['broken.csv', 'legacy-systems.csv', 'product-brief.md']);
    expect(all.items.find((item) => item.name === 'broken.csv')?.availability).toBe('missing');
  });
});

describe('source.read', () => {
  it('reads an explicit text_lines range exactly', async () => {
    const world = makeWorld();
    const result = succeededData<SourceReadResult>(
      await call(world, 'source.read', { sourceId: SOURCE_ID_A, version: 1, locator: { kind: 'text_lines', startLine: 2, endLine: 3 }, maxChars: 8000 }),
    );
    expect(result.content).toBe('预算约束：延迟预算 200ms\n离线模式必须可用');
    expect(result.locator).toEqual({ kind: 'text_lines', startLine: 2, endLine: 3 });
    expect(result.totalChars).toBe(result.content.length);
    expect(result.truncated).toBe(false);
    expect(result.trust).toBe('untrusted_content');
  });

  it('defaults to the whole document and truncates to maxChars', async () => {
    const world = makeWorld();
    const full = succeededData<SourceReadResult>(
      await call(world, 'source.read', { sourceId: SOURCE_ID_A, version: 1, maxChars: 8000 }),
    );
    expect(full.content).toBe(MARKDOWN);
    expect(full.truncated).toBe(false);
    expect(full.locator).toEqual({ kind: 'text_lines', startLine: 1, endLine: 4 });

    const bounded = succeededData<SourceReadResult>(
      await call(world, 'source.read', { sourceId: SOURCE_ID_A, version: 1, maxChars: 5 }),
    );
    expect(bounded.content.length).toBeLessThanOrEqual(5);
    expect(bounded.totalChars).toBe(MARKDOWN.length);
    expect(bounded.truncated).toBe(true);
  });

  it('reads csv_rows rows by 1-based data row number', async () => {
    const world = makeWorld();
    const result = succeededData<SourceReadResult>(
      await call(world, 'source.read', {
        sourceId: SOURCE_ID_B,
        version: 1,
        locator: { kind: 'csv_rows', rowNumbers: [1, 3] },
        maxChars: 8000,
      }),
    );
    expect(result.locator).toEqual({ kind: 'csv_rows', rowNumbers: [1, 3] });
    expect(result.content.split(/\r?\n/).filter(Boolean)).toEqual([
      'id,name,budget',
      'S-1001,ERP 财务核心,1200',
      'S-1003,预算工具,430',
    ]);
  });

  it('reads a csv row by primary key, including trimmed fallback', async () => {
    const world = makeWorld();
    const result = succeededData<SourceReadResult>(
      await call(world, 'source.read', {
        sourceId: SOURCE_ID_B,
        version: 1,
        locator: { kind: 'csv_key', primaryKeyColumn: 'id', primaryKeyValue: 'S-1002' },
        maxChars: 8000,
      }),
    );
    expect(result.content).toContain('S-1002,CRM 客户关系,860');
    expect((failureOf(await call(world, 'source.read', {
      sourceId: SOURCE_ID_B,
      version: 1,
      locator: { kind: 'csv_key', primaryKeyColumn: 'id', primaryKeyValue: 'nope' },
      maxChars: 100,
    }))).code).toBe('key_not_found');
  });

  it('resolves json_pointer locators', async () => {
    const world = createTestWorld();
    world.addSource({
      id: SOURCE_ID_C,
      name: 'constraints.json',
      mime: 'application/json',
      text: JSON.stringify({ constraints: { latency: [100, 200], offline: true } }),
    });
    const result = succeededData<SourceReadResult>(
      await call(world, 'source.read', {
        sourceId: SOURCE_ID_C,
        version: 1,
        locator: { kind: 'json_pointer', pointer: '/constraints/latency' },
        maxChars: 200,
      }),
    );
    expect(result.content).toBe(JSON.stringify([100, 200], null, 2));
    expect((failureOf(await call(world, 'source.read', {
      sourceId: SOURCE_ID_C,
      version: 1,
      locator: { kind: 'json_pointer', pointer: '/missing' },
      maxChars: 200,
    }))).code).toBe('json_pointer_not_found');
  });

  it('fails predictably for unknown sources, bad versions and invalid locators', async () => {
    const world = makeWorld();
    expect(
      failureOf(await call(world, 'source.read', { sourceId: '99999999-9999-4999-8999-999999999999', version: 1, maxChars: 100 }))
        .code,
    ).toBe('source_not_found');
    expect(
      failureOf(await call(world, 'source.read', { sourceId: SOURCE_ID_A, version: 2, maxChars: 100 })).code,
    ).toBe('source_not_found');
    expect(
      failureOf(await call(world, 'source.read', {
        sourceId: SOURCE_ID_A,
        version: 1,
        locator: { kind: 'text_lines', startLine: 5, endLine: 3 },
        maxChars: 100,
      })).code,
    ).toBe('locator_invalid');
    expect(
      failureOf(await call(world, 'source.read', {
        sourceId: SOURCE_ID_A,
        version: 1,
        locator: { kind: 'text_lines', startLine: 9, endLine: 10 },
        maxChars: 100,
      })).code,
    ).toBe('locator_out_of_range');
    expect(
      failureOf(await call(world, 'source.read', {
        sourceId: SOURCE_ID_B,
        version: 1,
        locator: { kind: 'csv_rows', rowNumbers: [99] },
        maxChars: 100,
      })).code,
    ).toBe('locator_out_of_range');
  });

  it('never reads sources that belong to another task', async () => {
    const world = makeWorld();
    const foreign = makeSourceItem(
      { id: SOURCE_ID_C, name: 'foreign.csv', mime: 'text/csv', text: 'a\n1\n' },
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
    );
    world.sources.set(`${foreign.id}@${foreign.version}`, {
      source: foreign,
      bytes: new TextEncoder().encode('a\n1\n'),
    });
    expect(failureOf(await call(world, 'source.read', { sourceId: SOURCE_ID_C, version: 1, maxChars: 100 })).code).toBe(
      'source_not_found',
    );
  });

  it('rejects non UTF-8 source bytes', async () => {
    const world = makeWorld();
    world.sources.set(`${SOURCE_ID_C}@1`, {
      source: makeSourceItem({ id: SOURCE_ID_C, name: 'latin1.txt', mime: 'text/plain', text: 'x' }),
      bytes: new Uint8Array([0xff, 0xfe, 0x00]),
    });
    expect(failureOf(await call(world, 'source.read', { sourceId: SOURCE_ID_C, version: 1, maxChars: 100 })).code).toBe(
      'unsupported_encoding',
    );
  });
});

describe('source.search', () => {
  it('returns real spans whose hash verifies against the exact excerpt', async () => {
    const world = makeWorld();
    const result = succeededData<SourceSearchResult>(await call(world, 'source.search', { query: '预算' }));
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.searchedSources.sort()).toEqual([SOURCE_ID_A, SOURCE_ID_B].sort());
    expect(world.calls.saveSpan).toBe(result.hits.length);
    expect(world.spans).toHaveLength(result.hits.length);

    for (const hit of result.hits) {
      expect(hit.excerpt.length).toBeLessThanOrEqual(400);
      expect(hit.quoteHash).toBe(sha256Hex(hit.excerpt));
      expect(hit.score).toBeGreaterThanOrEqual(1);
      const persisted = world.spans.find((span) => span.id === hit.spanId);
      expect(persisted).toBeDefined();
      expect(persisted?.quoteHash).toBe(hit.quoteHash);
      expect(persisted?.version).toBe(hit.version);
      expect(persisted?.createdAt).toBe(world.nowIso);
    }

    const textHit = result.hits.find((hit) => hit.sourceId === SOURCE_ID_A);
    expect(textHit?.locator.kind).toBe('text_lines');
    if (textHit?.locator.kind === 'text_lines') {
      const sourceLine = MARKDOWN.split('\n')[textHit.locator.startLine - 1]!;
      expect(sourceLine).toContain('预算');
      expect(textHit.excerpt).toBe(sourceLine);
    }

    const csvHit = result.hits.find((hit) => hit.sourceId === SOURCE_ID_B);
    expect(csvHit?.locator.kind).toBe('csv_rows');
    if (csvHit?.locator.kind === 'csv_rows') {
      expect(csvHit.locator.rowNumbers).toEqual([3]);
      expect(csvHit.excerpt).toContain('预算');
    }

    const ref = spanRefFromHit(result.hits[0]!);
    expect(ref.quoteHash).toBe(result.hits[0]!.quoteHash);
    expect(ref.spanId).toBe(result.hits[0]!.spanId);
  });

  it('ranks by occurrence count and honors the limit', async () => {
    const world = createTestWorld();
    world.addSource({
      id: SOURCE_ID_A,
      name: 'twice.txt',
      mime: 'text/plain',
      text: 'keyword keyword\nkeyword\n',
    });
    const limited = succeededData<SourceSearchResult>(await call(world, 'source.search', { query: 'keyword', limit: 1 }));
    expect(limited.hits).toHaveLength(1);
    expect(limited.hits[0]!.score).toBe(2);
    const all = succeededData<SourceSearchResult>(await call(world, 'source.search', { query: 'keyword', limit: 5 }));
    expect(all.hits).toHaveLength(2);
  });

  it('searches case-insensitively and filters by sourceIds', async () => {
    const world = makeWorld();
    const upper = succeededData<SourceSearchResult>(await call(world, 'source.search', { query: 'BUDGET' }));
    expect(upper.hits.some((hit) => hit.sourceId === SOURCE_ID_B)).toBe(true);

    const filtered = succeededData<SourceSearchResult>(
      await call(world, 'source.search', { query: '预算', sourceIds: [SOURCE_ID_A] }),
    );
    expect(filtered.searchedSources).toEqual([SOURCE_ID_A]);
    expect(filtered.hits.every((hit) => hit.sourceId === SOURCE_ID_A)).toBe(true);
  });

  it('rejects empty queries, unknown sources and multiline queries without writing spans', async () => {
    const world = makeWorld();
    expect(failureOf(await call(world, 'source.search', { query: '   ' })).code).toBe('empty_query');
    expect(
      failureOf(
        await call(world, 'source.search', { query: 'x', sourceIds: ['99999999-9999-4999-8999-999999999999'] }),
      ).code,
    ).toBe('source_not_found');
    expect(failureOf(await call(world, 'source.search', { query: 'a\nb' })).code).toBe('invalid_arguments');
    expect(world.calls.saveSpan).toBe(0);
  });

  it('produces deterministic span ids for the same content', async () => {
    const first = makeWorld();
    const second = makeWorld();
    const a = succeededData<SourceSearchResult>(await call(first, 'source.search', { query: '预算' }));
    const b = succeededData<SourceSearchResult>(await call(second, 'source.search', { query: '预算' }));
    const idsA = a.hits.map((hit: SearchHit) => hit.spanId).sort();
    const idsB = b.hits.map((hit: SearchHit) => hit.spanId).sort();
    expect(idsA).toEqual(idsB);
    expect(idsA[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not fabricate hits for absent terms', async () => {
    const world = makeWorld();
    const result = succeededData<SourceSearchResult>(
      await call(world, 'source.search', { query: 'totally-absent-term' }),
    );
    expect(result.hits).toEqual([]);
    expect(world.calls.saveSpan).toBe(0);
  });
});
