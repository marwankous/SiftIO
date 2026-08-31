# SiftIO — Design Spec

**Date:** 2026-08-29
**Context:** Submission for [The WebMCP Challenge](https://webmcp.devpost.com/) — deadline 2026-09-03, 1:00 PM PDT.
**Status:** Approved, pending implementation plan.

---

## 1. Summary

SiftIO is a local-first data vault that runs entirely in the browser. A user drops in CSV or JSON exports — bank statements, fitness logs, app data dumps — and the files are parsed and loaded into an in-page DuckDB-wasm instance. Nothing is uploaded. There is no backend.

SiftIO then exposes that data to a connected AI agent through WebMCP tools, so ChatGPT (or Chrome's built-in agent) can query, join, aggregate, and chart the user's private data without the data ever leaving the machine. An always-visible audit panel shows the user exactly which rows the agent read.

**Positioning line:** *Your data stays in the browser. Only the answers leave.*

---

## 2. Why WebMCP (judging criterion #1)

WebMCP's distinguishing property is that the agent operates on state that exists **only inside the page**. SiftIO is built directly on that property:

- **There is nothing for a server-side MCP to connect to.** No API, no database, no upload endpoint. The user's data lives in browser memory and IndexedDB. A conventional MCP server is not a worse option here — it is an impossible one.
- **Scale makes uploading incoherent.** A 400,000-row export cannot fit in a context window and a privacy-conscious user will not upload it. SiftIO's answer is to run the query locally and return only the handful of rows that answer the question.
- **The toolset is a function of live application state.** Tools appear and disappear as datasets are loaded and ejected. That behaviour has no meaning for a static server-side toolset.

The design deliberately exercises the full WebMCP API surface — dynamic `registerTool`/`unregisterTool`, runtime-generated `inputSchema`, elicitation via the `client` parameter, and tool `annotations` — rather than registering a fixed list of CRUD endpoints.

---

## 3. Non-goals

Explicitly out of scope for this build:

- Accounts, authentication, multi-user, or cloud sync.
- Server-side anything. The deployed artifact is static files.
- Dataset-specific parsers (Apple Health XML, Google Takeout, Spotify). The generic CSV/JSON ingest plus a column mapper covers these formats' exported CSVs and is more broadly useful.
- File System Access API. A plain file input is sufficient.
- Writing to or mutating user data. SiftIO is read-only over ingested data; the only destructive operation is ejecting a dataset.
- Export beyond downloading a view as CSV.

---

## 4. Architecture

Angular 22 standalone components with signals, built by the Angular CLI, deployed as static assets to Cloudflare Pages. No server component exists.

### 4.1 Services

**`DuckService`** — owns the single duckdb-wasm instance and its worker. Responsibilities: async bundle selection and instantiation, `query(sql)` returning Arrow results as plain JS objects, table registration and drop. Instantiation is lazy — the wasm bundle loads on first dataset ingest, not at app boot.

**`VaultService`** — the ingest pipeline and dataset registry. Responsibilities: read the dropped file, parse CSV/JSON, infer per-column types, persist the raw file bytes and schema metadata to IndexedDB, register the table in DuckDB, and expose the dataset list as a signal. On app boot it rehydrates every persisted dataset back into DuckDB.

**`McpService`** — the WebMCP boundary. Responsibilities: feature-detect `navigator.modelContext`, register the static tools at boot, and subscribe to `VaultService`'s dataset signal to register/unregister the per-dataset dynamic tools as datasets come and go. Every tool's `execute` is wrapped so that each invocation is timed, measured, and written to the audit log.

**`AuditService`** — an append-only log of tool invocations. Each entry records tool name, arguments, row count returned, approximate byte count, duration, and timestamp. Exposes running totals: rows held locally vs. rows returned to the agent.

### 4.2 UI

A three-pane layout:

- **Left — Datasets.** Drop zone, list of loaded datasets with row counts and inferred schemas, per-dataset eject, and the column mapper.
- **Center — Viewport.** Result table for the most recent query, chart rendered by `render_chart`, and the pinned board of saved views.
- **Right — Agent Activity.** Live audit feed, connection status (`navigator.modelContext` present or not), the currently registered toolset, and the rows-local vs. rows-seen counter.

### 4.3 Persistence

IndexedDB stores raw file bytes plus schema metadata per dataset. DuckDB tables are rebuilt from those bytes on boot; DuckDB's own state is not persisted. Saved views (name, SQL, chart config) are stored alongside.

---

## 5. Data ingest

1. User drops a `.csv` or `.json` file.
2. Parse. CSV via a streaming parser; JSON accepted as an array of objects or an object containing exactly one array property.
3. Infer each column's type by sampling: `integer`, `number`, `date`, `boolean`, `enum` (low distinct-count strings), or `string`.
4. Present the **column mapper**: the user confirms inferred types and may attach a semantic role to a column — `amount`, `timestamp`, `category`, `identifier`, `label`, or none. Roles are optional; ingest proceeds without them.
5. Register the table in DuckDB under a sanitised name derived from the filename.
6. Persist to IndexedDB, update the dataset signal, which triggers tool registration.

Semantic roles are not cosmetic: they are interpolated into the generated tool descriptions, so the agent is told that `txn_amt` is the amount column. This is the mechanism by which the human shapes what the agent is able to understand.

---

## 6. WebMCP tools

All tools are registered on `navigator.modelContext`. Every `execute` returns a plain JavaScript object.

### 6.1 Static tools

| Tool | Purpose | Annotations |
|---|---|---|
| `list_datasets` | Returns every loaded dataset: name, row count, column names with types and semantic roles. The agent's entry point. | `readOnlyHint` |
| `run_sql` | Executes an arbitrary read-only SQL query across all loaded tables. The power tool — enables cross-dataset joins. | `readOnlyHint` |
| `render_chart` | Runs a query and renders the result into the page viewport as a bar, line, scatter, or table view. | `readOnlyHint` |
| `save_view` | Pins a named query and chart config to the board so it survives after the agent disconnects. | — |
| `eject_dataset` | Removes a dataset from the vault. Requires confirmation from the human. | `destructiveHint` |

**`run_sql` guard.** The query is parsed and rejected unless it is a single `SELECT` or `WITH … SELECT` statement. Statements containing `ATTACH`, `COPY`, `INSTALL`, `LOAD`, `EXPORT`, or any DDL/DML keyword are rejected with an explanatory error. Multiple statements are rejected. Results are capped at 1,000 rows with the cap reported in the response, so a careless `SELECT *` cannot flood the agent's context or the audit log.

### 6.2 Dynamic per-dataset tools

For each loaded dataset, two tools are registered and are unregistered when the dataset is ejected:

**`query_<dataset>`** — filter, aggregate, sort, and limit that dataset. Its `inputSchema` is **generated at registration time from the dataset's actual inferred columns**: column parameters are typed enums of the real column names, numeric filters appear only for numeric columns, date-range filters only for date columns. The agent therefore sees a schema-accurate, self-documenting tool rather than a generic string bag.

**`describe_<dataset>`** — per-column statistics: type, null count, distinct count, min/max for numerics and dates, and top values for enums. Lets the agent orient itself before querying.

### 6.3 Elicitation

Where a tool call is ambiguous, `execute` uses the `client` parameter to ask the human rather than guessing. Two concrete cases in this build:

- A `run_sql` query references a bare column name that exists in more than one loaded dataset — SiftIO asks which the user meant.
- `eject_dataset` is called — SiftIO asks the human to confirm before dropping.

### 6.4 Registration lifecycle

At boot: feature-detect, then register static tools. `McpService` subscribes to the dataset signal; on add it registers the pair of dynamic tools for that dataset, on remove it unregisters them. Re-registration after a hot reload is made idempotent by unregistering by name first and ignoring the not-found error.

If `navigator.modelContext` is absent, the app runs normally and the Agent Activity pane displays setup instructions for `chrome://flags/#enable-webmcp-testing`.

---

## 7. Audit trail

Every tool invocation, successful or failed, produces an audit entry. The Agent Activity pane renders these live and shows a persistent headline counter of the form `412,331 rows local · 14 rows seen by agent`.

This exists for two reasons. It is the product's trust mechanism — the user can verify the claim that only answers leave. It is also the clearest single visual for the demo video.

---

## 8. Testing

**Unit (Vitest).** Column type inference across representative fixtures. The `run_sql` guard, with a table of statements that must be accepted and rejected. `inputSchema` generation from a known schema. Table-name sanitisation.

**Integration.** Ingest a fixture CSV, assert the dataset appears in DuckDB with the expected row count, assert the dynamic tools are registered, eject, assert they are unregistered.

**Manual/dev.** A `MockAgent` dev panel lists the registered toolset and invokes any tool with hand-entered arguments, mirroring `navigator.modelContextTesting.executeTool`. This allows development and testing without the Chrome flag, and serves as a fallback demonstration surface if the flag misbehaves during recording.

**End-to-end.** Manual verification in Chrome with `chrome://flags/#enable-webmcp-testing` enabled, against the deployed `*.pages.dev` URL, before submission.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| duckdb-wasm worker and wasm asset wiring inside an Angular build is the one genuine unknown. | Spike this first, before any other work. If it resists, `sql.js` is a drop-in fallback behind the same `DuckService` interface. |
| duckdb-wasm's `latest` dist-tag is a `-dev` build (`1.33.1-dev57.0`). | This is long-standing upstream convention, not a pre-release signal. Pin the exact version. |
| Cross-origin isolation headers needed for the threaded wasm bundle. | Use duckdb-wasm's automatic bundle selection, which falls back to the non-threaded build without COOP/COEP. Add a `_headers` file only if profiling shows it is needed. |
| WebMCP API surface may drift before the deadline. | Feature-detect and fail soft. Keep all WebMCP contact inside `McpService` so a signature change is a one-file edit. |
| Demo depends on a Chrome flag behaving on camera. | The `MockAgent` panel is a working fallback that still demonstrates the tools. |

---

## 10. Deliverables

1. Deployed static site on Cloudflare Pages at an HTTPS `*.pages.dev` URL.
2. Public GitHub repository with an OSS licence file (MIT) detectable in the About section, plus a README covering setup, the tool catalogue, and how to enable WebMCP in Chrome.
3. Demo video under 3 minutes with audio, published publicly on YouTube.
4. Devpost text description addressing WebMCP fit, the user-experience gain, the novel capability, and the implementation approach.
