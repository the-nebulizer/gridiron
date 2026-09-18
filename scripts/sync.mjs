// Pull the whole league state from Sleeper into data/league/snapshot.json,
// with every player ID resolved to a name. This snapshot is the ONLY source
// of truth about rosters and availability — never reason from memory.
//
// Usage: node scripts/sync.mjs [week]
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sleeper from './sleeper.mjs';
import { buildOutlook } from './outlook.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const dataDir = path.join(root, 'data');

const state = await sleeper.getState();
const week = Number(process.argv[2]) || state.week || 1;

const [league, rosters, users, matchups, trendingAdds, trendingDrops, players, schedule] =
  await Promise.all([
    sleeper.getLeague(config.league_id),
    sleeper.getRosters(config.league_id),
    sleeper.getUsers(config.league_id),
    sleeper.getMatchups(config.league_id, week),
    sleeper.getTrending('add'),
    sleeper.getTrending('drop'),
    sleeper.getPlayers(path.join(dataDir, 'players.json')),
    sleeper.getSchedule(state.season),
  ]);

// The players dump is refreshed at most daily, so its injury tags can lag by up
// to 24h. Record when it was actually fetched so a skill can weigh that.
const playersCachedAt = (await stat(path.join(dataDir, 'players.json'))).mtime.toISOString();

// Bye weeks come from the schedule, never from the players dump — Sleeper's
// player objects carry no bye field, so reading one there silently yields null
// and invites guessing from memory. Team code -> bye week.
const byes = sleeper.byeWeeks(schedule);
const scheduleTeams = new Set(schedule.flatMap((g) => [g.home, g.away]));

// Each team's game for the CURRENT week, keyed by team code, so a routine can
// look up games[player.team] instead of re-scanning the schedule itself.
// Checked against a raw schedule response (2026-09-18, week 2): every entry
// is exactly {status, date, home, week, game_id, away}, and `date` is a bare
// calendar date ("2026-09-20") — no time-of-day, no timezone, no separate
// kickoff field anywhere in the payload. So `kickoff` below is that date
// string, unchanged, not a real timestamp; never synthesize a time-of-day
// from a slot guess (early/late/SNF/MNF) — a wrong invented kickoff is worse
// than an honestly date-only one for a Sunday check deciding how much time
// is left. A team on bye this week gets no entry, so a lookup miss reads as
// "no game", not as a stale game from last week. Unlike byeWeeks, a canceled
// game still gets an entry here — its status says "canceled" plainly, which
// is more useful to a reader than silence.
function buildGames(schedule, week) {
  const games = {};
  for (const g of schedule) {
    if (g.week !== week) continue;
    games[g.home] = { kickoff: g.date, status: g.status, opponent: g.away, home: true };
    games[g.away] = { kickoff: g.date, status: g.status, opponent: g.home, home: false };
  }
  return Object.fromEntries(Object.entries(games).sort());
}
const games = buildGames(schedule, week);

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
    if (/^[A-Z]{2,3}$/.test(id))
      return { id, name: `${id} DEF`, position: 'DEF', team: id, bye_week: byes.get(id) ?? null };
    return { id, name: `unknown(${id})`, position: null, team: null };
  }
  return {
    id,
    name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id,
    position: p.position ?? null,
    team: p.team ?? null,
    bye_week: byes.get(p.team) ?? null,
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
    division: r.settings?.division ?? null,
    record: `${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}${r.settings?.ties ? `-${r.settings.ties}` : ''}`,
    // Sleeper splits points into whole + hundredths; ignoring the decimal
    // part shaves up to 0.99 off every team.
    fpts: (r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100,
    faab_remaining: (league.settings?.waiver_budget ?? 0) - (r.settings?.waiver_budget_used ?? 0),
    starters,
    bench,
    reserve,
  };
});

const myTeam = teams.find((t) => t.roster_id === config.roster_id);
const myMatchup = matchups.find((m) => m.roster_id === config.roster_id);
// A null matchup_id means no game this week (playoff bye, eliminated, week 18).
// Matching on it would pair us with whichever other idle roster comes first —
// a fabricated opponent. No id, no opponent.
const oppMatchup =
  myMatchup && myMatchup.matchup_id != null
    ? matchups.find((m) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== config.roster_id)
    : null;
const oppTeam = oppMatchup ? teams.find((t) => t.roster_id === oppMatchup.roster_id) : null;

const transactions = transactionsRaw.map((t) => ({
  week: t.leg,
  // When it actually happened — needed to answer "what changed since I last looked".
  at: t.status_updated ?? t.created ?? null,
  type: t.type,
  status: t.status,
  by: (t.roster_ids ?? []).map((rid) => teams.find((x) => x.roster_id === rid)?.owner ?? rid),
  adds: Object.keys(t.adds ?? {}).map(resolve),
  drops: Object.keys(t.drops ?? {}).map(resolve),
  faab_bid: t.settings?.waiver_bid ?? null,
}));

// `count` used to be called `add_count` on BOTH lists, so a player being cut
// by 400k managers carried an "add_count" of 400k — an invitation to read the
// drop list as interest. Each entry now names its own direction and carries
// the net, because the two run at once and the add count alone flatters a
// player everyone is also cutting.
const addCounts = new Map(trendingAdds.map((t) => [t.player_id, t.count]));
const dropCounts = new Map(trendingDrops.map((t) => [t.player_id, t.count]));
const trendResolve = (list, direction) =>
  list.map((t) => ({
    ...resolve(t.player_id),
    [direction === 'add' ? 'add_count' : 'drop_count']: t.count,
    net_adds: (addCounts.get(t.player_id) ?? 0) - (dropCounts.get(t.player_id) ?? 0),
    rostered_in_league: allRosteredIds.has(t.player_id),
  }));

// Who is actually available, not just who is trending. Candidates used to come
// only from Sleeper's global trending top-100, which in a 12-team league hides
// most of the pool: 81 of 87 unrostered QBs were invisible to /waivers,
// including a listed NFL starter — in a superflex league. The pool is filtered
// to players who could plausibly start (depth chart 1-2, or trending, or a
// defense) and capped per position so it stays cheap to read.
const POOL_CAP = { QB: 10, RB: 12, WR: 12, TE: 10, K: 6, DEF: 8 };
const availableByPosition = {};
for (const [id, p] of Object.entries(players)) {
  if (allRosteredIds.has(id)) continue;
  const pos = p.position;
  if (!POOL_CAP[pos]) continue;
  if (pos !== 'DEF') {
    if (!p.team) continue;                       // not on an NFL roster
    if (p.status && p.status !== 'Active') continue; // practice squad, inactive
    const depth = p.depth_chart_order;
    if (!(depth != null && depth <= 2) && !addCounts.has(id)) continue;
  }
  const resolved = resolve(id);
  (availableByPosition[pos] ??= []).push({
    ...resolved,
    depth_chart_order: p.depth_chart_order ?? null,
    add_count: addCounts.get(id) ?? 0,
    drop_count: dropCounts.get(id) ?? 0,
    net_adds: (addCounts.get(id) ?? 0) - (dropCounts.get(id) ?? 0),
  });
}
for (const [pos, list] of Object.entries(availableByPosition)) {
  list.sort((a, b) =>
    (a.depth_chart_order ?? 9) - (b.depth_chart_order ?? 9) ||
    b.net_adds - a.net_adds ||
    String(a.name).localeCompare(String(b.name))
  );
  availableByPosition[pos] = list.slice(0, POOL_CAP[pos]);
}

const snapshot = {
  fetched_at: new Date().toISOString(),
  players_cached_at: playersCachedAt,
  season: state.season,
  season_start_date: state.season_start_date ?? null,
  // True only once a real game has kicked off, per the schedule's game statuses.
  // The old date comparison flipped at 00:00 UTC on season_start_date — the
  // evening BEFORE the opener in US time — which would switch the skills out of
  // pre-season (free-agent) mode while adds were still first-come-first-serve.
  games_have_started: sleeper.kickoffHasHappened(schedule),
  week,
  // Every league rule a recommendation might turn on, read from the API — not
  // a subset. A rule that isn't here is a rule some routine will reconstruct
  // from memory, which is the one thing this project exists to prevent.
  league: {
    name: league.name,
    teams: league.total_rosters ?? league.settings?.num_teams ?? null,
    divisions: league.settings?.divisions ?? 0,
    roster_positions: league.roster_positions,
    bench_slots: (league.roster_positions ?? []).filter((p) => p === 'BN').length,
    reserve_slots: league.settings?.reserve_slots ?? 0,
    taxi_slots: league.settings?.taxi_slots ?? 0,
    // Which injury designations Sleeper will let into the IR slot. An `ir`
    // recommendation for a player carrying anything else is a move the app
    // will simply refuse.
    ir_eligible_statuses: Object.entries({
      Out: league.settings?.reserve_allow_out,
      Doubtful: league.settings?.reserve_allow_doubtful,
      NA: league.settings?.reserve_allow_na,
      Sus: league.settings?.reserve_allow_sus,
      DNR: league.settings?.reserve_allow_dnr,
      COV: league.settings?.reserve_allow_cov,
    }).filter(([, allowed]) => allowed === 1).map(([status]) => status),
    pass_td: league.scoring_settings?.pass_td,
    rec: league.scoring_settings?.rec,
    scoring: league.scoring_settings,
    waiver_type: league.settings?.waiver_type === 2 ? 'faab' : String(league.settings?.waiver_type ?? ''),
    waiver_budget: league.settings?.waiver_budget,
    waiver_bid_min: league.settings?.waiver_bid_min ?? 0,
    waiver_clear_days: league.settings?.waiver_clear_days,
    // Sleeper counts the week from Sunday, so 2 is Tuesday night's deadline
    // for the Wednesday run.
    waiver_day_of_week: league.settings?.waiver_day_of_week,
    trade_deadline: league.settings?.trade_deadline,
    trade_review_days: league.settings?.trade_review_days,
    veto_votes_needed: league.settings?.veto_votes_needed,
    trades_disabled: league.settings?.disable_trades === 1,
    draft_pick_trading: league.settings?.pick_trading === 1,
    max_keepers: league.settings?.max_keepers ?? 0,
    playoff_teams: league.settings?.playoff_teams,
    playoff_week_start: league.settings?.playoff_week_start,
    // With league_average_match on, every team also plays the league median
    // each week — a second result that rewards a high floor over a boom bench.
    median_matchup: league.settings?.league_average_match === 1,
  },
  // Team -> bye week for all 32 NFL teams, so any player's bye is derivable
  // without re-fetching the schedule (and without anyone recalling one).
  byes: Object.fromEntries([...byes.entries()].sort()),
  // This week's kickoff/status/opponent per team, one entry per team with a
  // game this week (see buildGames above for what `kickoff` actually holds).
  games,
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
  transactions: transactions.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
  trending: { adds: trendResolve(trendingAdds, 'add'), drops: trendResolve(trendingDrops, 'drop') },
  // The free-agent pool by position, best first. This is the candidate list
  // for /waivers — `trending` alone is Sleeper-wide noise, not availability.
  available: availableByPosition,
};

// CLAUDE.md, docs/LEAGUE.md, docs/ACTIONS.md and the waivers/trade skills all
// say "Tuesday night deadline, Wednesday processing, 2-day clear" as prose,
// not read from the snapshot — Sleeper numbers days from Monday, so
// waiver_day_of_week 2 is Wednesday, and a 2-day clear means a player
// dropped Monday is claimable in that Wednesday run.
// If the commissioner ever changes either setting in Sleeper, every report
// and the dashboard would keep saying "Wednesday" with nothing to catch the
// drift. Kept as one pure function, not inline, so selftest.mjs can pin it
// without running the live sync. This doesn't rearchitect that prose into
// reading the field — it just makes a mismatch loud instead of silent.
function waiverAssumptionWarning(league) {
  if (league.waiver_day_of_week === 2 && league.waiver_clear_days === 2) return null;
  return `WARNING: league waiver settings no longer match what the docs and reports assume ` +
    `(waiver_day_of_week=${league.waiver_day_of_week}, waiver_clear_days=${league.waiver_clear_days}; ` +
    `expected 2 and 2, i.e. Wednesday processing with a 2-day clear). ` +
    `Update CLAUDE.md, docs/LEAGUE.md, docs/ACTIONS.md and the waivers/trade skills before trusting any "by Tuesday" wording.`;
}
const waiverWarning = waiverAssumptionWarning(snapshot.league);
if (waiverWarning) console.error(waiverWarning);

// The forward view, computed here so every routine reads the same numbers:
// what my roster looks like in each week still to come, which slots go empty,
// and which weeks need a plan. Nothing downstream should ever count positions
// or recall a bye by hand. See scripts/outlook.mjs.
snapshot.outlook = buildOutlook(snapshot);

await mkdir(path.join(dataDir, 'league'), { recursive: true });
await writeFile(path.join(dataDir, 'league', 'snapshot.json'), JSON.stringify(snapshot, null, 2));

// Human-readable summary
const byeWeek = (p) => (p?.bye_week ? `, bye W${p.bye_week}` : '');
const slot = (positions, list) => positions.map((pos, i) => `  ${pos.padEnd(11)} ${list[i] ? `${list[i].name} (${list[i].position ?? '?'} ${list[i].team ?? '-'}${byeWeek(list[i])})` : '—'}`);
const startingSlots = (league.roster_positions ?? []).filter((p) => p !== 'BN');

console.log(`# ${league.name} — Week ${week} (${state.season})`);
console.log(`Me: ${myTeam.owner} (roster ${myTeam.roster_id}) ${myTeam.record}, FAAB $${myTeam.faab_remaining}`);
console.log(`\nMy starters:`);
console.log(slot(startingSlots, myTeam.starters).join('\n'));
if (oppTeam) {
  console.log(`\nOpponent: ${oppTeam.owner} (${oppTeam.record})`);
  console.log(slot(startingSlots, oppTeam.starters).join('\n'));
} else {
  console.log(`\nNo matchup this week (bye or not scheduled).`);
}
// A rostered player on a real team with no bye resolved means byeWeeks() gave
// up on that team (see its warning) — never let that pass as a quiet null.
const noBye = new Set();
for (const t of teams) {
  for (const p of [...t.starters, ...t.bench, ...t.reserve].filter(Boolean)) {
    if (p.team && p.bye_week == null && scheduleTeams.has(p.team)) noBye.add(p.team);
  }
}
for (const team of [...noBye].sort()) console.log(`WARNING: no bye week resolved for ${team} — rostered ${team} players carry bye_week null; check the schedule before trusting any bye plan.`);
const hurt = [...myTeam.starters, ...myTeam.bench, ...myTeam.reserve].filter((p) => p?.injury_status);
if (hurt.length) {
  console.log(`\nInjury flags on my roster:`);
  for (const p of hurt) console.log(`  ${p.name} (${p.position}) — ${p.injury_status}`);
}
// The forward view: roster shape now, then every week still to come. Past
// weeks are not printed — nothing can be done about them, and a bye that has
// already passed reads as a problem when it isn't one.
const shape = snapshot.outlook.roster_shape;
console.log(`\nRoster shape: ${Object.entries(shape.active_by_position).map(([pos, n]) => `${n} ${pos}`).join(', ')} active${shape.ir_used ? `, ${shape.ir_used} on IR` : ''}`);
console.log(`  Bench ${shape.bench_slots - shape.bench_open}/${shape.bench_slots} used, IR ${shape.ir_used}/${shape.ir_slots} used.${shape.thin_positions.length ? ` No cover at: ${shape.thin_positions.join(', ')}.` : ''}`);
console.log(`\nWeeks ${snapshot.outlook.from_week}-${snapshot.outlook.through_week} (playoffs W${snapshot.outlook.playoff_weeks[0]}-W${snapshot.outlook.playoff_weeks.at(-1)}, trade deadline W${snapshot.outlook.trade_deadline_week}):`);
for (const w of snapshot.outlook.weeks) {
  const bits = [];
  if (w.byes) bits.push(`bye: ${w.byes.map((p) => `${p.name} (${p.pos})`).join(', ')}`);
  if (w.empty_slots) bits.push(`CANNOT FILL ${w.empty_slots.join(', ')}`);
  if (w.empty_slots_if_injured_stay_out) bits.push(`${w.empty_slots_if_injured_stay_out.join(', ')} empty unless ${w.injured_counted.map((p) => p.name).join('/')} is back`);
  if (bits.length) console.log(`  W${String(w.week).padEnd(2)}${w.playoffs ? '*' : ' '} ${bits.join(' · ')}`);
}
console.log(snapshot.outlook.crunch_weeks.length
  ? `  Crunch weeks: ${snapshot.outlook.crunch_weeks.map((w) => `W${w}`).join(', ')} (* = fantasy playoffs)`
  : `  No crunch weeks ahead.`);
// Forward-aware, not forward-planning: the outlook says which slots go empty
// and this says who is sitting there to fix it. The call itself is /waivers'.
const holes = new Map();
for (const w of snapshot.outlook.weeks) {
  for (const slot of w.empty_slots ?? []) {
    if (!holes.has(slot)) holes.set(slot, []);
    holes.get(slot).push(w.week);
  }
}
if (holes.size) {
  console.log(`\nFree agents who cover the slots above:`);
  for (const [slot, weeks] of holes) {
    const pool = (snapshot.available[slot] ?? []).filter((p) => !weeks.includes(p.bye_week)).slice(0, 4);
    console.log(`  ${slot} (needed W${weeks.join(', W')}): ${pool.length ? pool.map((p) => `${p.name} (${p.team})`).join(', ') : 'nobody unrostered covers it'}`);
  }
}

const freeAdds = snapshot.trending.adds.filter((t) => !t.rostered_in_league).slice(0, 10);
console.log(`\nTop trending adds NOT rostered in this league:`);
for (const t of freeAdds) console.log(`  ${t.name} (${t.position ?? '?'} ${t.team ?? '-'}) +${t.add_count} adds, net ${t.net_adds >= 0 ? '+' : ''}${t.net_adds}`);
console.log(`\nSnapshot written to data/league/snapshot.json`);
