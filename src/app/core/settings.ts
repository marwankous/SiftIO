import { Injectable, signal } from '@angular/core';

/**
 * Display preferences. Currency is a *declared* setting, never inferred: a
 * column called `amt` carries no unit, so the symbol is whatever the person
 * looking at their own data says it is. "None" formats plain numbers.
 */
export const CURRENCIES = ['None', '$', '£', '€', '¥', '₹'] as const;
export type Currency = (typeof CURRENCIES)[number];

const KEY = 'siftio:currency';
const LAYOUT_KEY = 'siftio:layout';

export const PANEL_MIN = 200;
export const PANEL_MAX = 560;

export interface Layout {
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
}

const DEFAULT_LAYOUT: Layout = { left: 300, right: 340, leftOpen: true, rightOpen: true };

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _currency = signal<Currency>(read());
  readonly currency = this._currency.asReadonly();

  private readonly _layout = signal<Layout>(readLayout());
  readonly layout = this._layout.asReadonly();

  setPanelWidth(side: 'left' | 'right', px: number): void {
    const clamped = Math.min(Math.max(Math.round(px), PANEL_MIN), PANEL_MAX);
    this._layout.update((l) => ({ ...l, [side]: clamped }));
    this.persistLayout();
  }

  togglePanel(side: 'left' | 'right'): void {
    const key = side === 'left' ? 'leftOpen' : 'rightOpen';
    this._layout.update((l) => ({ ...l, [key]: !l[key] }));
    this.persistLayout();
  }

  private persistLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this._layout()));
    } catch {
      // Storage can be blocked; the layout just will not persist.
    }
  }

  setCurrency(c: Currency): void {
    this._currency.set(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      // Storage can be blocked; the choice just will not persist.
    }
  }

  /** The symbol to prefix, or '' when the user has chosen None. */
  symbol(): string {
    const c = this._currency();
    return c === 'None' ? '' : c;
  }
}

function readLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const v = JSON.parse(raw) as Partial<Layout>;
    return {
      left: clamp(v.left, DEFAULT_LAYOUT.left),
      right: clamp(v.right, DEFAULT_LAYOUT.right),
      leftOpen: v.leftOpen ?? true,
      rightOpen: v.rightOpen ?? true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const clamp = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(v, PANEL_MIN), PANEL_MAX)
    : fallback;

function read(): Currency {
  try {
    const v = localStorage.getItem(KEY) as Currency | null;
    return v && (CURRENCIES as readonly string[]).includes(v) ? v : '$';
  } catch {
    return '$';
  }
}
