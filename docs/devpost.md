# Devpost submission copy

Paste-ready text for the submission form. Not part of the app.

---

## Project name

SiftIO

## Elevator pitch

Your data stays in the browser. Only the answers leave.

---

## About the project

### Inspiration

Everyone has a file they would like to ask questions about and will never upload. A bank
export. A health record. Ten years of app history.

The moment an AI is involved, the implicit deal is "send us your data" — so most people
just don't. That deal exists because of *where the code runs*, not because of anything
fundamental about the problem. WebMCP changes where the code runs, so we wanted to find
out whether the deal could be broken.

### What it does

SiftIO is a local-first data vault. Drop in CSV or JSON exports and they load into a real
database — DuckDB, compiled to WebAssembly — running **inside the browser tab**. Nothing
is uploaded. There is no backend.

It then publishes that data to a connected AI agent as WebMCP tools. The agent writes the
query, SiftIO runs it locally, and only the answer comes back. Ask *"which spending
category is highest on days I worked out?"* and it joins two of your files and draws the
chart in the page, while an audit panel shows exactly what was read:

> **5,178 rows held locally · 6 rows seen by the agent**

That ratio is the whole product.

### Why WebMCP is load-bearing

Most agent integrations could just as easily have been a server-side MCP. This one could
not:

- **There is nothing for a server to connect to.** No API, no database, no upload
  endpoint. The data lives in browser memory and IndexedDB. A conventional MCP server is
  not a worse option here — it is an impossible one.
- **Uploading is incoherent at this scale.** A 400,000-row export does not fit in a
  context window. Running the query locally and returning the twelve rows that answer it
  is the only sane shape, and it is the shape WebMCP makes possible.
- **The toolset is a function of live page state.** Load a file and a `query_<table>` tool
  appears, its input schema generated from that file's real columns. A static server-side
  toolset has no equivalent.

### How we built it

Angular 21 (standalone, zoneless, signals), TypeScript strict, Tailwind, DuckDB-wasm,
Chart.js and IndexedDB, deployed as a Cloudflare static-asset Worker with no server
component at all. 175 tests.

**The architecture is four services and one rule.** `DuckService` owns the wasm database,
`VaultService` owns the set of loaded datasets, `McpService` is the only file allowed to
touch the WebMCP API, and `AuditService` records every invocation. The rule is that the
vault's dataset signal is the single source of truth — the UI and the published toolset
are both derived from it, so they cannot disagree.

**Ingest delegates to DuckDB rather than reimplementing it.** A dropped file is registered
into DuckDB's virtual filesystem, then
`CREATE TABLE x AS SELECT * FROM read_csv_auto(...)` does the parsing and type inference,
and `DESCRIBE` hands back the schema. That removes a CSV parser dependency and an entire
class of inference bugs. The registered buffer is dropped immediately afterwards, so a
100 MB export is never held twice in memory. Table names are sanitised for SQL — a file
called `2024-taxes.csv` becomes `t_2024_taxes`, because an identifier cannot start with a
digit — and re-loading a file replaces it rather than accumulating `transactions_2`, which
also keeps the agent's tool names stable.

**Generating a tool for a file it has never seen.** This is the part we would point a
judge at. When a dataset loads, `buildQueryToolSchema` reads its inferred columns and
emits a JSON Schema specific to that file: real column names as typed enums, numeric
filters only on numeric columns, `since`/`until` bounds only where a date exists. The
agent cannot hallucinate a column, because it is choosing from a list of the ones you
actually have. A matching `describe_<table>` runs `SUMMARIZE` so the agent can check
ranges and null counts before committing to a query.

**Column labels change what the agent can do, not just what it reads.** Labelling a column
rewrites that generated schema: `identifier` is removed from the aggregate list because
`sum(id)` is meaningless, `amount` becomes the default measure, `category` leads the
group-by list, and `timestamp` unlocks date-range filters that otherwise do not exist at
all. One click changes the shape of the tool the agent receives.

**Registration is reactive.** Nothing calls `registerTool` from the UI. An effect watches
the dataset signal and reconciles the published toolset against it, reading the current
tool map inside `untracked()` so registering a tool cannot retrigger the effect that
registered it. It takes an explicit `Injector` because `init()` runs from a component
constructor but the effect has to outlive that injection context. On reload, datasets
rehydrate from IndexedDB and re-register themselves with no extra code.

**Making Arrow output safe for an agent.** DuckDB returns Apache Arrow, which is full of
values that cannot survive a tool response. Every result is normalised against the Arrow
schema: `BIGINT` becomes a number when it fits in a float and an exact string when it does
not, `HUGEINT` totals arrive as `Decimal128` limb arrays and are converted back to
numbers, `DATE` renders as `2025-01-06` while `TIMESTAMP` keeps its time. Only columns
Arrow itself calls numeric are touched, so a zero-padded postcode is never mangled.

**Guarding a SQL surface an agent controls.** `run_sql` accepts one `SELECT` and nothing
else. String literals and comments are blanked before keyword scanning, so a query
filtering on the text `'drop table t'` is accepted while a real `DROP` is rejected.
Structured queries validate every column, operator, aggregate and date bound against
allowlists rather than interpolating them — `orderBy: 'amt"; DROP TABLE txns; --'` comes
back as *unknown column*. Results are capped at 1,000 rows, detected by fetching one extra
row rather than a second count query.

**Keeping the human in the loop.** `render_chart` draws into the page, so findings appear
in front of you rather than only in chat. Every call is logged in plain English — *"Grouped
transactions by category, sum of amt, from 2025-01-01"* — with the raw payload one click
deeper, under a running counter of rows held versus rows seen. A derived insight sentence
names the leader and the gap, computed from the result and never invented. `save_view`
pins a query so it outlives the conversation.

**Failing honestly.** With no WebMCP present the app still works and says so. If IndexedDB
is unavailable or wedged, persistence times out and degrades to a visible warning instead
of hanging the ingest forever. And because an agent arrives at an empty vault in its own
browser context, `list_datasets` explains that situation rather than returning a bare
empty array.

Shipped alongside is a library of **14 generated sample datasets** (5,178 rows) chosen to
break naive ingest: CSV and JSON, `DATE` and `TIMESTAMP`, booleans, NULLs, negative
numbers, unicode, fields containing commas and quotes, and that digit-leading filename.

### Challenges we ran into

**The API was not where the documentation said.** Several widely-cited write-ups state
that `navigator.modelContext` is the only entry point. It is not: Chrome exposes it on
`document.modelContext`, exactly as this challenge's own sample shows. Built against the
wrong global, SiftIO registered precisely **zero** tools with a real agent — while every
unit test passed, because the tests mocked the API we believed in.

**There is no `unregisterTool`.** The design assumed ejecting a dataset would remove its
tools. Chrome ships `registerTool`, `getTools`, `executeTool` and nothing else;
re-registering a name is silently ignored. Rather than pretend, the app calls
`unregisterTool` where it exists and tells the user plainly when it doesn't — the stale
tool still reports that its dataset is gone.

**The agent has its own vault.** An agent opens the page in *its own* browsing context,
with its own IndexedDB. Data loaded in your browser is invisible to it. It found the
tools, called `list_datasets`, got an empty result — and had no way forward, because we
had shipped seven tools for reading the vault and none for filling it. `list_samples` and
`load_sample` exist because of that dead end.

**`registerFileBuffer` transfers the ArrayBuffer**, detaching it. Persisting those same
bytes immediately afterwards failed with "ArrayBuffer is detached", so no dataset ever
survived a reload. The vault now stores the `Blob`, which IndexedDB keeps out-of-line
anyway.

**Numbers were quietly wrong in three different ways.** `BIGINT` arrives as a JavaScript
`bigint`, which `JSON.stringify` throws on outright — and converting with `Number()`
silently corrupts anything above $2^{53}$, turning `9223372036854775807` into
`...776000`. `sum()` over integers returns `HUGEINT`, which Arrow delivers as a
`Decimal128` limb array, so totals reached the agent as *text*. And `TIMESTAMP` columns
were being reported as plain dates while carrying a time.

**A chart that was never drawn.** The canvas was hidden with a CSS class until a chart
existed, so on first render Chart.js measured it at zero and crushed every bar into the
corner. Second renders looked fine, which is exactly why it survived so long.

### What we learned

The lesson that kept repeating: **a green test suite is not evidence that the product
works.** Every one of the bugs above passed every test, because mocks encode the same
assumptions as the code they stand in for. The detach bug needed a real ArrayBuffer; the
wrong-global bug needed a real browser; the zero-width chart needed a real layout.

The build now stamps a fingerprint of `src/` into the bundle and refuses to ship if that
fingerprint is missing from the output — added after a stale build twice deployed code
that did not match source while all tests passed.

The second lesson is about honesty as a feature. This app's entire claim is that you can
trust what it shows you, which ruled out a surprising number of conveniences: no currency
symbol invented for a column called `amt` (it is a setting you declare), no guessed column
labels, no "Agent connected" when only the API is present. The audit panel exists so the
privacy claim never has to be taken on faith.

### Accomplishments that we're proud of

**An agent really did use it.** ChatGPT found the tools on the deployed site, called
`list_datasets`, loaded a sample and answered a cross-dataset question with the chart
rendering in the page. Not a mock, not a local demo — the live URL, through the browser's
own WebMCP entry point.

**A tool built for a file that did not exist a moment ago.** `query_<table>` is not a
template with a name substituted in; its schema is generated from the actual inferred
columns, so the agent is picking from *your* column names, with numeric filters only where
numbers live and date ranges only where dates do. Eject the file and the tool goes with
it. This is the thing a server-side MCP structurally cannot do.

**Labels that change capability, not wording.** Marking a column `identifier` removes it
from the aggregate list because a total of ID numbers is meaningless. Marking one
`timestamp` unlocks `since`/`until` filters that do not otherwise exist. The human is
editing what the agent is *able to ask*, in one click — which is the most literal
human-agent collaboration we could find.

**Trust you can check rather than take on faith.** The counter reading *5,178 rows held
locally · 6 rows seen by the agent* is derived from a real audit log of every invocation,
each one readable in plain English with the exact payload one click deeper. The privacy
claim is falsifiable from inside the product.

**Zero backend, and that is the proof.** The entire deployment is static files. There is
no server to send data to even by accident — which is a stronger guarantee than any policy
we could have written.

**We resisted the convenient lies.** No currency symbol invented for a column called
`amt`; it is a setting you declare. No auto-guessed column labels, because a wrong guess
silently drops a column from aggregation. No "Agent connected" when only the API is
present — that one misled a real user, so it now reads *Tools published / Agent connected
/ Last tool call*, with connection inferred from actual agent calls. In a product whose
whole claim is that you can trust what it shows you, each of those was worth the friction.

**175 tests, and a build that refuses to ship a lie.** After a stale build twice deployed
code that did not match source while every test passed, the build now fingerprints `src/`
into the bundle and fails if that fingerprint is missing from the output.

### What's next for SiftIO

**Streaming ingest.** Today a file is read into memory before DuckDB sees it, which caps
comfortable use somewhere in the hundreds of megabytes. DuckDB can read incrementally and
persist to OPFS, which would take SiftIO from *large* files to *genuinely too large to
upload* — the case that makes the argument strongest.

**Importers for the exports people actually have.** The generic CSV and JSON path is
deliberately universal, but Apple Health's XML, Google Takeout's nested JSON and bank
statement dialects each need a little translation before they become a clean table.

**Real tool removal, when the platform allows it.** Chrome ships no `unregisterTool`, so an
ejected dataset's tools linger until reload. The code already calls it where it exists;
the moment it lands, that caveat disappears on its own.

**Deeper elicitation.** The spec's `client.elicit` is the least settled part of WebMCP, so
we use it narrowly — ambiguous column names and destructive confirmations. As it
stabilises, the interesting version is the agent asking *"by 'worked out' do you mean any
session, or over thirty minutes?"* instead of quietly picking one.

**Shareable views without shareable data.** `save_view` pins a query and chart locally.
Exporting that as a small file someone else could run against *their own* vault would let
people share an analysis without ever sharing a row.

**An audit you can take away.** The log proves what left your machine while you are looking
at it. Exporting it — signed, timestamped — would make that a record rather than a
reassurance.

### Honest limitation

WebMCP is days old and off by default. Today this needs Chrome with
`chrome://flags/#enable-webmcp-testing`, or the ChatGPT desktop app's built-in browser,
which gained WebMCP support in late August 2026. That is exactly why this is a hackathon
entry and not a product. The bet is that browser-native agent tools become ordinary — and
if they do, this is what local-first analysis looks like.

With no agent attached it still works as a local SQL and charting tool, and a built-in
**Dev: invoke a tool** panel calls any tool by hand, through the same code path an agent
uses.

---

## Built with

Ordered most to least relevant — the first four are what a judge is filtering for.

```
webmcp
model-context-protocol
duckdb
webassembly
angular
typescript
indexeddb
apache-arrow
sql
chart.js
tailwind
cloudflare-workers
wrangler
vitest
javascript
docker
node.js
local-first
```

18 of the 25 allowed. Everything listed is genuinely in the project: Arrow because DuckDB
returns it and results are normalised against its schema, Docker because the dev container
pins the toolchain, Wrangler because deployment is a static-asset Worker. No RxJS — the
app uses signals throughout.

## Video demo

https://youtu.be/VpV0vQ2Wzg0

## Try it out

- **Live:** https://siftio.marouane-kouskous.workers.dev
- **Code:** https://github.com/marwankous/SiftIO (MIT)

Open the site, click **Load sample data**, and ask your agent which spending category is
highest on days you worked out. No agent to hand? The **Dev: invoke a tool** panel in the
right-hand pane runs any tool directly.
