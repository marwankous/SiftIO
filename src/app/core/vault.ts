import { Injectable, computed, inject, signal } from '@angular/core';
import { del, entries, get, set } from 'idb-keyval';
import { DuckService } from './duck';
import { mapDuckType, sanitizeTableName } from './schema';
import type { Column, Dataset, SemanticRole } from './models';

const KEY_PREFIX = 'ds:';

/**
 * IndexedDB can be unavailable (private windows, blocked storage) or wedged by a
 * pending deleteDatabase, in which case `open` never settles and every read and
 * write hangs silently. Persistence is a bonus here — the dataset is already
 * usable in DuckDB — so give it a deadline and carry on without it.
 */
const PERSIST_TIMEOUT_MS = 4000;

interface StoredDataset {
  meta: Dataset;
  /**
   * The original file, not its bytes. `registerFileBuffer` *transfers* the
   * ArrayBuffer to the DuckDB worker, which detaches it — persisting those
   * bytes afterwards fails with "ArrayBuffer is detached". A Blob also lets
   * IndexedDB store the payload out-of-line instead of in the JS heap.
   */
  blob: Blob;
}

/**
 * Owns the set of loaded datasets. The `datasets` signal is the single source
 * of truth that drives both the UI and — via McpService — which WebMCP tools
 * are currently registered.
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly duck = inject(DuckService);
  private readonly _datasets = signal<Dataset[]>([]);
  readonly datasets = this._datasets.asReadonly();

  readonly rowsLocal = computed(() => this._datasets().reduce((n, d) => n + d.rowCount, 0));

  private readonly _persistent = signal(true);
  /** False once a storage operation has failed; datasets will not survive a reload. */
  readonly persistent = this._persistent.asReadonly();

  /** Never let a storage failure block or hang an ingest. */
  private async guard<T>(op: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        op,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('storage timed out')), PERSIST_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this._persistent.set(false);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  byId(id: string): Dataset | undefined {
    return this._datasets().find((d) => d.id === id);
  }

  /**
   * @param roles optional column labels applied before the dataset is persisted,
   *   so a curated sample arrives already meaningful to the agent. Unknown column
   *   names are ignored.
   */
  async ingest(file: File, roles?: Record<string, SemanticRole>): Promise<Dataset> {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.json')) {
      throw new Error('SiftIO reads csv or json files.');
    }
    // Re-loading a file replaces it rather than piling up transactions_2,
    // transactions_3 — which also keeps its tool names stable for the agent.
    const existing = this._datasets().find((d) => d.fileName === file.name);
    if (existing) await this.eject(existing.id);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const loaded = await this.load(file.name, bytes);
    for (const [column, role] of Object.entries(roles ?? {})) {
      this.applyRole(loaded.id, column, role);
    }
    const meta = this.byId(loaded.id) ?? loaded;
    await this.guard<void>(set(KEY_PREFIX + meta.id, { meta, blob: file } satisfies StoredDataset), undefined);
    return meta;
  }

  /** Shared by ingest and rehydrate so a restored dataset takes the same path. */
  private async load(fileName: string, bytes: Uint8Array): Promise<Dataset> {
    const table = this.uniqueTable(sanitizeTableName(fileName));
    const ext = fileName.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    const rowCount = await this.duck.ingestFile(table, `${table}.${ext}`, bytes);
    const columns: Column[] = (await this.duck.describeTable(table)).map((c) => ({
      name: c.name,
      duckType: c.duckType,
      type: mapDuckType(c.duckType),
      role: 'none' as SemanticRole,
    }));
    const meta: Dataset = {
      id: table,
      table,
      fileName,
      rowCount,
      columns,
      ingestedAt: Date.now(),
    };
    this._datasets.update((list) => [...list, meta]);
    return meta;
  }

  private uniqueTable(base: string): string {
    const taken = new Set(this._datasets().map((d) => d.table));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  async eject(id: string): Promise<void> {
    const ds = this.byId(id);
    if (!ds) return;
    await this.duck.dropTable(ds.table);
    await this.guard<void>(del(KEY_PREFIX + id), undefined);
    this._datasets.update((list) => list.filter((d) => d.id !== id));
  }

  /**
   * Labelling a column is what teaches the agent what the data means.
   * Awaitable so the label is durable before the page can be reloaded.
   */
  async setRole(id: string, column: string, role: SemanticRole): Promise<void> {
    this.applyRole(id, column, role);
    await this.persistMeta(id);
  }

  private applyRole(id: string, column: string, role: SemanticRole): void {
    this._datasets.update((list) =>
      list.map((d) =>
        d.id !== id
          ? d
          : { ...d, columns: d.columns.map((c) => (c.name === column ? { ...c, role } : c)) },
      ),
    );
  }

  private async persistMeta(id: string): Promise<void> {
    const ds = this.byId(id);
    if (!ds) return;
    const stored = await this.guard(get<StoredDataset>(KEY_PREFIX + id), undefined);
    if (stored) await this.guard<void>(set(KEY_PREFIX + id, { ...stored, meta: ds }), undefined);
  }

  /** Rebuild every persisted dataset into DuckDB. Called once at app boot. */
  async rehydrate(): Promise<void> {
    const all = await this.guard<[string, StoredDataset][]>(entries<string, StoredDataset>(), []);
    for (const [key, stored] of all) {
      if (!String(key).startsWith(KEY_PREFIX)) continue;
      const bytes = new Uint8Array(await stored.blob.arrayBuffer());
      const meta = await this.load(stored.meta.fileName, bytes);
      // load() always starts roles at 'none', so re-apply what the user set.
      // applyRole, not setRole: the store already holds these, no write-back needed.
      for (const c of stored.meta.columns) {
        if (c.role !== 'none') this.applyRole(meta.id, c.name, c.role);
      }
    }
  }
}
