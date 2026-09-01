# Gridiron

Ben's fantasy football season manager for **"Battle for the Gridiron Throne"** (Sleeper). Local Claude Code tool: a thin data layer over the Sleeper public API + skills for the weekly loop. Read `docs/RESUME.md` first when picking up work.

## Prime directive

**Never reason about rosters, availability, or draft state from memory, pasted text, or web snippets.** This project exists because a chat-based workflow hallucinated player availability on draft day. Before ANY recommendation:

```
node scripts/sync.mjs        # optionally: node scripts/sync.mjs <week>
```

then read `data/league/snapshot.json`. That file is the only truth about who is rostered, starting, or available. Web research is for **news, injuries, and rankings only** — never for who-is-on-what-roster. If sync fails, stop and say so; do not proceed from stale data.

## League constants (verified via API)

- League ID `1353093442397294592`, 12 teams; Ben = `JustBenwastaken`, roster_id **12**
- **Superflex** (QB/2RB/2WR/TE/FLEX/SUPER_FLEX/K/DEF + 5 BN + 1 IR), **6-pt pass TDs**, **half-PPR**
- **$100 FAAB**, waivers process **Wednesday**; trade deadline **W11**; playoffs 7 teams, **W15–17**
- Scoring implication that generic rankings miss: with 6-pt pass TDs in superflex, a startable QB in SUPER_FLEX nearly always beats a WR/TE there.

## Layout

- `config.json` — league/user IDs (public data, committed)
- `scripts/sleeper.mjs` — API client; `scripts/sync.mjs` — snapshot builder
- `data/` — gitignored cache (`players.json` refreshed when >24h old; `league/snapshot.json` per sync)
- `.claude/skills/` — `/lineup`, `/waivers`, `/trade`
- `docs/` — league facts, season plan, resume doc
