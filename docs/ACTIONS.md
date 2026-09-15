# Actions contract — the "Do now" card

The dashboard's top card lists concrete moves for Ben to make in the Sleeper app. Those moves are **structured data written by the routines and re-verified live by the page**, never prose scraped from a report. This file is the contract between the three parts:

1. Every report in `reports/` starts with an **action block** (below).
2. `node scripts/actions.mjs` validates each newest report against a fresh snapshot and compiles `reports/actions.json`.
3. `docs/index.html` reads `reports/actions.json`, checks each action against live Sleeper rosters, and renders the card.

The prime directive applies at every step: an action that names a player who is not provably where the action says they are is a validation error **at write time**, and `--check` fails.

There is a second, softer case the contract has to handle, and getting it wrong broke the whole loop once: an action written days ago that has since been **done** (Ben made the move) or **gone** (someone else took the player). Those are the system working, not a bad report. The compile carries them through with a `state` so the card can show them; only genuinely open actions are held to the strict rules. Until 2026-09-15 the compile revalidated everything as if freshly written, so acting on the advice — winning the claim, making the lineup swap, having the trade accepted — made the next routine's compile exit non-zero and publish nothing.

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

Every id in a block comes from the snapshot you just synced; never type one from memory. The block is required even when there is nothing to do: `"actions": []` with a `verdict` such as "Hold — nothing clears the bar." The dashboard never renders the report body at all — it shows the `verdict` as a one-line outcome and links to the write-up on GitHub. On GitHub the block shows as a code block.

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
| `id` | string | Optional. Compiler generates `<source>:<kind>:<player>` (`<source>:trade:<with>` for trades) when absent. |
| `after` | string | Optional. Id of an action that must be **done** before this one makes sense. The card nests this under it as "Then". |
| `if_not` | string | Optional. Id of an action this one is the **fallback** for: do this only if that one is declined, dismissed, or no longer possible. The card nests this under it as "If that falls through". |

Per-kind fields and validation (all checked against `data/league/snapshot.json`):

| kind | extra fields | validation | live "done" test on the dashboard |
|---|---|---|---|
| `add` | `drop` (id, optional), `mode` (`fcfs` or `waiver`), `faab` (integer $, waiver mode only) | `player` rostered by **no** team in the league; `drop` (if given) on my roster; `faab` between 0 and my `faab_remaining` | `player` on my roster. If another team rostered them first, the card shows "taken by <owner>". |
| `drop` | — | `player` on my roster | `player` no longer on my roster |
| `start` | `slot` (one of the league's non-BN positions), `for` (id of the starter being benched, optional) | `player` on my roster; `player`'s position must be legal in `slot`; `for` (if given) currently in my starters **and currently holding that same `slot`** (the swap must be in place, or it empties `for`'s slot); with no `for`, `slot` must already be empty | `player` in my starters and `for` (if given) not in my starters |
| `ir` | — | `player` on my roster and not already in `reserve`; the IR slot must have room (`league.reserve_slots`, netted against any `activate` in the same set) | `player` in my `reserve` |
| `activate` | — | `player` in my `reserve` | `player` on my roster and not in `reserve` |
| `trade` | `with` (roster_id), `give` (ids), `get` (ids), `message` (sendable offer text, optional) | `with` ≠ my roster_id; every `give` on my roster; every `get` on `with`'s roster | every `get` on my roster. The page cannot see pending offers, so trades also get a manual "dismiss" on the card. |

Prefer one `start` with `for` over a separate bench instruction. Never emit an action that leaves a starting slot empty — this is now enforced rather than merely asked for: a `start` whose `for` holds a different slot is rejected, as is a kicker in the QB slot or any other position/slot mismatch.

### Sequencing — the standing order and explicit dependencies

Actions from four routines land on one card, so they must not contradict each other. Two mechanisms, both enforced by the compiler:

**The standing order** (fixed, printed on the card, the same every week):

1. **Lineup moves before their kickoff.** Free, time-locked, never wait on anything.
2. **Waiver claims by Tuesday night.** They never wait for a trade. Claims process Wednesday morning in bid order.
3. **Trade offers, any time.** A player you have offered is locked in Sleeper until the other manager answers, and there is no deadline on that answer (this league's trade review is 0 days, so an accepted offer processes at once). An offer sent Monday can still be pending on Wednesday morning, so **any player in an open offer is unavailable as a drop for that week's claims**.

**Explicit dependencies** (`after` / `if_not`, above) whenever two actions touch the same resource. The compiler rejects a set of actions that conflicts without a link:

- Two open actions that **consume the same rostered player** (as `drop`, `give`, `for`, or the subject of `ir` / `activate` / `drop`) must be linked by `after` or `if_not` in one direction.
- Adds with no `drop` that are not linked to each other must not exceed the open bench slots.
- `ir` actions must not exceed `league.reserve_slots`, counting who is already in reserve and netting off any `activate` in the same set — so "activate X, then IR Y" is fine but a second body into a full IR slot is an error.
- An `ir` action for a player whose designation is not in `league.ir_eligible_statuses` is a warning, not an error: Sleeper's `reserve_allow_*` flags don't map cleanly onto every tag it displays, so this flags a likely-refused move without blocking the report.
- The bids of unlinked adds should not exceed `faab_remaining` (warning only; Sleeper skips a claim it cannot fund).
- `after` / `if_not` must reference an action that exists in the compiled set (any source), and must not form a cycle.

**Every routine reads `reports/actions.json` before writing.** Open actions from the *other* sources are standing commitments this week. A new report either avoids their resources or links to them explicitly — a waivers report must not name a drop who sits in an open trade offer unless the claim is `if_not` that trade; a trades report should prefer offers that do not include the player this week's claim intends to drop, and must say so in `why` when it cannot.

How the card treats a dependent action:

| link | parent state | dependent shows as |
|---|---|---|
| `after` | open | nested under the parent, "Then:", not counted as open |
| `after` | done | promoted to open |
| `after` | gone / dismissed | gone |
| `if_not` | open | nested under the parent, "If that falls through:", not counted as open |
| `if_not` | done | superseded, shelved |
| `if_not` | gone / dismissed | promoted to open |

Open primary actions are numbered in the standing order (lineup, then claims, then trades; urgency within each). The order is not printed on the card: the numbering is the outcome, the reasoning behind it is not something the dashboard shows.

## 2. The compiler — `scripts/actions.mjs`

```
node scripts/actions.mjs --check <file>  # strict validation of one report, no write
node scripts/actions.mjs                 # compile newest report per type -> reports/actions.json
```

**The two modes are deliberately different in strictness**, and each routine runs both: `--check` on the report it just wrote, then the compile.

| | `--check <file>` | compile |
|---|---|---|
| when | write time, on your own report | after, over all four routines' newest reports |
| an action you cannot do right now | **error** — a report should never name an impossible move | depends: see below |
| already done / gone | error | carried through with `state`, logged, exempt from the strict rules and from sequencing (they hold no player, need no bench slot, spend no FAAB) |
| open but partly overtaken (its `drop` left the roster, its `for` stopped starting, its bid now exceeds FAAB) | error | **note**, printed on every run; the stale part is dropped, the run continues |
| malformed block, bad enum, unknown player id | error | error |

Lifecycle states are computed with the same tests the dashboard applies live (section 3), so the compiler and the page always agree about what "done" means.

The `state` a compiled action carries is a note from compile time, not an instruction: `docs/index.html` recomputes every action's state against live Sleeper rosters on each refresh and that recomputation wins. So an action compiled as `gone` renders as open again if the player comes back — which is the behaviour you want, and the reason the page must never be made to trust the field.

Behaviour:

- Requires `data/league/snapshot.json`. Fails if it is missing or its `fetched_at` is more than 3 hours old ("run `node scripts/sync.mjs` first").
- Resolves player ids through the snapshot first (all rosters, trending, transactions), then `data/players.json`. An id found nowhere is an error.
- Picks the newest `reports/YYYY-MM-DD-<type>.md` for each type in `waivers`, `lineup`, `trades`, `inactives`. A missing type is fine; a report without a block, or a block that fails any rule above, is an error and the script exits non-zero without writing.
- Marks a source `stale: true` when its `week` is behind `snapshot.week` (informational). Drops only `start` actions whose `week` is behind `snapshot.week`; every other kind is kept. Every compiled action carries its `week`.
- Dedupes across sources by `kind` + `player`, keeping the action from the newest report file.
- Resolves `after` / `if_not` across all sources, rejects dangling references and cycles, and enforces the conflict rules in "Sequencing" above. Every compiled action carries `after` / `if_not` when set, plus `consumes` (the rostered ids it uses up) so the page can explain a conflict.
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

- `open` — the move is still valid and not yet made. Primary actions are numbered in the standing order (lineup, claims, trades), then by urgency, then report date (newest first). Dependents (`after` / `if_not`) nest under their parent per the Sequencing table and are not counted as open until promoted.
- `waiting` — a dependent whose parent is still open. Nested, muted.
- `superseded` — an `if_not` fallback whose parent was done. Shelved with done.
- `done` — the live test in the table above passes. Collapsed under a "Done" toggle, together with `gone` (below).
- `gone` — the move is no longer possible: an `add` whose player is now on someone else's roster (shown with the owner's name), or a `start` / `ir` / `activate` / `drop` whose player has left my roster. Shelved under the same toggle as `done`, counted separately, never shown as an instruction.
- `stale` — a `start` action whose `week` is behind the live NFL week. Hidden. Other kinds never go stale by week.
- `dismissed` — trades only, via a button; stored in `localStorage` keyed by action id + the source report filename, wrapped in try/catch. A dismissed trade stays hidden until a newer trades report replaces it.

Each open item shows, in order: the move in one bold line with player names, the deadline chip (mono, right-aligned), the `why` sentence, for a trade its `message` under a collapsed "Offer message" toggle, and a source line ("Waivers · 2026-09-15 · verified live 14:02"). One "Open Sleeper ↗" link in the card header, not per item. A dependent says "If that falls through:" or "Then:" and nothing more — which player the two actions contend over is the compiler's business, not the reader's.

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
