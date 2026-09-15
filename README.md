# Gridiron

Season manager for a 12-team superflex Sleeper league ("Battle for the Gridiron Throne"), built to one rule: **never reason about rosters from memory** — every recommendation starts from a fresh pull of the [Sleeper public API](https://docs.sleeper.com).

- **Dashboard** — [the-nebulizer.github.io/gridiron](https://the-nebulizer.github.io/gridiron/): outcomes only, no reasoning. A "Do now" card of concrete moves verified live against Sleeper, a "Heads up" list underneath, this week's lineup with kickoff times, the league's activity feed, a one-line outcome per routine, then standings and byes ahead. The full write-ups live in `reports/` for when you want the argument behind a call. Static page, no backend; the browser talks to Sleeper directly.
- **Data layer** — `npm run sync` snapshots the whole league to `data/league/snapshot.json` with every player ID resolved, including real bye weeks. `node scripts/league-activity.mjs` shows what the other managers have done and who they dropped that's still claimable.
- **Skills** — open Claude Code in this folder and run `/lineup`, `/waivers`, `/trade`, or `/inactives`; each syncs before it reasons.
- **Routines** — cloud agents write reports to `reports/`: trades (Mon), waivers (Tue), lineup (Thu), inactives (Sun), plus an hourly watcher. Each publishes to `main` with `scripts/publish-report.mjs` — anything else strands the report where the dashboard can't see it.

- **Planning** — `npm run outlook` shows, for every week still to come, who is on bye and which starting slots can't be filled at all, solved against the league's real slots rather than by counting bodies. `node scripts/outlook.mjs --add <id> --drop <id>` shows what a move would do to it.
- **Tests** — `npm test` runs an offline regression suite over the parts that decide what gets recommended: action lifecycle, lineup-slot legality, IR capacity, cross-routine sequencing, and the bye-week assignment.

Every report begins with a machine-checked action block compiled into `reports/actions.json` — see [`docs/ACTIONS.md`](docs/ACTIONS.md) for the contract. Sleeper's API is read-only, so all actual moves happen in the Sleeper app. Docs live in `docs/`; start with `docs/RESUME.md`.
