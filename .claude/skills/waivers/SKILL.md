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

## Mid-week: "someone dropped X — do I care?"

Not every question is the Tuesday report. When Ben asks about a single player, or a move another manager just made, run `node scripts/league-activity.mjs` (after the sync) and answer in this order:

1. **Can he even be added right now?** Before kickoff it's first-come-first-serve, so the answer is "go take him". After kickoff a drop sits on waivers — 2-day clear, Wednesday processing, costs FAAB. Only the Sleeper app shows which state a given player is in: "Add" means instant, "Claim" means Wednesday. Say so rather than guessing.
2. **What does it cost?** With a full roster every add is a swap; the question is never "is he good" but "is he better than the 15th man".
3. **Is the position streamable?** Never carry two of K or DEF. A dropped defense is worth a claim only as a clear season-long upgrade on the starter, or to cover that starter's bye that week.
4. **Which way is the market moving?** The snapshot carries Sleeper-wide adds AND drops. A player being dropped by tens of thousands is a signal; so is the reverse. Report the net, not just the add count — they run in both directions and the add count alone flatters a player everyone is cutting.
5. **Is he actually rosterable?** A player on IR or PUP can't fill an active spot.

Never: recommend a player without `rostered_in_league: false` in the current snapshot; spend below $1 on a player worth rostering; forget IR/PUP eligibility as a way to free a bench spot.

**Publishing.** A report that isn't on `main` never reaches the dashboard. Finish with `node scripts/publish-report.mjs reports/<file>.md "report: week <N> waivers"` and say where it landed — see CLAUDE.md.
