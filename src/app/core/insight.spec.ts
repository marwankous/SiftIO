import { describe, it, expect } from 'vitest';
import { summarise, describeCall, formatNumber } from './insight';
import type { AuditEntry, QueryResult } from './models';

const result = (rows: Record<string, unknown>[], columns?: string[]): QueryResult => ({
  columns: columns ?? Object.keys(rows[0] ?? {}),
  rows,
  truncated: false,
});

const entry = (tool: string, args: unknown, rows = 0): AuditEntry => ({
  id: 'x', tool, source: 'agent', args, rows, bytes: 0, ms: 1, at: 0,
});

describe('formatNumber', () => {
  it('groups thousands and keeps two decimals for fractions', () => {
    expect(formatNumber(3081.39)).toBe('3,081.39');
    expect(formatNumber(941)).toBe('941');
  });

  it('adds no symbol unless one is explicitly chosen', () => {
    // The unit of a column called `amt` is unknown until the user declares it.
    expect(formatNumber(12.5)).not.toMatch(/[$£€]/);
    expect(formatNumber(12.5, '£')).toBe('£12.50');
  });

  it('keeps the minus sign outside the symbol', () => {
    expect(formatNumber(-2026.55, '$')).toBe('-$2,026.55');
  });
});

describe('summarise', () => {
  const spend = result([
    { category: 'shopping', spend: 3081.39 },
    { category: 'groceries', spend: 2984.05 },
    { category: 'food', spend: 1909.62 },
  ]);

  it('reads as a plain sentence naming the leader, gap and share', () => {
    const s = summarise(spend)!;
    expect(s.text).toContain('Shopping is highest at 3,081.39');
    expect(s.text).toContain('97.34 ahead of groceries');
    expect(s.text).toContain('%');
    expect(s.topIndex).toBe(0);
  });

  it('uses the chosen currency symbol when one is set', () => {
    expect(summarise(spend, undefined, '$')!.text).toContain('$3,081.39');
  });

  it('points at the leading row wherever it sits', () => {
    const unsorted = result([
      { k: 'a', n: 1 },
      { k: 'b', n: 9 },
      { k: 'c', n: 4 },
    ]);
    expect(summarise(unsorted)!.topIndex).toBe(1);
  });

  it('says so when the top two tie', () => {
    const tied = result([{ k: 'a', n: 5 }, { k: 'b', n: 5 }]);
    expect(summarise(tied)!.text).toContain('level with');
  });

  it('honours the chart axes when given', () => {
    const two = result([
      { region: 'north', calls: 3, revenue: 100 },
      { region: 'south', calls: 9, revenue: 50 },
    ]);
    expect(summarise(two, { x: 'region', y: 'revenue' })!.text).toContain('North is highest');
  });

  it('claims nothing from a single row', () => {
    expect(summarise(result([{ k: 'a', n: 1 }]))).toBeNull();
  });

  it('claims nothing when there is no number to compare', () => {
    expect(summarise(result([{ a: 'x', b: 'y' }, { a: 'p', b: 'q' }]))).toBeNull();
  });

  it('claims nothing when there is no label to name', () => {
    expect(summarise(result([{ a: 1, b: 2 }, { a: 3, b: 4 }]))).toBeNull();
  });
});

describe('describeCall', () => {
  it.each([
    [entry('list_datasets', {}), /what data is loaded/i],
    [entry('list_samples', {}), /demo datasets/i],
    [entry('load_sample', { file: 'sleep.csv' }), /Loaded the sleep\.csv/],
    [entry('run_sql', { sql: 'SELECT 1' }, 6), /Ran a SQL query · 6 rows/],
    [entry('render_chart', { kind: 'bar' }, 6), /Drew a bar · 6 rows/],
    [entry('save_view', { name: 'Spend' }), /Pinned the view "Spend"/],
    [entry('eject_dataset', { table: 'sleep' }), /remove sleep/],
    [entry('describe_transactions', {}), /Inspected the columns of transactions/],
  ])('describes %#', (e, pattern) => {
    expect(describeCall(e)).toMatch(pattern);
  });

  it('turns a structured query into a sentence', () => {
    const text = describeCall(
      entry(
        'query_transactions',
        {
          groupBy: 'category',
          aggregate: { fn: 'sum', column: 'amt' },
          since: '2025-01-01',
          orderBy: 'amt',
          descending: true,
        },
        6,
      ),
    );
    expect(text).toContain('Grouped transactions by category, sum of amt');
    expect(text).toContain('from 2025-01-01');
    expect(text).toContain('sorted by amt descending');
  });

  it('describes a filtered read', () => {
    const text = describeCall(
      entry('query_sleep', { columns: ['day', 'hours'], where: [{ column: 'hours', op: '<', value: 6 }] }, 12),
    );
    expect(text).toContain('Read day, hours from sleep');
    expect(text).toContain('where hours < 6');
  });
});
