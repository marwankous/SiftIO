import { Component, ChangeDetectionStrategy, computed, inject, input } from '@angular/core';
import { VaultService } from '../core/vault';
import type { Dataset, SemanticRole } from '../core/models';

const ROLES: SemanticRole[] = [
  'none',
  'amount',
  'timestamp',
  'category',
  'identifier',
  'label',
];

/**
 * Where the human shapes what the agent can *do*. A role assigned here is not a
 * caption: it rewrites the generated tool schema — removing identifiers from the
 * aggregate enum, adding since/until range filters, choosing the default measure.
 */
@Component({
  selector: 'app-column-mapper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="mt-2">
      <summary class="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">
        Labels
        @if (labelled() > 0) {
          <span class="text-emerald-500/80">· {{ labelled() }} set</span>
        }
      </summary>
      <ul class="mt-2 space-y-1">
      @for (col of dataset().columns; track col.name) {
        <li
          class="flex items-center gap-1.5 text-xs"
          role="group"
          [attr.aria-label]="
            col.name +
            ' (' +
            col.type +
            ') is labelled ' +
            (col.role === 'none' ? 'nothing' : col.role)
          "
        >
          <span class="min-w-0 flex-1 truncate" [title]="col.name + ' (' + col.type + ')'">
            <span class="font-mono text-neutral-300">{{ col.name }}</span>
            <!-- &nbsp; because Angular collapses whitespace between elements -->
            <span class="text-[10px] text-neutral-600">&nbsp;({{ col.type }})</span>
            <span class="text-neutral-600" aria-hidden="true">&nbsp;&rarr;&nbsp;</span>
            <span
              class="text-[11px]"
              [class]="col.role === 'none' ? 'text-neutral-600' : 'text-emerald-400'"
              aria-hidden="true"
              >{{ col.role === 'none' ? 'unlabelled' : col.role }}</span
            >
          </span>
          <select
            class="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-200"
            (change)="setRole(col.name, $event)"
            [attr.aria-label]="'Change the label on ' + col.name"
          >
            <!-- [selected] on the option, not [value] on the select: the select's
                 value is set before its options exist, so the binding is lost and
                 every column reads "none" however it is actually labelled. -->
            @for (role of roles; track role) {
              <option [value]="role" [selected]="role === col.role">{{ role }}</option>
            }
          </select>
        </li>
      }
      </ul>
    </details>
  `,
})
export class ColumnMapper {
  private readonly vault = inject(VaultService);
  readonly dataset = input.required<Dataset>();
  readonly roles = ROLES;
  readonly labelled = computed(() => this.dataset().columns.filter((c) => c.role !== 'none').length);


  setRole(column: string, event: Event): void {
    const role = (event.target as HTMLSelectElement).value as SemanticRole;
    void this.vault.setRole(this.dataset().id, column, role);
  }
}
