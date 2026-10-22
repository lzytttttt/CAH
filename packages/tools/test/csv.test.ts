import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  parseCsv,
  serializeCsvRecord,
  tableFromCsv,
  tableFromParsedCsv,
  tableToCsv,
  writeCsv,
  type TableData,
} from '@ca/tools';

const QUOTED_CSV = 'id,name,note\r\n1,"Smith, John","line1\r\nline2"\r\n2,"say ""hi""",plain\r\n';

describe('parseCsv (RFC 4180)', () => {
  it('parses quoted fields with commas, CRLF inside quotes and escaped quotes', () => {
    const parsed = parseCsv(QUOTED_CSV);
    expect(parsed.header).toEqual(['id', 'name', 'note']);
    expect(parsed.rows).toEqual([
      ['1', 'Smith, John', 'line1\r\nline2'],
      ['2', 'say "hi"', 'plain'],
    ]);
    expect(parsed.eol).toBe('\r\n');
    expect(parsed.rowStartLines).toEqual([2, 4]);
    expect(parsed.fieldCountMismatchRows).toEqual([]);
  });

  it('strips a UTF-8 BOM and records it', () => {
    const parsed = parseCsv('\uFEFFa,b\r\n1,2\r\n');
    expect(parsed.hadBom).toBe(true);
    expect(parsed.header).toEqual(['a', 'b']);
    expect(parsed.rows).toEqual([['1', '2']]);
  });

  it('accepts LF endings, lone CR and a missing trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n').eol).toBe('\n');
    expect(parseCsv('a,b\r1,2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
  });

  it('handles empty fields and a final empty line without adding a phantom row', () => {
    const parsed = parseCsv('a,b,c\n,,\n1,,3\n');
    expect(parsed.rows).toEqual([
      ['', '', ''],
      ['1', '', '3'],
    ]);
  });

  it('reports ragged records instead of throwing', () => {
    const parsed = parseCsv('a,b\n1\n2,3,4\n');
    expect(parsed.fieldCountMismatchRows).toEqual([1, 2]);
  });

  it('reports duplicate headers', () => {
    const parsed = parseCsv('a,b,a\n1,2,3\n');
    expect(parsed.duplicateHeaders).toEqual(['a']);
  });

  it('rejects an unterminated quoted field with a predictable code', () => {
    const error = catchError(() => parseCsv('a,b\n1,"open\n'));
    expect(error).toBeInstanceOf(CsvParseError);
    expect((error as CsvParseError).code).toBe('unterminated_quote');
  });

  it('rejects malformed quotes inside unquoted fields and after closing quotes', () => {
    expect((catchError(() => parseCsv('a,b\n1,ab"cd\n')) as CsvParseError).code).toBe('malformed_quote');
    expect((catchError(() => parseCsv('a,b\n1,"ab"cd\n')) as CsvParseError).code).toBe('malformed_quote');
  });

  it('enforces field / row / column limits', () => {
    expect((catchError(() => parseCsv('a\nabcdef\n', { maxFieldChars: 3 })) as CsvParseError).code).toBe(
      'limit_exceeded',
    );
    expect((catchError(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2 })) as CsvParseError).code).toBe('limit_exceeded');
    expect((catchError(() => parseCsv('a,b,c\n1,2,3\n', { maxColumns: 2 })) as CsvParseError).code).toBe(
      'limit_exceeded',
    );
  });

  it('parses empty text as an empty table', () => {
    const parsed = parseCsv('');
    expect(parsed.header).toEqual([]);
    expect(parsed.rows).toEqual([]);
  });
});

describe('writeCsv', () => {
  it('quotes only when required and uses CRLF by default', () => {
    const text = writeCsv(['a', 'b'], [
      ['plain', 'has,comma'],
      ['say "hi"', 'two\r\nlines'],
    ]);
    expect(text).toBe('a,b\r\nplain,"has,comma"\r\n"say ""hi""","two\r\nlines"\r\n');
  });

  it('supports LF output', () => {
    expect(writeCsv(['a'], [['1']], { eol: '\n' })).toBe('a\n1\n');
  });

  it('round-trips a table through write -> parse -> table', () => {
    const table: TableData = {
      columns: [
        { key: 'id', label: 'id' },
        { key: 'text', label: 'text' },
        { key: 'n', label: 'n' },
      ],
      rows: [
        { id: '1', text: 'comma, quote " and\nnewline', n: 12.5 },
        { id: '2', text: '', n: 0 },
        { id: '3', text: '中文, 内容', n: -1 },
      ],
    };
    const csv = tableToCsv(table);
    const roundTripped = parseCsv(csv);
    expect(roundTripped.header).toEqual(['id', 'text', 'n']);
    expect(roundTripped.rows).toEqual([
      ['1', 'comma, quote " and\nnewline', '12.5'],
      ['2', '', '0'],
      ['3', '中文, 内容', '-1'],
    ]);
  });

  it('serializes one record without a line break', () => {
    expect(serializeCsvRecord(['a,b', 'c'])).toBe('"a,b",c');
  });

  it('rejects fields above the limit', () => {
    expect((catchError(() => serializeCsvRecord(['abcdef'], 3)) as CsvParseError).code).toBe('limit_exceeded');
    expect(
      (catchError(() => writeCsv(['a'], [['x'.repeat(32_769)]])) as CsvParseError).code,
    ).toBe('limit_exceeded');
  });
});

describe('tableFromParsedCsv', () => {
  it('builds a normalized table', () => {
    const table = tableFromCsv('id,name\n1,Alice\n2,Bob\n');
    expect(table.columns).toEqual([
      { key: 'id', label: 'id' },
      { key: 'name', label: 'name' },
    ]);
    expect(table.rows).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
  });

  it('rejects duplicate / empty headers and prototype-polluting names in strict mode', () => {
    expect((catchError(() => tableFromCsv('a,a\n1,2\n')) as CsvParseError).code).toBe('csv_parse_error');
    expect((catchError(() => tableFromCsv('a,\n1,2\n')) as CsvParseError).code).toBe('csv_parse_error');
    expect((catchError(() => tableFromCsv('__proto__,b\n1,2\n')) as CsvParseError).code).toBe('csv_parse_error');
  });

  it('disambiguates duplicate headers and pads ragged rows in lenient mode', () => {
    const issues: string[] = [];
    const table = tableFromParsedCsv(parseCsv('a,a\n1,2\n3\n'), { lenient: true, issues });
    expect(table.columns.map((column) => column.key)).toEqual(['a', 'a__2']);
    expect(table.rows).toEqual([
      { a: '1', a__2: '2' },
      { a: '3', a__2: '' },
    ]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects ragged rows in strict mode', () => {
    expect((catchError(() => tableFromCsv('a,b\n1\n')) as CsvParseError).code).toBe('csv_parse_error');
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}
