// Pure core of the points model — no imports beyond outlook-core, no Node
// builtins. It answers the question every add, drop and trade turns on and
// that the outlook (a fillability check) cannot: how many points does my
// best lineup score, week by week, with and without this move?
//
// Why it exists: on 2026-10-13 the waivers routine named three drops in one
// day — Stefon Diggs, then Bryce Young, then Will Reichard — each argued in
// prose, none from a number. Young had the highest scoring average of any
// quarterback on the roster (27.6/g). Nothing in the system could say so,
// because the snapshot carried rosters and byes but not one point scored or
// projected. Every recommendation now has to quote this instead.
//
// Inputs, all in the snapshot:
//   production[id] = { gp, avg, last3, pts: {week: n}, proj: {week: n} }
//     pts  — actual points in THIS league's scoring (validated exactly against
//            Sleeper's credited matchup points: 938/938 player-weeks)
//     proj — Sleeper's weekly projection, scored with the same settings
//   league.roster_positions, teams, my_roster_id, week
//
// Projections do NOT know about injuries (Lamar Jackson listed Out still
// projects 22.9), so the current week applies the injury tag itself:
// CURRENT_WEEK_OUT statuses score 0 this week. Later weeks use the projection
// as given — Sleeper does zero players it expects to miss (Charbonnet on PUP
// projects 0 in W6, 7.5 in W7) — and the report must say when a return date
// matters to the call.

import { SLOT_ELIGIBILITY } from './outlook-core.mjs';

export const CURRENT_WEEK_OUT = /^(out|doubtful|ir|pup|na|nfi|sus|dnr|cov)$/i;

// Score a stat line with the league's own scoring settings.
export function scoreLine(stats, scoring) {
  if (!stats) return 0;
  let total = 0;
  for (const [key, weight] of Object.entries(scoring ?? {})) {
    const v = stats[key];
    if (typeof v === 'number') total += v * weight;
  }
  return Math.round(total * 100) / 100;
}

// Maximum-weight assignment of players to starting slots (Hungarian
// algorithm, rectangular: every player gets either a slot or a bench column).
// A greedy fill is wrong here in exactly the superflex case — the best QB
// grabbed for SUPER_FLEX can strand a lineup that needed him at QB.
export function bestLineup(slotNames, players, pointsOf) {
  const n = players.length;
  const m = slotNames.length;
  if (!n) return { total: 0, lineup: slotNames.map((slot) => ({ slot, player: null, pts: 0 })) };
  const cols = m + n; // m real slots + n bench columns worth 0
  const NEG = -1e6;
  const w = players.map((p) => {
    const pts = pointsOf(p);
    const row = new Array(cols).fill(0);
    for (let j = 0; j < m; j++) row[j] = SLOT_ELIGIBILITY[slotNames[j]].includes(p.position) ? pts : NEG;
    return row;
  });
  // e-maxx Hungarian on cost = -weight, 1-indexed.
  const INF = 1e18;
  const u = new Array(n + 1).fill(0), v = new Array(cols + 1).fill(0);
  const pRow = new Array(cols + 1).fill(0), way = new Array(cols + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    pRow[0] = i;
    let j0 = 0;
    const minv = new Array(cols + 1).fill(INF);
    const used = new Array(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = pRow[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = -w[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) { u[pRow[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (pRow[j0] !== 0);
    do { const j1 = way[j0]; pRow[j0] = pRow[j1]; j0 = j1; } while (j0);
  }
  const lineup = slotNames.map((slot, j) => {
    const i = pRow[j + 1];
    const p = i ? players[i - 1] : null;
    const pts = p ? w[i - 1][j] : 0;
    // A body worth 0 (bye, ruled out) is not a starter — the slot is empty.
    return pts <= 0 ? { slot, player: null, pts: 0 } : { slot, player: p, pts };
  });
  const total = Math.round(lineup.reduce((s, x) => s + x.pts, 0) * 10) / 10;
  return { total, lineup };
}

// Points a player is expected to score in a given week, as the model sees it.
export function weekPoints(snapshot, player, week) {
  if (!player) return 0;
  if (player.bye_week === week) return 0;
  if (week === snapshot.week && CURRENT_WEEK_OUT.test(player.injury_status ?? '')) return 0;
  const prod = snapshot.production?.[player.id];
  return prod?.proj?.[week] ?? 0;
}

function myTeam(snapshot) {
  return snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
}

function findPlayer(snapshot, id) {
  if (typeof id !== 'string') return id;
  for (const t of snapshot.teams) {
    for (const p of [...t.starters, ...t.bench, ...t.reserve]) if (p?.id === id) return p;
  }
  for (const list of Object.values(snapshot.available ?? {})) {
    const p = list.find((x) => x.id === id);
    if (p) return p;
  }
  const t = (snapshot.trending?.adds ?? []).find((x) => x.id === id);
  if (t) return t;
  throw new Error(`value: unknown player id "${id}"`);
}

export function remainingWeeks(snapshot) {
  const playoffStart = snapshot.league?.playoff_week_start ?? 15;
  const last = Math.max(playoffStart + 2, 17);
  const out = [];
  for (let w = Math.max(snapshot.week ?? 1, 1); w <= last; w++) out.push(w);
  return out;
}

// The active roster after a hypothetical move. IR players are excluded: they
// cannot fill a slot until activated, which is its own move.
export function activeRoster(snapshot, { add = [], drop = [] } = {}) {
  const me = myTeam(snapshot);
  const dropIds = new Set(drop.map((d) => (typeof d === 'string' ? d : d.id)));
  const active = [...me.starters, ...me.bench].filter(Boolean).filter((p) => !dropIds.has(p.id));
  for (const a of add) {
    const p = findPlayer(snapshot, a);
    if (!active.some((x) => x.id === p.id)) active.push(p);
  }
  return active;
}

function slotsOf(snapshot) {
  return (snapshot.league?.roster_positions ?? []).filter((p) => p !== 'BN');
}

export function weeklyTotals(snapshot, roster, weeks = remainingWeeks(snapshot)) {
  const slots = slotsOf(snapshot);
  return weeks.map((week) => ({ week, total: bestLineup(slots, roster, (p) => weekPoints(snapshot, p, week)).total }));
}

const r1 = (x) => Math.round(x * 10) / 10;

// The value of a move, in projected starting-lineup points, against the roster
// as it stands. Positive is good. Broken out so a report can't hide a cost
// behind a total: this week, the next three, rest of season, and playoffs.
export function moveValue(snapshot, { add = [], drop = [] } = {}) {
  const weeks = remainingWeeks(snapshot);
  const base = weeklyTotals(snapshot, activeRoster(snapshot), weeks);
  const next = weeklyTotals(snapshot, activeRoster(snapshot, { add, drop }), weeks);
  const playoffStart = snapshot.league?.playoff_week_start ?? 15;
  const by_week = weeks.map((week, i) => ({ week, delta: r1(next[i].total - base[i].total) }));
  const sum = (f) => r1(by_week.filter(f).reduce((s, x) => s + x.delta, 0));
  const thisWeek = weeks[0];
  return {
    this_week: sum((x) => x.week === thisWeek),
    next_3: sum((x) => x.week < thisWeek + 3),
    rest_of_season: sum(() => true),
    playoffs: sum((x) => x.week >= playoffStart),
    by_week: by_week.filter((x) => x.delta !== 0),
  };
}

// Cover value: what a player is worth as insurance, which a projection-only
// lineup cannot see (a healthy backup QB never starts on paper). For each
// starter he could replace, how many lineup points does having him save if
// that starter misses one of the next three weeks? Averaged over those
// starters and weeks. A number, not a verdict — the report weighs it.
export function coverValue(snapshot, player, horizon = 3) {
  const slots = slotsOf(snapshot);
  const roster = activeRoster(snapshot);
  const without = roster.filter((p) => p.id !== player.id);
  const weeks = remainingWeeks(snapshot).slice(0, horizon);
  const eligible = (p) => slots.some((s) => SLOT_ELIGIBILITY[s].includes(p.position) && SLOT_ELIGIBILITY[s].includes(player.position));
  let total = 0, n = 0;
  for (const week of weeks) {
    const pts = (p) => weekPoints(snapshot, p, week);
    const starters = bestLineup(slots, roster, pts).lineup.map((x) => x.player)
      .filter((p) => p && p.id !== player.id && eligible(p) && pts(p) > 0);
    for (const s of starters) {
      const withHim = bestLineup(slots, roster.filter((p) => p.id !== s.id), pts).total;
      const withoutHim = bestLineup(slots, without.filter((p) => p.id !== s.id), pts).total;
      total += withHim - withoutHim;
      n++;
    }
  }
  return n ? r1(total / n) : 0;
}

// Every player on my active roster, with what dropping him (and adding no
// one) costs the lineup, plus his cover value and his record. Sorted
// cheapest-to-drop first: this is the drop order, and a report that names a
// different drop has to say why.
export function dropTable(snapshot) {
  const me = myTeam(snapshot);
  const rows = [];
  for (const p of activeRoster(snapshot)) {
    const v = moveValue(snapshot, { drop: [p.id] });
    const prod = snapshot.production?.[p.id] ?? {};
    rows.push({
      id: p.id, name: p.name, pos: p.position, team: p.team, status: p.injury_status ?? null,
      starting: me.starters.some((s) => s?.id === p.id),
      avg: prod.avg ?? null, gp: prod.gp ?? 0, last3: prod.last3 ?? null,
      proj_this_week: r1(weekPoints(snapshot, p, snapshot.week)),
      lost_this_week: -v.this_week, lost_rest_of_season: -v.rest_of_season, lost_playoffs: -v.playoffs,
      cover: coverValue(snapshot, p),
    });
  }
  rows.sort((a, b) => a.lost_rest_of_season + a.cover - (b.lost_rest_of_season + b.cover) || a.lost_this_week - b.lost_this_week);
  return rows;
}

// For one candidate add, every possible drop from my active roster and what
// the swap is worth. Best first. When the roster has an open spot, "no drop"
// is one of the options.
export function swapTable(snapshot, addId) {
  const add = findPlayer(snapshot, addId);
  const options = [];
  const me = myTeam(snapshot);
  const slots = slotsOf(snapshot);
  const benchSlots = (snapshot.league?.roster_positions ?? []).filter((p) => p === 'BN').length;
  const open = slots.length + benchSlots - activeRoster(snapshot).length;
  if (open > 0) options.push({ drop: null, drop_name: '(open spot)', ...moveValue(snapshot, { add: [add] }), cover_lost: 0 });
  for (const p of activeRoster(snapshot)) {
    options.push({
      drop: p.id, drop_name: p.name, drop_pos: p.position,
      ...moveValue(snapshot, { add: [add], drop: [p.id] }),
      cover_lost: coverValue(snapshot, p),
    });
  }
  options.sort((a, b) => (b.rest_of_season - b.cover_lost) - (a.rest_of_season - a.cover_lost) || b.this_week - a.this_week);
  return { add: { id: add.id, name: add.name, pos: add.position, team: add.team }, options, starters_unchanged: me == null };
}

// The best lineup for one week by projection, with who sits — the baseline
// the lineup routine starts from before news adjusts it.
export function projectedLineup(snapshot, week = snapshot.week) {
  const slots = slotsOf(snapshot);
  const roster = activeRoster(snapshot);
  const pts = (p) => weekPoints(snapshot, p, week);
  const { total, lineup } = bestLineup(slots, roster, pts);
  const used = new Set(lineup.map((x) => x.player?.id).filter(Boolean));
  return {
    week, total,
    lineup: lineup.map(({ slot, player, pts: p }) => ({ slot, id: player?.id ?? null, name: player?.name ?? null, pts: r1(p) })),
    bench: roster.filter((p) => !used.has(p.id)).map((p) => ({ id: p.id, name: p.name, pos: p.position, pts: r1(pts(p)), status: p.injury_status ?? null })),
  };
}

// The projected lineup with every player's matchup beside his projection, and
// every slot where the two pick different players. A projection-only lineup
// answered two start/sit questions in chat on 2026-10-29 (Goff over Cousins
// against the league's toughest QB defense; Denver over Cleveland against the
// stingiest offense for a DEF) while the published lineup report had already
// called both the other way on matchup — so the one tool everyone reaches for
// carries the matchup itself instead of relying on a second command.
// `locked` = his game has already started (snapshot.games), so the slot is set.
export function lineupWithMatchups(snapshot, week = snapshot.week) {
  const out = projectedLineup(snapshot, week);
  const byId = new Map(activeRoster(snapshot).map((p) => [p.id, p]));
  const locked = (p) => week === snapshot.week && ['in_game', 'complete'].includes(snapshot.games?.[p?.team]?.status);
  const enrich = (row) => {
    const p = byId.get(row.id);
    const m = p ? matchupAdjusted(snapshot, p, week) : null;
    return { ...row, pos: p?.position ?? row.pos ?? null, locked: locked(p), matchup: m };
  };
  const lineup = out.lineup.map(enrich);
  const bench = out.bench.map(enrich);
  const disagreements = [];
  for (const b of bench) {
    if (b.locked || !b.matchup || b.pts <= 0) continue;
    for (const s of lineup) {
      if (s.locked || !s.matchup || !SLOT_ELIGIBILITY[s.slot]?.includes(b.pos)) continue;
      if (b.matchup.estimate > s.matchup.estimate) {
        disagreements.push({ slot: s.slot, starter: s.name, starter_pts: s.pts, starter_adj: s.matchup.estimate, bench: b.name, bench_pts: b.pts, bench_adj: b.matchup.estimate });
      }
    }
  }
  return { ...out, lineup, bench, disagreements };
}

// Fantasy points each NFL team has allowed to each position this
// season, in THIS league's scoring, with a rank (1 = allows the most, i.e. the
// easiest matchup). A projection prices the opponent in as one number; this
// is the number behind it, so a start/sit call between two quarterbacks can
// say who each one faces and how that defense has actually played — Ben's
// rule, 2026-10-21, after a QB call was made off projections alone.
//
// Attribution uses each player's CURRENT team (Sleeper's weekly stat lines
// carry no team), so a player traded mid-season credits his earlier games to
// his new team's opponents. A line from a week his current team had no game
// is the tell for that and is skipped rather than misfiled.
//
//   schedule   — [{week, home, away, status}], the full season
//   weekStats  — weekStats[i] is the stat map for week i + 1
//   playerInfo — id -> {position, team}
// K counts kickers' points against that defense; DEF counts what defenses
// scored against that team's OFFENSE (a DEF stat line is keyed by its own
// team code, so it lands on the team it played) — the streaming question.
export const ALLOWED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
export function defenseAllowed(schedule, weekStats, playerInfo, scoring) {
  const opponent = new Map(); // `${week}:${team}` -> opponent
  for (const g of schedule ?? []) {
    if (g.status === 'canceled') continue;
    opponent.set(`${g.week}:${g.home}`, g.away);
    opponent.set(`${g.week}:${g.away}`, g.home);
  }
  const totals = {}; // def -> {weeks: Set(week), QB: n, ...}
  const entry = (d) => (totals[d] ??= { weeks: new Set(), ...Object.fromEntries(ALLOWED_POSITIONS.map((p) => [p, 0])) });
  (weekStats ?? []).forEach((stats, i) => {
    const week = i + 1;
    if (!stats) return;
    // A game counts for the defense whether or not anyone scored on it.
    for (const key of opponent.keys()) {
      const [w, team] = key.split(':');
      if (Number(w) === week) entry(team).weeks.add(week);
    }
    for (const [id, line] of Object.entries(stats)) {
      if (!(line?.gp > 0)) continue;
      const info = playerInfo?.[id];
      if (!info || !ALLOWED_POSITIONS.includes(info.position) || !info.team) continue;
      const def = opponent.get(`${week}:${info.team}`);
      if (!def) continue;
      entry(def)[info.position] += scoreLine(line, scoring);
    }
  });
  const out = {};
  for (const [def, t] of Object.entries(totals)) {
    out[def] = { games: t.weeks.size };
    for (const pos of ALLOWED_POSITIONS) out[def][pos] = { avg: r1(t[pos] / (t.weeks.size || 1)), rank: null };
  }
  const n = Object.keys(out).length;
  for (const pos of ALLOWED_POSITIONS) {
    Object.keys(out)
      .sort((a, b) => out[b][pos].avg - out[a][pos].avg || a.localeCompare(b))
      .forEach((def, i) => { out[def][pos].rank = i + 1; out[def][pos].of = n; });
  }
  return Object.fromEntries(Object.entries(out).sort());
}

// A rough opponent-adjusted read for one player in one week: how he has
// scored relative to what his past opponents allow his position, applied to
// what this week's opponent allows. Goff's 27.8 average on 2026-10-21 came
// largely against the 3rd- and 4th-most generous pass defenses; against Green
// Bay (28th of 32) it read 19.0, where the projection said 22.6. Small
// samples and the player's own games sit inside the defense averages, so this
// is a second opinion beside the projection, never a replacement for it.
// Returns null when there is nothing to compare (no games, no opponent).
export function matchupAdjusted(snapshot, player, week = snapshot.week) {
  const dvp = snapshot.defense_vs_position;
  const pos = player?.position;
  const team = player?.team;
  if (!dvp || !ALLOWED_POSITIONS.includes(pos) || !team) return null;
  const raw = snapshot.team_schedule?.[team]?.[week];
  if (!raw || raw === 'BYE') return null;
  const opp = raw.replace(/^@/, '');
  const pts = snapshot.production?.[player.id]?.pts ?? {};
  let scored = 0, expected = 0, games = 0;
  for (const [w, p] of Object.entries(pts)) {
    const faced = snapshot.team_schedule_played?.[team]?.[w];
    if (!faced || faced === 'BYE') continue;
    const allowed = dvp[faced.replace(/^@/, '')]?.[pos]?.avg;
    if (typeof allowed !== 'number' || allowed <= 0) continue;
    scored += p; expected += allowed; games++;
  }
  const vs = dvp[opp]?.[pos];
  if (!games || !vs) return null;
  const ratio = scored / expected;
  return { opponent: opp, home: !raw.startsWith('@'), allows: vs.avg, rank: vs.rank, of: vs.of, ratio: Math.round(ratio * 100) / 100, games, estimate: r1(ratio * vs.avg) };
}
