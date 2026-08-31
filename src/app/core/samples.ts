import { Injectable, inject, signal } from '@angular/core';
import { VaultService } from './vault';
import type { Dataset, SemanticRole } from './models';

export interface SampleEntry {
  file: string;
  title: string;
  note: string;
  rows: number;
  roles: Record<string, SemanticRole>;
}

/**
 * The bundled demo library, described by public/samples/index.json.
 *
 * An agent reaches this page in its own browsing context, with its own empty
 * vault — data the user loaded in a different browser is invisible to it. So
 * loading a sample has to be something the agent can do itself, or it arrives
 * at an empty table with no way forward.
 */
@Injectable({ providedIn: 'root' })
export class SamplesService {
  private readonly vault = inject(VaultService);
  private readonly _samples = signal<SampleEntry[]>([]);
  readonly samples = this._samples.asReadonly();

  constructor() {
    void this.loadManifest();
  }

  private async loadManifest(): Promise<void> {
    try {
      const res = await fetch('samples/index.json');
      if (!res.ok) return; // the library is optional; the drop zone still works
      this._samples.set(((await res.json()) as { samples: SampleEntry[] }).samples ?? []);
    } catch {
      // Offline or missing manifest — nothing to show, nothing to report.
    }
  }

  find(file: string): SampleEntry | undefined {
    return this._samples().find((s) => s.file === file);
  }

  /** Fetch one bundled sample and ingest it, labels and all. */
  async ingest(file: string): Promise<Dataset> {
    const sample = this.find(file);
    if (!sample) {
      const known = this._samples().map((s) => s.file).join(', ');
      throw new Error(`No sample named "${file}". Available: ${known || 'none loaded yet'}`);
    }
    const res = await fetch(`samples/${sample.file}`);
    if (!res.ok) throw new Error(`Could not fetch ${sample.file}`);
    return this.vault.ingest(new File([await res.blob()], sample.file), sample.roles);
  }
}
