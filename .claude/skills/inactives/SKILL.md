---
name: inactives
description: Sunday game-day check for Out/Doubtful/inactive starters on Ben's team, with the bench pivot to make before kickoff.
---

# /inactives — game-day check (Sunday)

1. **Sync first (mandatory).** Run `node scripts/sync.mjs`; STOP on failure — never proceed from an old snapshot or memory.
2. **Calendar calibration** (see CLAUDE.md): if today is before `season_start_date`, or no NFL slate is imminent or underway right now, write `reports/YYYY-MM-DD-inactives.md` as a one-paragraph "not actionable" report (say plainly there are no games to check yet) with the action block still present — `"verdict"` explains why, `"actions": []` — then skip to step 7.
3. Read `data/league/snapshot.json`: my current starters and each one's `injury_status`; note bench players who'd be close-call pivots too.
4. Web-research ONLY official inactive lists and late-week (Fri/Sat/Sunday-morning) designations for my starters and those close bench calls. Roster placement itself still comes from the snapshot, never from search.
5. For every starter who is Out, Doubtful, or reported inactive, name the bench pivot in **this league's scoring** (superflex, 6-pt pass TDs, half-PPR — a healthy QB in SUPER_FLEX still nearly always outranks a WR/TE pivot).
6. Write the report to `reports/YYYY-MM-DD-inactives.md`, action block first per `docs/ACTIONS.md`: for each pivot needed, a `start` action with `for`, `urgency: before_kickoff`, and a `deadline_label` naming the kickoff time, e.g.:
   ```actions
   { "week": 2, "verdict": "Diggs is OUT — start Keenan Allen at WR.",
     "next_check": "Lineup, Thu 7am",
     "actions": [{ "kind": "start", "player": "1479", "for": "2449", "slot": "WR",
       "urgency": "before_kickoff", "deadline_label": "before Sun 1:00pm ET",
       "why": "Diggs ruled out; Allen is the best healthy WR on the bench." }] }
   ```
   A hold verdict (nobody flipped) still ships this block, with `"actions": []`.
7. Run `node scripts/actions.mjs`; STOP on failure — fix the block, never bypass. Publish with `node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> inactives"` and say where it landed — see CLAUDE.md.

Never: treat a preseason/camp injury tag as a game-day status; name a pivot without confirming both players' roster slots in the snapshot; skip the action block on a "not actionable" report; emit an action for a player the snapshot doesn't place exactly where the action claims.
