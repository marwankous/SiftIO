import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { McpService } from './mcp';
import { VaultService } from './vault';
import { DuckService } from './duck';
import { ViewportService } from './viewport';
import { SamplesService } from './samples';
import type { Dataset } from './models';
import type { McpToolDef } from './webmcp';

const dataset = (id: string): Dataset => ({
  id,
  table: id,
  fileName: `${id}.csv`,
  rowCount: 5,
  ingestedAt: 0,
  columns: [
    { name: 'amt', type: 'number', duckType: 'DOUBLE', role: 'amount' },
    { name: 'day', type: 'date', duckType: 'DATE', role: 'timestamp' },
  ],
});

const emptyResult = { columns: [], rows: [], truncated: false };

describe('McpService', () => {
  let mcp: McpService;
  let datasets: ReturnType<typeof signal<Dataset[]>>;
  let registered: Map<string, McpToolDef>;
  let duck: { query: ReturnType<typeof vi.fn> };
  let eject: ReturnType<typeof vi.fn>;

  function setup(withWebMcp = true, opts: { unregister?: boolean; where?: 'document' | 'navigator' } = {}) {
    const { unregister = true, where = 'document' } = opts;
    registered = new Map();
    datasets = signal<Dataset[]>([]);
    eject = vi.fn(async () => {});
    duck = { query: vi.fn(async () => emptyResult) };

    delete (document as unknown as Record<string, unknown>)['modelContext'];
    delete (navigator as unknown as Record<string, unknown>)['modelContext'];

    if (withWebMcp) {
      // Chrome 152 shape: registerTool is async and rejects on a duplicate name.
      const ctx: Record<string, unknown> = {
        registerTool: async (t: McpToolDef) => {
          if (registered.has(t.name)) throw new Error('already registered');
          registered.set(t.name, t);
        },
      };
      if (unregister) {
        ctx['unregisterTool'] = (n: string) => {
          if (!registered.has(n)) throw new Error('not found');
          registered.delete(n);
        };
      }
      const host = where === 'document' ? document : navigator;
      (host as unknown as Record<string, unknown>)['modelContext'] = ctx;
    }

    const vault = {
      datasets: datasets.asReadonly(),
      rowsLocal: () => 42,
      byId: (id: string) => datasets().find((d) => d.id === id),
      eject,
    };

    const library = {
      samples: () => [
        { file: 'transactions.csv', title: 'Bank transactions', note: 'A year of spending.', rows: 941, roles: {} },
      ],
      find: (f: string) => (f === 'transactions.csv' ? { file: f } : undefined),
      ingest: vi.fn(async (f: string) => {
        if (f !== 'transactions.csv') throw new Error(`No sample named "${f}".`);
        const ds = dataset('transactions');
        datasets.set([...datasets(), ds]);
        return ds;
      }),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: VaultService, useValue: vault },
        { provide: DuckService, useValue: duck },
        { provide: SamplesService, useValue: library },
      ],
    });
    mcp = TestBed.inject(McpService);
  }

  beforeEach(() => setup());
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>)['modelContext'];
    delete (navigator as unknown as Record<string, unknown>)['modelContext'];
  });

  it('reports availability from feature detection', () => {
    mcp.init();
    expect(mcp.available()).toBe(true);
  });

  it('registers the static tools at init', () => {
    mcp.init();
    expect([...registered.keys()].sort()).toEqual([
      'eject_dataset',
      'list_datasets',
      'list_samples',
      'load_sample',
      'render_chart',
      'run_sql',
      'save_view',
    ]);
  });

  it('tells the agent what to do when the vault is empty', async () => {
    mcp.init();
    // An agent reaching a fresh page must not hit a dead end.
    const out = (await mcp.invoke('list_datasets', {})) as { datasets: unknown[]; hint?: string };
    expect(out.datasets).toEqual([]);
    expect(out.hint).toMatch(/list_samples/);
  });

  it('drops the hint once data is loaded', async () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    const out = (await mcp.invoke('list_datasets', {})) as { hint?: string };
    expect(out.hint).toBeUndefined();
  });

  it('loads a bundled sample, which registers its tools', async () => {
    mcp.init();
    const out = (await mcp.invoke('load_sample', { file: 'transactions.csv' })) as {
      table: string;
      tools: string[];
    };
    expect(out.table).toBe('transactions');
    expect(out.tools).toEqual(['query_transactions', 'describe_transactions']);
    TestBed.tick();
    expect(registered.has('query_transactions')).toBe(true);
  });

  it('reports a helpful error for a sample that does not exist', async () => {
    mcp.init();
    const out = (await mcp.invoke('load_sample', { file: 'nope.csv' })) as { error?: string };
    expect(out.error).toMatch(/No sample named/);
  });

  it('fails soft when WebMCP is absent', () => {
    setup(false);
    expect(() => mcp.init()).not.toThrow();
    expect(mcp.available()).toBe(false);
    // Tools still exist locally, so the MockAgent panel keeps working.
    expect(mcp.toolNames()).toContain('run_sql');
  });

  it('registers a tool pair when a dataset is added', () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    expect(registered.has('query_txns')).toBe(true);
    expect(registered.has('describe_txns')).toBe(true);
  });

  it('unregisters the pair when the dataset is ejected', () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    datasets.set([]);
    TestBed.tick();
    expect(registered.has('query_txns')).toBe(false);
    expect(registered.has('describe_txns')).toBe(false);
    // Static tools are untouched.
    expect(registered.has('run_sql')).toBe(true);
  });

  it('keeps tools for datasets that remain when another is ejected', () => {
    mcp.init();
    datasets.set([dataset('txns'), dataset('workouts')]);
    TestBed.tick();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    expect(registered.has('query_txns')).toBe(true);
    expect(registered.has('query_workouts')).toBe(false);
  });

  it('generates a schema from the dataset real columns', () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    const schema = registered.get('query_txns')!.inputSchema as any;
    expect(schema.properties.groupBy.enum).toEqual(['amt', 'day']);
  });

  it('records every invocation in the audit log', async () => {
    mcp.init();
    await mcp.invoke('list_datasets', {});
    const audit = TestBed.inject(
      (await import('./audit')).AuditService,
    );
    expect(audit.callCount()).toBe(1);
    expect(audit.entries()[0].tool).toBe('list_datasets');
  });

  it('returns an error object instead of throwing when a tool fails', async () => {
    mcp.init();
    const out = (await mcp.invoke('run_sql', { sql: 'DROP TABLE txns' })) as {
      error?: string;
    };
    expect(out.error).toMatch(/only select queries are allowed/i);
    expect(duck.query).not.toHaveBeenCalled();
  });

  it('rejects a forbidden keyword smuggled into a SELECT', async () => {
    mcp.init();
    const out = (await mcp.invoke('run_sql', {
      sql: 'SELECT * FROM t; DROP TABLE t',
    })) as { error?: string };
    expect(out.error).toMatch(/one statement/i);
    expect(duck.query).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool name', async () => {
    mcp.init();
    await expect(mcp.invoke('nope', {})).rejects.toThrow(/No such tool/);
  });

  it('routes a successful query result into the viewport', async () => {
    mcp.init();
    duck.query = vi.fn(async () => ({ columns: ['a'], rows: [{ a: 1 }], truncated: false }));
    await mcp.invoke('run_sql', { sql: 'SELECT 1 AS a' });
    expect(TestBed.inject(ViewportService).result()?.rows).toEqual([{ a: 1 }]);
  });

  it('does not eject when the user declines the confirmation', async () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    vi.stubGlobal('confirm', () => false);
    const out = (await mcp.invoke('eject_dataset', { table: 'txns' })) as { ejected: boolean };
    expect(out.ejected).toBe(false);
    expect(eject).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('ejects when the user confirms', async () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    vi.stubGlobal('confirm', () => true);
    const out = (await mcp.invoke('eject_dataset', { table: 'txns' })) as { ejected: boolean };
    expect(out.ejected).toBe(true);
    expect(eject).toHaveBeenCalledWith('txns');
    vi.unstubAllGlobals();
  });

  it('finds the API on document.modelContext, where Chrome 152 exposes it', () => {
    mcp.init();
    expect(mcp.available()).toBe(true);
    expect(registered.has('run_sql')).toBe(true);
  });

  it('falls back to navigator.modelContext if an implementation puts it there', () => {
    setup(true, { where: 'navigator' });
    mcp.init();
    expect(mcp.available()).toBe(true);
    expect(registered.has('run_sql')).toBe(true);
  });

  it('survives registerTool rejecting on a duplicate name', async () => {
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    // Re-registering is first-write-wins in Chrome; nothing should throw.
    await Promise.resolve();
    expect(registered.has('query_txns')).toBe(true);
  });

  it('keeps ejected dataset tools listed when the browser cannot unregister', () => {
    setup(true, { unregister: false });
    mcp.init();
    expect(mcp.canUnregister()).toBe(false);
    datasets.set([dataset('txns')]);
    TestBed.tick();
    datasets.set([]);
    TestBed.tick();
    // Chrome 152 has no unregisterTool, so the tool really is still registered.
    // The UI must not claim otherwise.
    expect(mcp.toolNames()).toContain('query_txns');
    expect(registered.has('query_txns')).toBe(true);
  });

  it('reports that the dataset is gone when a stale tool is invoked', async () => {
    setup(true, { unregister: false });
    mcp.init();
    datasets.set([dataset('txns')]);
    TestBed.tick();
    datasets.set([]);
    TestBed.tick();
    const out = (await mcp.invoke('query_txns', {})) as { error?: string };
    expect(out.error).toMatch(/no longer loaded/i);
  });

  it('is idempotent across repeated init calls', () => {
    mcp.init();
    mcp.init();
    expect(mcp.toolNames().filter((n) => n === 'run_sql')).toHaveLength(1);
  });
});
