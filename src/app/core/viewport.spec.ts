import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ViewportService } from './viewport';
import type { QueryResult } from './models';

const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
  entries: async () => [...store.entries()],
}));

const result: QueryResult = {
  columns: ['a'],
  rows: [{ a: 1 }],
  truncated: false,
};

describe('ViewportService', () => {
  let svc: ViewportService;

  beforeEach(() => {
    store.clear();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ViewportService);
  });

  it('starts empty', () => {
    expect(svc.result()).toBeNull();
    expect(svc.chart()).toBeNull();
    expect(svc.views()).toEqual([]);
  });

  it('shows a result without a chart by default', () => {
    svc.show(result);
    expect(svc.result()).toEqual(result);
    expect(svc.chart()).toBeNull();
  });

  it('clears a previous chart when a later result has none', () => {
    svc.show(result, { kind: 'bar', x: 'a' });
    expect(svc.chart()).not.toBeNull();
    svc.show(result);
    expect(svc.chart()).toBeNull();
  });

  it('clears back to the starting state', () => {
    svc.show(result, { kind: 'bar', x: 'a' }, 'Grouped a by b.', 'SELECT 1');
    svc.clear();
    expect(svc.result()).toBeNull();
    expect(svc.chart()).toBeNull();
    expect(svc.note()).toBe('');
    expect(svc.sql()).toBe('');
  });

  it('keeps saved views when the result is cleared', async () => {
    await svc.saveView('Spend', 'SELECT 1', { kind: 'bar' });
    svc.show(result);
    svc.clear();
    expect(svc.views()).toHaveLength(1);
  });

  it('saves and removes views', async () => {
    const v = await svc.saveView('spend', 'SELECT 1', { kind: 'bar' });
    expect(svc.views()).toHaveLength(1);
    await svc.removeView(v.id);
    expect(svc.views()).toEqual([]);
  });

  it('restores saved views from storage on construction', async () => {
    await svc.saveView('spend', 'SELECT 1', { kind: 'bar' });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fresh = TestBed.inject(ViewportService);
    await Promise.resolve();
    await Promise.resolve();

    expect(fresh.views().map((v) => v.name)).toEqual(['spend']);
  });
});
