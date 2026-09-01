---
name: trade
description: Evaluate a trade offer or hunt for trades across all 12 rosters, valued in this league's superflex 6-pt-pass-TD scoring.
---

# /trade — evaluate or hunt

1. **Sync first (mandatory).** Run `node scripts/sync.mjs`; STOP on failure. Read `data/league/snapshot.json` — all 12 teams' full rosters are in `teams`.
2. Mode A — **evaluate** (Ben pasted an offer): confirm every named player's actual roster in the snapshot first. Value both sides in THIS league's scoring (superflex + 6-pt pass TD inflates every startable QB well past generic trade charts; half-PPR). Weigh roster fit and bye coverage (mine: Goff W6, Lamar W13), not just raw value. Verdict: accept / counter (with the counter) / decline, in plain sentences.
3. Mode B — **hunt**: scan all 12 rosters for surplus/need mismatches against mine; identify the 2–3 most plausible partners; draft a short, sendable offer message for the best one.
4. From W9 on, remind that the trade deadline is **W11**; 7 of 12 make playoffs, so value wins-now accordingly.

Never: value a QB off a standard-scoring trade chart; propose a player the snapshot shows on a different roster than assumed; ignore what the OTHER manager needs (a trade they won't accept is worth nothing).
