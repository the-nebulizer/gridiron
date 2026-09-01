---
name: waivers
description: Weekly FAAB waiver report for Ben's league — real availability from the Sleeper snapshot, bids sized to budget and future needs.
---

# /waivers — FAAB report (waivers process Wednesday)

1. **Sync first (mandatory).** Run `node scripts/sync.mjs`; STOP on failure. Read `data/league/snapshot.json`.
1b. **Check the add mode** (see CLAUDE.md "Calendar calibration"): if `games_have_started` is false, or recent `free_agent` transactions complete instantly, the pool is first-come-first-serve — recommend immediate $0 adds ranked by urgency, NOT FAAB bids, and say clearly that it's a race. Bid advice applies only once players are actually on waivers.
2. Candidates = snapshot `trending.adds` where `rostered_in_league` is false, plus anyone in `transactions` recently dropped in THIS league. Nobody else — if a name isn't provably unrostered in the snapshot, it doesn't go in the report.
3. Web-research the top candidates: why trending (injury ahead of them? role change?), rest-of-season outlook, not just last week's box score.
4. Recommend: up to 5 adds ranked, each with a FAAB bid sized against my `faab_remaining` and the standing plan in `docs/SEASON-PLAN.md` (reserve budget for W6/W13 QB streaming; QBs are gold in superflex — grab any startable QB who ever hits waivers). Name the drop for each add, from my bench, with one sentence.
5. Note explicitly: claims are manual in the Sleeper app; deadline is Tuesday night before Wednesday processing.

Never: recommend a player without `rostered_in_league: false` in the current snapshot; spend below $1 on a player worth rostering; forget IR/PUP eligibility as a way to free a bench spot.
