import { describe, it, expect } from 'vitest';
import { sanitizeTableName, mapDuckType, describeColumn } from './schema';
import type { Column, ColumnType } from './models';

describe('sanitizeTableName', () => {
  it.each([
    ['transactions.csv', 'transactions'],
    ['My Bank Export 2025.csv', 'my_bank_export_2025'],
    ['weird!!name@@.json', 'weird_name'],
    ['2024-data.csv', 't_2024_data'],
    ['.csv', 't'],
    ['select.csv', 't_select'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeTableName(input)).toBe(expected);
  });
});

describe('mapDuckType', () => {
  it.each<[string, ColumnType]>([
    ['BIGINT', 'integer'],
    ['INTEGER', 'integer'],
    ['HUGEINT', 'integer'],
    ['DOUBLE', 'number'],
    ['DECIMAL(10,2)', 'number'],
    ['FLOAT', 'number'],
    ['DATE', 'date'],
    ['TIMESTAMP', 'timestamp'],
    ['TIMESTAMP WITH TIME ZONE', 'timestamp'],
    ['TIMESTAMPTZ', 'timestamp'],
    ['DATETIME', 'timestamp'],
    ['TIME', 'timestamp'],
    ['BOOLEAN', 'boolean'],
    ['VARCHAR', 'string'],
    ['SOMETHING_NEW', 'string'],
  ])('%s -> %s', (duck, expected) => {
    expect(mapDuckType(duck)).toBe(expected);
  });
});

describe('describeColumn', () => {
  const col = (over: Partial<Column>): Column => ({
    name: 'amt',
    type: 'number',
    duckType: 'DOUBLE',
    role: 'none',
    ...over,
  });

  it('describes a plain column by type', () => {
    expect(describeColumn(col({}))).toBe('amt (number)');
  });

  it('includes the semantic role when set', () => {
    expect(describeColumn(col({ role: 'amount' }))).toBe('amt (number, the amount column)');
  });
});
