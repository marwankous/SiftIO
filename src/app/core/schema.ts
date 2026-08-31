import type { Column, ColumnType, SemanticRole } from './models';

/** DuckDB rejects these as bare identifiers, so they get a `t_` prefix. */
const RESERVED = new Set([
  'select',
  'from',
  'where',
  'table',
  'order',
  'group',
  'join',
  'union',
  'create',
  'drop',
  'insert',
  'update',
  'delete',
  'index',
  'view',
  'all',
]);

export function sanitizeTableName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  let name = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) return 't';
  // DuckDB identifiers cannot start with a digit.
  if (/^[0-9]/.test(name) || RESERVED.has(name)) name = `t_${name}`;
  return name;
}

/** Collapse DuckDB's many type strings into the handful SiftIO cares about. */
export function mapDuckType(duckType: string): ColumnType {
  const t = duckType.toUpperCase();
  if (/BOOL/.test(t)) return 'boolean';
  // TIMESTAMP before DATE: telling an agent a value is a plain date when it
  // carries a time makes it reason about the data wrongly.
  if (/TIMESTAMP|DATETIME|^TIME/.test(t)) return 'timestamp';
  if (/DATE/.test(t)) return 'date';
  if (/INT/.test(t)) return 'integer';
  if (/DEC|NUMERIC|DOUBLE|FLOAT|REAL/.test(t)) return 'number';
  return 'string';
}

const ROLE_PHRASE: Record<SemanticRole, string> = {
  amount: 'the amount column',
  timestamp: 'the timestamp column',
  category: 'a category column',
  identifier: 'a unique identifier',
  label: 'a human-readable label',
  none: '',
};

/** The phrase interpolated into a generated tool description. */
export function describeColumn(c: Column): string {
  const phrase = ROLE_PHRASE[c.role];
  return phrase ? `${c.name} (${c.type}, ${phrase})` : `${c.name} (${c.type})`;
}
