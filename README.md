# Gridiron

Season manager for a 12-team superflex Sleeper league ("Battle for the Gridiron Throne"), built to one rule: **never reason about rosters from memory** — every recommendation starts from a fresh pull of the [Sleeper public API](https://docs.sleeper.com).

- **Dashboard** — [the-nebulizer.github.io/gridiron](https://the-nebulizer.github.io/gridiron/): live scorebug, slot-by-slot lineups, standings, trending free agents. Static page, no backend; the browser talks to Sleeper directly.
- **Data layer** — `npm run sync` snapshots the whole league to `data/league/snapshot.json` with every player ID resolved.
- **Skills** — open Claude Code in this folder and run `/lineup`, `/waivers`, or `/trade`; each syncs before it reasons.
- **Routines** — cloud agents commit a Tuesday waiver report and a Sunday inactives check to `reports/`.

Sleeper's API is read-only, so all actual moves happen in the Sleeper app. Docs live in `docs/`; start with `docs/RESUME.md`.
