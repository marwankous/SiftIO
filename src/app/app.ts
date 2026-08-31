import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { McpService } from './core/mcp';
import { VaultService } from './core/vault';
import { SettingsService, PANEL_MIN, PANEL_MAX } from './core/settings';
import { DatasetsPane } from './panes/datasets-pane';
import { ViewportPane } from './panes/viewport-pane';
import { ActivityPane } from './panes/activity-pane';

type Side = 'left' | 'right';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatasetsPane, ViewportPane, ActivityPane],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly mcp = inject(McpService);
  private readonly vault = inject(VaultService);
  readonly settings = inject(SettingsService);
  private readonly grid = viewChild<ElementRef<HTMLElement>>('grid');

  /** Which divider is being dragged, so it can highlight while in use. */
  readonly dragging = signal<Side | null>(null);

  protected readonly min = PANEL_MIN;
  protected readonly max = PANEL_MAX;

  /**
   * A collapsed panel is a zero-width column. The divider stays put either way,
   * so dragging it is enough to bring the panel back.
   */
  readonly columns = computed(() => {
    const l = this.settings.layout();
    return `${l.leftOpen ? l.left : 0}px 5px 1fr 5px ${l.rightOpen ? l.right : 0}px`;
  });

  constructor() {
    // Order matters: init() installs the effect first, so datasets restored
    // below register their tools as they load.
    this.mcp.init();
    void this.vault.rehydrate();
  }

  toggle(side: Side): void {
    this.settings.togglePanel(side);
  }

  startDrag(side: Side, event: PointerEvent): void {
    event.preventDefault();
    this.dragging.set(side);

    // Capture keeps the cursor from snagging on other elements, but a failure
    // must not abort the drag — so listen on window either way.
    const handle = event.target as HTMLElement;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Not capturable; window listeners below still deliver the moves.
    }

    const move = (e: PointerEvent) => this.resizeTo(side, e.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      this.dragging.set(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  /** Arrow keys resize too, so the divider is not mouse-only. */
  nudge(side: Side, delta: number): void {
    const l = this.settings.layout();
    this.settings.setPanelWidth(side, (side === 'left' ? l.left : l.right) + delta);
  }

  private resizeTo(side: Side, clientX: number): void {
    const box = this.grid()?.nativeElement.getBoundingClientRect();
    if (!box) return;
    const width = side === 'left' ? clientX - box.left : box.right - clientX;

    // Dragging a collapsed panel outwards is the natural way to reopen it.
    const l = this.settings.layout();
    const closed = side === 'left' ? !l.leftOpen : !l.rightOpen;
    if (closed && width > PANEL_MIN / 2) this.settings.togglePanel(side);

    this.settings.setPanelWidth(side, width);
  }
}
