/** Hard cap on rows returned to an agent from any tool. */
export const MAX_ROWS = 1000;

export type ColumnType = 'integer' | 'number' | 'date' | 'timestamp' | 'boolean' | 'string';

/**
 * What a column *means*, as labelled by the human. Roles are optional and flow
 * into the generated tool descriptions, so labelling `txn_amt` as `amount` is
 * how the user teaches the agent to read their data.
 */
export type SemanticRole =
  | 'amount'
  | 'timestamp'
  | 'category'
  | 'identifier'
  | 'label'
  | 'none';

export interface Column {
  name: string;
  type: ColumnType;
  /** The raw DuckDB type string, kept for display and debugging. */
  duckType: string;
  role: SemanticRole;
}

export interface Dataset {
  id: string;
  /** Sanitised DuckDB table name. Always equal to `id`. */
  table: string;
  fileName: string;
  rowCount: number;
  columns: Column[];
  ingestedAt: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when the result was cut off at MAX_ROWS. */
  truncated: boolean;
}

/** Who made the call: the browser's agent, or the in-page dev panel. */
export type CallSource = 'agent' | 'panel';

export interface AuditEntry {
  id: string;
  tool: string;
  source: CallSource;
  args: unknown;
  rows: number;
  bytes: number;
  ms: number;
  at: number;
  error?: string;
}

export type ChartKind = 'bar' | 'line' | 'scatter' | 'table';

export interface ChartSpec {
  kind: ChartKind;
  x?: string;
  y?: string;
}

export interface SavedView {
  id: string;
  name: string;
  sql: string;
  chart: ChartSpec;
}
