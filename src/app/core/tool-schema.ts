import { MAX_ROWS, type Dataset } from './models';
import { describeColumn } from './schema';

/**
 * Generates a WebMCP tool schema from a dataset's *actual* inferred columns, so
 * the agent sees real column names as typed enums instead of a generic string
 * bag. The agent controls every field here, so column names, operators and
 * aggregate functions are all validated against allowlists — never interpolated.
 */

const OPS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE'] as const;
const AGGS = ['sum', 'avg', 'min', 'max', 'count'] as const;

export interface QueryToolInput {
  columns?: string[];
  where?: { column: string; op: string; value: unknown }[];
  groupBy?: string;
  aggregate?: { fn: string; column: string };
  orderBy?: string;
  descending?: boolean;
  limit?: number;
  since?: string;
  until?: string;
}

/** Accepts a date or ISO timestamp and nothing else — these reach SQL. */
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;

const named = (ds: Dataset, role: string): string[] =>
  ds.columns.filter((c) => c.role === role).map((c) => c.name);

/** The column a `since`/`until` range filters on, if the human labelled one. */
export function timestampColumn(ds: Dataset): string | undefined {
  return named(ds, 'timestamp')[0];
}

/**
 * Aggregating an identifier is meaningless, so a column labelled `identifier`
 * is not offered. Columns labelled `amount` come first, and one becomes the
 * default — the label is what tells us which number is the measure.
 */
export function aggregatableColumns(ds: Dataset): string[] {
  const numeric = ds.columns
    .filter((c) => (c.type === 'integer' || c.type === 'number') && c.role !== 'identifier')
    .map((c) => c.name);
  const amounts = named(ds, 'amount').filter((n) => numeric.includes(n));
  return [...amounts, ...numeric.filter((n) => !amounts.includes(n))];
}

/** Columns labelled as categories are the ones worth grouping by, so lead with them. */
export function groupableColumns(ds: Dataset): string[] {
  const all = ds.columns.map((c) => c.name);
  const preferred = [...named(ds, 'category'), ...named(ds, 'label')];
  return [...preferred, ...all.filter((n) => !preferred.includes(n))];
}

export function buildQueryToolSchema(ds: Dataset): Record<string, unknown> {
  const names = ds.columns.map((c) => c.name);
  const aggregatable = aggregatableColumns(ds);
  const amount = named(ds, 'amount').find((n) => aggregatable.includes(n));
  const ts = timestampColumn(ds);

  const range = ts
    ? {
        since: {
          type: 'string',
          description: `Only rows where ${ts} is on or after this date (YYYY-MM-DD).`,
        },
        until: {
          type: 'string',
          description: `Only rows where ${ts} is on or before this date (YYYY-MM-DD).`,
        },
      }
    : {};

  return {
    type: 'object',
    required: [],
    properties: {
      ...range,
      columns: {
        type: 'array',
        description: 'Columns to return. Omit for all columns.',
        items: { type: 'string', enum: names },
      },
      where: {
        type: 'array',
        description: 'Filters, combined with AND.',
        items: {
          type: 'object',
          required: ['column', 'op', 'value'],
          properties: {
            column: { type: 'string', enum: names },
            op: { type: 'string', enum: [...OPS] },
            value: {},
          },
        },
      },
      groupBy: {
        type: 'string',
        enum: groupableColumns(ds),
        description: 'Column to group by.',
      },
      aggregate: {
        type: 'object',
        description: 'Aggregation to apply when grouping.',
        required: ['fn', 'column'],
        properties: {
          fn: { type: 'string', enum: [...AGGS] },
          column: amount
            ? { type: 'string', enum: aggregatable, default: amount }
            : { type: 'string', enum: aggregatable },
        },
      },
      orderBy: { type: 'string', enum: names },
      descending: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
    },
  };
}

export function buildQueryToolDescription(ds: Dataset): string {
  const ts = timestampColumn(ds);
  return (
    `Query the "${ds.fileName}" dataset (${ds.rowCount} rows, held locally in ` +
    `the user's browser). Columns: ${ds.columns.map(describeColumn).join(', ')}.` +
    (ts ? ` Use since/until to filter by ${ts}.` : '')
  );
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function buildQuerySql(ds: Dataset, input: QueryToolInput): string {
  const known = new Set(ds.columns.map((c) => c.name));
  const col = (name: string): string => {
    if (!known.has(name)) throw new Error(`Unknown column: ${name}`);
    return `"${name}"`;
  };

  const parts: string[] = [];

  if (input.groupBy && input.aggregate) {
    const { fn, column } = input.aggregate;
    if (!AGGS.includes(fn as (typeof AGGS)[number])) {
      throw new Error(`Unsupported aggregate: ${fn}`);
    }
    parts.push(`SELECT ${col(input.groupBy)}, ${fn}(${col(column)}) AS "${fn}_${column}"`);
  } else if (input.columns?.length) {
    parts.push(`SELECT ${input.columns.map(col).join(', ')}`);
  } else {
    parts.push('SELECT *');
  }

  parts.push(`FROM "${ds.table}"`);

  const clauses: string[] = [];

  for (const w of input.where ?? []) {
    if (!OPS.includes(w.op as (typeof OPS)[number])) {
      throw new Error(`Unsupported operator: ${w.op}`);
    }
    clauses.push(`${col(w.column)} ${w.op} ${lit(w.value)}`);
  }

  if (input.since !== undefined || input.until !== undefined) {
    const ts = timestampColumn(ds);
    if (!ts) {
      throw new Error(
        `since/until need a column labelled as the timestamp; ${ds.table} has none.`,
      );
    }
    for (const [key, op] of [
      ['since', '>='],
      ['until', '<='],
    ] as const) {
      const bound = input[key];
      if (bound === undefined) continue;
      if (!DATE_LITERAL.test(bound)) {
        throw new Error(`${key} must be a date like 2025-01-31, got: ${bound}`);
      }
      clauses.push(`${col(ts)} ${op} '${bound}'`);
    }
  }

  if (clauses.length) parts.push(`WHERE ${clauses.join(' AND ')}`);

  if (input.groupBy && input.aggregate) parts.push(`GROUP BY ${col(input.groupBy)}`);
  if (input.orderBy) {
    parts.push(`ORDER BY ${col(input.orderBy)}${input.descending ? ' DESC' : ''}`);
  }

  const limit = Math.min(Math.max(input.limit ?? MAX_ROWS, 1), MAX_ROWS);
  parts.push(`LIMIT ${limit}`);

  return parts.join(' ');
}
