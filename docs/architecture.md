# SiftIO — architecture

How the thing is put together, why it is put together that way, and the traps that are
easy to fall back into. For a user-facing tour, read [guide.md](guide.md) instead.

---

## The shape of it

```
              ┌──────────────────────── browser tab ────────────────────────┐
              │                                                             │
  file  ──▶   │  VaultService ──▶ DuckService ──▶ DuckDB (WebAssembly)      │
              │       │                                                     │
              │       │ datasets signal                                     │
              │       ▼                                                     │
              │  McpService ──▶ document.modelContext   ◀── agent           │
              │       │                                                     │
              │       ├──▶ AuditService  ──▶ Agent Activity pane            │
              │       └──▶ ViewportService ─▶ table + chart in the page     │
              │                                                             │
              └─────────────────────────────────────────────────────────────┘
                        no network calls carry user data outward
```

There is no server. The deployment is static files on a Cloudflare Worker, so there is
nothing to send data to even by mistake — which is the actual mechanism behind the privacy
claim, not a policy.

**One rule holds the design together:** `VaultService.datasets` is the single source of
truth. The UI renders from it and the published WebMCP toolset is reconciled against it,
so the two cannot disagree.

---

## Files

### `src/app/core/`

| File | Responsibility |
|---|---|
| `models.ts` | Types shared everywhere: `Dataset`, `Column`, `QueryResult`, `AuditEntry`, `MAX_ROWS`. |
| `duck.ts` | Owns the single duckdb-wasm instance. Boot, `query`, `ingestFile`, `describeTable`, `dropTable`, plus Arrow normalisation. |
| `vault.ts` | The dataset registry. Ingest, IndexedDB persistence, rehydration, semantic roles. |
| `mcp.ts` | **The only file that touches the WebMCP API.** Registers tools, reconciles them against the vault, wraps every call for the audit. |
| `tool-schema.ts` | Generates a per-dataset JSON Schema and turns structured input into safe SQL. |
| `sql-guard.ts` | The read-only boundary for agent-supplied SQL. |
| `schema.ts` | Table-name sanitisation, DuckDB→SiftIO type mapping, column descriptions. |
| `audit.ts` | Append-only log of tool invocations, capped at 200, with the rows-seen counter. |
| `insight.ts` | Derived summaries: the leader sentence, number formatting, plain-English call descriptions. |
| `viewport.ts` | What the centre pane is showing: result, chart spec, the note explaining it, saved views. |
| `samples.ts` | The bundled demo library and its manifest. |
| `settings.ts` | Declared preferences: currency symbol, panel layout. Persisted to `localStorage`. |
| `webmcp.ts` | Ambient types for the browser API, plus `getModelContext()` feature detection. |
| `build-stamp.ts` | Generated. A fingerprint of `src/`, used to prove the bundle matches source. |

### `src/app/panes/`

`datasets-pane` (drop zone, sample library, currency, labels help) · `column-mapper`
(per-column role editor) · `viewport-pane` (empty state, suggestions, chart, table,
insight, saved views) · `activity-pane` (counters, connection state, audit, diagnostics) ·
`mock-agent` (invoke any tool by hand).

`app.ts` is the shell: resizable and collapsible side panels, and the boot sequence.

### `scripts/`

`make-samples.mjs` generates the 14-dataset library deterministically ·
`stamp.mjs` writes the build fingerprint · `verify-build.mjs` fails the build if that
fingerprint is missing from the emitted bundle.

---

## Data flow

### Ingesting a file

1. `VaultService.ingest(file, roles?)` rejects anything that is not `.csv` or `.json`.
2. If a dataset with the same filename exists it is **ejected first**, so re-loading
   replaces rather than accumulating `transactions_2` — this also keeps tool names stable.
3. Bytes are registered into DuckDB's virtual filesystem, then
   `CREATE OR REPLACE TABLE x AS SELECT * FROM read_csv_auto('x.csv')` does the parsing
   and type inference. `dropFile` runs immediately after, so a large export is not held
   twice in memory.
4. `DESCRIBE` returns the schema; `mapDuckType` collapses DuckDB's types into
   `integer | number | date | timestamp | boolean | string`.
5. Any supplied roles are applied, then the **`Blob`** and metadata are written to
   IndexedDB.
6. The `datasets` signal updates, which is what causes the tools to appear.

On boot, `rehydrate()` replays every stored `Blob` through the same `load()` path, so a
restored dataset is indistinguishable from a fresh one.

### Registering tools

`McpService.init()` publishes seven static tools, then installs an effect over
`vault.datasets`. The effect reads the tool map inside `untracked()` — registering a tool
must not retrigger the effect that registered it — and reconciles: for each dataset,
publish `query_<table>` and `describe_<table>`; unpublish any dataset tool whose dataset is
gone.

The effect takes an **explicit `Injector`** because `init()` is called from a component
constructor but the effect has to outlive that injection context.

### Answering a query

`query_<table>` → `buildQuerySql` (validated against the dataset's real columns) →
`DuckService.query` → Arrow normalisation → `ViewportService.show(result, chart, note, sql)`
→ the pane renders the table, chart, insight and the "How this was worked out" disclosure.
Every step is recorded by `AuditService` with its source.

---

## WebMCP, as actually implemented

Verified against Chrome 152. The spec is young; expect drift.

- **The API is `document.modelContext`.** Not `navigator` — several widely-cited
  write-ups say otherwise and are wrong. `getModelContext()` checks `document` first and
  falls back to `navigator` in case an implementation differs.
- **`registerTool` is async** and rejects on a duplicate name. First registration wins;
  re-registering to update a tool does nothing.
- **There is no `unregisterTool`.** `McpService.canUnregister` reports this, and the UI
  says an ejected dataset's tools linger until reload rather than pretending otherwise.
- **`executeTool(tool, argsJson)`** takes the *tool object* from `getTools()`, and its
  arguments as a **JSON string**, not an object.
- **Agent presence is inferred, never assumed.** Audit entries carry a
  `source: 'agent' | 'panel'`; "Agent connected" turns true only once a call has actually
  arrived through the browser API.
- **An agent has its own vault.** It opens the page in its own browsing context with its
  own IndexedDB, so it cannot see data loaded in your browser. `list_samples` and
  `load_sample` exist so it can bootstrap; `list_datasets` explains the situation when the
  vault is empty.

---

## Turning Arrow into something an agent can read

DuckDB returns Apache Arrow, which is full of values that cannot survive a tool response.
`columnHints()` reads the Arrow schema and `normalizeValue()` applies it:

| Arrow type | Problem | What we do |
|---|---|---|
| `BIGINT` | `JSON.stringify` throws on `bigint`; `Number()` corrupts above 2⁵³ | number when safe, exact digits as a string otherwise |
| `HUGEINT` (from `sum()`) | Arrives as a `Decimal128` limb array, reads as text | converted via its digits, with a strict decimal check |
| `Date32` | Epoch number — ambiguous days vs millis | `2025-01-06` |
| `Timestamp` | Same, but carries a time | full ISO |
| `Utf8` | — | untouched |

Only columns Arrow itself calls numeric are converted, so a zero-padded postcode or id is
never mangled.

---

## Security model

Everything an agent supplies is untrusted input that reaches SQL.

- **`run_sql`** accepts one `SELECT` or `WITH … SELECT`. String literals and comments are
  blanked *before* keyword scanning, so `WHERE note = 'drop table t'` is fine while a real
  `DROP` is rejected. Multiple statements are rejected; a single trailing `;` is not.
- **Structured queries** validate every column against the dataset's real columns, and
  operators and aggregate functions against fixed allowlists. Nothing is interpolated —
  `orderBy: 'amt"; DROP TABLE txns; --'` comes back as *unknown column*.
- **Date bounds** must match a strict date/ISO pattern before reaching SQL.
- **Results are capped** at `MAX_ROWS` (1000), detected by fetching one extra row.
- **Ejection asks first**, via elicitation where available and a confirm otherwise.

---

## Persistence

IndexedDB via `idb-keyval`: `ds:<table>` holds `{ meta, blob }`, `views` holds saved
views, and `localStorage` holds display settings.

Persistence is treated as a **bonus, never a blocker**. `VaultService.guard()` races every
storage call against a 4-second deadline; on failure the dataset still loads and
`persistent()` flips false, which the UI surfaces. A wedged IndexedDB — a pending
`deleteDatabase`, blocked storage, a private window — used to hang ingest forever.

---

## Build and deploy

```bash
npm start                      # dev server
npm test -- --watch=false      # 175 tests, jsdom, no browser needed
npm run build                  # clean → stamp → ng build → verify
npm run deploy                 # build, then wrangler deploy
```

`npm run build` **always cleans first and verifies afterwards.** Angular's persistent cache
twice emitted a bundle that did not match source while every test passed, so the cache is
disabled in `angular.json` and the build fails outright if the source fingerprint is
missing from the output. Deploy only through `npm run deploy`.

Deployment is an assets-only Cloudflare Worker (`wrangler.jsonc`) with no `main` script.
`public/_headers` is copied to the output root and honoured by Workers static assets.

---

## Traps worth remembering

Each of these shipped once, passed every test, and was only caught in a real browser.

- **`registerFileBuffer` transfers the ArrayBuffer**, detaching it. Persist the `Blob`,
  never the bytes you just handed to DuckDB.
- **Angular `[value]` on a `<select>`** is applied before its `<option>`s exist, so the
  binding is lost and the control shows the wrong thing. Bind `[selected]` on the option,
  or drive `el.value` imperatively.
- **A canvas hidden with a CSS class** measures zero, and Chart.js locks that size in.
  Create the canvas only when there is a chart.
- **`requestAnimationFrame` never fires in a background tab.** Use `setTimeout` for
  post-render work.
- **`setPointerCapture` throws** when the pointer id is not active, which silently kills a
  drag. Wrap it, and put move listeners on `window`.
- **Angular collapses whitespace between elements**, so adjacent spans render as
  `minutesinteger`. Use `&nbsp;` or punctuation.
- **A green test suite proves the mocks agree with the code**, not that the product works.

---

## Testing

175 tests, Vitest through the Angular builder, jsdom — no browser required, so it runs
anywhere. Pure logic (`sql-guard`, `schema`, `tool-schema`, `insight`, Arrow
normalisation) is tested directly; services are tested against fakes, including a fake
`document.modelContext` that reproduces Chrome's async, no-unregister behaviour and an
`idb-keyval` mock that can hang on demand.

The DuckDB boot itself needs a real browser and is verified manually — stated plainly here
rather than faked with a mock that would prove nothing.
