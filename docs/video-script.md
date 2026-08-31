# Demo video — script and shot list

**Requirements:** under 3 minutes · public on YouTube · must have audio · must show the
project functioning. Aim for **2:30–2:45** so you are not fighting the clock.

---

## Before you hit record

- [ ] **Start with an empty vault.** The "tools appear" moment is the whole point, and it
      only lands if the app starts with nothing loaded. In DevTools →
      Application → IndexedDB, delete `keyval-store`, then **close and reopen the tab**
      (a pending delete blocks the next page's connection).
- [ ] Set the currency picker to whatever you want on camera, or `no symbol`.
- [ ] Both side panels open. Window maximised, browser zoom 100%.
- [ ] Close other tabs, notifications off, and check nothing personal is on screen.
- [ ] Do one silent dry run. The wasm bundle downloads on first ingest, so the *second*
      run is noticeably faster — record that one.
- [ ] Record at 1080p. Xbox Game Bar (`Win+G`) works; OBS gives you better audio control.

**Where to record:** the ChatGPT desktop app's built-in browser if it works on your
machine — that is the only way to film a real conversation. Otherwise Chrome with
`chrome://flags/#enable-webmcp-testing` enabled and drive it from the page (Plan B below).
Decide this *before* the deadline, not on the day.

---

## Plan A — with a real agent (preferred)

### 0:00–0:20 · The problem

*Screen: SiftIO open, empty state showing.*

> "This is a bank export — five years, forty thousand rows. I want to ask an AI about it,
> and I am never going to upload it. That is the trade everyone accepts, and it only
> exists because of where the code runs."

### 0:20–0:45 · Load data, and watch the toolset change

*Screen: point at "7 tools registered". Ask the agent to load the samples.*

> "SiftIO runs a real database — DuckDB, compiled to WebAssembly — inside this tab. Watch
> the right-hand panel as data loads."

*Tools jump from 7 to 11. Let it breathe for a second.*

> "Those two new tools were generated just now, from the actual columns in that file. The
> agent has a typed tool for a file that did not exist a moment ago."

### 0:45–1:35 · The question

*Type into the agent:*
> **"Which spending category is highest on days I worked out? Chart it."**

> "That needs two separate files joined together — the thing a spreadsheet cannot do.
> The agent writes the query, SiftIO runs it here, and the chart is drawn into the page."

*Chart and insight card appear. Read the insight aloud.*

> "Shopping is highest, ninety-seven ahead of groceries."

### 1:35–2:05 · The payoff

*Point at the counter.*

> "Here is the part that matters. Five thousand rows are sitting in my browser. Six rows
> ever reached the model — and every single call is logged, in plain English, with the
> exact payload one click away. You do not have to take the privacy claim on faith; you
> can check it."

### 2:05–2:30 · The human half

*Open a dataset's Labels.*

> "It works the other way too. Labelling this column as an identifier removes it from the
> agent's aggregate list, because a total of ID numbers is meaningless. Labelling a date
> column unlocks range filters that did not exist before. One click changes what the agent
> is *able* to ask."

### 2:30–2:45 · Close

*Eject a dataset; tools drop.*

> "No backend, no upload, no account. Your data stays in the browser — only the answers
> leave."

---

## Plan B — no agent available

Same script, but replace the agent turns. Say once, early and without apology:

> "WebMCP shipped days ago and is still behind a flag, so I will drive the same tools
> directly — this is the identical code path an agent uses."

- **0:20** click **Load sample data** instead of asking the agent
- **0:45** click the suggested question **"Chart workout-day spending by category"** in the
  viewport — it calls the real `render_chart` tool and lands in the audit like any other call
- **1:35** add: open DevTools and run `await document.modelContext.getTools()` to show the
  live tool list. This is worth 10 seconds; it is hard proof the tools are genuinely
  published to the browser
- Everything else is unchanged

Plan B is a perfectly respectable submission. Judges know the client side is days old — a
video that is straight about it reads better than one implying a conversation you could
not record.

---

## Publishing

- Upload to YouTube as **Public** (not Unlisted — the rules say public).
- Title: `SiftIO — ask an AI about data you would never upload`
- Description: one line, the live URL, the repo URL.
- Paste the link into the Devpost **Video demo link** field and check it plays in a private
  window before you submit.

---

## What judges are scoring

| Criterion | The shot that earns it |
|---|---|
| **WebMCP leverage** | Tool count changing as datasets load; the generated per-file tool |
| **Execution** | The whole flow working end to end without a stumble |
| **Impact** | The rows-held vs rows-seen counter |
| **Creativity** | Labels changing what the agent can do |

If you only have time to nail one thing, nail the counter. It is the only moment that
makes someone sit up.
