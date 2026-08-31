import { describe, it, expect } from 'vitest';
import { assertReadOnlySql } from './sql-guard';

const ok = [
  'SELECT * FROM txns',
  'select a, b from t where a > 1',
  'WITH x AS (SELECT 1) SELECT * FROM x',
  '  \n SELECT 1 \n ',
  'SELECT * FROM txns; ',
  "SELECT * FROM t WHERE note = 'drop table t'",
  'SELECT * FROM a JOIN b ON a.id = b.id',
];

const bad: [string, string][] = [
  ['DROP TABLE txns', 'DROP'],
  ['DELETE FROM txns', 'DELETE'],
  ['INSERT INTO t VALUES (1)', 'INSERT'],
  ['UPDATE t SET a = 1', 'UPDATE'],
  ['CREATE TABLE x (a INT)', 'CREATE'],
  ['ALTER TABLE t ADD COLUMN c INT', 'ALTER'],
  ["ATTACH 'x.db'", 'ATTACH'],
  ["COPY t TO 'out.csv'", 'COPY'],
  ['INSTALL httpfs', 'INSTALL'],
  ['LOAD httpfs', 'LOAD'],
  ["EXPORT DATABASE 'd'", 'EXPORT'],
  ['PRAGMA database_list', 'PRAGMA'],
  ['SELECT 1; DROP TABLE t', 'one statement'],
  ['', 'empty'],
  ['   ', 'empty'],
];

describe('assertReadOnlySql', () => {
  it.each(ok)('accepts %s', (sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it.each(bad)('rejects %s', (sql, reason) => {
    expect(() => assertReadOnlySql(sql)).toThrow(new RegExp(reason, 'i'));
  });
});
