import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import { AuditService } from '../core/audit';
import type { AuditEntry } from '../core/models';
import { VaultService } from '../core/vault';
import { McpService } from '../core/mcp';
import { MockAgent, type ToolExample } from './mock-agent';
import { describeCall } from '../core/insight';
import { BUILD_STAMP } from '../core/build-stamp';

@Component({
  selector: 'app-activity-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, DatePipe, MockAgent],
  template: `
    <h2 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Agent Activity</h2>

    <!-- The whole pitch in one glance. -->
    <div class="mt-3 rounded border border-neutral-800 p-3">
      <div class="text-2xl font-semibold tabular-nums text-neutral-100">
        {{ vault.rowsLocal() | number }}
      </div>
      <div class="text-[11px] text-neutral-500">rows held locally</div>
      <div class="mt-2 text-2xl font-semibold tabular-nums text-emerald-400">
        {{ audit.rowsSeen() | number }}
      </div>
      <div class="text-[11px] text-neutral-500">rows seen by the agent</div>
    </div>

    <dl class="mt-3 space-y-1 text-xs">
      <div class="flex items-center justify-between gap-2">
        <dt class="text-neutral-400">Tools published</dt>
        <dd [class]="mcp.available() ? 'text-emerald-400' : 'text-neutral-500'">
          {{ mcp.available() ? mcp.toolNames().length + ' tools' : 'not supported here' }}
        </dd>
      </div>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-neutral-400">Agent connected</dt>
        <dd
          class="flex items-center gap-1.5"
          [class]="mcp.agentConnected() ? 'text-emerald-400' : 'text-neutral-500'"
        >
          <span
            class="inline-block h-2 w-2 rounded-full"
            [class]="mcp.agentConnected() ? 'bg-emerald-400' : 'bg-neutral-700'"
          ></span>
          {{ mcp.agentConnected() ? 'yes' : 'not yet' }}
        </dd>
      </div>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-neutral-400">Last tool call</dt>
        <dd class="truncate text-neutral-300">
          @if (audit.lastCall(); as last) {
            <span class="font-mono text-[11px]">{{ last.tool }}</span>
            <span class="text-neutral-600">· {{ last.at | date: 'HH:mm:ss' }}</span>
          } @else {
            <span class="text-neutral-500">none</span>
          }
        </dd>
      </div>
    </dl>

    @if (!mcp.available()) {
      <p class="mt-2 text-[11px] leading-snug text-neutral-500">
        Open <span class="font-mono">chrome://flags/#enable-webmcp-testing</span>, set it to
        Enabled and restart Chrome — or open this page in ChatGPT's browser.
      </p>
    } @else if (!mcp.agentConnected()) {
      <p class="mt-2 text-[11px] leading-snug text-neutral-500">
        The tools are live. Ask an agent a question in this browser and this will flip to
        connected on its first call.
      </p>
    }

    <div class="mt-3">
      <p class="text-[11px] text-neutral-500">{{ mcp.toolNames().length }} tools registered</p>
      <ul class="mt-1 flex flex-wrap gap-1">
        @for (t of mcp.toolNames(); track t) {
          <li
            class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px]"
            [class]="isDatasetTool(t) ? 'text-emerald-300' : 'text-neutral-400'"
          >
            {{ t }}
          </li>
        }
      </ul>
    </div>

    <div class="mt-4">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">Audit</h3>
        @if (audit.callCount()) {
          <button class="text-[11px] text-neutral-500 hover:text-neutral-300" (click)="audit.clear()">
            Clear
          </button>
        }
      </div>
      <ul class="mt-2 space-y-1">
        @for (e of audit.entries(); track e.id) {
          <li class="rounded border border-neutral-800 px-2 py-1 text-[11px]">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate font-mono" [class]="e.error ? 'text-red-400' : 'text-neutral-200'">
                {{ e.tool }}
              </span>
              <span class="shrink-0 text-neutral-600">{{ e.at | date: 'HH:mm:ss' }}</span>
            </div>
            @if (e.error) {
              <p class="mt-0.5 text-red-400">{{ e.error }}</p>
            } @else {
              <p class="mt-0.5 text-neutral-400">{{ plain(e) }}</p>
              <p class="text-neutral-600">{{ e.ms | number: '1.0-0' }} ms</p>
            }
            <details class="mt-0.5">
              <summary class="cursor-pointer text-neutral-600">Exactly what it sent</summary>
              <pre class="mt-1 break-all whitespace-pre-wrap text-neutral-500">{{ args(e.args) }}</pre>
            </details>
          </li>
        } @empty {
          <li class="text-[11px] text-neutral-600">No tool calls yet.</li>
        }
      </ul>
    </div>

    <div class="mt-4 border-t border-neutral-800 pt-3">
      <div class="flex items-center justify-between gap-2">
        <button
          class="text-[11px] text-neutral-500 hover:text-neutral-300"
          (click)="showMock.set(!showMock())"
        >
          {{ showMock() ? 'Hide' : 'Dev: invoke a tool' }}
        </button>
        <button
          type="button"
          class="grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] leading-none transition-colors"
          [class]="
            showMockHelp()
              ? 'border-emerald-600 text-emerald-400'
              : 'border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300'
          "
          (click)="showMockHelp.set(!showMockHelp())"
          [attr.aria-expanded]="showMockHelp()"
          aria-label="What is the tool invoker?"
          title="What is the tool invoker?"
        >
          ?
        </button>
      </div>

      @if (showMockHelp()) {
        <div class="mt-2 rounded border border-neutral-800 bg-neutral-900/70 p-2">
          <p class="text-[11px] leading-snug text-neutral-400">
            Calls any registered tool yourself, with hand-written JSON arguments — no agent
            needed.
          </p>
          <ul class="mt-2 space-y-1 text-[11px] leading-snug text-neutral-500">
            <li>
              <span class="text-neutral-300">Same code path an agent uses</span>, so calls
              show up in the audit above exactly as an agent's would.
            </li>
            <li>
              Useful for checking a tool before asking an agent, and as a fallback when no
              agent is connected.
            </li>
          </ul>

          <p class="mt-3 text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
            Examples — click to load
          </p>
          <ul class="mt-1 space-y-1">
            @for (ex of examples; track ex.label) {
              <li>
                <button
                  type="button"
                  class="w-full rounded border border-neutral-800 px-2 py-1 text-left hover:border-neutral-600 hover:bg-neutral-800/60"
                  (click)="useExample(ex)"
                >
                  <span class="block text-[11px] text-neutral-300">{{ ex.label }}</span>
                  <span class="block font-mono text-[10px] text-emerald-400">{{ ex.tool }}</span>
                  <span class="block font-mono text-[10px] break-all text-neutral-500">{{ ex.args }}</span>
                </button>
              </li>
            }
          </ul>
          <p class="mt-2 text-[11px] leading-snug text-neutral-500">
            The last two need <span class="font-mono">transactions.csv</span> and
            <span class="font-mono">workouts.csv</span> loaded — the second example does that.
          </p>
        </div>
      }

      @if (showMock()) {
        <app-mock-agent [preset]="preset()" />
      }
      <details class="mt-3">
        <summary class="cursor-pointer text-[11px] text-neutral-600 hover:text-neutral-400">
          Diagnostics
        </summary>
        <dl class="mt-2 space-y-1 text-[10px]">
          <div class="flex justify-between gap-2">
            <dt class="text-neutral-500">Build</dt>
            <dd class="font-mono text-neutral-500">{{ buildStamp }}</dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-neutral-500">Tool removal</dt>
            <dd [class]="mcp.canUnregister() ? 'text-neutral-500' : 'text-amber-500/80'">
              {{ mcp.canUnregister() ? 'supported' : 'unsupported' }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-neutral-500">Agent calls</dt>
            <dd class="text-neutral-500">{{ audit.agentCalls().length }}</dd>
          </div>
        </dl>
        @if (mcp.available() && !mcp.canUnregister()) {
          <p class="mt-2 text-[10px] leading-snug text-neutral-500">
            This browser has no <span class="font-mono">unregisterTool</span>, so an ejected
            dataset's tools stay listed until you reload. They report that the dataset is gone.
          </p>
        }
      </details>
    </div>
  `,
})
export class ActivityPane {
  readonly audit = inject(AuditService);
  readonly vault = inject(VaultService);
  readonly mcp = inject(McpService);
  readonly showMock = signal(false);
  readonly showMockHelp = signal(false);
  readonly preset = signal<ToolExample | null>(null);

  readonly examples: (ToolExample & { label: string })[] = [
    { label: 'See what is loaded', tool: 'list_datasets', args: '{}' },
    {
      label: 'Load a demo dataset',
      tool: 'load_sample',
      args: '{ "file": "transactions.csv" }',
    },
    {
      label: 'Total spending by category',
      tool: 'query_transactions',
      args: '{ "groupBy": "category", "aggregate": { "fn": "sum", "column": "amt" } }',
    },
    {
      label: 'Spending on days you worked out, charted',
      tool: 'render_chart',
      args:
        '{ "sql": "SELECT t.category, round(sum(t.amt),2) AS spend FROM transactions t ' +
        'JOIN workouts w USING (day) GROUP BY t.category ORDER BY spend DESC", ' +
        '"kind": "bar", "x": "category", "y": "spend" }',
    },
  ];

  useExample(ex: ToolExample): void {
    this.preset.set({ tool: ex.tool, args: ex.args });
    this.showMock.set(true);
  }
  readonly buildStamp = BUILD_STAMP;

  plain(entry: AuditEntry): string {
    return describeCall(entry);
  }

  isDatasetTool(name: string): boolean {
    return name.startsWith('query_') || name.startsWith('describe_');
  }

  args(value: unknown): string {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch {
      return '[unserialisable]';
    }
  }
}
