# SiftIO — what it's for and how to drive it

**Ask an AI about data you would never upload.**

Your CSV and JSON exports load into a real database running inside the browser tab. An AI
agent writes the queries; SiftIO runs them locally and hands back only the answer.

```
5,178 rows  ──sift──▶  6 rows
held in your browser    the agent ever sees
```

That ratio is the whole product. Everything below is detail hanging off it.

---

## The problem

Say you have a bank export: five years, forty thousand rows. You want to know what you
spent on transport last winter compared with this one. Today you choose between four bad
options.

| What you would do now | Why it is unsatisfying |
|---|---|
| Paste the CSV into a chatbot | You have handed over your bank history, and it breaks past a few thousand rows anyway. |
| Write the SQL yourself | You need to know SQL, and somewhere to run it. |
| Build a pivot table | Tedious, and every follow-up question means rebuilding it. |
| Upload to an analytics service | Same privacy problem, plus an account and a subscription. |

SiftIO is a fifth option. The file never leaves the page — DuckDB, compiled to
WebAssembly, runs inside the tab. The agent writes a query, SiftIO executes it locally,
and six rows go back instead of forty thousand.

**When not to bother:** small file, nothing sensitive in it? Paste it into a chatbot and
move on. SiftIO earns its place when the data is large, private, or both.

---

## Four steps

1. **Turn on the browser flag.** Open `chrome://flags/#enable-webmcp-testing`, set it to
   Enabled, restart Chrome. Or skip this and open the site inside ChatGPT's in-app
   browser, which supports it natively.
2. **Load some data.** Click **Load sample data** for a starter set, open **Sample
   library** for all fourteen, or drag in your own CSV or JSON.
3. **Ask your agent a question in plain English.** It discovers the available tools by
   itself — you never name them.
4. **Watch the middle and right panels** while it works. Results and charts appear in the
   page, and every call it makes is logged.

---

## Questions that work on the shipped samples

> Which spending category is highest on days I worked out? Chart it.

> Did I sleep worse in months where I spent more? Join sleep and transactions.

> What were my top five merchants between January and March 2025?

> Which apps do I use most on days I take fewer than 5,000 steps?

Each of these needs two or three separate files at once. That is the part a spreadsheet
cannot do, and the part SiftIO is built around.

---

## The toolkit

### Five tools are always there

| Tool | What it does | Why you care |
|---|---|---|
| `list_datasets` | An inventory of what is loaded, with every column and type. | The agent's way in. Without it, it is guessing what you have. |
| `list_samples` | The demo datasets bundled with SiftIO. | An agent opens the page in its own browser, with an empty vault. This is how it finds something to work with. |
| `load_sample` | Loads one of them into the vault. | Lets the agent get started on its own, instead of stopping at an empty table. |
| `run_sql` | One read-only `SELECT`, capped at a thousand rows. | This is what joins files together — the reason cross-file questions work at all. |
| `render_chart` | Runs a query and draws the result into the page. | You see the finding rather than reading a description of it. |
| `save_view` | Pins a query and its chart to your board. | It outlives the conversation. Tomorrow it is still there. |
| `eject_dataset` | Removes a dataset, after asking you first. | Your data, your call — the agent cannot drop anything silently. |

### Two more appear for every file you load

Load `transactions.csv` and these are created on the spot, named after your file. Eject it
and they disappear.

| Tool | What it does | Why you care |
|---|---|---|
| `query_transactions` | Filter, group and aggregate — with the input schema built from your actual columns. | The agent cannot invent a column that does not exist. It picks from a list of your real ones. |
| `describe_transactions` | Per-column statistics: ranges, null counts, distinct values. | Lets the agent check the data before querying, so it asks a sensible question first time. |

**This is the unusual part.** Most integrations hand an AI one generic "query" tool and
hope for the best. SiftIO builds a custom, typed tool for a file it has never seen, then
throws it away when you are done.

---

## Three panels

| Where | Panel | What it is |
|---|---|---|
| Left | **Datasets** | Drop files here. Each shows its row count, its table name, and a Labels toggle. |
| Centre | **Viewport** | Where results and charts land. The agent writes here; you read it. |
| Right | **Agent activity** | The running count of rows held versus rows seen, and a log of every call made. |

The third panel is the one that matters. It shows exactly what left your machine, so you
never have to take the privacy claim on faith.

---

## Labels

Under each dataset is a **Labels** toggle. A label is not a caption — it rewrites the tool
the agent receives.

| Label | What it changes |
|---|---|
| `timestamp` | Unlocks `since` and `until` date filters that do not otherwise exist. |
| `amount` | Becomes the default thing to total or average. |
| `category` | Leads the list of columns worth grouping by. |
| `identifier` | Removed from aggregation entirely, because a total of ID numbers is meaningless. |

The fourteen bundled samples arrive already labelled. Your own files start unlabelled and
work fine without it — labelling just sharpens the tool.

---

## What this is not, yet

**It needs an experimental browser flag today.** WebMCP is new and off by default, so the
real audience right now is people willing to flip a setting. That is exactly why this is a
hackathon entry and not a product. The bet is that browser-native agent tools become
ordinary — and if they do, this is what local-first analysis looks like.

With no agent connected it still works as a local SQL and charting tool, and the **Dev:
invoke a tool** panel lets you call any tool by hand and watch what comes back.

---

Built for [The WebMCP Challenge](https://webmcp.devpost.com/) ·
[Open SiftIO](https://siftio.marouane-kouskous.workers.dev) ·
[Source](https://github.com/marwankous/SiftIO) · MIT
