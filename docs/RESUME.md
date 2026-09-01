# RESUME — pick up here

Read this first in any new session.

## What this is

Season manager for Ben's Sleeper league. Ground truth = `node scripts/sync.mjs` → `data/league/snapshot.json`. See `CLAUDE.md` for the prime directive and league constants.

## State (2026-09-01)

- **Built + verified**: data layer (`scripts/`), snapshot resolves all 12 rosters to real names against the live league; skills `/lineup`, `/waivers`, `/trade`; docs.
- **Scheduled routines**: Tue ~7am waiver report, Sun ~11am ET inactives check — status: see repo issues/log; created at initial build (verify they still exist with `/schedule list`).
- **Not done**: nothing in-app can be automated (Sleeper API is read-only — all roster moves are manual in the Sleeper app).

## Next steps

1. Week 1: run `/lineup` before Sunday; act on SEASON-PLAN "Immediate" items (Charbonnet → IR if eligible).
2. Keep `docs/SEASON-PLAN.md` log current after each transaction.
3. Phase two (Aug 2027): draft assistant — poll `GET /v1/draft/{draft_id}/picks` via `scripts/sleeper.mjs`, filter cached verified rankings to available-only; consider zacharytran26/Fantasy-Football-Draft-MCP (MIT, Python) alongside for model projections.

## Conventions

- No secrets anywhere; everything is public API data.
- `data/` is a disposable gitignored cache — regenerate any time with sync.
