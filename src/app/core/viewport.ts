import { Injectable, signal } from '@angular/core';
import { get, set } from 'idb-keyval';
import type { ChartSpec, QueryResult, SavedView } from './models';

const VIEWS_KEY = 'views';

/**
 * What the centre pane is currently showing. Agents write here through
 * `render_chart` and `save_view`, so the human sees what the agent found
 * rather than only reading about it in chat.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly _result = signal<QueryResult | null>(null);
  private readonly _chart = signal<ChartSpec | null>(null);
  /** What produced the current result, in words — the viewport states its assumptions. */
  private readonly _note = signal<string>('');
  private readonly _sql = signal<string>('');
  private readonly _views = signal<SavedView[]>([]);

  readonly result = this._result.asReadonly();
  readonly chart = this._chart.asReadonly();
  readonly note = this._note.asReadonly();
  readonly sql = this._sql.asReadonly();
  readonly views = this._views.asReadonly();

  constructor() {
    void this.restore();
  }

  private async restore(): Promise<void> {
    const saved = await get<SavedView[]>(VIEWS_KEY);
    if (saved?.length) this._views.set(saved);
  }

  show(result: QueryResult, chart: ChartSpec | null = null, note = '', sql = ''): void {
    this._result.set(result);
    this._chart.set(chart);
    this._note.set(note);
    this._sql.set(sql);
  }

  /** Drop the current result, returning the viewport to its starting state. */
  clear(): void {
    this._result.set(null);
    this._chart.set(null);
    this._note.set('');
    this._sql.set('');
  }

  /** Pinned so it survives after the agent disconnects. */
  async saveView(name: string, sql: string, chart: ChartSpec): Promise<SavedView> {
    const view: SavedView = { id: crypto.randomUUID(), name, sql, chart };
    this._views.update((v) => [...v, view]);
    await set(VIEWS_KEY, this._views());
    return view;
  }

  async removeView(id: string): Promise<void> {
    this._views.update((v) => v.filter((x) => x.id !== id));
    await set(VIEWS_KEY, this._views());
  }
}
