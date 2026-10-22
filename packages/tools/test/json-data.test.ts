import { describe, expect, it } from 'vitest';
import {
  DataFormatError,
  JsonDataError,
  parseBoundedJson,
  tableFromJsonValue,
  tableToJsonValue,
  type TableData,
} from '@ca/tools';

function failure(fn: () => unknown): DataFormatError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DataFormatError);
    return error as DataFormatError;
  }
  throw new Error('expected a DataFormatError');
}

describe('parseBoundedJson', () => {
  it('parses a JSON document and strips a BOM', () => {
    expect(parseBoundedJson('\uFEFF{"a":[1,true,null,"x"]}')).toEqual({ a: [1, true, null, 'x'] });
  });

  it('rejects empty and invalid JSON with predictable codes', () => {
    expect(failure(() => parseBoundedJson('   ')).code).toBe('json_parse_error');
    expect(failure(() => parseBoundedJson('{"a":')).code).toBe('json_parse_error');
  });

  it('rejects nesting beyond the contract depth limit', () => {
    let deep: unknown = null;
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(failure(() => parseBoundedJson(JSON.stringify(deep))).code).toBe('limit_exceeded');
  });

  it('rejects node counts beyond the limit', () => {
    const big = Array.from({ length: 20 }, (_value, index) => index);
    expect(failure(() => parseBoundedJson(JSON.stringify(big), { maxNodes: 5 })).code).toBe('limit_exceeded');
  });

  it('rejects non-finite JSON numbers such as 1e999', () => {
    expect(failure(() => parseBoundedJson('{"n":1e999}')).code).toBe('json_parse_error');
  });

  it('rejects prototype-polluting object keys', () => {
    expect(failure(() => parseBoundedJson('{"__proto__":{"x":1}}')).code).toBe('json_parse_error');
    expect((failure(() => parseBoundedJson('{"a":{"constructor":1}}')) as JsonDataError).code).toBe('json_parse_error');
  });
});

describe('tableFromJsonValue', () => {
  it('projects an array of objects with a first-appearance column union', () => {
    const table = tableFromJsonValue([
      { b: 1, a: 'x' },
      { a: 'y', c: true },
    ]);
    expect(table.columns.map((column) => column.key)).toEqual(['b', 'a', 'c']);
    expect(table.rows).toEqual([
      { b: 1, a: 'x', c: null },
      { b: null, a: 'y', c: true },
    ]);
  });

  it('projects arrays of scalars and objects', () => {
    expect(tableFromJsonValue([1, 2]).columns[0]?.key).toBe('value');
    const objectTable = tableFromJsonValue({ name: 'a', n: 2 });
    expect(objectTable.rows).toEqual([{ name: 'a', n: 2 }]);
    expect(tableFromJsonValue([]).rows).toEqual([]);
  });

  it('flattens nested values into JSON text cells and records an issue', () => {
    const issues: string[] = [];
    const table = tableFromJsonValue([{ id: 'a', meta: { k: [1, 2] } }], { issues });
    expect(table.rows[0]?.meta).toBe('{"k":[1,2]}');
    expect(issues).toHaveLength(1);
  });

  it('rejects tables with more rows than the contract allows', () => {
    const tooMany = Array.from({ length: 50_001 }, () => 1);
    expect(failure(() => tableFromJsonValue(tooMany)).code).toBe('limit_exceeded');
  });

  it('rejects forbidden or overlong keys', () => {
    const polluted = JSON.parse('[{"__proto__":1}]') as never;
    expect(failure(() => tableFromJsonValue(polluted)).code).toBe('json_parse_error');
    expect(failure(() => tableFromJsonValue([{ ['k'.repeat(200)]: 1 }])).code).toBe('json_parse_error');
  });
});

describe('tableToJsonValue', () => {
  it('round-trips a table through JSON', () => {
    const table: TableData = {
      columns: [
        { key: 'id', label: 'id' },
        { key: 'n', label: 'n' },
      ],
      rows: [
        { id: '1', n: 2 },
        { id: '2', n: null },
      ],
    };
    const value = tableToJsonValue(table);
    expect(value).toEqual([
      { id: '1', n: 2 },
      { id: '2', n: null },
    ]);
    expect(tableFromJsonValue(value)).toEqual(table);
  });
});
