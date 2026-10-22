import { describe, expect, it } from 'vitest';
import { writeCsv } from '@ca/tools';
import {
  buildDataProfile,
  profileTableData,
  type TableData,
} from '@ca/tools';
import { SOURCE_ID_A } from './source-ids';

/** Generated legacy-like table: 24 rows, 2 exact duplicate rows, 1 missing name. */
function legacyRows(): string[][] {
  const systems = [
    ['S-1001', 'ERP 财务核心', '财务部', 'active', '1200', '85', 'SOAP', '主账套'],
    ['S-1002', 'CRM 客户关系', '销售部', 'Active', '860', '120', 'REST', '含客户主数据'],
    ['S-1003', 'MES 制造执行', '生产部', 'legacy', '430', '210', 'OPC-UA', '车间现场系统'],
    ['S-1004', 'WMS 仓储管理', '供应链部', 'decommissioned', '150', '190', 'REST', '已计划下线'],
    ['S-1005', 'HR 人事系统', '人力资源部', 'active', '210', '95', 'REST', '含薪酬字段'],
    ['S-1006', 'PLM 产品生命周期', '研发部', 'planned', '320', '140', 'REST', '待立项'],
    ['S-1007', 'QMS 质量管理', '质量部', 'legacy', '180', '260', 'SOAP', '旧版接口'],
    ['S-1007', 'QMS 质量管理', '质量部', 'legacy', '190', '250', 'SOAP', '重复登记'],
    ['S-1008', 'SRM 供应商', '采购部', 'active', '240', '110', 'REST', '供应商门户'],
    ['S-1009', 'BI 报表平台', '数据部', 'legacy', '780', '310', 'ODBC', '依赖数仓'],
    ['S-1010', '主数据 MDM', '数据部', 'planned', '150', '180', 'REST', '主数据治理'],
    ['S-1011', 'OMS 订单', '销售部', 'active', '340', '90', 'REST', '订单中心'],
    ['S-1012', 'TMS 运输', '物流部', 'unknown', '220', '230', 'REST', '状态未知'],
    ['S-1013', 'EAM 设备资产', '设备部', 'legacy', '260', '220', 'SOAP', '设备台账'],
    ['S-1014', '客服工单', '客服部', 'active', '130', '100', 'REST', '工单系统'],
    ['S-1015', '数据仓库', '数据部', 'active', '5400', '400', 'JDBC', '核心数仓'],
    ['S-1001', 'ERP 财务（旧实例）', '财务部', 'retired', '1100', '95', 'SOAP', '重复主键的旧实例'],
    ['S-1016', '门户网站', '市场部', ' Active ', '90', '75', 'REST', '大小写与空格不规范'],
    ['S-1017', '邮件系统', 'IT 运维部', 'active', '460', '65', 'SMTP', '邮件网关'],
    ['S-1018', '权限中心', '安全部', 'planned', '40', '50', 'REST', '统一权限'],
    ['S-1019', '监控平台', 'IT 运维部', 'active', '320', '55', 'REST', '监控告警'],
    ['S-1020', '备份系统', 'IT 运维部', 'legacy', '2100', '600', 'NFS', '备份归档'],
    ['S-1021', '', '运营部', 'active', '60', '130', 'REST', '缺少必填名称'],
    ['S-1022', '报表工具(临时)', '数据部', 'planned', '30', '200', 'REST', '临时规划系统'],
  ];
  // two exact duplicate rows appended (total 26 raw -> duplicates counted as extras)
  return systems.concat([systems[2]!, systems[14]!]);
}

const LEGACY_HEADER = [
  'sys_id',
  'name',
  'owner',
  'status',
  'data_volume_gb',
  'latency_ms',
  'protocol_type',
  'notes',
];

describe('buildDataProfile (CSV)', () => {
  it('profiles a generated legacy-like table with real counts', () => {
    const rows = legacyRows();
    const csv = writeCsv(LEGACY_HEADER, rows);
    const profile = buildDataProfile({
      sourceId: SOURCE_ID_A,
      version: 1,
      format: 'csv',
      text: csv,
    });

    expect(profile.rowCount).toBe(26);
    expect(profile.columnCount).toBe(8);
    expect(profile.format).toBe('csv');

    const byKey = new Map(profile.columns.map((column) => [column.key, column]));
    expect(byKey.get('sys_id')?.inferredType).toBe('string');
    expect(byKey.get('data_volume_gb')?.inferredType).toBe('number');
    expect(byKey.get('latency_ms')?.inferredType).toBe('number');
    expect(byKey.get('status')?.inferredType).toBe('string');
    expect(byKey.get('name')?.missing).toBe(1);
    expect(byKey.get('sys_id')?.missing).toBe(0);
    expect(byKey.get('sys_id')?.distinct).toBe(22);
    expect(byKey.get('status')?.distinct).toBe(8);

    expect(profile.duplicateRowCount).toBe(2);
    expect(profile.missingRequiredCount).toBe(1);
    expect(profile.issues.some((issue) => issue.includes('duplicate data row'))).toBe(true);
    expect(profile.issues.some((issue) => issue.includes('empty cell'))).toBe(true);

    for (const column of profile.columns) {
      expect(column.samples.length).toBeLessThanOrEqual(5);
      expect(column.issues.length).toBeLessThanOrEqual(20);
    }
    expect(profile.issues.length).toBeLessThanOrEqual(100);
  });

  it('reports ragged rows as issues instead of failing', () => {
    const profile = buildDataProfile({
      sourceId: SOURCE_ID_A,
      version: 1,
      format: 'csv',
      text: 'a,b\n1\n2,3,4\n',
    });
    expect(profile.rowCount).toBe(2);
    expect(profile.columnCount).toBe(2);
    expect(profile.issues.some((issue) => issue.includes('fields'))).toBe(true);
  });

  it('handles an empty CSV source', () => {
    const profile = buildDataProfile({ sourceId: SOURCE_ID_A, version: 1, format: 'csv', text: '' });
    expect(profile.rowCount).toBe(0);
    expect(profile.columnCount).toBe(0);
    expect(profile.columns).toEqual([]);
    expect(profile.issues.length).toBeGreaterThan(0);
  });
});

describe('profileTableData column inference', () => {
  const table: TableData = {
    columns: [
      { key: 'num', label: 'num' },
      { key: 'date', label: 'date' },
      { key: 'bool', label: 'bool' },
      { key: 'mixed', label: 'mixed' },
      { key: 'empty', label: 'empty' },
      { key: 'text', label: 'text' },
    ],
    rows: [
      { num: '1', date: '2024-01-01', bool: 'true', mixed: '1', empty: '', text: 'a' },
      { num: '2.5', date: '2024/02/03', bool: 'no', mixed: 'abc', empty: '   ', text: 'b' },
    ],
  };

  it('infers string/number/date/boolean/mixed/empty types', () => {
    const summary = profileTableData(table);
    const byKey = new Map(summary.columns.map((column) => [column.key, column]));
    expect(byKey.get('num')?.inferredType).toBe('number');
    expect(byKey.get('date')?.inferredType).toBe('date');
    expect(byKey.get('bool')?.inferredType).toBe('boolean');
    expect(byKey.get('mixed')?.inferredType).toBe('mixed');
    expect(byKey.get('empty')?.inferredType).toBe('empty');
    expect(byKey.get('text')?.inferredType).toBe('string');
    expect(byKey.get('empty')?.missing).toBe(2);
    expect(byKey.get('mixed')?.issues.some((issue) => issue.includes('mixed'))).toBe(true);
  });
});

describe('buildDataProfile (JSON)', () => {
  it('profiles an array of objects and reports flattened nested values', () => {
    const value = [
      { id: 'a', n: 1, meta: { k: 1 } },
      { id: 'b', n: 2 },
      { id: 'c', n: 3, meta: null },
    ];
    const profile = buildDataProfile({
      sourceId: SOURCE_ID_A,
      version: 1,
      format: 'json',
      text: JSON.stringify(value),
    });
    expect(profile.rowCount).toBe(3);
    expect(profile.columnCount).toBe(3);
    const byKey = new Map(profile.columns.map((column) => [column.key, column]));
    expect(byKey.get('id')?.inferredType).toBe('string');
    expect(byKey.get('n')?.inferredType).toBe('number');
    expect(byKey.get('meta')?.missing).toBe(2);
    expect(profile.issues.some((issue) => issue.includes('nested JSON value'))).toBe(true);
  });

  it('profiles a scalar JSON value as a single value column', () => {
    const profile = buildDataProfile({ sourceId: SOURCE_ID_A, version: 1, format: 'json', text: '"hello"' });
    expect(profile.rowCount).toBe(1);
    expect(profile.columnCount).toBe(1);
    expect(profile.columns[0]).toMatchObject({ key: 'value', inferredType: 'string' });
  });
});
