# Season plan — standing intents

Living doc. Update as the season moves. Every item was checked against the live snapshot on 2026-09-01 — notably, the draft-day transcript's claim that Jordyn Tyson was rostered turned out to be **false** (he is not on the team). Trust the snapshot.

## Immediate (before Week 1 kickoff — season starts Sep 9)

0. **Pre-season adds are instant and free right now** (FCFS, not waivers — confirmed from the league's transaction log on Sep 1). The Sep 1 waiver report's Cousins/Davis/Hill picks are right, but as immediate adds, not Wednesday bids. Grab them in the app the moment you decide.

1. ~~IR slot is empty~~ **DONE 2026-09-01**: Ben moved Zach Charbonnet (RB, SEA — PUP) into the IR slot; bench now has an open spot (verified in snapshot). Revisit when Charbonnet comes off PUP — Sleeper will require moving him back to the active roster (or cutting him) to keep the slot legal.
2. ~~Questionable tags to watch before Sunday: Jeanty, Kraft, Dicker (starters), Meyers, Pierce (bench).~~ **Updated 2026-09-10 from a fresh sync:** the Jeanty/Kraft/Dicker camp tags have cleared; the only tag on the roster is Jakobi Meyers (Questionable, thumb — bench, no lineup impact), plus Charbonnet on PUP in the IR slot. Pierce is no longer ours — dropped Sep 1, now on elembach's roster.

## Standing

- **QB bye coverage** — Goff out W6 (Cousins covers it). **W13 is the problem week: Lamar (BAL) and Cousins (LV) are both on bye**, so the QB/SUPER_FLEX pair is Goff + Young — and Jeanty (LV) and Allen (IND) are out that week too. Start FAAB-scouting a W13 streamer well before then. Startable QBs do surface after the draft — Tua, Cousins and Rodgers were all free-agent pickups in the first ten days — but each one was gone within days of appearing, so in superflex the window is short; grab one the moment he's there rather than waiting for W13.
- **Young + McMillan stack** — live in W13 when Young starts (in W6 it's Cousins who fills SUPER_FLEX, and in W5 both Panthers are on bye anyway); a Young→McMillan TD is worth 12 pts under 6-pt passing. Nice bonus, but never preserve the stack over a better streaming QB.
- **Trade deadline W11** — do an honest contender assessment at W9 (`/trade` hunt mode). 7 of 12 make the playoffs, so the bar is low; don't sell early.
- **FAAB discipline** — $100 for the season. Reserve ~$20 for **W13** (QB, with Lamar and Cousins both out) and ~$10 for **W7**, where Dicker (K) and the Bills (DEF) are on bye the same week and both slots need a one-week body. W6 no longer needs a reserve — Cousins covers it. Spend past that only for an obvious league-winner.

## Log

- 2026-09-01: repo built; Week 1 lineup as drafted.
- 2026-09-01: Charbonnet → IR (Ben, in app). Bench open: 4 of 5 spots used.
- 2026-09-01: **Kirk Cousins added** — instant FCFS, $0 FAAB (pre-season mode confirmed in practice). QB room now Lamar/Goff/Cousins/Young. ~~Bye weeks 6 and 13 are covered in-house; the ~$20 FAAB reserve for QB streaming can relax.~~ **Corrected 2026-09-09:** Cousins is on LV, whose bye is **W13 — the same week as Lamar**. He covers W6 only; the W13 QB reserve stays. Roster is FULL (15+1 IR): Davis/Hill or any further add now requires a drop (report suggested Pierce / Allen).
- 2026-09-09: **Bye weeks now come from data.** `scripts/sync.mjs` read `p.bye_week` off the Sleeper players dump, a field that does not exist — every `bye_week` in the snapshot was silently `null`, so every bye claim in the reports and docs had been asserted from memory. Byes are now derived from `GET /schedule/nfl/regular/{season}`, and `games_have_started` now keys off real game status instead of a date comparison that flipped a day early. Full bye map in `docs/LEAGUE.md`.
