# Next season — rollover checklist

Sleeper creates a **new league every season** (new league id, new roster ids, possibly new rules). Nothing in `config.json` carries over by itself, and last season's advice applied to a changed league is how a tool like this goes quietly wrong. In order:

1. **Find and adopt the league.** Once the commissioner has rolled it over:
   ```
   node scripts/new-season.mjs --season 2027           # look first: which league, which rules changed
   node scripts/new-season.mjs --season 2027 --write   # adopt: config.json + docs/league-constants.json
   node scripts/sync.mjs
   ```
   It matches through Sleeper's `previous_league_id`, then by name, and refuses to guess between two. It prints every rule that moved (FAAB budget, scoring entries, roster slots, deadline, keepers, playoff weeks).
2. **Correct the prose where the rules moved.** `CLAUDE.md` "League constants", `docs/LEAGUE.md` and the skills quote them. Sync prints **LEAGUE RULES CHANGED** until the baseline is refreshed, so the warning is the to-do list.
3. **Keepers.** The league has `max_keepers: 1`. Decide the keeper before the draft; the keeper deadline is the commissioner's. Last season's roster is the input, not the snapshot (the new league starts with the keepers carried over — read it, don't assume it).
4. **Draft (phase two, `docs/RESUME.md`).** Poll `GET /v1/draft/{draft_id}/picks`, filter verified rankings to what is still available. The prime directive applies hardest here: never reason about who is available from memory.
5. **Routines (Ben, in the claude.ai UI).** The four scheduled routines and the roster watcher are created outside agent control, so crons, prompts and models can only be changed there (`docs/ROUTINES.md`). Check that none points at last season's data.
6. **Reset the season-specific docs.** `docs/SEASON-PLAN.md`, the "State" section of `docs/RESUME.md`. Archive `reports/` for the old season (the dashboard reads `reports/` from `main`; move the old ones to `reports/2026/` and check the dashboard still finds the newest of each kind).
7. **Pre-season is first-come-first-serve** (CLAUDE.md "Calendar calibration"): adds are instant and cost $0 until the first kickoff. Confirm from the transaction log, not from the calendar.
8. **Run `npm test`** after any change; CI runs it on every push (`.github/workflows/test.yml`).

## What carries over by design

- The points model, matchup sheet, outlook, stream and denial scripts read everything from the snapshot, so they follow the new league without edits.
- `snapshot.transaction_history` rebuilds from Sleeper each sync; nothing to migrate.
- Lessons that shipped as tests (`scripts/selftest.mjs`) stay valid: each is a bug that happened once.
