/**
 * The security boundary for `run_sql`. An agent can pass arbitrary text, so
 * this is what stops it mutating the vault or reaching outside the browser.
 */

const FORBIDDEN = [
  'DROP',
  'DELETE',
  'INSERT',
  'UPDATE',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'COPY',
  'INSTALL',
  'LOAD',
  'EXPORT',
  'IMPORT',
  'PRAGMA',
  'SET',
  'CALL',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'CHECKPOINT',
];

/**
 * Blank out string literals and comments so keyword scanning cannot be fooled
 * by a legitimate query like `WHERE note = 'drop table t'`.
 */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ');
}

export function assertReadOnlySql(sql: string): void {
  const raw = sql?.trim() ?? '';
  if (!raw) throw new Error('Query is empty.');

  // A single trailing semicolon is fine; anything after it is a second statement.
  const stripped = strip(raw)
    .trim()
    .replace(/;\s*$/, '');

  if (stripped.includes(';')) {
    throw new Error('Only one statement is allowed per query.');
  }

  const first = stripped.match(/^[a-z_]+/i)?.[0].toUpperCase() ?? '';
  if (first !== 'SELECT' && first !== 'WITH') {
    throw new Error(
      `Only SELECT queries are allowed. This one starts with ${first || 'nothing recognisable'}.`,
    );
  }

  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(stripped)) {
      throw new Error(`${word} is not permitted. SiftIO is read-only.`);
    }
  }
}
