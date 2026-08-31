import { Injectable, computed, signal } from '@angular/core';
import type { AuditEntry, CallSource } from './models';

/** Keep the feed bounded; the user is scanning it, not archiving it. */
const CAP = 200;

/**
 * The trust surface. Every tool invocation an agent makes is recorded here and
 * rendered live, so the user can verify the claim that only answers leave.
 */
@Injectable({ providedIn: 'root' })
export class AuditService {
  private readonly _entries = signal<AuditEntry[]>([]);
  readonly entries = this._entries.asReadonly();

  readonly rowsSeen = computed(() => this._entries().reduce((n, e) => n + e.rows, 0));
  readonly callCount = computed(() => this._entries().length);

  /** A real agent has called a tool — the only reliable proof one is connected. */
  readonly agentCalls = computed(() => this._entries().filter((e) => e.source === 'agent'));
  readonly lastCall = computed(() => this._entries()[0] ?? null);

  record(
    tool: string,
    args: unknown,
    rows: number,
    ms: number,
    error?: string,
    source: CallSource = 'agent',
  ): void {
    this._entries.update((list) =>
      [
        {
          id: crypto.randomUUID(),
          tool,
          source,
          args,
          rows,
          bytes: byteLength(args),
          ms,
          at: Date.now(),
          error,
        },
        ...list,
      ].slice(0, CAP),
    );
  }

  clear(): void {
    this._entries.set([]);
  }
}

/** Never let an unserialisable argument break the audit trail. */
function byteLength(args: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(args ?? {})).length;
  } catch {
    return 0;
  }
}
