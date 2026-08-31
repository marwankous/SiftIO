import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { McpService } from '../core/mcp';

export interface ToolExample {
  tool: string;
  args: string;
}

/**
 * Invokes tools directly, bypassing the browser's agent. Goes through the same
 * wrapped `execute` a real agent hits, so calls appear in the audit feed
 * identically — which is what makes it a usable fallback when the Chrome flag
 * is unavailable.
 */
@Component({
  selector: 'app-mock-agent',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mt-2 space-y-2">
      <select
        #sel
        class="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-1 font-mono text-[11px] text-neutral-200"
        (change)="tool.set($any($event.target).value)"
        aria-label="Tool to invoke"
      >
        <!-- [selected] on the option, not [value] on the select: the select's value
             is applied before its options exist, so the shown tool would not match
             the one that actually runs. -->
        @for (t of mcp.toolNames(); track t) {
          <option [value]="t" [selected]="t === tool()">{{ t }}</option>
        }
      </select>
      <textarea
        rows="3"
        class="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-1 font-mono text-[11px] text-neutral-200"
        [value]="argsText()"
        (input)="argsText.set($any($event.target).value)"
        aria-label="Tool arguments as JSON"
      ></textarea>
      <button
        class="w-full rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        (click)="run()"
        [disabled]="running()"
      >
        {{ running() ? 'Running…' : 'Run' }}
      </button>
      @if (output()) {
        <pre
          class="max-h-48 overflow-auto rounded bg-neutral-900 p-2 text-[10px] break-all whitespace-pre-wrap text-neutral-400"
          >{{ output() }}</pre
        >
      }
    </div>
  `,
})
export class MockAgent {
  readonly mcp = inject(McpService);
  /** Set by an example in the help panel; fills the form ready to run. */
  readonly preset = input<ToolExample | null>(null);
  private readonly selectEl = viewChild<ElementRef<HTMLSelectElement>>('sel');
  readonly tool = signal('list_datasets');
  readonly argsText = signal('{}');
  readonly output = signal('');
  readonly running = signal(false);

  constructor() {
    // Keep the shown option in step with the tool that will actually run.
    // [selected] alone does not move an already-rendered select, which left the
    // dropdown naming a different tool from the one being invoked.
    effect(() => {
      const t = this.tool();
      this.mcp.toolNames(); // re-run when the option list changes
      queueMicrotask(() => {
        const el = this.selectEl()?.nativeElement;
        if (el && el.value !== t) el.value = t;
      });
    });

    // An example was picked: load it into the form.
    effect(() => {
      const p = this.preset();
      if (!p) return;
      this.tool.set(p.tool);
      this.argsText.set(p.args);
      this.output.set('');
    });

    // Keep the selection valid as datasets come and go.
    effect(() => {
      const names = this.mcp.toolNames();
      if (names.length && !names.includes(this.tool()) && !this.preset()) {
        this.tool.set(names[0]);
      }
    });
  }

  async run(): Promise<void> {
    this.running.set(true);
    try {
      const args = JSON.parse(this.argsText() || '{}');
      this.output.set(JSON.stringify(await this.mcp.invoke(this.tool(), args), null, 2));
    } catch (e) {
      this.output.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.running.set(false);
    }
  }
}
