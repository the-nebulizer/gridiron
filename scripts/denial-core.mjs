// "Should I bid just to keep someone else from getting him?" — answered from
// the snapshot, not from a feeling.
//
// Born 2026-11-05: Devin Singletary added nothing to Ben's lineup, so four
// reports passed on him. annaf23 — the team the Bowers offer was with, and a
// team with a stake in Ben's playoff race — then won him for $15 after a
// second manager also bid. Nothing in the system asked who else would gain
// from a player, or whether he could be a trade piece. This does.
//
// For every unrostered candidate it computes, for each of the other 11 teams,
// what his arrival does to THAT team's best lineup (same engine and
// projections as value-core.mjs), then sets that beside how much the team
// matters to Ben (this week's opponent, a direct rival in the race, the
// bubble, or nobody), whether anyone is actually contesting him, and what it
// would cost Ben (FAAB ceiling, and the roster spot he'd have to free).
//
// It computes and flags; it does not spend Ben's money. The report makes the
// call, and a bid that adds nothing to Ben's own lineup has to say, in the
// action block, whether it is a block or a trade chip — actions.mjs checks
// that against this file.
import { bestLineup, weekPoints, remainingWeeks, swapTable } from './value-core.mjs';

// ---- thresholds (projected lineup points; named so the report can quote them) ----
export const OPPONENT_THIS_WEEK_GAIN = 3;    // a start that swings this week's game
export const RIVAL_ROS_GAIN = 8;             // rest-of-season points that move a playoff race
export const RIVAL_PLAYOFF_GAIN = 3;         // ...and that show up in W15-17
export const CHIP_ROS_GAIN = 5;              // a buyer needs to actually start him to pay for him
export const OWN_MERIT_GAIN = 3;             // above this he is a normal add, not a denial case
export const HOT_NET_ADDS = 300000;          // Sleeper-wide net adds that count as the market wanting him
export const HOT_CLAIMANTS = 2;              // distinct managers in this league who went after him

const r1 = (x) => Math.round(x * 10) / 10;

export function parseRecord(rec) {
  const m = String(rec ?? '').match(/^(\d+)-(\d+)(?:-(\d+))?$/);
  if (!m) return { w: 0, l: 0, t: 0, pct: 0, games: 0 };
  const [w, l, t] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const games = w + l + t;
  return { w, l, t, games, pct: games ? (w + t / 2) / games : 0 };
}

function slotsOf(snapshot) {
  return (snapshot.league?.roster_positions ?? []).filter((p) => p !== 'BN');
}

// Active roster of any team (IR/reserve cannot fill a slot).
function teamRoster(team) {
  return [...team.starters, ...team.bench].filter(Boolean);
}

// What adding `player` does to a team's best lineup: this week, rest of
// season, playoffs. Weeks where the team is idle are zero by construction
// (weekPoints already zeroes byes and current-week Out tags).
export function teamGain(snapshot, team, player) {
  const slots = slotsOf(snapshot);
  const weeks = remainingWeeks(snapshot);
  const playoffStart = snapshot.league?.playoff_week_start ?? 15;
  const base = teamRoster(team);
  const withHim = base.some((p) => p.id === player.id) ? base : [...base, player];
  const by_week = weeks.map((week) => {
    const pts = (p) => weekPoints(snapshot, p, week);
    return { week, delta: bestLineup(slots, withHim, pts).total - bestLineup(slots, base, pts).total };
  });
  const sum = (f) => r1(by_week.filter(f).reduce((s, x) => s + x.delta, 0));
  return {
    this_week: sum((x) => x.week === weeks[0]),
    rest_of_season: sum(() => true),
    playoffs: sum((x) => x.week >= playoffStart),
  };
}

// How much a team matters to Ben's season. The order is the order of
// importance: the team across the table this week; a team in my division or
// within two games of me or ahead; a team fighting for the last playoff
// spots; everyone else.
export function relationships(snapshot) {
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const mine = parseRecord(me.record);
  const cut = snapshot.league?.playoff_teams ?? 7;
  const ranked = [...snapshot.teams].sort((a, b) => parseRecord(b.record).pct - parseRecord(a.record).pct || b.fpts - a.fpts);
  const rankOf = new Map(ranked.map((t, i) => [t.roster_id, i + 1]));
  const oppId = snapshot.matchup?.opponent?.roster_id;
  const out = new Map();
  for (const t of snapshot.teams) {
    if (t.roster_id === me.roster_id) continue;
    const rec = parseRecord(t.record);
    const rank = rankOf.get(t.roster_id);
    const gamesBehind = (mine.pct - rec.pct) * Math.max(mine.games, 1);
    let tag = 'out of it', weight = 0;
    if (t.roster_id === oppId) { tag = 'opponent this week'; weight = 3; }
    else if ((t.division === me.division && gamesBehind <= 2) || gamesBehind <= 0) { tag = 'direct rival'; weight = 2; }
    else if (rank >= cut - 2 && rank <= cut + 2) { tag = 'on the bubble'; weight = 1; }
    out.set(t.roster_id, { tag, weight, rank, record: t.record });
  }
  return { me, mine, cut, ranks: rankOf, byTeam: out };
}

// Who has been going after a player: distinct claimants (won or lost) in the
// transactions the snapshot carries, plus whether he was dropped and re-bid.
export function demandFor(snapshot, playerId) {
  const claimants = new Set();
  const bids = [];
  let dropped_by = null;
  for (const tx of snapshot.transactions ?? []) {
    if ((tx.adds ?? []).some((a) => a.id === playerId)) {
      for (const who of tx.by ?? []) claimants.add(who);
      if (tx.status === 'complete' && tx.type === 'waiver') bids.push({ by: (tx.by ?? [])[0], faab: tx.faab_bid ?? 0 });
    }
    if ((tx.drops ?? []).some((d) => d.id === playerId)) dropped_by = (tx.by ?? [])[0] ?? null;
  }
  return { claimants: [...claimants], winning_bids: bids, dropped_by };
}

// Candidates: the unrostered pool, deduped. Dropped-and-unclaimed players are
// already in `available`; trending adds not rostered are added too.
export function candidatePool(snapshot) {
  const seen = new Map();
  for (const list of Object.values(snapshot.available ?? {})) for (const p of list) seen.set(p.id, p);
  for (const t of snapshot.trending?.adds ?? []) if (!t.rostered_in_league && !seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

// A team that is short at a position "gains" from ANY player there, and can
// claim a replacement for free. What a candidate takes away from a team, or
// is worth to it, is the gain OVER the best other unrostered player at his
// position — otherwise every tight end on the wire looks like a threat the
// week a rival's TE slot is empty.
function exclusiveGain(snapshot, team, player, cache) {
  const key = (p) => `${team.roster_id}:${p.id}`;
  const gainOf = (p) => cache.get(key(p)) ?? (cache.set(key(p), teamGain(snapshot, team, p)), cache.get(key(p)));
  const g = gainOf(player);
  const alts = candidatePool(snapshot).filter((p) => p.id !== player.id && p.position === player.position);
  let best = { this_week: 0, rest_of_season: 0, playoffs: 0 };
  for (const a of alts) {
    const ag = gainOf(a);
    if (ag.rest_of_season > best.rest_of_season) best = ag;
  }
  const ex = (k) => r1(Math.max(0, g[k] - Math.max(0, best[k])));
  return { raw: g, this_week: ex('this_week'), rest_of_season: ex('rest_of_season'), playoffs: ex('playoffs') };
}

export function denialRow(snapshot, player, { partners = [], cache = new Map() } = {}) {
  const rel = relationships(snapshot);
  const demand = demandFor(snapshot, player.id);
  const byOwner = new Map(snapshot.teams.map((t) => [t.owner, t]));

  // Me: what he's worth to my own lineup, and what the roster spot costs.
  let own = null;
  try {
    const t = swapTable(snapshot, player.id);
    const best = t.options[0];
    own = best ? { this_week: best.this_week, rest_of_season: best.rest_of_season, playoffs: best.playoffs, drop: best.drop_name, net: r1(best.rest_of_season - best.cover_lost) } : null;
  } catch { own = null; }

  const teams = snapshot.teams.filter((t) => t.roster_id !== snapshot.my_roster_id).map((t) => {
    const g = exclusiveGain(snapshot, t, player, cache);
    const r = rel.byTeam.get(t.roster_id);
    const contesting = demand.claimants.includes(t.owner);
    const material =
      (r.tag === 'opponent this week' && g.this_week >= OPPONENT_THIS_WEEK_GAIN) ||
      (['direct rival', 'on the bubble'].includes(r.tag) && g.rest_of_season >= RIVAL_ROS_GAIN && g.playoffs >= RIVAL_PLAYOFF_GAIN);
    return {
      roster_id: t.roster_id, owner: t.owner, relation: r.tag, rank: r.rank, record: r.record,
      faab: t.faab_remaining, contesting, partner: partners.includes(t.owner),
      this_week: g.this_week, rest_of_season: g.rest_of_season, playoffs: g.playoffs,
      raw_rest_of_season: g.raw.rest_of_season, material, buyer: g.rest_of_season >= CHIP_ROS_GAIN,
    };
  });

  const threats = teams.filter((t) => t.material).sort((a, b) => b.rest_of_season - a.rest_of_season);
  const buyers = teams.filter((t) => t.buyer).sort((a, b) => b.rest_of_season - a.rest_of_season);
  const ownMerit = own && (own.net >= OWN_MERIT_GAIN || own.this_week >= OWN_MERIT_GAIN);

  // The price to beat is not visible (bids are blind). What is visible: who
  // could pay, and what winning bids have looked like for him this window.
  const ceiling = threats.length ? Math.max(...threats.map((t) => t.faab)) : 0;
  const likely = threats.filter((t) => t.contesting || t.faab > 0);

  let verdict, reason;
  if (ownMerit) {
    verdict = 'ADD_ON_MERIT'; reason = 'he improves my own lineup — a normal /waivers add, no denial case needed';
  } else if (threats.length && threats.some((t) => t.contesting || demand.claimants.length)) {
    verdict = 'BLOCK_CANDIDATE';
    reason = `${threats.map((t) => t.owner).join(', ')} would start him and matter to my season`;
  } else if (threats.length) {
    verdict = 'WATCH';
    reason = `${threats.map((t) => t.owner).join(', ')} would gain, but nobody has bid on him yet — a block is a guess; recheck after the run`;
  } else if (buyers.length && !ownMerit) {
    verdict = 'TRADE_CHIP_CANDIDATE';
    reason = `${buyers.slice(0, 3).map((t) => t.owner).join(', ')} would start him`;
  } else {
    verdict = 'NO'; reason = 'no team that matters to my season gains from him, and nobody who would start him is a trade partner';
  }
  if (verdict !== 'NO' && partners.length) {
    const hit = buyers.filter((t) => t.partner);
    if (hit.length && !['ADD_ON_MERIT'].includes(verdict)) {
      verdict = verdict === 'BLOCK_CANDIDATE' ? 'BLOCK_AND_CHIP' : 'TRADE_CHIP_CANDIDATE';
      reason += `; ${hit.map((t) => t.owner).join(', ')} (a trade partner) would start him`;
    }
  }

  // Revealed demand. A projection model sees lineups, not what a manager
  // thinks a player is worth; a hot player nobody's lineup needs on paper is
  // exactly the Singletary case. Never let "the model sees no gain" close it.
  const trend = (snapshot.trending?.adds ?? []).find((t) => t.id === player.id);
  const netAdds = player.net_adds ?? trend?.net_adds ?? 0;
  // Kickers and defenses are streamed at $0 after the run; their league-wide add
  // counts are noise, so only an in-league scramble (two managers) counts there.
  const streamed = ['K', 'DEF'].includes(player.position);
  const hot = (!streamed && netAdds >= HOT_NET_ADDS) || demand.claimants.length >= HOT_CLAIMANTS;
  if (hot && ['NO', 'WATCH', 'TRADE_CHIP_CANDIDATE'].includes(verdict)) {
    reason = `${netAdds >= HOT_NET_ADDS ? `${netAdds.toLocaleString('en-US')} net adds league-wide` : ''}${demand.claimants.length ? `${netAdds >= HOT_NET_ADDS ? ', ' : ''}${demand.claimants.join(' and ')} went after him in this league` : ''} — the market wants him and the lineup model can't say why. Find the reason (role or injury news) and name whose need it is before passing`;
    verdict = 'CONTESTED_CHECK';
  }

  return {
    id: player.id, name: player.name, pos: player.position, team: player.team,
    market: { net_adds: netAdds },
    demand, own, teams, threats, buyers, price: { ceiling, bidders_who_can_pay: likely.map((t) => ({ owner: t.owner, faab: t.faab })) },
    verdict, reason,
  };
}

export function denialTable(snapshot, opts = {}) {
  const cache = new Map();
  const rows = candidatePool(snapshot).map((p) => denialRow(snapshot, p, { ...opts, cache }));
  const rank = { BLOCK_AND_CHIP: 0, BLOCK_CANDIDATE: 1, CONTESTED_CHECK: 2, TRADE_CHIP_CANDIDATE: 3, WATCH: 4, ADD_ON_MERIT: 5, NO: 6 };
  rows.sort((a, b) => rank[a.verdict] - rank[b.verdict] || (b.threats[0]?.rest_of_season ?? b.buyers[0]?.rest_of_season ?? 0) - (a.threats[0]?.rest_of_season ?? a.buyers[0]?.rest_of_season ?? 0));
  return rows;
}
