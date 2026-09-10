# Routines — owner's runbook

The five scheduled routines live in the claude.ai routines UI, not in this repo. Their prompts were created outside agent control and the API refuses to edit them, so every change below is something **Ben pastes in by hand**. This page is the checklist for that.

Times: Central is CDT (UTC-5) until clocks fall back on **Sunday Nov 1, 2026**, then CST (UTC-6). Cron is evaluated in UTC, so every routine drifts an hour earlier in local time on Nov 1 unless its cron is changed.

## What was tried and doesn't work

Replacement routines created by the agent (`create_trigger`) spawn sessions **without the repository attached** — verified Sep 10: two test runs, no checkout, nothing pushed. Only routines created in the claude.ai UI get the repo. So the originals stay, and every change below is a UI edit. Nothing on this page needs code.

## Three edits that need no pasting (do these first)

1. **Sunday inactives cron → `40 15 * * 0`** (10:40am CDT; `40 16 * * 0` from Nov 1). It currently fires at 10:06am, before inactives post at 10:30.
2. **Roster watcher: cron → `30 12,22 * * *`** (7:30am and 5:30pm, two runs a day instead of sixteen) **and model → Haiku 4.5.** Its normal run is two scripts and a stop; it doesn't need Sonnet. This one change removes ~85% of the weekly spend.
3. **Email notifications on, all five.** They're all off, which is how five reports went missing without anyone noticing.

## The five routines

| Routine | Trigger id | Cron (UTC) | Central now (CDT) | Central from Nov 1 (CST) | Purpose | Verdict |
|---|---|---|---|---|---|---|
| Waivers | `trig_018jkMrmz2vDLU6qQdiGeKZE` | `0 12 * * 2` | Tue 7:00am | Tue 6:00am | FAAB report before Wednesday processing | Keep. Paste in new step 5 + bye phrase. |
| Lineup | `trig_01DxqQ5pTd1sJRc8CSnX4YHy` | `0 12 * * 4` | Thu 7:00am | Thu 6:00am | Start/sit before Thursday night | Keep. Paste in new step 5. |
| Inactives | `trig_01WEymfugQorRLQeP2YLdvqx` | `0 15 * * 0` | Sun 10:00am (fires ~10:06) | Sun 9:00am | Game-day inactives before the early slate | **Move later** — see below. Paste in new step 5 + opening sentence. |
| Trades | `trig_01Jr9ik2fKEiwcs4yaS99ZeQ` | `0 12 * * 1` | Mon 7:00am | Mon 6:00am | Weekly trade hunt through the W11 deadline | Keep. Paste in new step 5 + bye phrase. |
| Roster watcher | `trig_01DTuqiqG69gfwSjFfW65vah` | `0 0-3,12-23 * * *` | hourly 7pm–10pm and 7am–6pm (fires ~:02) | hourly 6pm–9pm and 6am–5pm | Re-run the four reports when the roster changes | **Cut frequency or shift off the hour** — see below. Paste in new steps 4, 5, 7. |

**Turn on email notifications for all five.** They are all off right now, which is how four (then five) reports went missing for a week without anyone noticing. Push is fine too, but email leaves a trail.

## Problem 1 — Sunday inactives fires before inactives exist

The routine fires at about 10:06am Central. Official inactives post **90 minutes before each kickoff** — 11:30am ET / 10:30am CT for the 1pm ET slate. So the run wakes up 25 minutes before the first real information of the day exists and can only repeat Friday's injury designations, which Ben already has.

Fix the schedule:

- Through Oct 25: `40 15 * * 0` (10:40am CDT — ten minutes after the early-slate inactives post)
- From Nov 1: `40 16 * * 0` (10:40am CST)

Late-slate and Sunday-night inactives still post after the report runs; the report should say so and tell Ben which of his starters are in later games, rather than pretending it has covered them.

## Problem 2 — the hourly watcher

Sixteen runs a day, 112 sessions a week, and in nine days it has detected **zero** roster changes. Worse, it fires at :02 in the same hours the weekly routines fire (12 and 15 UTC), so on Tuesday, Thursday, Sunday and Monday mornings two sessions are on the repo at once — that is exactly how a same-day file conflict on a report happens.

Pick one:

- **Preferred:** 2–3 runs a day, e.g. `30 12,17,23 * * *` (7:30am, 12:30pm, 6:30pm CDT). Roster moves are manual in the Sleeper app, and the dashboard already shows league activity live, so hourly polling buys almost nothing.
- **Minimum:** keep the hours but move it off the hour: `30 0-3,12-23 * * *`. That alone stops it colliding with the weekly runs.

## Problem 3 — reports were being stranded (partly fixed)

Every routine session runs on its own branch. The old step 5 — "commit only that report file to main and push" — pushed to that branch, and the dashboard only reads `main`. Five reports were lost this way between Sep 3 and Sep 10.

The repo-side fix is in PR #1: `scripts/publish-report.mjs`, the "Publishing a report" section in `CLAUDE.md`, and a publish line at the end of each skill. The routines will pick that up because their prompts say "read CLAUDE.md" / "follow SKILL.md" — but the prompts themselves still carry the old step 5, and a prompt instruction beats a doc the model may skim. So paste the text below in as well.

**Until PR #1 merges, every scheduled run clones `main`, finds none of the fix, and strands its report on a session branch the same way as before. The next fire is the Sunday inactives run.** Merging PR #1 first is the single highest-leverage action on this page.

## Paste-in text — the four weekly routines

In each of the Waivers, Lineup, Trades and Inactives prompts, **replace step 5** ("Commit only that report file to main ... and push") with the block for that routine.

### Waivers — step 5

```
5. Publish, or the dashboard never sees it. This session runs on its own branch, so a plain git push strands the report. Run: node scripts/publish-report.mjs reports/<YYYY-MM-DD>-waivers.md "report: week <N> waivers" --replace — it pushes to main and verifies the report is actually there. If it reports failure, it will have pushed a fallback branch: say so and say the report is NOT on the dashboard. Finish with one plain sentence stating whether origin/main contains the report. Never end the run without that sentence.
```

Also in the Waivers prompt, replace the phrase

> (reserve budget for W6/W13 QB streaming)

with

> (reserve budget per the bye table in docs/SEASON-PLAN.md — read byes from the snapshot, not memory)

### Lineup — step 5

```
5. Publish, or the dashboard never sees it. This session runs on its own branch, so a plain git push strands the report. Run: node scripts/publish-report.mjs reports/<YYYY-MM-DD>-lineup.md "report: week <N> lineup" --replace — it pushes to main and verifies the report is actually there. If it reports failure, it will have pushed a fallback branch: say so and say the report is NOT on the dashboard. Finish with one plain sentence stating whether origin/main contains the report. Never end the run without that sentence.
```

### Trades — step 5

```
5. Publish, or the dashboard never sees it. This session runs on its own branch, so a plain git push strands the report. Run: node scripts/publish-report.mjs reports/<YYYY-MM-DD>-trades.md "report: week <N> trades" --replace — it pushes to main and verifies the report is actually there. If it reports failure, it will have pushed a fallback branch: say so and say the report is NOT on the dashboard. Finish with one plain sentence stating whether origin/main contains the report. Never end the run without that sentence.
```

Also in the Trades prompt, replace the phrase

> weigh bye coverage (my QBs: Goff out W6, Lamar out W13)

with

> weigh bye coverage — read every player's bye week from the snapshot, never from memory (W13 is the crunch: Lamar, Cousins, Jeanty and Allen are all out)

### Inactives — step 5

```
5. Publish, or the dashboard never sees it. This session runs on its own branch, so a plain git push strands the report. Run: node scripts/publish-report.mjs reports/<YYYY-MM-DD>-inactives.md "report: week <N> inactives" --replace — it pushes to main; --replace means this run's report supersedes any earlier one from today and verifies the report is actually there. If it reports failure, it will have pushed a fallback branch: say so and say the report is NOT on the dashboard. Finish with one plain sentence stating whether origin/main contains the report. Never end the run without that sentence.
```

Also in the Inactives prompt, add this sentence to the opening paragraph:

> Official inactives post 90 minutes before each kickoff (11:30am ET for 1pm games); the report is worthless if it only repeats Friday's injury designations.

## Paste-in text — the roster watcher

Three edits to the watcher prompt.

### Step 4 — two phrase substitutions

- Delete `(my_roster_id = 12)`.
- Replace `(see season_start_date / games_have_started in the snapshot, per CLAUDE.md)` with `(the snapshot says whether real games have started; per CLAUDE.md)`.

### Step 5 — replace the report header spec with

```
Each report opens with a single quoted line written for Ben: "> Refreshed <Month D> after a roster change: <diff in player names>" (for example "> Refreshed Sep 14 after a roster change: added Michael Mayer, dropped Malik Davis"). On the first run, when there is no previous fingerprint, the line is "> Refreshed <Month D>: baseline". No ISO timestamps, no snapshot field names, no file paths anywhere in the report body — plain English a fantasy manager would read.
```

### Step 7 — replace entirely with

```
7. Publish all four reports in ONE commit together with reports/.roster-fingerprint.json — never the reports without the fingerprint (a missing fingerprint makes the next hourly run think everything changed and regenerate all four again), and never a plain git push (this session runs on its own branch; the dashboard reads main only). Run:
   git add reports/*.md reports/.roster-fingerprint.json
   git commit -m "reports: refresh after roster change (week <N>)"
   git push origin HEAD:main
   If the push is rejected because main moved: git pull --rebase origin main, keeping THIS session's version of any conflicting report file (git checkout --theirs <file> during the rebase, then git add and git rebase --continue), and push HEAD:main again. If the rebase fails or the second push is refused: git rebase --abort, push to a fallback branch (git push origin HEAD:refs/heads/reports-fallback-<YYYY-MM-DD-HHMM>), and finish with an explicit sentence saying the reports are NOT on the dashboard and naming that branch. Otherwise finish with one plain sentence confirming origin/main contains the four reports and the fingerprint. Never end the run without that sentence.
```

## Checklist

- [x] Merge PR #1 (done Sep 10 — every routine's publish step now works via CLAUDE.md)
- [ ] Watcher model → Haiku 4.5
- [ ] Inactives cron → `40 15 * * 0` now, `40 16 * * 0` from Nov 1
- [ ] Watcher cron → `30 12,17,23 * * *` (or at least `30 0-3,12-23 * * *`)
- [ ] Email notifications on, all five
- [ ] Paste step 5 into Waivers, Lineup, Trades, Inactives; plus the bye/inactives phrase edits
- [ ] Paste steps 4, 5, 7 into the watcher
- [ ] On Nov 1: decide whether the Tue/Thu/Mon 7am runs should stay 7am local (`0 13 * * 2`, etc.) or are fine at 6am
