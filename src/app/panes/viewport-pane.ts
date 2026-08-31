import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  ElementRef,
  DestroyRef,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Chart, registerables } from 'chart.js';
import { ViewportService } from '../core/viewport';
import { DuckService } from '../core/duck';
import { VaultService } from '../core/vault';
import { SamplesService } from '../core/samples';
import { McpService } from '../core/mcp';
import { SettingsService } from '../core/settings';
import { sanitizeTableName } from '../core/schema';
import type { SampleEntry } from '../core/samples';
import { summarise, formatNumber, labelColumn, numericColumn } from '../core/insight';
import type { ChartKind, ChartSpec, QueryResult, SavedView } from '../core/models';

/** 'table' is a viewport mode, not a Chart.js type. */
type DrawableKind = Exclude<ChartKind, 'table'>;

Chart.register(...registerables);

interface Suggestion {
  q: string;
  needs: string[];
  sql: string;
  x: string;
  y: string;
}

/** Answerable questions, each naming the tables it needs. */
const SUGGESTIONS: Suggestion[] = [
  {
    q: 'Chart workout-day spending by category',
    needs: ['transactions', 'workouts'],
    sql: `SELECT t.category, round(sum(t.amt),2) AS spend
          FROM transactions t JOIN workouts w USING (day)
          GROUP BY t.category ORDER BY spend DESC`,
    x: 'category',
    y: 'spend',
  },
  {
    q: 'Compare spending against how well you slept',
    needs: ['transactions', 'sleep'],
    sql: `SELECT s.quality, round(sum(t.amt),2) AS spend
          FROM sleep s JOIN transactions t USING (day)
          GROUP BY s.quality ORDER BY spend DESC`,
    x: 'quality',
    y: 'spend',
  },
  {
    q: 'Which apps you use most on low-step days',
    needs: ['screen_time', 'steps'],
    sql: `SELECT sc.app, round(sum(sc.minutes)) AS minutes
          FROM screen_time sc JOIN steps st USING (day)
          WHERE st.steps < 5000
          GROUP BY sc.app ORDER BY minutes DESC`,
    x: 'app',
    y: 'minutes',
  },
  {
    q: 'Your top merchants by spend',
    needs: ['transactions'],
    sql: `SELECT merchant, round(sum(amt),2) AS spend
          FROM transactions GROUP BY merchant ORDER BY spend DESC LIMIT 8`,
    x: 'merchant',
    y: 'spend',
  },
];

/** Questions that need more than one file — the point of the product. */
const EXAMPLES = [
  { q: 'Which spending category is highest on days I worked out? Chart it.', needs: ['transactions.csv', 'workouts.csv'] },
  { q: 'Did I sleep worse in months where I spent more?', needs: ['sleep.csv', 'transactions.csv'] },
  { q: 'Which apps do I use most on days I take fewer than 5,000 steps?', needs: ['screen-time.csv', 'steps.csv'] },
];

@Component({
  selector: 'app-viewport-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <h2 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Viewport</h2>

    @if (error()) {
      <p class="mt-3 rounded bg-red-950 px-2 py-1 text-xs text-red-300">{{ error() }}</p>
    }

    <!-- Nothing loaded: say plainly what to do, and what each question needs. -->
    @if (empty()) {
      <div class="mt-4 rounded-lg border border-dashed border-neutral-800 p-6">
        <h3 class="text-base font-semibold text-neutral-100">No data loaded yet</h3>
        <p class="mt-1 max-w-prose text-sm text-neutral-400">
          An agent can connect, but it has nothing to answer from. Load the sample data or
          drop your own CSV or JSON on the left, then ask a question.
        </p>
        <button
          class="mt-3 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          (click)="loadStarter()"
          [disabled]="loading()"
        >
          {{ loading() ? 'Loading…' : 'Load sample data' }}
        </button>

        <div class="mt-5 rounded border border-neutral-800 bg-neutral-900/60 p-3">
          <p class="text-[11px] leading-snug text-neutral-400">
            Asking an agent a data question cold usually gets you "please upload your
            data" — it has no reason to look for tools. Give it this instead:
          </p>
          <p class="mt-2 font-mono text-[11px] leading-snug break-words text-neutral-300">
            {{ agentPrompt }}
          </p>
          <button
            type="button"
            class="mt-2 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-emerald-700 hover:text-emerald-300"
            (click)="copyPrompt()"
          >
            {{ copied() ? 'Copied' : 'Copy prompt for your agent' }}
          </button>
        </div>

        <p class="mt-6 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Then try asking
        </p>
        <ul class="mt-2 space-y-2">
          @for (e of examples; track e.q) {
            <li class="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2">
              <p class="text-sm text-neutral-300">{{ e.q }}</p>
              <p class="mt-1 text-[11px] text-neutral-500">
                needs
                @for (n of e.needs; track n) {
                  <span
                    class="font-mono"
                    [class]="hasFile(n) ? 'text-emerald-400' : 'text-neutral-500'"
                    >{{ n }}</span
                  >
                  <span class="text-neutral-700">&nbsp;</span>
                }
              </p>
            </li>
          }
        </ul>
      </div>
    }

    <!-- Created only when there is a chart. Hiding it instead let Chart.js
         measure a zero-sized canvas on first render and lock the bars to 0. -->
    @if (showChart()) {
      <div class="mt-3">
        <div class="relative h-80 w-full">
          <canvas #canvas></canvas>
        </div>
      </div>
    }

    @if (viewport.result(); as result) {
      <div class="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          (click)="back()"
        >
          <span aria-hidden="true">&larr;</span>
          {{ empty() ? 'Clear result' : 'Back to questions' }}
        </button>
        @if (viewport.sql() && !naming()) {
          <button
            class="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-emerald-700 hover:text-emerald-300"
            (click)="startNaming()"
          >
            {{ pinned() ? 'Pinned ✓' : 'Pin this view' }}
          </button>
        }
      </div>

      @if (insight(); as ins) {
        <p class="mt-3 rounded border border-emerald-800/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
          {{ ins.text }}
        </p>
      }

      @if (viewport.note()) {
        <details class="mt-2">
          <summary class="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">
            How this was worked out
          </summary>
          <p class="mt-1 text-[11px] leading-snug text-neutral-400">{{ viewport.note() }}</p>
          @if (viewport.sql()) {
            <pre class="mt-1 overflow-x-auto rounded bg-neutral-900 p-2 font-mono text-[10px] text-neutral-400">{{ viewport.sql() }}</pre>
          }
        </details>
      }

      <div class="mt-3 overflow-x-auto rounded border border-neutral-800">
        <table class="w-full text-left text-xs">
          <thead class="bg-neutral-900 text-neutral-400">
            <tr>
              @for (c of result.columns; track c) {
                <th class="px-2 py-1 font-medium whitespace-nowrap">{{ c }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of result.rows; track $index) {
              <tr
                class="border-t border-neutral-800/60"
                [class]="$index === insight()?.topIndex ? 'bg-emerald-950/30' : ''"
              >
                @for (c of result.columns; track c) {
                  <td class="px-2 py-1 whitespace-nowrap tabular-nums text-neutral-300">
                    {{ cell(row[c], c) }}
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="mt-1 flex items-center justify-between gap-2">
        <p class="text-[11px] text-neutral-500">
          {{ result.rows.length | number }} rows shown
          @if (result.truncated) {
            <span class="text-amber-400">· capped at 1,000</span>
          }
        </p>
      </div>

      @if (naming()) {
        <div class="mt-2 flex items-center gap-2">
          <label class="sr-only" for="view-name">Name for this view</label>
          <input
            #nameInput
            id="view-name"
            class="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-emerald-600"
            [value]="viewName()"
            (input)="viewName.set($any($event.target).value)"
            (keydown.enter)="confirmPin()"
            (keydown.escape)="naming.set(false)"
            placeholder="Name this view"
          />
          <button
            class="shrink-0 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            (click)="confirmPin()"
            [disabled]="!viewName().trim()"
          >
            Save
          </button>
          <button
            class="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200"
            (click)="naming.set(false)"
          >
            Cancel
          </button>
        </div>
      }
    } @else if (!empty()) {
      <div class="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-4">
        <p class="text-sm text-neutral-200">
          <span class="font-semibold text-emerald-400">Ready.</span>
          Ask your agent a question — or run one of these yourself.
        </p>
        <ul class="mt-3 space-y-1.5">
          @for (s of ready(); track s.q) {
            <li>
              <button
                type="button"
                class="w-full rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-left text-sm text-neutral-300 hover:border-emerald-700 hover:text-neutral-100 disabled:opacity-50"
                (click)="ask(s)"
                [disabled]="asking()"
              >
                {{ s.q }}
              </button>
            </li>
          } @empty {
            <li class="text-xs text-neutral-500">
              Load a second dataset to unlock cross-dataset questions.
            </li>
          }
        </ul>
        @if (locked().length) {
          <p class="mt-4 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
            Load one more dataset to unlock
          </p>
          <ul class="mt-1.5 space-y-1.5">
            @for (l of locked(); track l.q) {
              <li
                class="flex items-center justify-between gap-3 rounded border border-neutral-800/70 px-3 py-2"
              >
                <span class="text-sm text-neutral-500">{{ l.q }}</span>
                <button
                  type="button"
                  class="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] whitespace-nowrap text-neutral-300 hover:border-emerald-700 hover:text-emerald-300 disabled:opacity-50"
                  (click)="unlock(l)"
                  [disabled]="loading()"
                >
                  Load {{ l.missingLabel }}
                </button>
              </li>
            }
          </ul>
        }
      </div>
    }

    @if (viewport.views().length) {
      <div class="mt-6">
        <h3 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Saved views</h3>
        <div class="mt-2 flex flex-wrap gap-2">
          @for (v of viewport.views(); track v.id) {
            <div class="rounded border border-neutral-800 px-2 py-1 text-xs">
              <span class="text-neutral-200">{{ v.name }}</span>
              <button class="ml-2 text-emerald-400 hover:underline" (click)="run(v)">Run</button>
              <button class="ml-2 text-neutral-500 hover:text-red-400" (click)="remove(v.id)">
                Remove
              </button>
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class ViewportPane {
  readonly viewport = inject(ViewportService);
  private readonly duck = inject(DuckService);
  private readonly vault = inject(VaultService);
  private readonly library = inject(SamplesService);
  private readonly mcp = inject(McpService);
  private readonly settings = inject(SettingsService);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  readonly error = signal('');
  readonly loading = signal(false);
  readonly pinned = signal(false);
  readonly naming = signal(false);
  readonly viewName = signal('');
  readonly examples = EXAMPLES;
  readonly asking = signal(false);
  readonly copied = signal(false);

  /** Names the tools explicitly — the difference between an agent using SiftIO and
   *  telling the user to upload a CSV. */
  readonly agentPrompt =
    'Open ' +
    'https://siftio.marouane-kouskous.workers.dev' +
    ' and list its WebMCP tools. Then call load_sample for transactions.csv and ' +
    'workouts.csv, and use render_chart to answer: which spending category is highest ' +
    'on days I worked out?';

  async copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.agentPrompt);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.error.set('Could not copy — select the text above instead.');
    }
  }

  private readonly tables = computed(() => new Set(this.vault.datasets().map((d) => d.table)));
  /** Suggestions whose tables are all loaded. */
  readonly ready = computed(() =>
    SUGGESTIONS.filter((s) => s.needs.every((n) => this.tables().has(n))),
  );
  /** Bundled samples keyed by the table name they produce once loaded. */
  private readonly sampleByTable = computed(() => {
    const m = new Map<string, SampleEntry>();
    for (const s of this.library.samples()) m.set(sanitizeTableName(s.file), s);
    return m;
  });

  /**
   * Suggestions one dataset short, named by the sample a person can click —
   * not by the SQL table name, which appears nowhere in the library.
   */
  readonly locked = computed(() =>
    SUGGESTIONS.filter((s) => !s.needs.every((n) => this.tables().has(n))).map((s) => {
      const missing = s.needs.filter((n) => !this.tables().has(n));
      const samples = missing.map((n) => this.sampleByTable().get(n)).filter((x) => !!x);
      return {
        q: s.q,
        files: samples.map((x) => x!.file),
        missingLabel: samples.length
          ? samples.map((x) => x!.title).join(' + ')
          : missing.join(' + '),
      };
    }),
  );

  readonly empty = computed(() => this.vault.datasets().length === 0);
  readonly insight = computed(() => {
    const r = this.viewport.result();
    if (!r) return null;
    const c = this.viewport.chart();
    return summarise(r, { x: c?.x, y: c?.y }, this.settings.symbol());
  });

  private chart?: Chart;

  readonly showChart = () => {
    const spec = this.viewport.chart();
    return !!spec && spec.kind !== 'table';
  };

  private destroyed = false;

  constructor() {
    effect(() => {
      const spec = this.viewport.chart();
      const result = this.viewport.result();
      const top = this.insight()?.topIndex;
      const el = this.canvas()?.nativeElement;

      this.pinned.set(false);
      this.naming.set(false);
      this.chart?.destroy();
      this.chart = undefined;
      if (!el || !spec || !result?.rows.length) return;
      // Narrow before the async hop — TypeScript cannot carry it into the callback.
      const kind: DrawableKind | 'table' = spec.kind;
      if (kind === 'table') return;

      this.chart = draw(el, { ...spec, kind }, result, top);
      // The wrapper's `hidden` class is removed in this same change-detection
      // pass, so the canvas measures zero right now and the bars come out
      // squashed into a corner. Resize once layout has settled. setTimeout, not
      // requestAnimationFrame: rAF never fires in a background tab, which left
      // the chart undrawn entirely.
      setTimeout(() => {
        if (!this.destroyed) this.chart?.resize();
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.chart?.destroy();
    });
  }

  hasFile(file: string): boolean {
    return this.vault.datasets().some((d) => d.fileName === file);
  }

  /** Columns shown as money: the charted measure, else any fractional number. */
  private isMoney(column: string): boolean {
    if (!this.settings.symbol()) return false;
    const r = this.viewport.result();
    if (!r) return false;
    const y = numericColumn(r, this.viewport.chart()?.y);
    if (y) return column === y;
    return r.rows.some((row) => typeof row[column] === 'number' && !Number.isInteger(row[column]));
  }

  cell(v: unknown, column: string): string {
    if (typeof v !== 'number') return String(v ?? '');
    return formatNumber(v, this.isMoney(column) ? this.settings.symbol() : '');
  }

  /** Load whatever a locked suggestion is missing. */
  async unlock(l: { files: string[] }): Promise<void> {
    if (!l.files.length) return;
    this.loading.set(true);
    this.error.set('');
    try {
      for (const f of l.files) await this.library.ingest(f);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Return to the Ready panel; running a view or a question is not a one-way door. */
  back(): void {
    this.viewport.clear();
    this.error.set('');
  }

  /** Run a suggestion through the real tool, so it lands in the audit like any call. */
  async ask(s: Suggestion): Promise<void> {
    this.asking.set(true);
    this.error.set('');
    try {
      const out = (await this.mcp.invoke('render_chart', {
        sql: s.sql,
        kind: 'bar',
        x: s.x,
        y: s.y,
      })) as { error?: string };
      if (out.error) this.error.set(out.error);
    } finally {
      this.asking.set(false);
    }
  }

  async loadStarter(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      for (const f of ['transactions.csv', 'workouts.csv', 'sleep.csv']) {
        await this.library.ingest(f);
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Suggested name, e.g. "spend by category" — editable, never imposed. */
  private suggestedName(): string {
    const r = this.viewport.result();
    if (!r) return 'Saved view';
    const c = this.viewport.chart();
    const y = numericColumn(r, c?.y);
    const x = labelColumn(r, c?.x, y);
    return x && y ? `${y} by ${x}` : 'Saved view';
  }

  startNaming(): void {
    this.viewName.set(this.suggestedName());
    this.naming.set(true);
    // setTimeout, not queueMicrotask: the input is rendered by the change
    // detection pass this click triggers, so a microtask still runs too early.
    setTimeout(() => {
      const el = this.nameInput()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  async confirmPin(): Promise<void> {
    const sql = this.viewport.sql();
    const name = this.viewName().trim();
    if (!sql || !name) return;
    const spec = this.viewport.chart() ?? { kind: 'table' as const };
    await this.viewport.saveView(name, sql, spec);
    this.naming.set(false);
    this.pinned.set(true);
  }

  async run(view: SavedView): Promise<void> {
    this.error.set('');
    try {
      this.viewport.show(await this.duck.query(view.sql), view.chart, `Re-ran "${view.name}".`, view.sql);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async remove(id: string): Promise<void> {
    await this.viewport.removeView(id);
  }
}

function draw(
  el: HTMLCanvasElement,
  spec: ChartSpec & { kind: DrawableKind },
  result: QueryResult,
  topIndex?: number,
  symbol = '',
): Chart {
  const y = numericColumn(result, spec.y) ?? result.columns[1] ?? result.columns[0];
  const x = labelColumn(result, spec.x, y) ?? result.columns[0];

  // The leading bar is emphasised so the chart says the same thing as the insight.
  const base = 'rgba(52, 211, 153, 0.45)';
  const lead = 'rgba(52, 211, 153, 0.95)';
  const colors = result.rows.map((_, i) => (i === topIndex ? lead : base));

  return new Chart(el, {
    type: spec.kind,
    data: {
      labels: result.rows.map((r) => String(r[x])),
      datasets: [
        {
          label: y,
          data: result.rows.map((r) => Number(r[y])),
          backgroundColor: spec.kind === 'line' ? 'rgba(52, 211, 153, 0.15)' : colors,
          borderColor: 'rgb(52, 211, 153)',
          borderWidth: spec.kind === 'line' ? 2 : 1,
          fill: spec.kind === 'line',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${y}: ${formatNumber(Number(ctx.parsed.y ?? ctx.parsed), symbol)}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: x, color: '#8a908c', font: { size: 11 } },
          ticks: { color: '#737373', maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: y, color: '#8a908c', font: { size: 11 } },
          ticks: { color: '#737373', callback: (v) => formatNumber(Number(v), symbol) },
          grid: { color: 'rgba(115,115,115,0.15)' },
        },
      },
    },
  });
}
