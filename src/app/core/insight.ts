import type { AuditEntry, QueryResult } from './models';

/**
 * Plain-language summaries derived from a result — never invented.
 *
 * A currency symbol is never inferred — it is passed in from the user's own
 * setting. A column called `amt` carries no unit, so guessing one would be
 * fabricating information; declaring one is the user's call.
 */

export function formatNumber(v: number, symbol = ''): string {
  const abs = Math.abs(v);
  const dp = Number.isInteger(v) ? 0 : abs < 1 ? 4 : 2;
  const n = v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (!symbol) return n;
  return v < 0 ? `-${symbol}${n.slice(1)}` : `${symbol}${n}`;
}

const sentenceCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The first column whose values are numeric, preferring a named one. */
export function numericColumn(result: QueryResult, prefer?: string): string | undefined {
  if (prefer && result.rows.some((r) => isNum(r[prefer]))) return prefer;
  return result.columns.find((c) => result.rows.some((r) => isNum(r[c])));
}

/** The first column that reads as a label, preferring a named one. */
export function labelColumn(result: QueryResult, prefer?: string, exclude?: string): string | undefined {
  if (prefer && prefer !== exclude && result.columns.includes(prefer)) return prefer;
  return result.columns.find((c) => c !== exclude && result.rows.every((r) => !isNum(r[c])));
}

export interface Insight {
  text: string;
  /** The row that leads, so the chart can highlight the same bar. */
  topIndex: number;
}

/**
 * "Shopping leads at 3,081.39 — 97.34 ahead of groceries."
 * Returns null when the shape does not support a claim worth making.
 */
export function summarise(
  result: QueryResult,
  prefer?: { x?: string; y?: string },
  symbol = '',
): Insight | null {
  if (result.rows.length < 2) return null;

  const value = numericColumn(result, prefer?.y);
  if (!value) return null;
  const label = labelColumn(result, prefer?.x, value);
  if (!label) return null;

  const ranked = result.rows
    .map((r, i) => ({ i, name: String(r[label] ?? ''), n: r[value] }))
    .filter((r): r is { i: number; name: string; n: number } => isNum(r.n))
    .sort((a, b) => b.n - a.n);
  if (ranked.length < 2) return null;

  const [top, next] = ranked;
  const gap = top.n - next.n;
  const share = ranked.reduce((s, r) => s + Math.abs(r.n), 0);

  const lead =
    gap === 0
      ? `level with ${next.name}`
      : `${formatNumber(gap, symbol)} ahead of ${next.name}`;
  const pct =
    share > 0 ? ` It is ${Math.round((Math.abs(top.n) / share) * 100)}% of the total.` : '';

  return {
    text:
      `${sentenceCase(top.name)} is highest at ${formatNumber(top.n, symbol)} — ` +
      `${lead}.${pct}`,
    topIndex: top.i,
  };
}

/** What the agent asked for, in words, for the audit feed. */
export function describeCall(entry: AuditEntry): string {
  const a = (entry.args ?? {}) as Record<string, unknown>;
  const rows = `${formatNumber(entry.rows)} row${entry.rows === 1 ? '' : 's'}`;

  if (entry.tool === 'list_datasets') return 'Asked what data is loaded';
  if (entry.tool === 'list_samples') return 'Asked which demo datasets are available';
  if (entry.tool === 'load_sample') return `Loaded the ${a['file'] ?? 'sample'} dataset`;
  if (entry.tool === 'run_sql') return `Ran a SQL query · ${rows} returned`;
  if (entry.tool === 'render_chart') return `Drew a ${a['kind'] ?? 'chart'} · ${rows}`;
  if (entry.tool === 'save_view') return `Pinned the view "${a['name'] ?? 'untitled'}"`;
  if (entry.tool === 'eject_dataset') return `Asked to remove ${a['table'] ?? 'a dataset'}`;

  const table = entry.tool.replace(/^(query|describe)_/, '');
  if (entry.tool.startsWith('describe_')) return `Inspected the columns of ${table}`;
  if (entry.tool.startsWith('query_')) return `${describeQuery(a, table)} · ${rows}`;
  return entry.tool;
}

/** Turns structured query-tool input into a sentence. */
export function describeQuery(a: Record<string, unknown>, table: string): string {
  const parts: string[] = [];
  const agg = a['aggregate'] as { fn?: string; column?: string } | undefined;

  if (a['groupBy'] && agg?.fn) {
    parts.push(`Grouped ${table} by ${a['groupBy']}, ${agg.fn} of ${agg.column}`);
  } else if (Array.isArray(a['columns']) && (a['columns'] as string[]).length) {
    parts.push(`Read ${(a['columns'] as string[]).join(', ')} from ${table}`);
  } else {
    parts.push(`Read ${table}`);
  }

  for (const w of (a['where'] as { column: string; op: string; value: unknown }[]) ?? []) {
    parts.push(`where ${w.column} ${w.op} ${String(w.value)}`);
  }
  if (a['since']) parts.push(`from ${a['since']}`);
  if (a['until']) parts.push(`to ${a['until']}`);
  if (a['orderBy']) parts.push(`sorted by ${a['orderBy']}${a['descending'] ? ' descending' : ''}`);

  return parts.join(', ');
}
