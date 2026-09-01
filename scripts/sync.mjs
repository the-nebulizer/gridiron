// Pull the whole league state from Sleeper into data/league/snapshot.json,
// with every player ID resolved to a name. This snapshot is the ONLY source
// of truth about rosters and availability — never reason from memory.
//
// Usage: node scripts/sync.mjs [week]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sleeper from './sleeper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const dataDir = path.join(root, 'data');

const state = await sleeper.getState();
const week = Number(process.argv[2]) || state.week || 1;

const [league, rosters, users, matchups, trendingAdds, trendingDrops, players] =
  await Promise.all([
    sleeper.getLeague(config.league_id),
    sleeper.getRosters(config.league_id),
    sleeper.getUsers(config.league_id),
    sleeper.getMatchups(config.league_id, week),
    sleeper.getTrending('add'),
    sleeper.getTrending('drop'),
    sleeper.getPlayers(path.join(dataDir, 'players.json')),
  ]);

const txWeeks = week > 1 ? [week - 1, week] : [week];
const transactionsRaw = (
  await Promise.all(txWeeks.map((w) => sleeper.getTransactions(config.league_id, w)))
).flat();

const ownerName = new Map(users.map((u) => [u.user_id, u.display_name]));

function resolve(id) {
  if (id == null || id === '0' || id === '') return null;
  const p = players[id];
  if (!p) {
    // Team defenses are keyed by team code ("BUF") but may be absent from old dumps.
    if (/^[A-Z]{2,3}$/.test(id)) return { id, name: `${id} DEF`, position: 'DEF', team: id };
    return { id, name: `unknown(${id})`, position: null, team: null };
  }
  return {
    id,
    name: p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? id,
    position: p.position ?? null,
    team: p.team ?? null,
    bye_week: p.bye_week ?? null,
    injury_status: p.injury_status ?? null,
  };
}

const allRosteredIds = new Set(rosters.flatMap((r) => r.players ?? []));

const teams = rosters.map((r) => {
  const starters = (r.starters ?? []).map(resolve);
  const starterIds = new Set(r.starters ?? []);
  const reserve = (r.reserve ?? []).map(resolve);
  const reserveIds = new Set(r.reserve ?? []);
  const bench = (r.players ?? [])
    .filter((id) => !starterIds.has(id) && !reserveIds.has(id))
    .map(resolve);
  return {
    roster_id: r.roster_id,
    owner: ownerName.get(r.owner_id) ?? r.owner_id,
    record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}`,
    fpts: r.settings?.fpts ?? 0,
    faab_remaining: (league.settings?.waiver_budget ?? 0) - (r.settings?.waiver_budget_used ?? 0),
    starters,
    bench,
    reserve,
  };
});

const myTeam = teams.find((t) => t.roster_id === config.roster_id);
const myMatchup = matchups.find((m) => m.roster_id === config.roster_id);
const oppMatchup = myMatchup
  ? matchups.find((m) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== config.roster_id)
  : null;
const oppTeam = oppMatchup ? teams.find((t) => t.roster_id === oppMatchup.roster_id) : null;

const transactions = transactionsRaw.map((t) => ({
  week: t.leg,
  type: t.type,
  status: t.status,
  by: (t.roster_ids ?? []).map((rid) => teams.find((x) => x.roster_id === rid)?.owner ?? rid),
  adds: Object.keys(t.adds ?? {}).map(resolve),
  drops: Object.keys(t.drops ?? {}).map(resolve),
  faab_bid: t.settings?.waiver_bid ?? null,
}));

const trendResolve = (list) =>
  list.map((t) => ({
    ...resolve(t.player_id),
    add_count: t.count,
    rostered_in_league: allRosteredIds.has(t.player_id),
  }));

const snapshot = {
  fetched_at: new Date().toISOString(),
  season: state.season,
  season_start_date: state.season_start_date ?? null,
  games_have_started: state.season_start_date ? new Date() >= new Date(state.season_start_date) : null,
  week,
  league: {
    name: league.name,
    pass_td: league.scoring_settings?.pass_td,
    rec: league.scoring_settings?.rec,
    roster_positions: league.roster_positions,
    waiver_budget: league.settings?.waiver_budget,
    trade_deadline: league.settings?.trade_deadline,
    playoff_week_start: league.settings?.playoff_week_start,
  },
  my_roster_id: config.roster_id,
  teams,
  matchup: myMatchup
    ? {
        my_starters: myTeam.starters,
        my_points: myMatchup.points ?? 0,
        opponent: oppTeam
          ? { roster_id: oppTeam.roster_id, owner: oppTeam.owner, starters: oppTeam.starters, points: oppMatchup.points ?? 0 }
          : null,
      }
    : null,
  transactions,
  trending: { adds: trendResolve(trendingAdds), drops: trendResolve(trendingDrops) },
};

await mkdir(path.join(dataDir, 'league'), { recursive: true });
await writeFile(path.join(dataDir, 'league', 'snapshot.json'), JSON.stringify(snapshot, null, 2));

// Human-readable summary
const slot = (positions, list) => positions.map((pos, i) => `  ${pos.padEnd(11)} ${list[i] ? `${list[i].name} (${list[i].position ?? '?'} ${list[i].team ?? '-'})` : '—'}`);
const startingSlots = (league.roster_positions ?? []).filter((p) => p !== 'BN');

console.log(`# ${league.name} — Week ${week} (${state.season})`);
console.log(`Me: ${myTeam.owner} (roster ${myTeam.roster_id}) ${myTeam.record}, FAAB $${myTeam.faab_remaining}`);
console.log(`\nMy starters:`);
console.log(slot(startingSlots, myTeam.starters).join('\n'));
if (oppTeam) {
  console.log(`\nOpponent: ${oppTeam.owner} (${oppTeam.record})`);
  console.log(slot(startingSlots, oppTeam.starters).join('\n'));
}
const hurt = [...myTeam.starters, ...myTeam.bench, ...myTeam.reserve].filter((p) => p?.injury_status);
if (hurt.length) {
  console.log(`\nInjury flags on my roster:`);
  for (const p of hurt) console.log(`  ${p.name} (${p.position}) — ${p.injury_status}`);
}
const freeAdds = snapshot.trending.adds.filter((t) => !t.rostered_in_league).slice(0, 10);
console.log(`\nTop trending adds NOT rostered in this league:`);
for (const t of freeAdds) console.log(`  ${t.name} (${t.position ?? '?'} ${t.team ?? '-'}) +${t.add_count}`);
console.log(`\nSnapshot written to data/league/snapshot.json`);
