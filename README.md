# Gridiron

Season manager for a 12-team superflex Sleeper league ("Battle for the Gridiron Throne"), built to one rule: **never reason about rosters from memory** — every recommendation starts from a fresh pull of the [Sleeper public API](https://docs.sleeper.com).

- **Dashboard** — [the-nebulizer.github.io/gridiron](https://the-nebulizer.github.io/gridiron/), organized by what needs deciding: what's on the clock, this week's lineup with kickoff times, the league's activity feed, the written brief, then standings and byes ahead. Static page, no backend; the browser talks to Sleeper directly.
- **Data layer** — `npm run sync` snapshots the whole league to `data/league/snapshot.json` with every player ID resolved, including real bye weeks. `node scripts/league-activity.mjs` shows what the other managers have done and who they dropped that's still claimable.
- **Skills** — open Claude Code in this folder and run `/lineup`, `/waivers`, or `/trade`; each syncs before it reasons.
- **Routines** — cloud agents write reports to `reports/`: trades (Mon), waivers (Tue), lineup (Thu), inactives (Sun), plus an hourly watcher. Each publishes to `main` with `scripts/publish-report.mjs` — anything else strands the report where the dashboard can't see it.

Sleeper's API is read-only, so all actual moves happen in the Sleeper app. Docs live in `docs/`; start with `docs/RESUME.md`.
