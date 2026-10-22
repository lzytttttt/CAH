import { describe, expect, it } from 'vitest';
import type { TransformOperation } from '@ca/contracts';
import {
  TableTransformError,
  applyTransformOperations,
  canonicalJsonHash,
  tableToJsonValue,
  type TableData,
} from '@ca/tools';

function sampleTable(): TableData {
  return {
    columns: [
      { key: 'id', label: 'id' },
      { key: 'name', label: 'name' },
      { key: 'status', label: 'status' },
      { key: 'qty', label: 'qty' },
      { key: 'created', label: 'created' },
      { key: 'active', label: 'active' },
    ],
    rows: [
      { id: 'S-1', name: ' Alpha ', status: 'Active', qty: '10', created: '2024-01-02', active: 'true' },
      { id: 'S-2', name: 'beta', status: 'legacy', qty: '2', created: '2024/03/04', active: 'no' },
      { id: 'S-3', name: 'Gamma', status: ' Active ', qty: '30', created: '2024-05-06', active: 'false' },
      { id: 's-1', name: 'alpha', status: 'active', qty: '', created: '2024-06-07', active: '' },
    ],
  };
}

function run(operations: readonly TransformOperation[], table: TableData = sampleTable()) {
  return applyTransformOperations(table, operations);
}

function failure(fn: () => unknown): TableTransformError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TableTransformError);
    return error as TableTransformError;
  }
  throw new Error('expected a TableTransformError');
}

describe('select / rename', () => {
  it('selects and reorders columns', () => {
    const { table } = run([{ op: 'select', columns: ['name', 'id'] }]);
    expect(table.columns.map((column) => column.key)).toEqual(['name', 'id']);
    expect(Object.keys(table.rows[0]!)).toEqual(['name', 'id']);
  });

  it('rejects unknown and duplicate selected columns', () => {
    expect(failure(() => run([{ op: 'select', columns: ['nope'] }])).code).toBe('column_not_found');
    expect(failure(() => run([{ op: 'select', columns: ['id', 'id'] }])).code).toBe('duplicate_column');
  });

  it('renames columns while keeping row data and order', () => {
    const { table } = run([{ op: 'rename', mapping: { status: 'state', qty: 'quantity', id: 'system_id' } }]);
    expect(table.columns.map((column) => column.key)).toEqual([
      'system_id',
      'name',
      'state',
      'quantity',
      'created',
      'active',
    ]);
    expect(table.rows[1]).toMatchObject({ system_id: 'S-2', state: 'legacy', quantity: '2' });
  });

  it('rejects renaming unknown columns or colliding with an existing column', () => {
    expect(failure(() => run([{ op: 'rename', mapping: { nope: 'x' } }])).code).toBe('column_not_found');
    expect(failure(() => run([{ op: 'rename', mapping: { status: 'name' } }])).code).toBe('duplicate_column');
  });
});

describe('filter', () => {
  const cases: Array<{ op: TransformOperation; expected: string[] }> = [
    { op: { op: 'filter', column: 'status', operator: 'eq', value: 'legacy' }, expected: ['S-2'] },
    { op: { op: 'filter', column: 'status', operator: 'neq', value: 'legacy' }, expected: ['S-1', 'S-3', 's-1'] },
    { op: { op: 'filter', column: 'qty', operator: 'gt', value: 5 }, expected: ['S-1', 'S-3'] },
    { op: { op: 'filter', column: 'qty', operator: 'lt', value: 5 }, expected: ['S-2'] },
    {
      op: { op: 'filter', column: 'id', operator: 'in', value: ['S-1', 'S-3'] },
      expected: ['S-1', 'S-3'],
    },
    {
      op: { op: 'filter', column: 'id', operator: 'not_in', value: ['S-1', 'S-3'] },
      expected: ['S-2', 's-1'],
    },
    { op: { op: 'filter', column: 'name', operator: 'contains', value: 'a' }, expected: ['S-1', 'S-2', 'S-3', 's-1'] },
    { op: { op: 'filter', column: 'qty', operator: 'not_empty' }, expected: ['S-1', 'S-2', 'S-3'] },
    { op: { op: 'filter', column: 'status', operator: 'matches', value: '^[Aa]ctive$' }, expected: ['S-1', 's-1'] },
  ];

  for (const testCase of cases) {
    it(`supports ${testCase.op.op} ${'operator' in testCase.op ? testCase.op.operator : ''}`, () => {
      const { table } = run([testCase.op]);
      expect(table.rows.map((row) => row.id)).toEqual(testCase.expected);
    });
  }

  it('rejects invalid operator values and unsafe regexes', () => {
    expect(failure(() => run([{ op: 'filter', column: 'id', operator: 'in', value: 'S-1' }])).code).toBe(
      'invalid_operator_value',
    );
    expect(failure(() => run([{ op: 'filter', column: 'id', operator: 'gt' }])).code).toBe(
      'invalid_operator_value',
    );
    expect(failure(() => run([{ op: 'filter', column: 'name', operator: 'matches', value: '(a+)+$' }])).code).toBe(
      'unsafe_regex',
    );
  });
});

describe('sort', () => {
  it('sorts strings ascending and descending, keeping empties last', () => {
    const asc = run([{ op: 'sort', column: 'name', direction: 'asc', numeric: false }]).table;
    expect(asc.rows.map((row) => row.name)).toEqual([' Alpha ', 'Gamma', 'alpha', 'beta']);

    const desc = run([{ op: 'sort', column: 'qty', direction: 'desc', numeric: true }]).table;
    expect(desc.rows.map((row) => row.id)).toEqual(['S-3', 'S-1', 'S-2', 's-1']);
  });

  it('sorts numerics numerically and records non-numeric values', () => {
    const result = run([{ op: 'sort', column: 'qty', direction: 'asc', numeric: true }]);
    expect(result.table.rows.map((row) => row.id)).toEqual(['S-2', 'S-1', 'S-3', 's-1']);
    expect(result.issues.some((issue) => issue.includes('non-numeric'))).toBe(false);
  });

  it('is stable for equal keys', () => {
    const table: TableData = {
      columns: [{ key: 'k', label: 'k' }, { key: 'n', label: 'n' }],
      rows: [
        { k: 'b', n: '1' },
        { k: 'a', n: '2' },
        { k: 'a', n: '3' },
      ],
    };
    const { table: sorted } = applyTransformOperations(table, [{ op: 'sort', column: 'k' }]);
    expect(sorted.rows.map((row) => row.n)).toEqual(['2', '3', '1']);
  });

  it('sorts empty values last even in descending order', () => {
    const { table } = run([{ op: 'sort', column: 'qty', direction: 'desc', numeric: true }]);
    expect(table.rows[table.rows.length - 1]!.id).toBe('s-1');
  });
});

describe('dedupe', () => {
  it('keeps the first occurrence with normalized keys', () => {
    const { table } = run([{ op: 'dedupe', keys: ['id'], keep: 'first', normalize: 'trim_lower' }]);
    expect(table.rows.map((row) => row.id)).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('keeps the last occurrence with normalized keys', () => {
    const { table } = run([{ op: 'dedupe', keys: ['id'], keep: 'last', normalize: 'trim_lower' }]);
    expect(table.rows.map((row) => row.id)).toEqual(['S-2', 'S-3', 's-1']);
  });

  it('supports normalize none and multi-column keys', () => {
    const none = run([{ op: 'dedupe', keys: ['id'], keep: 'first', normalize: 'none' }]).table;
    expect(none.rows.map((row) => row.id)).toEqual(['S-1', 'S-2', 'S-3', 's-1']);
    const multi = run([{ op: 'dedupe', keys: ['status', 'active'], keep: 'first' }]).table;
    expect(multi.rows.length).toBe(4);
  });

  it('rejects unknown keys', () => {
    expect(failure(() => run([{ op: 'dedupe', keys: ['nope'] }])).code).toBe('column_not_found');
  });
});

describe('normalize / cast / fill', () => {
  it('applies trim/lower/collapse_space/strip_quotes and nullTokens', () => {
    const table: TableData = {
      columns: [{ key: 'v', label: 'v' }],
      rows: [{ v: '  HELLO   world  ' }, { v: '"quoted"' }, { v: 'N/A' }, { v: null }],
    };
    const normalized = applyTransformOperations(table, [
      { op: 'normalize', column: 'v', transforms: ['trim', 'lower', 'collapse_space'], nullTokens: ['N/A'] },
    ]).table;
    expect(normalized.rows.map((row) => row.v)).toEqual(['hello world', '"quoted"', null, null]);

    const quotes = applyTransformOperations(table, [
      { op: 'normalize', column: 'v', transforms: ['strip_quotes'] },
    ]).table;
    expect(quotes.rows[1]!.v).toBe('quoted');
  });

  it('casts numbers/dates/booleans deterministically', () => {
    const result = run([
      { op: 'cast', column: 'qty', to: 'number' },
      { op: 'cast', column: 'created', to: 'date' },
      { op: 'cast', column: 'active', to: 'boolean' },
    ]);
    expect(result.table.rows.map((row) => row.qty)).toEqual([10, 2, 30, null]);
    expect(result.table.rows.map((row) => row.created)).toEqual(['2024-01-02', '2024-03-04', '2024-05-06', '2024-06-07']);
    expect(result.table.rows.map((row) => row.active)).toEqual([true, false, false, null]);
    expect(result.issues).toEqual([]);
  });

  it('records non-strict cast failures as issues and nulls the cell', () => {
    const table: TableData = {
      columns: [{ key: 'n', label: 'n' }],
      rows: [{ n: 'abc' }, { n: '12' }],
    };
    const result = applyTransformOperations(table, [{ op: 'cast', column: 'n', to: 'number', strict: false }]);
    expect(result.table.rows.map((row) => row.n)).toEqual([null, 12]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('not a number');
  });

  it('throws on strict cast failures', () => {
    const table: TableData = { columns: [{ key: 'n', label: 'n' }], rows: [{ n: 'abc' }] };
    expect(failure(() => applyTransformOperations(table, [{ op: 'cast', column: 'n', to: 'number', strict: true }])).code).toBe(
      'cast_failed',
    );
  });

  it('fills empty cells only (default) or all cells', () => {
    const onlyEmpty = run([{ op: 'fill', column: 'qty', value: '0', onlyEmpty: true }]).table;
    expect(onlyEmpty.rows.map((row) => row.qty)).toEqual(['10', '2', '30', '0']);
    const all = run([{ op: 'fill', column: 'qty', value: 0, onlyEmpty: false }]).table;
    expect(all.rows.map((row) => row.qty)).toEqual([0, 0, 0, 0]);
  });

  it('rejects non-scalar fill values', () => {
    expect(failure(() => run([{ op: 'fill', column: 'qty', value: { bad: true }, onlyEmpty: true }])).code).toBe(
      'invalid_operator_value',
    );
  });
});

describe('map / limit / require', () => {
  it('maps values and records unmapped values as issues, keeping the original', () => {
    const result = run([
      {
        op: 'map',
        column: 'status',
        mapping: { Active: 'active', legacy: 'legacy', active: 'active' },
        fallback: null,
        recordIssueOnUnknown: true,
      },
    ]);
    expect(result.table.rows.map((row) => row.status)).toEqual(['active', 'legacy', ' Active ', 'active']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('no mapping');
  });

  it('applies the fallback when configured', () => {
    const result = run([
      {
        op: 'map',
        column: 'status',
        mapping: { Active: 'active' },
        fallback: 'unknown',
        recordIssueOnUnknown: true,
      },
    ]);
    expect(result.table.rows.map((row) => row.status)).toEqual(['active', 'unknown', 'unknown', 'unknown']);
    expect(result.issues).toEqual([]);
  });

  it('limits rows', () => {
    expect(run([{ op: 'limit', count: 2 }]).table.rows).toHaveLength(2);
    expect(run([{ op: 'limit', count: 100 }]).table.rows).toHaveLength(4);
  });

  it('require records an issue but never drops rows', () => {
    const result = run([{ op: 'require', columns: ['qty', 'id'] }]);
    expect(result.table.rows).toHaveLength(4);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('column "qty"');
    expect(result.issues[0]).toContain('row(s) 4');
  });

  it('rejects unknown columns across operators', () => {
    expect(failure(() => run([{ op: 'require', columns: ['nope'] }])).code).toBe('column_not_found');
    expect(failure(() => run([{ op: 'map', column: 'nope', mapping: {} }])).code).toBe('column_not_found');
    expect(failure(() => run([{ op: 'normalize', column: 'nope', transforms: ['trim'] }])).code).toBe(
      'column_not_found',
    );
    expect(failure(() => run([{ op: 'sort', column: 'nope' }])).code).toBe('column_not_found');
    expect(failure(() => run([{ op: 'filter', column: 'nope', operator: 'not_empty' }])).code).toBe(
      'column_not_found',
    );
  });

  it('caps recorded issues and appends an omission note', () => {
    const table: TableData = {
      columns: [{ key: 'n', label: 'n' }],
      rows: Array.from({ length: 5 }, () => ({ n: 'bad' })),
    };
    const result = applyTransformOperations(table, [{ op: 'cast', column: 'n', to: 'number' }], { maxIssues: 2 });
    expect(result.issues).toHaveLength(2);
    expect(result.issues[1]).toContain('more data issue(s) were omitted');
  });
});

describe('determinism and immutability', () => {
  it('produces identical output and hashes on repeated runs', () => {
    const operations: TransformOperation[] = [
      { op: 'rename', mapping: { status: 'state' } },
      { op: 'normalize', column: 'state', transforms: ['trim', 'lower'] },
      { op: 'dedupe', keys: ['id'], keep: 'last' },
    ];
    const first = applyTransformOperations(sampleTable(), operations);
    const second = applyTransformOperations(sampleTable(), operations);
    expect(second.table).toEqual(first.table);
    expect(second.issues).toEqual(first.issues);
    expect(canonicalJsonHash(tableToJsonValue(second.table))).toBe(canonicalJsonHash(tableToJsonValue(first.table)));
  });

  it('never mutates the input table', () => {
    const input = sampleTable();
    const snapshot = JSON.parse(JSON.stringify(input)) as TableData;
    applyTransformOperations(input, [
      { op: 'normalize', column: 'name', transforms: ['trim', 'lower'] },
      { op: 'cast', column: 'qty', to: 'number' },
      { op: 'sort', column: 'qty', numeric: true },
    ]);
    expect(input).toEqual(snapshot);
  });

  it('supports chaining a full cleaning pipeline', () => {
    const table: TableData = {
      columns: [
        { key: 'sys_id', label: 'sys_id' },
        { key: 'name', label: 'name' },
        { key: 'status', label: 'status' },
      ],
      rows: [
        { sys_id: ' S-1 ', name: 'A', status: ' running ' },
        { sys_id: 'S-2', name: '', status: 'active' },
        { sys_id: 's-1', name: 'A2', status: 'ACTIVE' },
      ],
    };
    const result = applyTransformOperations(table, [
      { op: 'rename', mapping: { sys_id: 'system_id' } },
      { op: 'normalize', column: 'system_id', transforms: ['trim', 'lower'] },
      { op: 'normalize', column: 'status', transforms: ['trim', 'lower'] },
      { op: 'dedupe', keys: ['system_id'], keep: 'last' },
      { op: 'map', column: 'status', mapping: { active: 'active', running: 'active' } },
      { op: 'require', columns: ['name'] },
    ]);
    expect(result.table.rows).toEqual([
      { system_id: 's-2', name: '', status: 'active' },
      { system_id: 's-1', name: 'A2', status: 'active' },
    ]);
    expect(result.issues).toHaveLength(1);
  });
});
