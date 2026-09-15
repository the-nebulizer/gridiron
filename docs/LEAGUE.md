# League: Battle for the Gridiron Throne

All values verified against the Sleeper API on 2026-08-31 (`GET /v1/league/1353093442397294592`).

## Settings

| Setting | Value |
|---|---|
| Teams | 12, in **2 divisions** |
| Lineup | QB, RB, RB, WR, WR, TE, FLEX, SUPER_FLEX, K, DEF |
| Bench / IR | 5 BN + 1 IR (`reserve_slots=1`) |
| IR eligibility | Only **Out** and **COV** designations (`reserve_allow_doubtful/na/sus/dnr` are all 0) — IR is not a general bench-relief valve |
| Scoring | 6-pt passing TD, 0.5 PPR, 0.04/pass yd, 0.1/rush+rec yd, −1 INT, −2 fumble lost |
| Weekly opponent | H2H **plus the league median** (`league_average_match=1`) — two results a week, so floor counts twice |
| Waivers | FAAB, $100 budget, min bid $0, 2-day clear, processes **Wednesday** |
| Trades | Deadline **Week 11**; review 0 days (accepted offers process at once); 6 votes to veto; **draft picks cannot be traded** (`pick_trading=0`) |
| Keepers | **1** (`max_keepers=1`) — young players hold value past this season |
| Playoffs | 7 teams, Weeks 15–17 |

Every value above is in the snapshot under `league`, re-read from the API on each sync. Quote the snapshot, not this table.

## Ben's team (roster_id 12)

QBs: **Lamar Jackson** (BAL, bye W13), **Jared Goff** (DET, bye W6), **Kirk Cousins** (LV, bye W13), **Bryce Young** (CAR, bye W5).

## Bye weeks and the weeks ahead

**This is computed, not maintained by hand.** An earlier version of this page carried a bye table that went stale the moment a player was dropped. Run:

```
node scripts/sync.mjs        # then read snapshot.outlook
node scripts/outlook.mjs     # the same view, printed
```

`outlook` gives, for every week still to come: who is on bye, which starting slots cannot be filled at all (solved against the real slots, so FLEX and SUPER_FLEX are accounted for), the count at each position, and which positions have no cover. `node scripts/outlook.mjs --add <id> --drop <id>` shows what a proposed move does to all of it.

As printed on 2026-09-15 (illustrative — re-run it, never quote it):

```
Roster: 4 QB, 3 RB, 4 WR, 1 TE, 1 K, 1 DEF (14 active), 1 on IR
Bench 4/5 used, IR 1/1 used.  No cover at: TE, K, DEF

W5   bye: McMillan (WR), Young (QB)
W6   bye: Goff (QB)
W7   bye: Diggs (WR), Dicker (K), Bills (DEF), Meyers (WR) · CANNOT FILL K, DEF
W9   bye: Warren (RB)
W10  bye: Irving (RB)
W11  bye: Kraft (TE) · CANNOT FILL TE
W13  bye: Lamar (QB), Jeanty (RB), Cousins (QB), Allen (WR)
Crunch weeks: W5, W7, W11, W13
```

Worth reading carefully: **W7 and W11 are the weeks the lineup actually breaks** (no kicker, no defense; no tight end). W13 loses four starters including two QBs but still fields a legal lineup on Goff + Young — it is a quality problem, not a legality one. The old hand-written table called W13 the crisis and missed that W11 had no TE at all.

## Season calendar

- **W7** — kicker and defense both on bye, and there is only one of each: two one-week bodies needed, budget FAAB for it
- **W9** — honest roster assessment ahead of the trade deadline
- **W11** — trade deadline, and the only TE is on bye: stream a TE
- **W13** — Lamar **and** Cousins both out (BAL and LV share W13) → Goff + Young start; Jeanty and Allen out too
- **W15–17** — fantasy playoffs; weight moves toward these weeks from the deadline on

Note: `players.json` from Sleeper carries **no** bye field at all — reading `p.bye_week` there silently returns null. Byes come from `GET https://api.sleeper.app/schedule/nfl/regular/{season}` (the week a team has no game), which `scripts/sleeper.mjs` wraps as `getSchedule`/`byeWeeks`.
