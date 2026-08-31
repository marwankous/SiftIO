import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { VaultService } from '../core/vault';
import { SamplesService, type SampleEntry } from '../core/samples';
import { SettingsService, CURRENCIES, type Currency } from '../core/settings';
import { ColumnMapper } from './column-mapper';

/** The three that join on `day` — enough to demo a cross-dataset question. */
const STARTER = ['transactions.csv', 'workouts.csv', 'sleep.csv'];

@Component({
  selector: 'app-datasets-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ColumnMapper],
  template: `
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Datasets</h2>
      <div class="flex items-center gap-2">
        <label class="sr-only" for="currency">Currency shown on amounts</label>
        <select
          id="currency"
          class="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-400"
          (change)="setCurrency($any($event.target).value)"
          title="Currency shown on amounts"
        >
          @for (c of currencies; track c) {
            <option [value]="c" [selected]="c === settings.currency()">
              {{ c === 'None' ? 'no symbol' : c }}
            </option>
          }
        </select>
      <button
        type="button"
        class="grid h-4 w-4 place-items-center rounded-full border text-[10px] leading-none transition-colors"
        [class]="
          showHelp()
            ? 'border-emerald-600 text-emerald-400'
            : 'border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300'
        "
        (click)="showHelp.set(!showHelp())"
        [attr.aria-expanded]="showHelp()"
        aria-label="What do column labels do?"
        title="What do column labels do?"
      >
        ?
      </button>
      </div>
    </div>

    <!-- Written once for the whole pane, not repeated under every dataset. -->
    @if (showHelp()) {
      <div class="mt-2 rounded border border-neutral-800 bg-neutral-900/70 p-2">
        <p class="text-[11px] leading-snug text-neutral-400">
          Under each dataset, <span class="text-neutral-200">Labels</span> says what a column
          means. A label is not a caption — it changes the tool the agent receives.
        </p>
        <dl class="mt-2 space-y-1.5 text-[11px] leading-snug">
          @for (doc of labelDocs; track doc.role) {
            <div class="flex gap-2">
              <dt class="w-20 shrink-0 font-mono text-emerald-400">{{ doc.role }}</dt>
              <dd class="text-neutral-400">{{ doc.effect }}</dd>
            </div>
          }
        </dl>
        <p class="mt-2 text-[11px] leading-snug text-neutral-500">
          Leave a column as <span class="font-mono">none</span> and it still works — the tool
          is just less specific.
          <a
            class="text-emerald-400 hover:underline"
            href="https://github.com/marwankous/SiftIO/blob/main/docs/guide.md"
            target="_blank"
            rel="noreferrer"
            >Full guide</a
          >
        </p>
      </div>
    }

    <label
      class="mt-3 block cursor-pointer rounded border border-dashed px-3 py-6 text-center text-xs transition-colors"
      [class]="
        dragging()
          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
          : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
      "
      (dragover)="onDragOver($event)"
      (dragleave)="dragging.set(false)"
      (drop)="onDrop($event)"
    >
      <input
        type="file"
        class="hidden"
        accept=".csv,.json"
        multiple
        (change)="onPick($event)"
      />
      Drop a CSV or JSON export here
      <span class="mt-1 block text-[10px] text-neutral-600">or click to browse</span>
    </label>

    <button
      class="mt-2 w-full rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
      (click)="loadStarter()"
      [disabled]="busy()"
    >
      Load sample data
    </button>

    @if (samples().length) {
      <details class="mt-2">
        <summary class="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">
          Sample library ({{ samples().length }})
        </summary>
        <ul class="mt-2 space-y-1">
          @for (s of samples(); track s.file) {
            <li class="rounded border border-neutral-800 px-2 py-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-xs text-neutral-200">{{ s.title }}</span>
                <button
                  class="shrink-0 text-[11px] text-emerald-400 hover:underline disabled:text-neutral-600 disabled:no-underline"
                  (click)="loadOne(s)"
                  [disabled]="busy()"
                >
                  Load
                </button>
              </div>
              <p class="text-[10px] leading-snug text-neutral-500">{{ s.note }}</p>
              <p class="text-[10px] text-neutral-600">
                {{ s.rows | number }} rows · <span class="font-mono">{{ s.file }}</span>
              </p>
            </li>
          }
        </ul>
        <button
          class="mt-2 w-full rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800"
          (click)="loadAll()"
          [disabled]="busy()"
        >
          Load all {{ samples().length }}
        </button>
      </details>
    }

    @if (busy()) {
      <p class="mt-2 text-xs text-neutral-400">{{ busyLabel() }}</p>
    }
    @if (error()) {
      <p class="mt-2 rounded bg-red-950 px-2 py-1 text-xs text-red-300">{{ error() }}</p>
    }
    @if (!vault.persistent()) {
      <p class="mt-2 rounded bg-amber-950/60 px-2 py-1 text-[11px] leading-snug text-amber-300">
        Browser storage is unavailable, so datasets work now but will not survive a reload.
      </p>
    }

    <ul class="mt-4 space-y-3">
      @for (ds of vault.datasets(); track ds.id) {
        <li class="rounded border border-neutral-800 p-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm text-neutral-200" [title]="ds.fileName">
                {{ ds.fileName }}
              </p>
              <p class="text-[11px] text-neutral-500">
                {{ ds.rowCount | number }} rows · {{ ds.columns.length }} columns ·
                <span class="font-mono">{{ ds.table }}</span>
              </p>
            </div>
            <button
              class="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300"
              (click)="eject(ds.id)"
              [attr.aria-label]="'Eject ' + ds.fileName"
            >
              Eject
            </button>
          </div>
          <app-column-mapper [dataset]="ds" />
        </li>
      } @empty {
        <li class="text-xs text-neutral-600">Nothing loaded yet.</li>
      }
    </ul>
  `,
})
export class DatasetsPane {
  readonly vault = inject(VaultService);
  readonly busy = signal(false);
  readonly busyLabel = signal('');
  readonly error = signal('');
  readonly dragging = signal(false);
  readonly showHelp = signal(false);
  readonly settings = inject(SettingsService);
  readonly currencies = CURRENCIES;

  setCurrency(c: Currency): void {
    this.settings.setCurrency(c);
  }

  /** The single source for what each label actually does. */
  readonly labelDocs = [
    { role: 'amount', effect: 'Becomes the default measure to total or average.' },
    { role: 'timestamp', effect: 'Unlocks since / until date filters that do not otherwise exist.' },
    { role: 'category', effect: 'Leads the list of columns worth grouping by.' },
    { role: 'identifier', effect: 'Excluded from aggregation — a total of ID numbers is meaningless.' },
    { role: 'label', effect: 'Marks the human-readable name for a row.' },
  ];

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    void this.ingestAll(event.dataTransfer?.files ?? null);
  }

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.ingestAll(input.files).then(() => (input.value = ''));
  }

  private readonly library = inject(SamplesService);
  readonly samples = this.library.samples;

  loadStarter(): Promise<void> {
    return this.loadFiles(this.samples().filter((s) => STARTER.includes(s.file)));
  }

  loadOne(sample: SampleEntry): Promise<void> {
    return this.loadFiles([sample]);
  }

  loadAll(): Promise<void> {
    return this.loadFiles(this.samples());
  }

  private async loadFiles(list: SampleEntry[]): Promise<void> {
    if (!list.length) return;
    this.begin('Fetching sample data…');
    try {
      for (const s of list) {
        this.busyLabel.set(`Loading ${s.file} into DuckDB…`);
        await this.library.ingest(s.file);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  private async ingestAll(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    // The first ingest also downloads the wasm bundle, so say so.
    this.begin('Loading into DuckDB…');
    try {
      for (const f of Array.from(files)) {
        this.busyLabel.set(`Loading ${f.name} into DuckDB…`);
        await this.vault.ingest(f);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy.set(false);
    }
  }

  async eject(id: string): Promise<void> {
    try {
      await this.vault.eject(id);
    } catch (e) {
      this.fail(e);
    }
  }

  private begin(label: string): void {
    this.error.set('');
    this.busyLabel.set(label);
    this.busy.set(true);
  }

  private fail(e: unknown): void {
    this.error.set(e instanceof Error ? e.message : String(e));
  }
}
