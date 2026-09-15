# Gridiron

Ben's fantasy football season manager for **"Battle for the Gridiron Throne"** (Sleeper). Local Claude Code tool: a thin data layer over the Sleeper public API + skills for the weekly loop. Read `docs/RESUME.md` first when picking up work.

## Prime directive

**Never reason about rosters, availability, or draft state from memory, pasted text, or web snippets.** This project exists because a chat-based workflow hallucinated player availability on draft day. Before ANY recommendation:

```
node scripts/sync.mjs        # optionally: node scripts/sync.mjs <week>
```

then read `data/league/snapshot.json`. That file is the only truth about who is rostered, starting, or available. Web research is for **news, injuries, and rankings only** — never for who-is-on-what-roster. If sync fails, stop and say so; do not proceed from stale data.

## League constants (verified via API)

- League ID `1353093442397294592`, 12 teams; Ben = `JustBenwastaken`, roster_id **12**
- **Superflex** (QB/2RB/2WR/TE/FLEX/SUPER_FLEX/K/DEF + 5 BN + 1 IR), **6-pt pass TDs**, **half-PPR**
- **$100 FAAB**, 2-day waiver clear, waivers process **Wednesday**; trade deadline **W11**; playoffs 7 teams, **W15–17**
- **Keeper league** — `max_keepers: 1`, so a young player has value past this season. **Draft picks cannot be traded.** Trade review is 0 days (an accepted offer processes at once); 6 votes veto.
- **Two divisions**, and `league_average_match` is on — every team also plays the **league median** each week, so a high floor wins twice and a boom bench wins once.
- **One IR slot**, and Sleeper only accepts certain designations in it — read `league.reserve_slots` and `league.ir_eligible_statuses` from the snapshot rather than assuming IR is a free bench spot.
- Scoring implication that generic rankings miss: with 6-pt pass TDs in superflex, a startable QB in SUPER_FLEX nearly always beats a WR/TE there.

Every one of these is in the snapshot under `league`, read from the API on each sync. Quote the snapshot, not this list.

## Calendar calibration (check EVERY run)

The snapshot carries `season_start_date` and `games_have_started` (the latter is true only once a real game has left `pre_game` in the Sleeper schedule — not a date comparison). Sleeper labels the league "in_season, week 1" as soon as drafts end — do not trust that label; trust the date.

**Before `season_start_date`** (pre-season): unrostered players are largely first-come-first-serve — adds are instant and cost $0 FAAB, not Wednesday bids (confirm from the snapshot: `free_agent` transactions completing at creation time = FCFS mode). Recommend "add NOW", never "bid and wait". No games exist yet: no points, no inactives, no start/sit urgency; injury tags are camp designations. A routine that fires when its job doesn't exist yet (e.g. Sunday inactives with no Sunday games) writes a one-paragraph report saying exactly that and stops.

**After kickoff**: players lock to waivers per league rules (Wednesday processing, FAAB bids) and the skills' normal guidance applies.

## Forward awareness (every recommendation, not just this week's)

A recommendation that only weighs the current week is how a roster ends up with four QBs and one TE, or with its kicker and defense on bye in the same week and no FAAB left to cover it. Every sync computes `snapshot.outlook` (`scripts/outlook.mjs`) and every routine reads it:

- `roster_shape` — how many I have at each position, how many the lineup demands, which bench and IR slots are open, and `thin_positions`: the positions with no cover if one body is lost.
- `weeks` — for **every week still to come**, who is on bye and which starting slots cannot be filled at all. The question is solved as a real assignment against the league's slots, so FLEX and SUPER_FLEX are accounted for; a bare count per position is not an answer.
- `crunch_weeks`, `playoff_weeks`, `weeks_until_trade_deadline` — what to plan budget and trades around.

Never count a position by hand, and never state a bye week from memory — both are already computed. Before recommending a swap, check what it does to the rest of the season:

```
node scripts/outlook.mjs                          # the roster as it stands
node scripts/outlook.mjs --add <id> --drop <id>   # the same view if I made that move
```

A move that fixes one week and empties a slot in another is a trade-off to state plainly in the report, never a hidden cost. Weeks 15–17 are the fantasy playoffs and count for more than a Week 3 upgrade.

## Publishing a report (every scheduled run, without exception)

The dashboard reads `reports/` from **`main` only**. Scheduled runs happen on their own session branch, so an ordinary `git commit` + `git push` leaves the report where nobody will ever see it — the same as not writing it. Four reports were lost this way between Sep 3 and Sep 8, including a time-critical waiver call.

Every report begins with the action block described in `docs/ACTIONS.md`, and `node scripts/actions.mjs` must pass — compiling `reports/actions.json` — before the report is published; publish the report and `reports/actions.json` together in the same command.

So finish every run with:

```
node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> <type>"
```

It commits, pushes `HEAD:main`, rebases once if main moved, and if it still can't get there, pushes a branch and tells you to open a PR. **Never end a run with the report only on a session branch, and never end one silently — the final message must say where the report landed.**

## Sequencing

Every routine reads `reports/actions.json` before writing. Open actions from the other routines are standing commitments this week, not suggestions to override. Conflicts over the same player get linked with `after` / `if_not` per `docs/ACTIONS.md`, and the compiler refuses to write `reports/actions.json` when a conflict is left unlinked.

## Usage discipline

Ben is on a usage-metered plan. The dashboard costs nothing; every scheduled run costs tokens. Read only what the task needs (the watcher runs its two scripts before reading anything else and stops on UNCHANGED); web-research only the handful of candidates a decision turns on, never the whole trending list; and mechanical jobs — the inactives lookup, the roster watcher — belong on Haiku, judgment jobs on Sonnet, nothing on Opus. Model choice lives in each routine's settings (`docs/ROUTINES.md`).

## Report voice

Reports in `reports/` and the dashboard's own copy are written for Ben, not for the machine. Say what's true in plain English; keep the plumbing out of the copy — no command lines, no snapshot field names (`games_have_started`, `season_start_date`, `faab_bid`), no "scanned `data/league/snapshot.json`". The prime directive still requires the sync, and the report should still say the data is fresh and where the calendar stands — as a sentence a manager would read ("Read off a fresh sync; Week 1 hasn't kicked off yet"), not as evidence of compliance. Naming a slash command Ben can run (`/lineup`) or a doc he can open (`docs/LEAGUE.md`) is fine; those are for him. Same on the dashboard: show a date, not a report filename; show a reason, not an exception string.

## Layout

- `config.json` — league/user IDs (public data, committed)
- `scripts/sleeper.mjs` — API client; `scripts/sync.mjs` — snapshot builder; `scripts/actions.mjs` — compiles report action blocks into `reports/actions.json`
- `scripts/outlook.mjs` — the forward view: positional counts, and every week ahead I can't field a legal lineup. Runs inside every sync; also a what-if tool (`--add` / `--drop`)
- `scripts/league-activity.mjs` — what the other 11 managers have done, and who they dropped that's still claimable
- `data/` — gitignored cache (`players.json` refreshed when >24h old; `league/snapshot.json` per sync)
- `.claude/skills/` — `/lineup`, `/waivers`, `/trade`, `/inactives`
- `docs/` — league facts, season plan, resume doc, `docs/ACTIONS.md` (the "Do now" card contract)
