import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AuditService } from './audit';

describe('AuditService', () => {
  let svc: AuditService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(AuditService);
  });

  it('starts empty', () => {
    expect(svc.entries()).toEqual([]);
    expect(svc.rowsSeen()).toBe(0);
    expect(svc.callCount()).toBe(0);
  });

  it('records newest first', () => {
    svc.record('a', {}, 1, 5);
    svc.record('b', {}, 2, 5);
    expect(svc.entries().map((e) => e.tool)).toEqual(['b', 'a']);
  });

  it('sums rows seen by the agent', () => {
    svc.record('a', {}, 3, 1);
    svc.record('b', {}, 11, 1);
    expect(svc.rowsSeen()).toBe(14);
  });

  it('counts failed calls but adds no rows', () => {
    svc.record('a', {}, 0, 1, 'boom');
    expect(svc.callCount()).toBe(1);
    expect(svc.rowsSeen()).toBe(0);
    expect(svc.entries()[0].error).toBe('boom');
  });

  it('caps the log at 200 entries', () => {
    for (let i = 0; i < 250; i++) svc.record('t', {}, 1, 1);
    expect(svc.entries().length).toBe(200);
  });

  it('separates agent calls from dev-panel calls', () => {
    svc.record('a', {}, 1, 1, undefined, 'agent');
    svc.record('b', {}, 1, 1, undefined, 'panel');
    expect(svc.agentCalls().map((e) => e.tool)).toEqual(['a']);
    expect(svc.callCount()).toBe(2);
  });

  it('exposes the most recent call', () => {
    svc.record('a', {}, 1, 1);
    svc.record('b', {}, 1, 1);
    expect(svc.lastCall()?.tool).toBe('b');
  });

  it('estimates bytes from the argument payload', () => {
    svc.record('a', { q: 'hello' }, 1, 1);
    expect(svc.entries()[0].bytes).toBeGreaterThan(0);
  });

  it('does not throw on arguments that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => svc.record('a', cyclic, 1, 1)).not.toThrow();
    expect(svc.entries()[0].bytes).toBe(0);
  });

  it('clears the log', () => {
    svc.record('a', {}, 1, 1);
    svc.clear();
    expect(svc.entries()).toEqual([]);
    expect(svc.rowsSeen()).toBe(0);
  });
});
