import { Injectable } from '@angular/core';
import * as duckdb from '@duckdb/duckdb-wasm';
import { MAX_ROWS, type QueryResult } from './models';

/** What the Arrow schema says a column is, where it changes how we render it. */
export type ColumnHint = 'date' | 'timestamp' | 'numeric';

/**
 * Arrow hands back values that cannot be serialised into a tool response as-is:
 * BIGINT columns arrive as `bigint`, which `JSON.stringify` throws on, and
 * DATE/TIMESTAMP columns arrive as epoch numbers rather than `Date` objects.
 * An agent shown `1641427200000` cannot tell days from milliseconds, so
 * temporal columns are rendered as ISO strings using the Arrow schema.
 */
export function normalizeValue(v: unknown, hint?: ColumnHint): unknown {
  if (v === null || v === undefined) return null;

  if (hint === 'date' || hint === 'timestamp') {
    const ms = typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.getTime() : v;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      const iso = new Date(ms).toISOString();
      // A DATE has no time component; showing one would invent precision.
      return hint === 'date' ? iso.slice(0, 10) : iso;
    }
  }

  // sum() over integers yields HUGEINT, which Arrow delivers as a Decimal128 —
  // a Uint32Array of limbs whose toString gives the decimal digits. Left alone
  // it reaches the agent as an object or a string, so an agent doing further
  // arithmetic on a total gets text. Only columns Arrow itself calls numeric are
  // converted, so a zero-padded id or postcode is never mangled.
  if (hint === 'numeric') {
    const text = typeof v === 'string' ? v : ArrayBuffer.isView(v) ? String(v) : null;
    // Anything that is not a plain decimal is left as-is rather than guessed at.
    if (text !== null && /^-?\d+(\.\d+)?$/.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n;
      return text; // beyond 2^53 — keep the digits exact
    }
    if (text !== null) return text;
  }

  return normalizeScalar(v);
}

function normalizeScalar(v: unknown): unknown {
  // Above 2^53 a bigint cannot round-trip through Number, so keep it exact as a
  // string rather than silently corrupting a large id.
  if (typeof v === 'bigint') {
    return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return null;
  if (ArrayBuffer.isView(v)) return String(v);
  if (typeof v === 'object') {
    // Arrow list/struct vectors — stringify rather than leak an exotic object.
    try {
      return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
    } catch {
      return String(v);
    }
  }
  return v;
}

export function normalizeRow(
  row: Record<string, unknown>,
  hints?: Map<string, ColumnHint>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v, hints?.get(k));
  return out;
}

/** Read column kinds off the Arrow schema, e.g. "Date32<DAY>", "Decimal<38,0>". */
export function columnHints(fields: { name: string; type: unknown }[]): Map<string, ColumnHint> {
  const map = new Map<string, ColumnHint>();
  for (const f of fields) {
    const t = String(f.type);
    if (/^Date/.test(t)) map.set(f.name, 'date');
    else if (/^Timestamp/.test(t)) map.set(f.name, 'timestamp');
    else if (/^(Decimal|Int|Uint|Float)/.test(t)) map.set(f.name, 'numeric');
  }
  return map;
}

@Injectable({ providedIn: 'root' })
export class DuckService {
  private db?: duckdb.AsyncDuckDB;
  private conn?: duckdb.AsyncDuckDBConnection;
  private booting?: Promise<void>;

  /** Idempotent. The wasm bundle downloads on first call, not at app boot. */
  init(): Promise<void> {
    this.booting ??= this.boot();
    return this.booting;
  }

  private async boot(): Promise<void> {
    // jsDelivr bundle selection picks the non-threaded build when the page is
    // not cross-origin isolated, which is what we want — no COOP/COEP headers.
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
    );
    const worker = new Worker(workerUrl);
    this.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    this.conn = await this.db.connect();
  }

  private async c(): Promise<duckdb.AsyncDuckDBConnection> {
    await this.init();
    return this.conn!;
  }

  /** Run a query, capped at MAX_ROWS. Fetches one extra row to detect truncation. */
  async query(sql: string): Promise<QueryResult> {
    const conn = await this.c();
    const table = await conn.query(`SELECT * FROM (${sql}) LIMIT ${MAX_ROWS + 1}`);
    const hints = columnHints(table.schema.fields);
    const all = table
      .toArray()
      .map((r) => normalizeRow(r.toJSON() as Record<string, unknown>, hints));
    const truncated = all.length > MAX_ROWS;
    return {
      columns: table.schema.fields.map((f) => f.name),
      rows: truncated ? all.slice(0, MAX_ROWS) : all,
      truncated,
    };
  }

  /** Load a CSV/JSON buffer into a table. DuckDB does the parsing and type inference. */
  async ingestFile(table: string, fileName: string, bytes: Uint8Array): Promise<number> {
    const conn = await this.c();
    await this.db!.registerFileBuffer(fileName, bytes);
    const reader = fileName.toLowerCase().endsWith('.json')
      ? `read_json_auto('${fileName}')`
      : `read_csv_auto('${fileName}')`;
    await conn.query(`CREATE OR REPLACE TABLE "${table}" AS SELECT * FROM ${reader}`);
    // The table owns a copy now; drop the buffer so a large file is not held twice.
    await this.db!.dropFile(fileName);
    const res = await conn.query(`SELECT count(*)::BIGINT AS n FROM "${table}"`);
    return Number((res.toArray()[0].toJSON() as Record<string, unknown>)['n']);
  }

  async describeTable(table: string): Promise<{ name: string; duckType: string }[]> {
    const conn = await this.c();
    const res = await conn.query(`DESCRIBE "${table}"`);
    return res.toArray().map((r) => {
      const o = r.toJSON() as Record<string, unknown>;
      return { name: String(o['column_name']), duckType: String(o['column_type']) };
    });
  }

  async dropTable(table: string): Promise<void> {
    const conn = await this.c();
    await conn.query(`DROP TABLE IF EXISTS "${table}"`);
  }
}
