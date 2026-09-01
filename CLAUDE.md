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
- **$100 FAAB**, waivers process **Wednesday**; trade deadline **W11**; playoffs 7 teams, **W15–17**
- Scoring implication that generic rankings miss: with 6-pt pass TDs in superflex, a startable QB in SUPER_FLEX nearly always beats a WR/TE there.

## Calendar calibration (check EVERY run)

The snapshot carries `season_start_date` and `games_have_started`. Sleeper labels the league "in_season, week 1" as soon as drafts end — do not trust that label; trust the date.

**Before `season_start_date`** (pre-season): unrostered players are largely first-come-first-serve — adds are instant and cost $0 FAAB, not Wednesday bids (confirm from the snapshot: `free_agent` transactions completing at creation time = FCFS mode). Recommend "add NOW", never "bid and wait". No games exist yet: no points, no inactives, no start/sit urgency; injury tags are camp designations. A routine that fires when its job doesn't exist yet (e.g. Sunday inactives with no Sunday games) writes a one-paragraph report saying exactly that and stops.

**After kickoff**: players lock to waivers per league rules (Wednesday processing, FAAB bids) and the skills' normal guidance applies.

## Layout

- `config.json` — league/user IDs (public data, committed)
- `scripts/sleeper.mjs` — API client; `scripts/sync.mjs` — snapshot builder
- `data/` — gitignored cache (`players.json` refreshed when >24h old; `league/snapshot.json` per sync)
- `.claude/skills/` — `/lineup`, `/waivers`, `/trade`
- `docs/` — league facts, season plan, resume doc
