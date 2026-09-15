---
name: lineup
description: Build this week's start/sit recommendation for Ben's team from a fresh Sleeper snapshot plus injury/news research.
---

# /lineup — weekly start/sit

1. **Sync first (mandatory).** Run `node scripts/sync.mjs` (add a week number to target a specific week). If it fails, STOP and report the error — never proceed from an old snapshot or memory.
2. Read `data/league/snapshot.json`: my starters/bench/reserve, opponent's starters, everyone's `injury_status`.
3. Web-research ONLY: injury/inactive news for my players and close calls, and current-week expert consensus for players within ~2 ranking spots of each other. Roster facts come from the snapshot alone.
4. Decide each slot in **this league's scoring**: superflex + 6-pt pass TDs (a healthy starting QB in SUPER_FLEX nearly always beats any WR/TE), half-PPR.
5. Frame close calls by win probability: projected favorite → prefer floor; underdog → prefer ceiling. Say which framing you used. If the snapshot's `league.median_matchup` is true, every week is also scored against the league median, so a high floor wins twice and a bench-heavy boom week wins once — weight floor accordingly and say so.
5a. **Set this week's lineup for this week.** Never bench a player to protect a later week — lineups are set weekly and nothing carries over. Then, separately, read the snapshot's `outlook` and close the report with one line naming the next `crunch_weeks` entry and what it needs. A slot the outlook says I cannot fill (`empty_slots`) is a waiver job; hand it to `/waivers` rather than solving it here.
5b. Read `reports/actions.json` first (per `docs/ACTIONS.md`): a `start` action must not name as `for` a player who sits in an open trade offer's `give` list — the move is still legal in Sleeper, but say in the report that the player may leave — and lineup moves are always step 1 of the standing order, so a `start` action never carries `after`.
6. Output: the full legal 10-slot lineup (QB, RB, RB, WR, WR, TE, FLEX, SUPER_FLEX, K, DEF); for every change from current starters, one sentence of reasoning; flag any Questionable/Doubtful starter with the bench pivot to make before kickoff (lineup changes are manual in the Sleeper app).
7. Write the report to `reports/YYYY-MM-DD-lineup.md`, action block first per `docs/ACTIONS.md`, e.g.:
   ```actions
   { "week": 2, "verdict": "Start Bucky Irving over Jaylen Warren at FLEX.",
     "next_check": "Waivers, Tue 7am",
     "actions": [{ "kind": "start", "player": "11584", "for": "8228", "slot": "FLEX",
       "urgency": "before_kickoff", "why": "Warren questionable; Irving has the full workload." }] }
   ```
   A hold verdict still ships this block, with `"actions": []`. Then validate the block you just wrote: `node scripts/actions.mjs --check reports/<file>.md` — strict, and STOP on failure; fix the block, never bypass. Then compile the card: `node scripts/actions.mjs`. The compile also reads the other three routines' newest reports; if it notes an action of theirs as done, gone, or drifted, that is expected — it is not yours to fix and not a reason to stop.

Never: name a player without confirming their roster slot in the snapshot; carry availability claims from search snippets; leave a slot empty when a legal option exists; emit an action for a player the snapshot doesn't place exactly where the action claims.

**Publishing.** A report that isn't on `main` never reaches the dashboard. Finish with `node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> lineup" --replace` and say where it landed — see CLAUDE.md.
