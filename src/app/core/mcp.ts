import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuditService } from './audit';
import { DuckService } from './duck';
import { VaultService } from './vault';
import { ViewportService } from './viewport';
import { SamplesService } from './samples';
import { describeQuery } from './insight';
import { assertReadOnlySql } from './sql-guard';
import {
  buildQuerySql,
  buildQueryToolDescription,
  buildQueryToolSchema,
  type QueryToolInput,
} from './tool-schema';
import { getModelContext, type McpClient, type McpToolDef } from './webmcp';
import { MAX_ROWS, type CallSource, type ChartKind, type Dataset } from './models';

/**
 * The only file in the app that touches the WebMCP API.
 *
 * Registers five static tools at init, then mirrors the vault's dataset list
 * onto the browser's toolset: adding a dataset registers its pair of tools.
 * Nothing calls registerTool imperatively from the UI — the vault signal is the
 * single trigger.
 *
 * Removal depends on the browser: Chrome 152 exposes no `unregisterTool`, so an
 * ejected dataset's tools remain registered. Their execute reports the dataset
 * is gone, and `canUnregister` lets the UI say so rather than pretend.
 */
@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly duck = inject(DuckService);
  private readonly vault = inject(VaultService);
  private readonly audit = inject(AuditService);
  private readonly viewport = inject(ViewportService);
  private readonly samples = inject(SamplesService);
  private readonly injector = inject(Injector);

  private readonly ctx = signal(getModelContext());
  private readonly _tools = signal<Map<string, McpToolDef>>(new Map());
  private started = false;

  readonly available = computed(() => this.ctx() !== null);
  readonly toolNames = computed(() => [...this._tools().keys()].sort());

  /**
   * Chrome 152 ships no `unregisterTool`, so an ejected dataset's tools stay
   * registered with the browser. Their execute already reports that the dataset
   * is gone; the UI surfaces this rather than pretending they vanished.
   */
  readonly canUnregister = computed(() => typeof this.ctx()?.unregisterTool === 'function');

  init(): void {
    if (this.started) return;
    this.started = true;
    this.ctx.set(getModelContext());
    for (const tool of this.staticTools()) this.register(tool);
    // Explicit injector: init() is called from a component constructor, but the
    // effect must outlive that call's injection context.
    effect(() => this.syncDatasetTools(), { injector: this.injector });
  }

  /** True once a real agent has actually called something. */
  readonly agentConnected = computed(() => this.audit.agentCalls().length > 0);

  /** Invoke a tool by name, bypassing the browser. Used by the dev panel. */
  async invoke(name: string, input: unknown): Promise<object> {
    const tool = this._raw.get(name);
    if (!tool) throw new Error(`No such tool: ${name}`);
    return this.run(tool, input, 'panel');
  }

  // --- registration lifecycle -------------------------------------------

  private syncDatasetTools(): void {
    const datasets = this.vault.datasets(); // the only tracked read
    untracked(() => {
      const wanted = new Set<string>();
      for (const ds of datasets) {
        wanted.add(`query_${ds.table}`);
        wanted.add(`describe_${ds.table}`);
      }
      const current = this._tools();
      for (const ds of datasets) {
        for (const tool of this.datasetTools(ds)) {
          if (!current.has(tool.name)) this.register(tool);
        }
      }
      for (const name of [...current.keys()]) {
        if (isDatasetTool(name) && !wanted.has(name)) this.unregister(name);
      }
    });
  }

  private readonly _raw = new Map<string, McpToolDef>();

  private register(tool: McpToolDef): void {
    this._raw.set(tool.name, tool);
    const wrapped: McpToolDef = { ...tool, execute: this.wrap(tool) };
    this._tools.update((m) => new Map(m).set(tool.name, wrapped));
    const ctx = this.ctx();
    if (!ctx) return;
    try {
      // registerTool is async in Chrome 152 and rejects on a duplicate name,
      // which is harmless — first registration wins and stays valid.
      Promise.resolve(ctx.registerTool(wrapped)).catch(() => undefined);
    } catch {
      // Give up quietly; the app stays usable without the agent.
    }
  }

  private unregister(name: string): void {
    const ctx = this.ctx();
    // Without browser support the tool genuinely stays registered, so leaving it
    // in the map keeps the UI honest about what an agent can still see.
    if (ctx && typeof ctx.unregisterTool !== 'function') return;
    this._raw.delete(name);
    this._tools.update((m) => {
      const next = new Map(m);
      next.delete(name);
      return next;
    });
    try {
      ctx?.unregisterTool?.(name);
    } catch {
      // Not found — nothing to do.
    }
  }

  /** Anything the browser's agent calls is tagged as such. */
  private wrap(tool: McpToolDef): McpToolDef['execute'] {
    return (input, client) => this.run(tool, input, 'agent', client);
  }

  /** Time every invocation, record it, and surface errors as tool results. */
  private async run(
    tool: McpToolDef,
    input: unknown,
    source: CallSource,
    client?: McpClient,
  ): Promise<object> {
    const started = performance.now();
    try {
      const out = (await tool.execute(input, client)) as { rows?: unknown[] };
      const rows = Array.isArray(out?.rows) ? out.rows.length : 0;
      this.audit.record(tool.name, input, rows, performance.now() - started, undefined, source);
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record(tool.name, input, 0, performance.now() - started, message, source);
      return { error: message };
    }
  }

  // --- static tools ------------------------------------------------------

  private staticTools(): McpToolDef[] {
    return [
      {
        name: 'list_datasets',
        description:
          "List every dataset currently loaded in the user's local SiftIO vault, with " +
          'row counts and column schemas. Call this first to discover what is available.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async () => {
          const datasets = this.vault.datasets();
          return {
            datasets: datasets.map((d) => ({
              table: d.table,
              file: d.fileName,
              rows: d.rowCount,
              columns: d.columns.map((c) => ({ name: c.name, type: c.type, role: c.role })),
            })),
            rowsHeldLocally: this.vault.rowsLocal(),
            // An empty vault is the normal starting state, not a failure.
            ...(datasets.length
              ? {}
              : {
                  hint:
                    'The vault is empty. Call list_samples to see the bundled demo ' +
                    'datasets and load_sample to load one, or ask the user to drop a ' +
                    'CSV or JSON file onto the page.',
                }),
          };
        },
      },
      {
        name: 'list_samples',
        description:
          'List the demo datasets bundled with SiftIO that can be loaded into the vault. ' +
          'Call this when list_datasets comes back empty — the vault starts empty in a ' +
          'fresh browser session, and these are the only datasets you can load yourself. ' +
          'Load them with load_sample and query them with the tools rather than fetching ' +
          'the files directly: querying runs in DuckDB over the whole vault, supports ' +
          "joins across datasets, and is recorded in the user's audit log.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async () => ({
          samples: this.samples.samples().map((s) => ({
            file: s.file,
            title: s.title,
            about: s.note,
            rows: s.rows,
          })),
          hint: 'Load one with load_sample. transactions.csv, workouts.csv and sleep.csv share a day column, so they join.',
        }),
      },
      {
        name: 'load_sample',
        description:
          'Load one bundled demo dataset into the local vault by file name, taken from ' +
          'list_samples. This registers query_<table> and describe_<table> tools for it. ' +
          'Only bundled samples can be loaded this way; the user adds their own files ' +
          'by dropping them on the page.',
        inputSchema: {
          type: 'object',
          required: ['file'],
          properties: {
            file: {
              type: 'string',
              description: 'A file name from list_samples, e.g. "transactions.csv".',
            },
          },
        },
        execute: async (input: { file: string }) => {
          const ds = await this.samples.ingest(input.file);
          return {
            loaded: ds.fileName,
            table: ds.table,
            rows: ds.rowCount,
            columns: ds.columns.map((c) => ({ name: c.name, type: c.type, role: c.role })),
            tools: [`query_${ds.table}`, `describe_${ds.table}`],
          };
        },
      },
      {
        name: 'run_sql',
        description:
          'Run a read-only SQL SELECT against the local DuckDB vault. Tables are named by ' +
          'the `table` field from list_datasets. Use this to join across datasets. ' +
          `At most ${MAX_ROWS} rows are returned. The result echoes the \`sql\` that ran — ` +
          'quote it when you report a number, so the reader can see what was counted. ' +
          'Amounts may be negative where a dataset records refunds; excluding them is a ' +
          'different question, so say which you did.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: 'object',
          required: ['sql'],
          properties: { sql: { type: 'string', description: 'A single SELECT statement.' } },
        },
        execute: async (input: { sql: string }, client?: McpClient) => {
          assertReadOnlySql(input.sql);
          await this.disambiguate(input.sql, client);
          const result = await this.duck.query(input.sql);
          this.viewport.show(result, null, 'Ran a SQL query across the vault.', input.sql);
          // Echo the statement back: the definition behind a number should travel
          // with it, so a reader can see what was counted without guessing.
          return { sql: input.sql, ...result };
        },
      },
      {
        name: 'render_chart',
        description:
          'Run a read-only SELECT and draw the result in the SiftIO viewport so the user ' +
          'can see it. Use after run_sql when a picture helps. The result echoes the `sql` ' +
          'that ran, alongside `columns` and `rows`.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: 'object',
          required: ['sql', 'kind'],
          properties: {
            sql: { type: 'string' },
            kind: { type: 'string', enum: ['bar', 'line', 'scatter', 'table'] },
            x: { type: 'string', description: 'Column for the x axis.' },
            y: { type: 'string', description: 'Column for the y axis.' },
          },
        },
        execute: async (input: { sql: string; kind: ChartKind; x?: string; y?: string }) => {
          assertReadOnlySql(input.sql);
          const result = await this.duck.query(input.sql);
          const spec = { kind: input.kind, x: input.x, y: input.y };
          this.viewport.show(result, spec, `Charted a SQL query as a ${input.kind}.`, input.sql);
          return { rendered: true, sql: input.sql, ...result };
        },
      },
      {
        name: 'save_view',
        description:
          "Pin a named query and chart to the user's board so it survives after this " +
          'conversation ends.',
        inputSchema: {
          type: 'object',
          required: ['name', 'sql', 'kind'],
          properties: {
            name: { type: 'string' },
            sql: { type: 'string' },
            kind: { type: 'string', enum: ['bar', 'line', 'scatter', 'table'] },
            x: { type: 'string' },
            y: { type: 'string' },
          },
        },
        execute: async (i: {
          name: string;
          sql: string;
          kind: ChartKind;
          x?: string;
          y?: string;
        }) => {
          assertReadOnlySql(i.sql);
          const view = await this.viewport.saveView(i.name, i.sql, {
            kind: i.kind,
            x: i.x,
            y: i.y,
          });
          return { saved: view.id, name: view.name };
        },
      },
      {
        name: 'eject_dataset',
        description: 'Remove a dataset from the local vault. The user is asked to confirm first.',
        annotations: { destructiveHint: true },
        inputSchema: {
          type: 'object',
          required: ['table'],
          properties: { table: { type: 'string' } },
        },
        execute: async (input: { table: string }, client?: McpClient) => {
          const ds = this.vault.datasets().find((d) => d.table === input.table);
          if (!ds) throw new Error(`No dataset named ${input.table}`);
          const ok = await this.confirm(
            `Remove "${ds.fileName}" (${ds.rowCount} rows) from your vault?`,
            client,
          );
          if (!ok) return { ejected: false, reason: 'The user declined.' };
          await this.vault.eject(ds.id);
          return { ejected: true, table: ds.table };
        },
      },
    ];
  }

  // --- dynamic per-dataset tools -----------------------------------------

  private datasetTools(ds: Dataset): McpToolDef[] {
    return [
      {
        name: `query_${ds.table}`,
        description: buildQueryToolDescription(ds),
        annotations: { readOnlyHint: true },
        inputSchema: buildQueryToolSchema(ds),
        execute: async (input: QueryToolInput) => {
          // Re-read from the vault rather than closing over a stale snapshot, so
          // roles assigned after registration are respected.
          const current = this.vault.byId(ds.id);
          if (!current) throw new Error(`${ds.table} is no longer loaded.`);
          const sql = buildQuerySql(current, input ?? {});
          const result = await this.duck.query(sql);
          this.viewport.show(
            result,
            null,
            `${describeQuery((input ?? {}) as Record<string, unknown>, current.table)}.`,
            sql,
          );
          return { sql, ...result };
        },
      },
      {
        name: `describe_${ds.table}`,
        description:
          `Column statistics for "${ds.fileName}" — type, null count, distinct count, ` +
          'and min/max. Call this before querying to understand the data.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: async () => {
          const result = await this.duck.query(`SELECT * FROM (SUMMARIZE "${ds.table}")`);
          return { table: ds.table, ...result };
        },
      },
    ];
  }

  // --- elicitation --------------------------------------------------------

  /** Ask the human when a bare column name is ambiguous across datasets. */
  private async disambiguate(sql: string, client?: McpClient): Promise<void> {
    const sets = this.vault.datasets();
    if (sets.length < 2) return;

    const owners = new Map<string, string[]>();
    for (const d of sets) {
      for (const c of d.columns) {
        owners.set(c.name, [...(owners.get(c.name) ?? []), d.table]);
      }
    }

    for (const [col, tables] of owners) {
      if (tables.length < 2) continue;
      // Only flag an *unqualified* mention: `amt`, not `txns.amt`.
      const bare = new RegExp(`(?<![."\\w])${col}\\b(?!\\s*\\.)`, 'i');
      if (!bare.test(sql)) continue;
      if (sql.includes(`."${col}"`) || sql.includes(`.${col}`)) continue;
      await this.ask(
        `"${col}" exists in ${tables.join(' and ')}. ` +
          'Qualify it in your query if this is not what you intended.',
        client,
      );
      return;
    }
  }

  /** Elicitation with a graceful fallback to a native confirm. */
  private async confirm(message: string, client?: McpClient): Promise<boolean> {
    if (client?.elicit) {
      try {
        const res = await client.elicit({ message });
        return res.action === 'accept';
      } catch {
        // Fall through to the in-page confirm.
      }
    }
    return globalThis.confirm?.(message) ?? false;
  }

  private async ask(message: string, client?: McpClient): Promise<void> {
    if (client?.elicit) {
      try {
        await client.elicit({ message });
      } catch {
        // Advisory only — never block the query on a failed elicitation.
      }
    }
  }
}

function isDatasetTool(name: string): boolean {
  return name.startsWith('query_') || name.startsWith('describe_');
}
