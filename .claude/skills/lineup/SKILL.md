---
name: lineup
description: Build this week's start/sit recommendation for Ben's team from a fresh Sleeper snapshot plus injury/news research.
---

# /lineup — weekly start/sit

1. **Sync first (mandatory).** Run `node scripts/sync.mjs` (add a week number to target a specific week). If it fails, STOP and report the error — never proceed from an old snapshot or memory.
2. Read `data/league/snapshot.json`: my starters/bench/reserve, opponent's starters, everyone's `injury_status`.
3. Web-research ONLY: injury/inactive news for my players and close calls, and current-week expert consensus for players within ~2 ranking spots of each other. Roster facts come from the snapshot alone.
4. Decide each slot in **this league's scoring**: superflex + 6-pt pass TDs (a healthy starting QB in SUPER_FLEX nearly always beats any WR/TE), half-PPR.
5. Frame close calls by win probability: projected favorite → prefer floor; underdog → prefer ceiling. Say which framing you used.
6. Output: the full legal 10-slot lineup (QB, RB, RB, WR, WR, TE, FLEX, SUPER_FLEX, K, DEF); for every change from current starters, one sentence of reasoning; flag any Questionable/Doubtful starter with the bench pivot to make before kickoff (lineup changes are manual in the Sleeper app).

Never: name a player without confirming their roster slot in the snapshot; carry availability claims from search snippets; leave a slot empty when a legal option exists.
