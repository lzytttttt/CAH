import { describe, expect, it } from 'vitest';
import {
  type DataProfileResult,
  type DataTransformResult,
  type SourceId,
} from '@ca/contracts';
import { createToolRuntime, tableToCsv } from '@ca/tools';
import { createTestWorld, failureOf, jsonArg, succeededData, type TestWorld } from './helpers';
import { SOURCE_ID_A, SOURCE_ID_B, SOURCE_ID_C } from './source-ids';

const runtime = createToolRuntime();

async function call(world: TestWorld, toolId: Parameters<typeof runtime.execute>[0], args: unknown) {
  return runtime.execute(toolId, jsonArg(args), world.ctx());
}

const LEGACY_CSV = [
  'sys_id,name,owner,status',
  ' S-1001 ,ERP 财务核心,财务部, running ',
  'S-1002,CRM 客户关系,销售部,Active',
  'S-1003,MES 制造执行,生产部,legacy',
  'S-1001,ERP 财务旧,财务部,retired',
  ',缺少主键,运营部,unknown',
].join('\n');

function makeWorld(): TestWorld {
  const world = createTestWorld();
  world.addSource({ id: SOURCE_ID_A, name: 'legacy-systems.csv', mime: 'text/csv', text: LEGACY_CSV });
  world.addSource({
    id: SOURCE_ID_B,
    name: 'constraints.json',
    mime: 'application/json',
    text: JSON.stringify([
      { key: 'offline', value: true, budget: 200 },
      { key: 'privacy', value: 'strict', budget: 100 },
    ]),
  });
  world.addSource({ id: SOURCE_ID_C, name: 'brief.md', mime: 'text/markdown', text: '# brief\n' });
  return world;
}

describe('data.profile', () => {
  it('profiles a CSV source through the tool runtime', async () => {
    const world = makeWorld();
    const result = await call(world, 'data.profile', { sourceId: SOURCE_ID_A, version: 1 });
    const profile = succeededData<DataProfileResult>(result);
    expect(result.status).toBe('succeeded');
    expect(profile.rowCount).toBe(5);
    expect(profile.columnCount).toBe(4);
    expect(profile.format).toBe('csv');
    const byKey = new Map(profile.columns.map((column) => [column.key, column]));
    expect(byKey.get('status')?.inferredType).toBe('string');
    expect(byKey.get('sys_id')?.missing).toBe(1);
    expect(profile.missingRequiredCount).toBeGreaterThanOrEqual(1);
  });

  it('profiles a JSON source', async () => {
    const world = makeWorld();
    const profile = succeededData<DataProfileResult>(
      await call(world, 'data.profile', { sourceId: SOURCE_ID_B, version: 1 }),
    );
    expect(profile.format).toBe('json');
    expect(profile.rowCount).toBe(2);
    expect(profile.columnCount).toBe(3);
  });

  it('rejects non-structured sources', async () => {
    const world = makeWorld();
    expect(failureOf(await call(world, 'data.profile', { sourceId: SOURCE_ID_C, version: 1 })).code).toBe(
      'unsupported_format',
    );
  });

  it('requires the data:profile scope', async () => {
    const world = makeWorld();
    world.setGrantedScopes(['sources:read']);
    expect(failureOf(await call(world, 'data.profile', { sourceId: SOURCE_ID_A, version: 1 })).code).toBe(
      'scope_denied',
    );
    expect(world.calls.getSource).toBe(0);
  });
});

describe('data.transform', () => {
  const operations = [
    { op: 'rename' as const, mapping: { sys_id: 'system_id' } },
    { op: 'normalize' as const, column: 'system_id', transforms: ['trim' as const, 'lower' as const] },
    { op: 'normalize' as const, column: 'status', transforms: ['trim' as const, 'lower' as const] },
    { op: 'dedupe' as const, keys: ['system_id'], keep: 'last' as const, normalize: 'trim_lower' as const },
    { op: 'require' as const, columns: ['system_id'] },
  ];

  it('writes a NEW object and never overwrites the source', async () => {
    const world = makeWorld();
    const sourceEntry = world.sources.get(`${SOURCE_ID_A}@1`)!;
    const originalBytes = sourceEntry.bytes.slice();

    const result = succeededData<DataTransformResult>(
      await call(world, 'data.transform', {
        sourceId: SOURCE_ID_A,
        version: 1,
        format: 'csv',
        operations,
        outputName: 'cleaned.csv',
      }),
    );

    expect(world.puts).toHaveLength(1);
    expect(world.calls.put).toBe(1);
    expect(world.sources.get(`${SOURCE_ID_A}@1`)!.bytes).toEqual(originalBytes);
    expect(sourceEntry.source.sizeBytes).toBe(originalBytes.length);

    expect(result.sourceId).toBe(SOURCE_ID_A);
    expect(result.version).toBe(1);
    expect(result.format).toBe('csv');
    expect(result.outputName).toBe('cleaned.csv');
    expect(result.deterministic).toBe(true);
    expect(result.objectHash).toBe(world.puts[0]!.hash);
    expect(world.puts[0]!.mime).toBe('text/csv');
    expect(result.rowCount).toBe(4);
    expect(result.preview).toHaveLength(4);
    expect(result.columns.map((column) => column.key)).toEqual(['system_id', 'name', 'owner', 'status']);
    expect(result.issues.some((issue) => issue.includes('require'))).toBe(true);
  });

  it('produces deterministic output bytes across repeated runs', async () => {
    const world = makeWorld();
    const args = { sourceId: SOURCE_ID_A, version: 1, format: 'csv', operations, outputName: 'cleaned.csv' };
    const first = succeededData<DataTransformResult>(await call(world, 'data.transform', args));
    const second = succeededData<DataTransformResult>(await call(world, 'data.transform', args));
    expect(world.puts).toHaveLength(2);
    expect(world.puts[0]!.text).toBe(world.puts[1]!.text);
    expect(second.objectHash).toBe(first.objectHash);
    expect(second.preview).toEqual(first.preview);
    expect(second.issues).toEqual(first.issues);
  });

  it('serializes the transformed table as CRLF CSV with a header', async () => {
    const world = makeWorld();
    const result = succeededData<DataTransformResult>(
      await call(world, 'data.transform', {
        sourceId: SOURCE_ID_A,
        version: 1,
        format: 'csv',
        operations: [
          { op: 'select', columns: ['name', 'status'] },
          { op: 'sort', column: 'name', direction: 'asc', numeric: false },
        ],
        outputName: 'subset.csv',
      }),
    );
    expect(result.rowCount).toBe(5);
    const lines = world.puts[0]!.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('name,status');
    expect(lines.length).toBe(6);
    expect(lines[1]).toBe('CRM 客户关系,Active');
  });

  it('transforms JSON sources and writes a JSON array object', async () => {
    const world = makeWorld();
    const result = succeededData<DataTransformResult>(
      await call(world, 'data.transform', {
        sourceId: SOURCE_ID_B,
        version: 1,
        format: 'json',
        operations: [
          { op: 'filter', column: 'budget', operator: 'gt', value: 150 },
          { op: 'select', columns: ['key', 'budget'] },
        ],
        outputName: 'filtered.json',
      }),
    );
    expect(result.rowCount).toBe(1);
    expect(world.puts[0]!.mime).toBe('application/json');
    expect(JSON.parse(world.puts[0]!.text)).toEqual([{ key: 'offline', budget: 200 }]);
  });

  it('rejects a format that contradicts the source type', async () => {
    const world = makeWorld();
    expect(
      failureOf(
        await call(world, 'data.transform', {
          sourceId: SOURCE_ID_A,
          version: 1,
          format: 'json',
          operations: [{ op: 'limit', count: 1 }],
        }),
      ).code,
    ).toBe('unsupported_format');
    expect(world.calls.put).toBe(0);
  });

  it('fails structural operator errors without writing anything', async () => {
    const world = makeWorld();
    expect(
      failureOf(
        await call(world, 'data.transform', {
          sourceId: SOURCE_ID_A,
          version: 1,
          format: 'csv',
          operations: [{ op: 'select', columns: ['missing_column'] }],
        }),
      ).code,
    ).toBe('column_not_found');
    expect(world.calls.put).toBe(0);
  });

  it('caps preview rows and issue strings for large outputs', async () => {
    const world = createTestWorld();
    const rows = Array.from({ length: 40 }, (_value, index) => `r${index},${index}`);
    world.addSource({
      id: SOURCE_ID_C,
      name: 'big.csv',
      mime: 'text/csv',
      text: `name,value\n${rows.join('\n')}\n`,
    });
    const result = succeededData<DataTransformResult>(
      await call(world, 'data.transform', {
        sourceId: SOURCE_ID_C,
        version: 1,
        format: 'csv',
        operations: [{ op: 'limit', count: 40 }],
        outputName: 'big.csv',
      }),
    );
    expect(result.rowCount).toBe(40);
    expect(result.preview).toHaveLength(20);
    expect(result.preview[0]).toEqual({ name: 'r0', value: '0' });
  });

  it('requires the data:transform scope', async () => {
    const world = makeWorld();
    world.setGrantedScopes(['sources:read']);
    expect(
      failureOf(
        await call(world, 'data.transform', {
          sourceId: SOURCE_ID_A,
          version: 1,
          format: 'csv',
          operations: [{ op: 'limit', count: 1 }],
        }),
      ).code,
    ).toBe('scope_denied');
    expect(world.calls.put).toBe(0);
  });

  it('produces output that matches the pure tableToCsv serialization', async () => {
    const world = makeWorld();
    const result = succeededData<DataTransformResult>(
      await call(world, 'data.transform', {
        sourceId: SOURCE_ID_A,
        version: 1,
        format: 'csv',
        operations: [{ op: 'select', columns: ['sys_id', 'name'] }],
        outputName: 'two.csv',
      }),
    );
    const expected = tableToCsv({
      columns: [
        { key: 'sys_id', label: 'sys_id' },
        { key: 'name', label: 'name' },
      ],
      rows: [
        { sys_id: ' S-1001 ', name: 'ERP 财务核心' },
        { sys_id: 'S-1002', name: 'CRM 客户关系' },
        { sys_id: 'S-1003', name: 'MES 制造执行' },
        { sys_id: 'S-1001', name: 'ERP 财务旧' },
        { sys_id: '', name: '缺少主键' },
      ],
    });
    expect(world.puts[0]!.text).toBe(expected);
    expect(result.rowCount).toBe(5);
  });

  it('returns typed failures for missing sources', async () => {
    const world = makeWorld();
    expect(
      failureOf(
        await call(world, 'data.transform', {
          sourceId: '99999999-9999-4999-8999-999999999999' as SourceId,
          version: 1,
          format: 'csv',
          operations: [{ op: 'limit', count: 1 }],
        }),
      ).code,
    ).toBe('source_not_found');
  });
});
