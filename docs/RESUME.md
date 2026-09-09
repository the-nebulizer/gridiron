# RESUME — pick up here

Read this first in any new session.

## What this is

Season manager for Ben's Sleeper league. Ground truth = `node scripts/sync.mjs` → `data/league/snapshot.json`. See `CLAUDE.md` for the prime directive and league constants.

## State (2026-09-09)

- **Built + verified**: data layer (`scripts/`), snapshot resolves all 12 rosters to real names against the live league; skills `/lineup`, `/waivers`, `/trade`; docs.
- **Dashboard**: `docs/index.html` on GitHub Pages (main//docs) at https://the-nebulizer.github.io/gridiron/ — client-side Sleeper fetches (CORS open), scorebug + lineups + standings + trending; auto-refreshes every 2 min while visible. Repo is PUBLIC by Ben's choice.
- **Scheduled routines** (all verified working after Ben allowed api.sleeper.app in the cloud env network settings; reports commit to `reports/`):
  - Tue 7am waivers `trig_018jkMrmz2vDLU6qQdiGeKZE`
  - Sun 10am inactives `trig_01WEymfugQorRLQeP2YLdvqx`
  - Thu 7am lineup `trig_01DxqQ5pTd1sJRc8CSnX4YHy`
  - Mon 7am trade hunt `trig_01Jr9ik2fKEiwcs4yaS99ZeQ`
  - The dashboard's "The brief" section renders the newest report per type with a Run-fresh link to each routine.
- **Bye weeks are data now (2026-09-09)**: the snapshot's `bye_week` used to be `null` for every player — `sync.mjs` read a field the Sleeper players dump doesn't have, so every bye statement in reports/docs was asserted from memory. Byes now come from `GET /schedule/nfl/regular/{season}` (`sleeper.getSchedule` / `sleeper.byeWeeks`), and `games_have_started` is now true only once a game has actually left `pre_game`. Read byes off the snapshot; the map is in `docs/LEAGUE.md`.
- **Known gap**: `scripts/roster-changed.mjs` fingerprints **only Ben's roster**, so the hourly watcher never re-runs reports when another manager moves — that's how the 09-07 trade report went stale on jimmygwithabigd's QB add. Widening the fingerprint to all 12 rosters would fix it, at the cost of far more re-runs.
- **Not done**: nothing in-app can be automated (Sleeper API is read-only — all roster moves are manual in the Sleeper app).

## Next steps

1. Week 1: run `/lineup` before Sunday; act on SEASON-PLAN "Immediate" items (Charbonnet → IR if eligible).
2. Keep `docs/SEASON-PLAN.md` log current after each transaction.
3. Phase two (Aug 2027): draft assistant — poll `GET /v1/draft/{draft_id}/picks` via `scripts/sleeper.mjs`, filter cached verified rankings to available-only; consider zacharytran26/Fantasy-Football-Draft-MCP (MIT, Python) alongside for model projections.

## Conventions

- No secrets anywhere; everything is public API data.
- `data/` is a disposable gitignored cache — regenerate any time with sync.
