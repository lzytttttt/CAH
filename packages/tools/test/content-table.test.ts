import { describe, expect, it } from 'vitest';
import {
  DataFormatError,
  csvContentFromTable,
  inferColumnType,
  jsonContentFromTable,
  tableFromCsvContent,
  tableFromJsonContent,
  tableFromModuleContent,
  type TableData,
} from '@ca/tools';

const TABLE: TableData = {
  columns: [
    { key: 'id', label: 'id' },
    { key: 'amount', label: 'amount' },
    { key: 'due', label: 'due' },
    { key: 'paid', label: 'paid' },
    { key: 'note', label: 'note' },
  ],
  rows: [
    { id: 'A-1', amount: 12.5, due: '2024-02-03', paid: true, note: 'first' },
    { id: 'A-2', amount: 0, due: '2024-02-04', paid: false, note: '' },
  ],
};

describe('content-table bridges', () => {
  it('infers column types deterministically', () => {
    expect(inferColumnType(['1', '2.5'])).toBe('number');
    expect(inferColumnType(['2024-01-01', '2024/02/03'])).toBe('date');
    expect(inferColumnType(['true', 'no'])).toBe('boolean');
    expect(inferColumnType(['1', 'abc'])).toBe('string');
    expect(inferColumnType(['', '   '])).toBe('string');
  });

  it('builds validated CSV module content with required flags', () => {
    const content = csvContentFromTable(TABLE, { required: ['id'] });
    expect(content.kind).toBe('csv');
    expect(content.columns.map((column) => column.type)).toEqual(['string', 'number', 'date', 'boolean', 'string']);
    expect(content.columns.find((column) => column.key === 'id')?.required).toBe(true);
    expect(content.rows).toEqual([
      { id: 'A-1', amount: 12.5, due: '2024-02-03', paid: true, note: 'first' },
      { id: 'A-2', amount: 0, due: '2024-02-04', paid: false, note: '' },
    ]);
  });

  it('round-trips CSV and JSON module content through tables', () => {
    const csv = csvContentFromTable(TABLE);
    expect(tableFromCsvContent(csv)).toEqual(TABLE);
    const json = jsonContentFromTable(TABLE);
    expect(json.kind).toBe('json');
    expect(tableFromJsonContent(json)).toEqual(TABLE);
    expect(tableFromModuleContent(json)).toEqual(TABLE);
  });

  it('rejects markdown content as a table', () => {
    expect(() =>
      tableFromModuleContent({ kind: 'markdown', sections: [] }),
    ).toThrowError(DataFormatError);
  });

  it('rejects rows that do not match the declared CSV columns', () => {
    expect(() =>
      tableFromCsvContent({
        kind: 'csv',
        columns: [
          { key: 'a', label: 'a', type: 'string', required: false },
          { key: 'b', label: 'b', type: 'string', required: false },
        ],
        rows: [{ a: '1' }],
      }),
    ).toThrowError(DataFormatError);
  });
});
