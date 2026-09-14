# Actions contract — the "Do now" card

The dashboard's top card lists concrete moves for Ben to make in the Sleeper app. Those moves are **structured data written by the routines and re-verified live by the page**, never prose scraped from a report. This file is the contract between the three parts:

1. Every report in `reports/` starts with an **action block** (below).
2. `node scripts/actions.mjs` validates each newest report against a fresh snapshot and compiles `reports/actions.json`.
3. `docs/index.html` reads `reports/actions.json`, checks each action against live Sleeper rosters, and renders the card.

The prime directive applies at every step: an action that names a player who is not provably where the action says they are is a validation error, and the compile fails.

## 1. The action block (in every report)

Directly under the report's `# H1` line, before any other content, a fenced code block tagged `actions` containing one JSON object:

````markdown
# Week 2 waivers — one add clears the bar

```actions
{
  "week": 2,
  "verdict": "Add Justice Hill now; drop Bryce Young to make room.",
  "next_check": "Lineup, Thu 7am",
  "actions": [
    {
      "kind": "add",
      "player": "<id from snapshot trending.adds>",
      "drop": "9228",
      "mode": "fcfs",
      "urgency": "now",
      "deadline_label": "first-come-first-serve, $0",
      "why": "Henry handcuff with a pass-down role; Young is your QB4 and never starts."
    }
  ]
}
```

Rest of the report: the supporting argument, in prose.
````

Every id in a block comes from the snapshot you just synced; never type one from memory. The block is required even when there is nothing to do: `"actions": []` with a `verdict` such as "Hold — nothing clears the bar." The dashboard strips the block before rendering the report on the brief tab; on GitHub it shows as a code block.

### Top-level fields

| field | type | rule |
|---|---|---|
| `week` | integer | The NFL week the report is about. Required. Sleeper flips its week number on Tuesday, so only `start` actions expire by week (see "stale" below); every other kind stays open until it is done or a newer report of the same type replaces it. |
| `verdict` | string | One sentence a human reads first. Required, non-empty. |
| `next_check` | string | The next routine due to run after this one, whatever its type — the weekly cycle is trades Mon 7am → waivers Tue 7am → lineup Thu 7am → inactives Sun 10am → trades. So a waivers report says `"Lineup, Thu 7am"` and a lineup report says `"Inactives, Sun 10am"`. Shown in the card's empty state. Required. |
| `actions` | array | Zero or more action objects. Required. |

### Action object

Common fields:

| field | type | rule |
|---|---|---|
| `kind` | enum | `add` · `drop` · `start` · `ir` · `activate` · `trade` |
| `player` | string | Sleeper player id (`"4881"`), or team code for a defense (`"BUF"`). Not used for `trade`. |
| `urgency` | enum | `now` · `before_kickoff` · `by_tuesday` · `this_week` · `optional` (sort order, highest first) |
| `deadline_label` | string | Optional. Human deadline, e.g. `"before Sun 1:00pm ET"`. Card falls back to a default per urgency. |
| `why` | string | One sentence, at most 200 characters. Required. |
| `id` | string | Optional. Compiler generates `<source>:<kind>:<player>` when absent. |

Per-kind fields and validation (all checked against `data/league/snapshot.json`):

| kind | extra fields | validation | live "done" test on the dashboard |
|---|---|---|---|
| `add` | `drop` (id, optional), `mode` (`fcfs` or `waiver`), `faab` (integer $, waiver mode only) | `player` rostered by **no** team in the league; `drop` (if given) on my roster; `faab` between 0 and my `faab_remaining` | `player` on my roster. If another team rostered them first, the card shows "taken by <owner>". |
| `drop` | — | `player` on my roster | `player` no longer on my roster |
| `start` | `slot` (one of the league's non-BN positions), `for` (id of the starter being benched, optional) | `player` on my roster; `for` (if given) currently in my starters | `player` in my starters and `for` (if given) not in my starters |
| `ir` | — | `player` on my roster and not already in `reserve` | `player` in my `reserve` |
| `activate` | — | `player` in my `reserve` | `player` on my roster and not in `reserve` |
| `trade` | `with` (roster_id), `give` (ids), `get` (ids), `message` (sendable offer text, optional) | `with` ≠ my roster_id; every `give` on my roster; every `get` on `with`'s roster | every `get` on my roster. The page cannot see pending offers, so trades also get a manual "dismiss" on the card. |

Prefer one `start` with `for` over a separate bench instruction. Never emit an action that leaves a starting slot empty.

## 2. The compiler — `scripts/actions.mjs`

```
node scripts/actions.mjs                 # validate newest report per type, write reports/actions.json
node scripts/actions.mjs --check <file>  # validate one report only, no write
```

Behaviour:

- Requires `data/league/snapshot.json`. Fails if it is missing or its `fetched_at` is more than 3 hours old ("run `node scripts/sync.mjs` first").
- Resolves player ids through the snapshot first (all rosters, trending, transactions), then `data/players.json`. An id found nowhere is an error.
- Picks the newest `reports/YYYY-MM-DD-<type>.md` for each type in `waivers`, `lineup`, `trades`, `inactives`. A missing type is fine; a report without a block, or a block that fails any rule above, is an error and the script exits non-zero without writing.
- Marks a source `stale: true` when its `week` is behind `snapshot.week` (informational). Drops only `start` actions whose `week` is behind `snapshot.week`; every other kind is kept. Every compiled action carries its `week`.
- Dedupes across sources by `kind` + `player`, keeping the action from the newest report file.
- Writes `reports/actions.json`:

```json
{
  "compiled_at": "2026-09-15T12:03:00Z",
  "season": "2026",
  "week": 2,
  "games_have_started": true,
  "roster": { "starters": ["4881", "..."], "bench": ["..."], "reserve": ["..."] },
  "sources": {
    "waivers":   { "report": "2026-09-15-waivers.md", "week": 2, "verdict": "...", "next_check": "...", "stale": false },
    "lineup":    { "report": "2026-09-10-lineup.md",  "week": 1, "verdict": "...", "next_check": "...", "stale": true }
  },
  "actions": [
    { "id": "waivers:add:11000", "source": "waivers", "report": "2026-09-15-waivers.md", "week": 2,
      "kind": "add", "player": "11000", "name": "Justice Hill", "pos": "RB", "team": "BAL",
      "drop": "9228", "drop_name": "Bryce Young", "mode": "fcfs",
      "urgency": "now", "deadline_label": "first-come-first-serve, $0", "why": "..." }
  ]
}
```

`roster` is the roster part of `reports/.roster-fingerprint.json` (my starter ids in slot order, bench and reserve ids sorted; not the `hurt` list), so the page can tell when the roster has moved since the actions were written. Every player id in an action gets a resolved `name`, `pos`, `team` (and `drop_name`, `for_name`, `give_names`, `get_names`, `with_owner` as applicable).

## 3. The card — `docs/index.html`

Sits above the scorebug. Reads `reports/actions.json` from raw.githubusercontent.com with a cache-buster on every refresh. Then, per action, against the **live** Sleeper rosters just fetched:

- `open` — the move is still valid and not yet made. Sorted by urgency, then by report date (newest first).
- `done` — the live test in the table above passes. Collapsed under a "Done" toggle, together with `gone` (below).
- `gone` — the move is no longer possible: an `add` whose player is now on someone else's roster (shown with the owner's name), or a `start` / `ir` / `activate` / `drop` whose player has left my roster. Shelved under the same toggle as `done`, counted separately, never shown as an instruction.
- `stale` — a `start` action whose `week` is behind the live NFL week. Hidden. Other kinds never go stale by week.
- `dismissed` — trades only, via a button; stored in `localStorage` keyed by action id + the source report filename, wrapped in try/catch. A dismissed trade stays hidden until a newer trades report replaces it.

Each open item shows, in order: the move in one bold line with player names, the deadline chip (mono, right-aligned), the `why` sentence, for a trade its `message` under a collapsed "Offer message" toggle, and a source line ("Waivers · 2026-09-15 · verified live 14:02"). One "Open Sleeper ↗" link in the card header, not per item.

**Mechanical alerts** the page computes itself from live data and shows under the actions as "Heads up" (they need no judgment and never go stale). A heads-up whose player already has an open action in the card above is suppressed — the routines have already turned it into an instruction, so it isn't also raised as a separate alert:

- a starter carrying any injury tag, with the kickoff to decide by (Out/Doubtful/IR/PUP red; Questionable amber);
- an empty starting slot (red);
- a player in the IR slot with no injury designation (amber);
- the page's existing items: a claimable player another manager just dropped, a hot free agent nobody rosters, a bench player out for the season, byes within three weeks.

Before `season_start_date` an injury tag is a camp designation, so the routines' action blocks should not turn one into a `start` action; the page still shows the tag.

**Empty state**: "Nothing to do." followed by the `next_check` of the freshest non-stale source, plus any heads-up alerts. Never a blank card.

**Roster drift**: if the live roster differs from `actions.json.roster`, a one-line note says the roster has changed since these were written and the watcher re-runs within the hour.

## 4. Who runs what

- Each skill (`/waivers`, `/lineup`, `/trade`, `/inactives`) writes the block, runs `node scripts/actions.mjs` and stops on failure, then publishes the report and `reports/actions.json` in one commit: `node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> <type>"`.
- The roster watcher regenerates all four reports after any move, recompiles, and commits the reports, `reports/actions.json` and the fingerprint together.
