---
name: trade
description: Evaluate a trade offer or hunt for trades across all 12 rosters, valued in this league's superflex 6-pt-pass-TD scoring.
---

# /trade — evaluate or hunt

1. **Sync first (mandatory).** Run `node scripts/sync.mjs`; STOP on failure. Read `data/league/snapshot.json` — all 12 teams' full rosters are in `teams`.
2. Mode A — **evaluate** (Ben pasted an offer): confirm every named player's actual roster in the snapshot first. Value both sides in THIS league's scoring (superflex + 6-pt pass TD inflates every startable QB well past generic trade charts; half-PPR). Weigh roster fit and bye coverage — read each player's `bye_week` from the snapshot, never from memory (my W13 is the crunch: Lamar, Cousins, Jeanty and Allen are all out). Verdict: accept / counter (with the counter) / decline, in plain sentences.
3. Mode B — **hunt**: scan all 12 rosters for surplus/need mismatches against mine; identify the 2–3 most plausible partners; draft a short, sendable offer message for the best one.
4. From W9 on, remind that the trade deadline is **W11**; 7 of 12 make playoffs, so value wins-now accordingly.
5. Write the report to `reports/YYYY-MM-DD-trades.md`, action block first per `docs/ACTIONS.md`, e.g.:
   ```actions
   { "week": 9, "verdict": "Send the Diggs-for-Etienne offer to roster 4.",
     "next_check": "Trade hunt, Mon 7am",
     "actions": [{ "kind": "trade", "with": 4, "give": ["2449"], "get": ["<their player id, from teams[] in the snapshot>"],
       "message": "Diggs for Etienne — you need WR depth, I need a bellcow.",
       "urgency": "this_week", "why": "Fills my RB2 hole; Diggs is buried behind their top two." }] }
   ```
   A hold verdict still ships this block, with `"actions": []`. Then run `node scripts/actions.mjs`; STOP on failure — fix the block, never bypass.

Never: value a QB off a standard-scoring trade chart; propose a player the snapshot shows on a different roster than assumed; ignore what the OTHER manager needs (a trade they won't accept is worth nothing); emit an action for a player the snapshot doesn't place exactly where the action claims.

**Publishing.** A report that isn't on `main` never reaches the dashboard. Finish with `node scripts/publish-report.mjs reports/<file>.md reports/actions.json "report: week <N> trades"` and say where it landed — see CLAUDE.md.
