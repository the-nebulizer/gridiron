# League: Battle for the Gridiron Throne

All values verified against the Sleeper API on 2026-08-31 (`GET /v1/league/1353093442397294592`).

## Settings

| Setting | Value |
|---|---|
| Teams | 12 |
| Lineup | QB, RB, RB, WR, WR, TE, FLEX, SUPER_FLEX, K, DEF |
| Bench / IR | 5 BN + 1 IR (reserve_slots=1) |
| Scoring | 6-pt passing TD, 0.5 PPR |
| Waivers | FAAB, $100 budget, processes **Wednesday** |
| Trade deadline | Week 11 |
| Playoffs | 7 teams, Weeks 15–17 |

## Ben's team (roster_id 12)

QBs: **Lamar Jackson** (BAL, bye W13), **Jared Goff** (DET, bye W6), **Kirk Cousins** (LV, bye W13), **Bryce Young** (CAR, bye W5).

## Bye weeks on my roster (2026)

Derived from the schedule by `scripts/sync.mjs` — every player in the snapshot carries a real `bye_week`. Re-read it from the snapshot; do not quote this table from memory.

| Week | Out | What it costs |
|---|---|---|
| W5 | McMillan (WR), Young (QB) | Nothing — Lamar/Goff/Cousins all play |
| W6 | Goff (QB) | Cousins takes SUPER_FLEX |
| W7 | Diggs (WR), Meyers (WR), Dicker (K), Bills (DEF) | **Worst week.** K and DEF both gone, plus two WRs — needs FAAB |
| W9 | Warren (RB) | FLEX shuffle |
| W10 | Irving (RB) | RB2 shuffle |
| W11 | Kraft (TE), Charbonnet (RB, IR) | **Only TE** — stream a TE |
| W13 | Lamar (QB), Cousins (QB), Jeanty (RB), Allen (WR) | **QB1 and QB3 out together** (both bye W13) — Goff + Young start; RB1 out too |
| W14 | Davis (RB) | Nothing — RB4 |

## Season calendar

- **W5** — Carolina bye (Young + McMillan both out; my other three QBs play — fine)
- **W6** — Goff bye → Cousins starts in SUPER_FLEX
- **W7** — K + DEF bye week; budget FAAB for a one-week kicker and defense
- **W9** — honest roster assessment ahead of the trade deadline
- **W11** — trade deadline; Kraft bye (only TE)
- **W13** — Lamar **and** Cousins both on bye (BAL and LV share W13) → Goff + Young are the pair; Jeanty out too
- **W15–17** — playoffs

Note: `players.json` from Sleeper carries **no** bye field at all — reading `p.bye_week` there silently returns null. Byes come from `GET https://api.sleeper.app/schedule/nfl/regular/{season}` (the week a team has no game), which `scripts/sleeper.mjs` wraps as `getSchedule`/`byeWeeks`.
