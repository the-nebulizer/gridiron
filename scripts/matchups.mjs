// The matchup sheet: every NFL game this week that one of my players is in,
// with who is throwing on each side.
//
// A projection already folds the opponent in, but only as one number per
// player. A start/sit call turns on the game around him: is his team expected
// to score, will it be ahead and running or behind and throwing, is the
// quarterback getting him the ball the starter or a backup, and is the other
// side's quarterback likely to give my defense sacks and turnovers. Those are
// questions about a GAME, not a player — a receiver, the back beside him and my
// kicker on the same team all share one answer — so this script groups by game
// and the lineup report researches each game once.
//
// It does the grounded half only: which games, which of my players (and my
// fantasy opponent's starters) are in each, home/away, both teams' QBs by
// depth chart with injury tags, and which bench players are close enough to a
// starter for the matchup to decide it. Betting lines, defensive rankings and
// weather are not in Sleeper's API and are not invented here; the report looks
// them up and says where they came from.
//
//   node scripts/matchups.mjs          # this week
//   node scripts/matchups.mjs 7        # another week
//   node scripts/matchups.mjs --json
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOpponent } from './stream.mjs';
import { projectedLineup, weekPoints } from './value-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A bench player within this many projected points of the weakest starter he
// could replace is a close call — the matchup, not the projection, decides it.
export const CLOSE_CALL_POINTS = 3;

const FLEX_OK = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'] };
const canFill = (slot, pos) => slot === pos || (FLEX_OK[slot] ?? []).includes(pos);
const teamOf = (p) => (p.position === 'DEF' ? p.id : p.team);
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * @param snapshot a synced snapshot object
 * @param opts.week the week to answer for (default: the snapshot's week)
 */
export function matchupSheet(snapshot, { week } = {}) {
  const wk = week ?? snapshot.week;
  const sched = snapshot.team_schedule ?? {};
  const qbs = snapshot.team_qbs ?? {};
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const opp = snapshot.matchup?.opponent ?? null;
  const proj = projectedLineup(snapshot, wk);
  const projSlot = new Map(proj.lineup.filter((x) => x.id).map((x) => [x.id, x.slot]));

  // Close calls: a benched player whose projection is within CLOSE_CALL_POINTS
  // of the weakest projected starter in a slot he could legally take.
  const closeTo = (p, pts) =>
    proj.lineup
      .filter((x) => x.id && canFill(x.slot, p.position) && pts >= x.pts - CLOSE_CALL_POINTS)
      .map((x) => x.name);

  const mine = [...me.starters, ...me.bench].filter(Boolean).map((p) => {
    const pts = r1(weekPoints(snapshot, p, wk));
    const slot = projSlot.get(p.id) ?? null;
    return {
      id: p.id, name: p.name, position: p.position, team: teamOf(p),
      injury_status: p.injury_status ?? null, proj: pts,
      projected_slot: slot,
      close_call_with: slot ? [] : closeTo(p, pts),
    };
  });
  const theirs = (opp?.starters ?? []).filter(Boolean).map((p) => ({
    id: p.id, name: p.name, position: p.position, team: teamOf(p),
  }));

  const games = new Map();
  const onBye = [];
  const gameFor = (team) => {
    const g = parseOpponent(sched[team]?.[wk]);
    if (!g) return null;
    const home = g.at ? g.opp : team;
    const away = g.at ? team : g.opp;
    const key = `${away}@${home}`;
    if (!games.has(key)) {
      const side = (t) => {
        const list = qbs[t] ?? [];
        const q1 = list[0] ?? null;
        return {
          team: t,
          qbs: list,
          // A tag on the depth-chart starter means the report must confirm
          // who actually takes the snaps before reasoning about this offense.
          qb_question: q1 && q1.injury_status ? `${q1.name} is ${q1.injury_status}` : (q1 ? null : 'no QB on the depth chart'),
          mine: [], theirs: [],
        };
      };
      games.set(key, {
        key, kickoff: snapshot.games?.[home]?.kickoff ?? null,
        status: snapshot.games?.[home]?.status ?? null,
        away: side(away), home: side(home),
      });
    }
    const game = games.get(key);
    return game.home.team === team ? game.home : game.away;
  };

  for (const p of mine) {
    const side = p.team ? gameFor(p.team) : null;
    if (side) side.mine.push(p); else onBye.push(p);
  }
  for (const p of theirs) {
    const side = p.team ? gameFor(p.team) : null;
    if (side) side.theirs.push(p);
  }

  // Games where I start someone (by projection) first, then close-call-only
  // games, then games that only involve my bench or my opponent.
  const weight = (g) => {
    const all = [...g.away.mine, ...g.home.mine];
    if (all.some((p) => p.projected_slot)) return 0;
    if (all.some((p) => p.close_call_with.length)) return 1;
    return all.length ? 2 : 3;
  };
  const list = [...games.values()].sort((a, b) => weight(a) - weight(b) || a.key.localeCompare(b.key));
  for (const g of list) {
    g.research = weight(g) <= 1;
  }
  return { week: wk, opponent_owner: opp?.owner ?? null, games: list, on_bye: onBye };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const weekArg = args.find((a) => /^\d+$/.test(a));

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8'));
  } catch {
    console.error('No snapshot. Run: node scripts/sync.mjs');
    process.exit(1);
  }
  if (!snapshot.team_schedule || !snapshot.team_qbs) {
    console.error('This snapshot predates the schedule/QB blocks. Re-run: node scripts/sync.mjs');
    process.exit(1);
  }

  const sheet = matchupSheet(snapshot, { week: weekArg ? Number(weekArg) : undefined });
  if (json) {
    console.log(JSON.stringify(sheet, null, 2));
  } else {
    console.log(`\nWeek ${sheet.week} matchup sheet${sheet.opponent_owner ? ` — vs ${sheet.opponent_owner}` : ''}\n`);
    const fmtQbs = (s) =>
      s.qbs.length ? s.qbs.map((q) => `${q.depth}. ${q.name}${q.injury_status ? ` (${q.injury_status})` : ''}`).join(', ') : 'none listed';
    const fmtMine = (p) => {
      const tag = p.projected_slot ? p.projected_slot : p.close_call_with.length ? `bench, close to ${p.close_call_with.join('/')}` : 'bench';
      return `${p.name} ${p.position} ${p.proj} [${tag}]${p.injury_status ? ` (${p.injury_status})` : ''}`;
    };
    for (const g of sheet.games) {
      console.log(`${g.research ? '*' : ' '} ${g.away.team} at ${g.home.team}  ${g.kickoff ?? ''}${g.status && g.status !== 'pre_game' ? `  ${g.status}` : ''}`);
      for (const s of [g.away, g.home]) {
        console.log(`    ${s.team.padEnd(4)} QBs: ${fmtQbs(s)}${s.qb_question ? `  <-- confirm who starts: ${s.qb_question}` : ''}`);
        if (s.mine.length) console.log(`         mine:   ${s.mine.map(fmtMine).join('; ')}`);
        if (s.theirs.length) console.log(`         theirs: ${s.theirs.map((p) => `${p.name} ${p.position}`).join('; ')}`);
      }
    }
    if (sheet.on_bye.length) console.log(`\n  On bye (score zero): ${sheet.on_bye.map((p) => `${p.name} ${p.position}`).join(', ')}`);
    console.log(`\n  * = a game the lineup turns on (a projected starter or a close call). Research each one once:`);
    console.log('    game total and spread (each team\'s implied points), who is throwing on both sides, whether the');
    console.log('    script leans pass or run, how the defense defends each position I have there, and weather/roof.');
    console.log('  Betting lines, defense rankings and weather are not in here — they come from the web, with a source.');
  }
}
