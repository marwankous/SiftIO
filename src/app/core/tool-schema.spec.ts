import { describe, it, expect } from 'vitest';
import { buildQueryToolSchema, buildQueryToolDescription, buildQuerySql } from './tool-schema';
import type { Dataset } from './models';

const ds: Dataset = {
  id: 'txns',
  table: 'txns',
  fileName: 'txns.csv',
  rowCount: 400,
  ingestedAt: 0,
  columns: [
    { name: 'id', type: 'integer', duckType: 'BIGINT', role: 'identifier' },
    { name: 'amt', type: 'number', duckType: 'DOUBLE', role: 'amount' },
    { name: 'day', type: 'date', duckType: 'DATE', role: 'timestamp' },
    { name: 'merchant', type: 'string', duckType: 'VARCHAR', role: 'category' },
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('buildQueryToolSchema', () => {
  const schema = buildQueryToolSchema(ds) as any;

  it('offers the real column names as an enum', () => {
    expect(schema.properties.columns.items.enum).toEqual(['id', 'amt', 'day', 'merchant']);
  });

  it('restricts groupBy to the same real columns', () => {
    // Order is meaningful (labelled categories lead) so compare as a set.
    expect([...schema.properties.groupBy.enum].sort()).toEqual(['amt', 'day', 'id', 'merchant']);
  });

  it('never offers an identifier for aggregation, because sum(id) is nonsense', () => {
    // `id` is numeric but labelled `identifier`, so the label removes it.
    expect(schema.properties.aggregate.properties.column.enum).toEqual(['amt']);
  });

  it('defaults the measure to the column labelled as the amount', () => {
    expect(schema.properties.aggregate.properties.column.default).toBe('amt');
  });

  it('leads groupBy with the columns labelled as categories', () => {
    expect(schema.properties.groupBy.enum[0]).toBe('merchant');
  });

  it('adds since/until because a column is labelled as the timestamp', () => {
    expect(schema.properties.since.description).toContain('day');
    expect(schema.properties.until.description).toContain('day');
  });

  it('caps limit at MAX_ROWS', () => {
    expect(schema.properties.limit.maximum).toBe(1000);
  });

  it('is a valid object schema with no required fields', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual([]);
  });
});

describe('unlabelled dataset', () => {
  const bare: Dataset = { ...ds, columns: ds.columns.map((c) => ({ ...c, role: 'none' as const })) };
  const schema = buildQueryToolSchema(bare) as any;

  it('offers every numeric column, having no identifier label to exclude', () => {
    expect(schema.properties.aggregate.properties.column.enum).toEqual(['id', 'amt']);
    expect(schema.properties.aggregate.properties.column.default).toBeUndefined();
  });

  it('offers no date range, since nothing is labelled as the timestamp', () => {
    expect(schema.properties.since).toBeUndefined();
    expect(schema.properties.until).toBeUndefined();
  });

  it('rejects since/until outright rather than guessing a column', () => {
    expect(() => buildQuerySql(bare, { since: '2025-01-01' })).toThrow(/labelled as the timestamp/i);
  });
});

describe('buildQueryToolDescription', () => {
  it('names the dataset, row count and semantic roles', () => {
    const d = buildQueryToolDescription(ds);
    expect(d).toContain('txns.csv');
    expect(d).toContain('400');
    expect(d).toContain('amt (number, the amount column)');
  });
});

describe('labels reach the agent', () => {
  it('an unlabelled column reads as bare type, a labelled one explains itself', () => {
    const bare: Dataset = {
      ...ds,
      columns: ds.columns.map((c) => ({ ...c, role: 'none' as const })),
    };
    expect(buildQueryToolDescription(bare)).toContain('amt (number)');
    expect(buildQueryToolDescription(bare)).not.toContain('the amount column');
    // Labelling is the mechanism by which the human teaches the agent.
    expect(buildQueryToolDescription(ds)).toContain('amt (number, the amount column)');
    expect(buildQueryToolDescription(ds)).toContain('day (date, the timestamp column)');
  });
});

describe('buildQuerySql', () => {
  it('selects all columns by default with the row cap', () => {
    expect(buildQuerySql(ds, {})).toBe('SELECT * FROM "txns" LIMIT 1000');
  });

  it('projects the requested columns', () => {
    expect(buildQuerySql(ds, { columns: ['amt', 'day'] })).toBe(
      'SELECT "amt", "day" FROM "txns" LIMIT 1000',
    );
  });

  it('builds a filter', () => {
    expect(buildQuerySql(ds, { where: [{ column: 'amt', op: '>', value: 10 }] })).toBe(
      'SELECT * FROM "txns" WHERE "amt" > 10 LIMIT 1000',
    );
  });

  it('quotes string filter values and escapes embedded quotes', () => {
    const sql = buildQuerySql(ds, {
      where: [{ column: 'merchant', op: '=', value: "Joe's" }],
    });
    expect(sql).toContain(`"merchant" = 'Joe''s'`);
  });

  it('groups and aggregates', () => {
    expect(
      buildQuerySql(ds, { groupBy: 'merchant', aggregate: { fn: 'sum', column: 'amt' } }),
    ).toBe(
      'SELECT "merchant", sum("amt") AS "sum_amt" FROM "txns" GROUP BY "merchant" LIMIT 1000',
    );
  });

  it('orders descending', () => {
    expect(buildQuerySql(ds, { orderBy: 'amt', descending: true })).toBe(
      'SELECT * FROM "txns" ORDER BY "amt" DESC LIMIT 1000',
    );
  });

  it('rejects a column that is not in the dataset', () => {
    expect(() => buildQuerySql(ds, { columns: ['secret'] })).toThrow(/unknown column: secret/i);
  });

  it('rejects an operator that is not allowed', () => {
    expect(() =>
      buildQuerySql(ds, { where: [{ column: 'amt', op: 'IS NOT NULL OR 1=1 --', value: 1 }] }),
    ).toThrow(/unsupported operator/i);
  });

  it('rejects an aggregate function that is not allowed', () => {
    expect(() =>
      buildQuerySql(ds, { groupBy: 'merchant', aggregate: { fn: 'evil', column: 'amt' } }),
    ).toThrow(/unsupported aggregate/i);
  });

  it('rejects an injected column name rather than interpolating it', () => {
    expect(() =>
      buildQuerySql(ds, { orderBy: 'amt"; DROP TABLE txns; --' }),
    ).toThrow(/unknown column/i);
  });

  it('clamps an oversized limit', () => {
    expect(buildQuerySql(ds, { limit: 99999 })).toContain('LIMIT 1000');
  });

  it('filters a date range through the labelled timestamp column', () => {
    expect(buildQuerySql(ds, { since: '2025-01-01', until: '2025-03-31' })).toBe(
      `SELECT * FROM "txns" WHERE "day" >= '2025-01-01' AND "day" <= '2025-03-31' LIMIT 1000`,
    );
  });

  it('combines a range with an ordinary filter', () => {
    const sql = buildQuerySql(ds, {
      since: '2025-06-01',
      where: [{ column: 'amt', op: '>', value: 10 }],
    });
    expect(sql).toContain(`WHERE "amt" > 10 AND "day" >= '2025-06-01'`);
  });

  it('accepts an ISO timestamp bound', () => {
    expect(buildQuerySql(ds, { since: '2025-01-01T09:30:00Z' })).toContain(
      `"day" >= '2025-01-01T09:30:00Z'`,
    );
  });

  it.each([
    "2025-01-01'; DROP TABLE txns; --",
    'yesterday',
    "' OR 1=1 --",
    '2025/01/01',
    '',
  ])('rejects %s as a date bound rather than interpolating it', (bound) => {
    expect(() => buildQuerySql(ds, { since: bound })).toThrow(/must be a date/i);
  });

  it('clamps a nonsensical limit up to at least one row', () => {
    expect(buildQuerySql(ds, { limit: 0 })).toContain('LIMIT 1');
    expect(buildQuerySql(ds, { limit: -5 })).toContain('LIMIT 1');
  });
});
