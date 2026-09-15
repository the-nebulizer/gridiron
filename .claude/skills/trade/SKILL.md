---
name: trade
description: Evaluate a trade offer or hunt for trades across all 12 rosters, valued in this league's superflex 6-pt-pass-TD scoring.
---

# /trade — evaluate or hunt

1. **Sync first (mandatory).** Run `node scripts/sync.mjs`; STOP on failure. Read `data/league/snapshot.json` — all 12 teams' full rosters are in `teams`.
1b. **Read the league's actual rules and my forward view from the snapshot, not from memory.** `league` carries every rule a trade turns on — `trade_deadline`, `trade_review_days` (0 here: an accepted offer processes at once), `veto_votes_needed`, `draft_pick_trading` (false — picks cannot be part of an offer), `max_keepers` (this is a keeper league, so a young player has value past this season), `playoff_week_start`, and `median_matchup`. `outlook` carries my positional counts, `thin_positions` and every week ahead I cannot fill.
2. Mode A — **evaluate** (Ben pasted an offer): confirm every named player's actual roster in the snapshot first. Value both sides in THIS league's scoring (superflex + 6-pt pass TD inflates every startable QB well past generic trade charts; half-PPR). Then run the offer through the future: `node scripts/outlook.mjs --add <each id I get> --drop <each id I give>` and compare it to the plain `node scripts/outlook.mjs`. Report what the deal does to the weeks ahead — especially the fantasy playoff weeks (`playoff_weeks`) and any week it turns from fillable to unfillable. Never read a bye from memory. Verdict: accept / counter (with the counter) / decline, in plain sentences.
3. Mode B — **hunt**: scan all 12 rosters for surplus/need mismatches against mine. My surplus and need are the outlook's `active_by_position` against `dedicated_slots` plus the flex slots — not an impression of the roster. Target the weeks the outlook flags: trading from a position with cover into one with none is worth more than a nominal value win. Identify the 2–3 most plausible partners, check each candidate offer with `scripts/outlook.mjs`, and draft a short, sendable offer message for the best one.
4. Read the deadline and the playoff field from the snapshot (`league.trade_deadline`, `league.playoff_teams`, `outlook.weeks_until_trade_deadline`). Once the deadline is within three weeks, say how many weeks are left in every report. With 7 of 12 making the playoffs the bar is low, so value wins-now — but a keeper slot (`league.max_keepers`) means a young player kept past this season is real value, not a throw-in.
5. **Check standing commitments first** (both modes). Read `reports/actions.json` (per `docs/ACTIONS.md`) before drafting or judging an offer: prefer offers that do not include the player this week's open waiver claim intends to drop. If the best offer must include such a player, link the two — the claim becomes `if_not` the trade, or the trade runs `after` the claim — and say in `why` that the offer locks that player through Wednesday's waiver processing. Remember an offer sent Monday can still be unanswered Wednesday, and with a 0-day review an acceptance processes at once.
6. Write the report to `reports/YYYY-MM-DD-trades.md`, action block first per `docs/ACTIONS.md`, e.g.:
   ```actions
   { "week": 9, "verdict": "Send the Diggs-for-Etienne offer to roster 4.",
     "next_check": "Trade hunt, Mon 7am",
     "actions": [{ "kind": "trade", "with": 4, "give": ["2449"], "get": ["<their player id, from teams[] in the snapshot>"],
       "message": "Diggs for Etienne — you need WR depth, I need a bellcow.",
       "urgency": "this_week", "why": "Fills my RB2 hole; Diggs is buried behind their top two." }] }
   ```
   A hold verdict still ships this block, with `"actions": []`. Then run `node scripts/actions.mjs`; STOP on failure — fix the block, never bypass.

Never: value a QB off a standard-scoring trade chart; propose a player the snapshot shows on a different roster than assumed; include a draft pick in an offer when `league.draft_pick_trading` is false; ignore what the OTHER manager needs (a trade they won't accept is worth nothing); judge an offer on this week's lineup alone when `scripts/outlook.mjs` will show you the rest of the season; emit an action for a player the snapshot doesn't place exactly where the action claims; send two offers that give the same player without linking them `if_not`.

**Publishing.** A report that isn't on `main` never reaches the dashboard. Finish with `node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> trades"` and say where it landed — see CLAUDE.md.
