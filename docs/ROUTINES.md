# Routines — owner's runbook

The scheduled routines live in the claude.ai routines UI, not in this repo. As of Sep 10 there are **two sets of five**: the originals, created by hand and untouchable by the agent (the API refuses to edit or disable them), and a **v2 set** the agent created with corrected prompts and better schedules. The v2 set is live and enabled. The originals are still on too, and only Ben can turn them off — that is the one action this page asks for.

Times: Central is CDT (UTC-5) until clocks fall back on **Sunday Nov 1, 2026**, then CST (UTC-6). Cron is evaluated in UTC, so every routine drifts an hour earlier in local time on Nov 1 unless its cron is changed.

## The five v2 routines (current)

All five: fresh session per run, `claude-sonnet-5 (the watcher runs on claude-haiku-4-5 — its usual job is two scripts and a stop)`, email notifications **on**, enabled.

| Routine | Trigger id | Cron (UTC) | Central now (CDT) | Central from Nov 1 (CST) | Purpose |
|---|---|---|---|---|---|
| Gridiron · Tuesday waivers (v2) | `trig_01Trg3Y2E7KekK96P5YRbMPj` | `50 11 * * 2` | Tue 6:50am | Tue 5:50am | FAAB report before Wednesday processing |
| Gridiron · Thursday lineup (v2) | `trig_012wLdkGSPX1aJqMRfLJsLkr` | `50 11 * * 4` | Thu 6:50am | Thu 5:50am | Start/sit before Thursday night |
| Gridiron · Monday trade hunt (v2) | `trig_0178fSEQwNLokG5GEkXfF3WT` | `50 11 * * 1` | Mon 6:50am | Mon 5:50am | Weekly trade hunt through the W11 deadline |
| Gridiron · Sunday inactives (v2) | `trig_01RfeuBVHsB7bQaXfdULQjrJ` | `40 15 * * 0` | Sun 10:40am | Sun 9:40am — **must move to `40 16 * * 0`** | Game-day inactives, ten minutes after the early-slate list posts |
| Gridiron · roster-change watcher (v2) | `trig_013F1F8HFMJTYYAD1gEhJ6PF` | `30 12,22 * * *` | 7:30am and 5:30pm | 6:30am and 4:30pm | Re-run the four reports when the roster changes — two runs a day instead of sixteen |

The v2 prompts already carry everything the old paste-in sections used to ask for: the publish step (`scripts/publish-report.mjs ... --replace`), the "read byes from the snapshot" wording, the inactives-timing sentence, and the watcher's report-header and one-commit rules. Nothing needs pasting into them.

## Switch off the originals

In the claude.ai routines UI, **disable** (or delete) each of these. Reason, the same for all five: both would run, and the old one strands or duplicates its report until it's off.

- [ ] Waivers — `trig_018jkMrmz2vDLU6qQdiGeKZE` (`0 12 * * 2`, Tue 7:00am)
- [ ] Lineup — `trig_01DxqQ5pTd1sJRc8CSnX4YHy` (`0 12 * * 4`, Thu 7:00am)
- [ ] Inactives — `trig_01WEymfugQorRLQeP2YLdvqx` (`0 15 * * 0`, Sun 10:00am)
- [ ] Trades — `trig_01Jr9ik2fKEiwcs4yaS99ZeQ` (`0 12 * * 1`, Mon 7:00am)
- [ ] Roster watcher — `trig_01DTuqiqG69gfwSjFfW65vah` (`0 0-3,12-23 * * *`, hourly)

### What happens while both sets are on

The v2 runs are scheduled ten minutes ahead of the old ones, so the v2 report normally lands on `main` first. When the old run then tries to publish the same day's file, it either pushes to its own session branch (the old prompt's broken step) or, if it follows `CLAUDE.md`, runs `publish-report.mjs` without `--replace`, hits a conflict on the report it can't reconcile, and falls back to pushing a branch and saying so. If the v2 run takes longer than ten minutes the two race, but the result is the same: the v2 run's `--replace` keeps its version, the old run ends up on a branch. Noisy — an extra session, an extra email, a stray `reports-fallback-*` branch — but not harmful: the dashboard keeps showing the v2 report.

The exception is **inactives**, where the old run fires at 10:00am, *before* the v2 run at 10:40am. The old report lands first (it's the one built before inactives exist), and the v2 run's `--replace` then supersedes it on main. Again correct in the end, just wasteful.

The old hourly watcher is the expensive one to leave on (see costs below) and the most likely to collide with a weekly run, since it fires at :02 in the same hours.

## Nov 1 — clocks fall back

- [ ] Inactives (v2) cron → `40 16 * * 0` so it keeps firing 10:40am local, after the early-slate inactives post. At `40 15` it would run at 9:40am CST, before the list exists.
- [ ] Decide whether the three 6:50am runs (waivers, lineup, trades) should move to `50 12 * * *`-style crons to stay 6:50am local, or are fine drifting to 5:50am. Nothing downstream depends on the exact hour; the reports just need to land before Ben looks at them.
- [ ] Watcher: `30 12,22` becomes 6:30am / 4:30pm local. Fine as is unless Ben wants the evening check later.

## Weekly cost

- **Old set:** about **$19.60/week**, and roughly 88% of that is the hourly watcher — 112 sessions a week that in nine days detected zero roster changes.
- **v2 set:** about **$4.70/week**. The watcher drops to 14 sessions a week; the four weekly reports are unchanged.

Until the originals are off, both bills are running.

## What the v2 routines fix

Kept here so the history makes sense; each of these still applies to the originals until they're disabled.

**Problem 1 — Sunday inactives fired before inactives existed.** The old run wakes at ~10:06am Central; official inactives post 90 minutes before kickoff, 10:30am Central for the early slate. So it could only repeat Friday's injury designations. The v2 run fires at 10:40am and its prompt says outright that a report repeating Friday's designations is worthless. Late-slate and Sunday-night inactives still post after the run; the report names which starters are in later games instead of pretending to cover them.

**Problem 2 — the hourly watcher.** Sixteen runs a day for nothing, and it fired at :02 in the same hours as the weekly routines, putting two sessions on the repo at once — the recipe for a same-day file conflict on a report. The v2 watcher runs twice a day, off the hour, and its prompt requires the four reports and the roster fingerprint to go up in one commit.

**Problem 3 — reports were being stranded.** Every routine session runs on its own branch, and the old step 5 ("commit only that report file to main and push") pushed to that branch while the dashboard reads `main` only. Five reports were lost between Sep 3 and Sep 10. The repo-side fix is `scripts/publish-report.mjs` plus the "Publishing a report" section in `CLAUDE.md`; the v2 prompts call the script directly instead of relying on the model to find it in the docs. The old prompts still carry the broken step and lean on CLAUDE.md to override it.

## If you ever need to hand-edit a prompt

The publish step every report routine should end with, in case a v2 prompt is ever cloned or rewritten by hand:

```
Publish, or the dashboard never sees it. This session runs on its own branch, so a plain git push strands the report. Run: node scripts/publish-report.mjs reports/<YYYY-MM-DD>-<type>.md "report: week <N> <type>" --replace — it pushes to main, replaces any earlier same-day version of this report, and verifies the report is actually there. If it reports failure, it will have pushed a fallback branch: say so and say the report is NOT on the dashboard. Finish with one plain sentence stating whether origin/main contains the report. Never end the run without that sentence.
```

For the watcher, the equivalent rule is: publish all four reports **and** `reports/.roster-fingerprint.json` in one commit (a missing fingerprint makes the next run think everything changed), push `HEAD:main`, rebase once keeping this session's version of any conflicting report, fall back to a `reports-fallback-<date>` branch if that fails, and end with a sentence saying whether main has the reports.
