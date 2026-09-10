# RESUME — pick up here

Read this first in any new session.

## What this is

Season manager for Ben's Sleeper league. Ground truth = `node scripts/sync.mjs` → `data/league/snapshot.json`. See `CLAUDE.md` for the prime directive and league constants.

## State (2026-09-09)

- **Built + verified**: data layer (`scripts/`), snapshot resolves all 12 rosters to real names against the live league; skills `/lineup`, `/waivers`, `/trade`; docs.
- **Dashboard**: `docs/index.html` on GitHub Pages (main//docs) at https://the-nebulizer.github.io/gridiron/ — client-side Sleeper fetches (CORS open), scorebug + lineups + standings + trending; auto-refreshes every 2 min while visible. Repo is PUBLIC by Ben's choice.
- **Scheduled routines — v2 set is live (2026-09-10)**: five replacement routines created by the agent with corrected prompts and schedules (fresh session each run, claude-sonnet-5, email notifications on). Reports publish to `reports/` on `main`:
  - Tue 6:50am waivers `trig_01Trg3Y2E7KekK96P5YRbMPj`
  - Thu 6:50am lineup `trig_012wLdkGSPX1aJqMRfLJsLkr`
  - Mon 6:50am trade hunt `trig_0178fSEQwNLokG5GEkXfF3WT`
  - Sun 10:40am inactives `trig_01RfeuBVHsB7bQaXfdULQjrJ` (cron must move to `40 16 * * 0` on Nov 1)
  - Roster watcher twice daily (7:30am / 5:30pm) `trig_013F1F8HFMJTYYAD1gEhJ6PF`
  - **The original five are still enabled and only Ben can switch them off** (created outside agent control; the API refuses to edit or disable them): waivers `trig_018jkMrmz2vDLU6qQdiGeKZE`, lineup `trig_01DxqQ5pTd1sJRc8CSnX4YHy`, inactives `trig_01WEymfugQorRLQeP2YLdvqx`, trades `trig_01Jr9ik2fKEiwcs4yaS99ZeQ`, watcher `trig_01DTuqiqG69gfwSjFfW65vah`. Until then both sets run and the old ones strand or duplicate their reports. Checklist and cost picture (old ≈ $19.60/wk, v2 ≈ $4.70/wk) in `docs/ROUTINES.md`.
  - The dashboard's "The brief" section renders the newest report per type with a Run-fresh link to each v2 routine.
- **Bye weeks are data now (2026-09-09)**: the snapshot's `bye_week` used to be `null` for every player — `sync.mjs` read a field the Sleeper players dump doesn't have, so every bye statement in reports/docs was asserted from memory. Byes now come from `GET /schedule/nfl/regular/{season}` (`sleeper.getSchedule` / `sleeper.byeWeeks`), and `games_have_started` is now true only once a game has actually left `pre_game`. Read byes off the snapshot; the map is in `docs/LEAGUE.md`.
- **Reports were being stranded (found + fixed 2026-09-10)**: all five routines were firing and succeeding, but their sessions run *on* their outcome branch, so "commit to main and push" landed on `claude/<name>-<suffix>` instead. Five reports (Sep 3 lineup, Sep 3 waivers, Sep 6 inactives, Sep 8 waivers, and the Sep 10 lineup found later the same day) never reached the dashboard — including a time-critical "add Vele free today, last chance before kickoff". All five recovered onto main. **The original routine prompts could not be edited** — they were created outside agent control and the API refuses updates — so the fix lives in the repo: `scripts/publish-report.mjs` (pushes `HEAD:main`, rebases once, falls back to a branch and says so), the "Publishing a report" section in `CLAUDE.md`, and a publish line at the end of each skill. `publish-report.mjs` now also takes `--replace`, which lets a later same-day run supersede an earlier version of the same report on main (that flag is on this branch and merges via a follow-up PR). The v2 routines call the script with `--replace` directly in their prompts, so they don't depend on the model finding it in the docs. The dashboard also flags a routine whose scheduled day passed with no report.
- **Dashboard rebuilt around decisions (2026-09-10)**: "On the clock" first (claimable drops, top available free agents, injured starters, byes within three weeks), then this week's lineup with kickoff times and TV, then the league activity feed, then the written brief, then standings and byes ahead. Kickoffs come from `scores/nfl/regular/{season}/{week}`.
- **Known gap**: `scripts/roster-changed.mjs` fingerprints **only Ben's roster**, so the twice-daily watcher still doesn't re-run reports when another manager moves. The dashboard now covers this live, so it matters less; widening the fingerprint to all 12 rosters would fix it properly, at the cost of far more re-runs.
- **Not done**: nothing in-app can be automated (Sleeper API is read-only — all roster moves are manual in the Sleeper app).

## Next steps

1. Week 1: run `/lineup` before Sunday; act on SEASON-PLAN "Immediate" items (Charbonnet → IR if eligible).
2. Keep `docs/SEASON-PLAN.md` log current after each transaction.
3. Phase two (Aug 2027): draft assistant — poll `GET /v1/draft/{draft_id}/picks` via `scripts/sleeper.mjs`, filter cached verified rankings to available-only; consider zacharytran26/Fantasy-Football-Draft-MCP (MIT, Python) alongside for model projections.

## Conventions

- No secrets anywhere; everything is public API data.
- `data/` is a disposable gitignored cache — regenerate any time with sync.
