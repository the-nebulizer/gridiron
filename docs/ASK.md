# Ask — a chat about this week's card

The Ask page is a claude.ai Artifact at https://claude.ai/artifact/FMKnrqruo8QqrpG7qednqY (also `ask_url` in `config.json`). It shows the same "Do now" card as the dashboard, plus a box where Ben can ask Claude questions about it — "why is #1 the priority", "who could I drop for a second TE", "is there a better defense on the wire". The dashboard's Do now header links to it (`target="gridiron-ask"`) and the Ask page links back to the dashboard (`target="gridiron-dash"`) — each opens one tab and re-focuses it rather than piling up duplicates.

It asks Claude through the artifact runtime's `sample` capability on **Ben's own claude.ai account**: no API key, no separate bill, no server. Each answer spends his plan's usage the way a chat message would, and he consents once per page open. The page keeps the conversation as a turn list (Claude remembers nothing between page loads). Every call carries a standing-instructions turn built from the page's own data: the prime directive (answer only from what's on the page; say "I can't see that from here" otherwise; no news, no injuries beyond the status tags, no rankings), the league's scoring facts, what the card's four case lines mean, the standing order, and the data itself as compact labelled sections. Claude can also call two tools: `whatIf` (runs the real outlook math — `scripts/outlook-core.mjs`, inlined — against add/drop ids) and `findPlayer` (name lookup over every player on the page). There are two model tiers: **Careful** (default, thinks 5–60s) and **Quick**.

## Using it

Open it from the dashboard's "Ask ↗" link next to the Do now header. Tap one of the example chips or type a question, pick Careful or Quick, and hit Ask. It can answer anything the card, the roster, the outlook, or the free-agent pool on the page can support — including "what if" questions, run live against the real solver. It cannot see anything past the moment the page was last published: no news, no injury updates beyond the status tag baked in, no rankings, no scores since. If something has moved since, the dashboard has the live version and the page says so.

## Refreshing it

The page has no network access of its own — it's an Artifact, and Artifact pages can't reach Sleeper or any other host — so it is only as fresh as its last publish. Refresh it with:

```
node scripts/sync.mjs
node scripts/actions.mjs
npm run ask
```

then publish `ask/index.html` to the URL above with the Artifact tool from a Claude Code session (`publish` with `url` set to the artifact URL — a session that hasn't published it before must `read` it first).

**The five cloud routines cannot do this.** Their allowed tools are Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch — no Artifact tool (verified 2026-09-15 by listing the routines). So today the page refreshes only when Ben or a local session refreshes it. The page states its own data time in the header and under the card, so it's always clear how stale it is.

## The automatic option (not built)

A routine could `curl` the data bundle into a Cloudflare D1 table from Bash — that needs a Cloudflare API token in the routines' environment, a UI change only Ben can make — and the page could read it back at open time through Ben's Cloudflare connector via the artifact `mcp` capability. Scoped, not started.

## How it's built

`npm run ask` runs `scripts/ask-bundle.mjs`, which bundles three things into `ask/index.html`:

- `ask/template.html` — the markup and client JS (committed; `ask/index.html` itself is gitignored, rebuilt each time)
- the data: `data/league/snapshot.json` + `reports/actions.json`, trimmed and repackaged — plus `docs/index.html`'s own Do-now rendering code, sliced out so the card on this page renders identically to the dashboard's, and `scripts/outlook-core.mjs`, inlined, so `whatIf` runs the real solver in the page
- four placeholders the bundler fills in: `/*__DATA__*/`, `/*__DONOW_PURE__*/`, `/*__OUTLOOK_CORE__*/`, `__AS_OF__`

The data is capped at 45,000 bytes (the runtime's whole prompt cap is 64 KiB, and the standing instructions need headroom too) — the bundler trims the free-agent pool and the trending list in steps until it fits, and refuses to write the file if it still can't.

Tests: `node scripts/ask-bundle.mjs --check` validates the emitted file (data block parses and is under the cap, the do-now renderer and outlook-core regions are present) without touching Sleeper or the snapshot. The fuller smoke harness for the page's pure logic (`buildInstructions`, `whatIf`, `findPlayer`, and the rest between the `/* ask-pure start */` / `/* ask-pure end */` markers in `ask/template.html`) lives outside this repo.
