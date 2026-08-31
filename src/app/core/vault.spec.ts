import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { VaultService } from './vault';
import { DuckService } from './duck';

// In-memory stand-in for idb-keyval so these tests need no IndexedDB.
const store = new Map<string, unknown>();
const idb = { hang: false };
const maybeHang = <T>(value: () => T): Promise<T> =>
  idb.hang ? new Promise<T>(() => {}) : Promise.resolve(value());

vi.mock('idb-keyval', () => ({
  get: (k: string) => maybeHang(() => store.get(k)),
  set: (k: string, v: unknown) => maybeHang(() => void store.set(k, v)),
  del: (k: string) => maybeHang(() => void store.delete(k)),
  entries: () => maybeHang(() => [...store.entries()]),
}));

const duck = {
  init: vi.fn(async () => {}),
  query: vi.fn(),
  // Detach the buffer exactly as duckdb-wasm's registerFileBuffer does, so the
  // persistence path is exercised against a detached ArrayBuffer.
  ingestFile: vi.fn(async (_t: string, _n: string, bytes: Uint8Array) => {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return 3;
  }),
  describeTable: vi.fn(async () => [
    { name: 'id', duckType: 'BIGINT' },
    { name: 'amt', duckType: 'DOUBLE' },
    { name: 'day', duckType: 'DATE' },
  ]),
  dropTable: vi.fn(async () => {}),
};

function fileOf(name: string): File {
  return new File(['id,amt,day\n1,2.5,2025-01-01\n'], name, { type: 'text/csv' });
}

describe('VaultService', () => {
  let svc: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    idb.hang = false;
    TestBed.configureTestingModule({
      providers: [{ provide: DuckService, useValue: duck }],
    });
    svc = TestBed.inject(VaultService);
  });

  it('ingests a file into a sanitised table with an inferred schema', async () => {
    const ds = await svc.ingest(fileOf('My Txns.csv'));
    expect(ds.table).toBe('my_txns');
    expect(ds.rowCount).toBe(3);
    expect(ds.columns.map((c) => c.type)).toEqual(['integer', 'number', 'date']);
    expect(ds.columns.every((c) => c.role === 'none')).toBe(true);
    expect(svc.datasets()).toHaveLength(1);
  });

  it('exposes total local rows across datasets', async () => {
    await svc.ingest(fileOf('a.csv'));
    await svc.ingest(fileOf('b.csv'));
    expect(svc.rowsLocal()).toBe(6);
  });

  it('replaces a dataset when the same file is loaded again', async () => {
    const a = await svc.ingest(fileOf('data.csv'));
    const b = await svc.ingest(fileOf('data.csv'));
    expect(svc.datasets()).toHaveLength(1);
    // Same table name, so the agent's tool names stay stable.
    expect(b.table).toBe(a.table);
    expect(b.table).toBe('data');
  });

  it('still disambiguates two different files whose names collide after sanitising', async () => {
    const a = await svc.ingest(fileOf('my data.csv'));
    const b = await svc.ingest(fileOf('my-data.csv'));
    expect(svc.datasets()).toHaveLength(2);
    expect(a.table).toBe('my_data');
    expect(b.table).toBe('my_data_2');
  });

  it('passes a .json file to DuckDB with a .json virtual name', async () => {
    await svc.ingest(fileOf('notes.json'));
    expect(duck.ingestFile).toHaveBeenCalledWith('notes', 'notes.json', expect.anything());
  });

  it('ejects a dataset and drops its table', async () => {
    const ds = await svc.ingest(fileOf('a.csv'));
    await svc.eject(ds.id);
    expect(svc.datasets()).toHaveLength(0);
    expect(duck.dropTable).toHaveBeenCalledWith(ds.table);
  });

  it('sets a semantic role on a column', async () => {
    const ds = await svc.ingest(fileOf('a.csv'));
    await svc.setRole(ds.id, 'amt', 'amount');
    expect(svc.byId(ds.id)!.columns.find((c) => c.name === 'amt')!.role).toBe('amount');
  });

  it('persists after DuckDB detaches the ingested ArrayBuffer', async () => {
    const ds = await svc.ingest(fileOf('a.csv'));
    const stored = store.get(`ds:${ds.id}`) as { blob: Blob };
    expect(stored.blob).toBeInstanceOf(Blob);
    expect(await stored.blob.text()).toContain('id,amt,day');
  });

  it('still ingests when storage hangs, and flags itself as non-persistent', async () => {
    // A wedged IndexedDB (pending deleteDatabase, blocked storage) never settles.
    idb.hang = true;
    vi.useFakeTimers();
    const pending = svc.ingest(fileOf('a.csv'));
    await vi.advanceTimersByTimeAsync(5000);
    const ds = await pending;
    vi.useRealTimers();

    expect(ds.rowCount).toBe(3);
    expect(svc.datasets()).toHaveLength(1); // usable in DuckDB regardless
    expect(svc.persistent()).toBe(false); // and the UI can say so
  });

  it('applies roles supplied at ingest, and ignores unknown columns', async () => {
    const ds = await svc.ingest(fileOf('a.csv'), {
      amt: 'amount',
      day: 'timestamp',
      nope: 'category', // not a column in this file
    });
    const role = (n: string) => ds.columns.find((c) => c.name === n)?.role;
    expect(role('amt')).toBe('amount');
    expect(role('day')).toBe('timestamp');
    expect(role('id')).toBe('none');
    expect(ds.columns.some((c) => c.name === 'nope')).toBe(false);
  });

  it('persists roles supplied at ingest so they survive a reload', async () => {
    await svc.ingest(fileOf('a.csv'), { amt: 'amount' });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: DuckService, useValue: duck }] });
    const fresh = TestBed.inject(VaultService);
    await fresh.rehydrate();
    expect(fresh.datasets()[0].columns.find((c) => c.name === 'amt')!.role).toBe('amount');
  });

  it('is persistent by default', () => {
    expect(svc.persistent()).toBe(true);
  });

  it('rejects an unsupported file type', async () => {
    await expect(svc.ingest(fileOf('notes.txt'))).rejects.toThrow(/csv or json/i);
  });

  it('rehydrates persisted datasets and restores their roles', async () => {
    const ds = await svc.ingest(fileOf('a.csv'));
    await svc.setRole(ds.id, 'amt', 'amount');

    // A fresh service against the same persisted store, as after a page reload.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: DuckService, useValue: duck }] });
    const fresh = TestBed.inject(VaultService);
    expect(fresh.datasets()).toHaveLength(0);

    await fresh.rehydrate();
    expect(fresh.datasets()).toHaveLength(1);
    expect(fresh.datasets()[0].fileName).toBe('a.csv');
    expect(fresh.datasets()[0].columns.find((c) => c.name === 'amt')!.role).toBe('amount');
  });
});
