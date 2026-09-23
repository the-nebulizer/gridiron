// The streaming question, answered from the snapshot: which defense (or
// kicker) do I start this week, and which weeks ahead need a different one.
//
// Ben asks this every week, so it is a standing job rather than a one-off
// lookup. Kicker and defense are the two positions nobody rosters depth at —
// twelve teams in this league carry thirteen defenses between them — so the
// answer is always "the one I hold, or one of the ~19 sitting unrostered",
// and the thing that decides it is the matchup.
//
// What this script does and does not do matters. It does the grounded half:
// who is actually unrostered, who each of them plays that week (home or
// away), who is on bye and therefore not an option at all, and which weeks
// my own defense cannot cover. It does NOT rank them — matchup quality is
// judgment, informed by news and rankings, and inventing a number for it here
// would be exactly the false precision the prime directive exists to stop.
// So candidates print in a stable alphabetical order with the market's
// attention alongside as a labelled column, never as a sort key.
//
//   node scripts/stream.mjs                 # defenses, this week
//   node scripts/stream.mjs 10              # defenses, week 10
//   node scripts/stream.mjs --season        # every remaining week, one line each
//   node scripts/stream.mjs --pos K         # kickers instead
//   node scripts/stream.mjs --json
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// "PHI" -> { opp: 'PHI', at: false }; "@GB" -> { opp: 'GB', at: true };
// "BYE" -> null. An unknown week (past the schedule) is also null, and the
// caller says "no game" rather than guessing one.
export function parseOpponent(entry) {
  if (typeof entry !== 'string' || !entry || entry === 'BYE') return null;
  return entry.startsWith('@') ? { opp: entry.slice(1), at: true } : { opp: entry, at: false };
}

export const describeOpponent = (o) => (o ? `${o.at ? 'at' : 'vs'} ${o.opp}` : 'bye');

/**
 * @param snapshot a synced snapshot object
 * @param opts.week      the week to answer for (default: the snapshot's week)
 * @param opts.position  'DEF' (default) or 'K'
 */
export function streamOptions(snapshot, { week, position = 'DEF' } = {}) {
  const wk = week ?? snapshot.week;
  const sched = snapshot.team_schedule ?? {};
  const me = (snapshot.teams ?? []).find((t) => t.roster_id === snapshot.my_roster_id);
  const mine = [...(me?.starters ?? []), ...(me?.bench ?? []), ...(me?.reserve ?? [])]
    .filter(Boolean)
    .filter((p) => p.position === position);
  const starterIds = new Set((me?.starters ?? []).filter(Boolean).map((p) => p.id));

  // A defense's "team" is its own code; a kicker's is the team he plays for.
  const teamOf = (p) => (position === 'DEF' ? p.id : p.team);
  const held = mine.map((p) => {
    const game = parseOpponent(sched[teamOf(p)]?.[wk]);
    return {
      id: p.id, name: p.name, team: teamOf(p), bye_week: p.bye_week ?? null,
      starting: starterIds.has(p.id), opponent: game, playable: game !== null,
    };
  });

  const candidates = (snapshot.available?.[position] ?? []).map((p) => {
    const game = parseOpponent(sched[teamOf(p)]?.[wk]);
    return {
      id: p.id, name: p.name, team: teamOf(p), bye_week: p.bye_week ?? null,
      net_adds: p.net_adds ?? 0, opponent: game, playable: game !== null,
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    week: wk,
    position,
    // Nothing I hold can play this week, so the slot is empty unless I add.
    must_add: held.length > 0 && held.every((h) => !h.playable),
    held,
    playable_candidates: candidates.filter((c) => c.playable),
    on_bye_candidates: candidates.filter((c) => !c.playable),
  };
}

/**
 * One line per remaining week: what I hold that can play, and how many free
 * options there are. Stops at the last fantasy week, the same bound
 * outlook-core uses — the NFL schedule runs a week longer than this league
 * does, and listing a Week 18 to plan around would invent a week that never
 * gets played here.
 */
export function streamSeason(snapshot, { position = 'DEF' } = {}) {
  const playoffStart = snapshot.league?.playoff_week_start ?? 15;
  const lastWeek = Math.max(playoffStart + 2, 17);
  const weeks = new Set();
  for (const byWeek of Object.values(snapshot.team_schedule ?? {})) {
    for (const w of Object.keys(byWeek)) if (Number(w) <= lastWeek) weeks.add(Number(w));
  }
  return [...weeks].sort((a, b) => a - b).map((week) => ({
    ...streamOptions(snapshot, { week, position }),
    playoffs: week >= playoffStart,
  }));
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/stream.mjs [<week>] [--pos DEF|K] [--season] [--json]';
  const json = args.includes('--json');
  const season = args.includes('--season');
  const posIdx = args.indexOf('--pos');
  const position = posIdx === -1 ? 'DEF' : String(args[posIdx + 1] ?? '').toUpperCase();
  if (!['DEF', 'K'].includes(position)) {
    console.error(`--pos must be DEF or K.\n${usage}`);
    process.exit(1);
  }
  const weekArg = args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--pos');

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8'));
  } catch {
    console.error('No snapshot. Run: node scripts/sync.mjs');
    process.exit(1);
  }
  if (!snapshot.team_schedule) {
    console.error('This snapshot predates the schedule block. Re-run: node scripts/sync.mjs');
    process.exit(1);
  }

  if (season) {
    const rows = streamSeason(snapshot, { position });
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`\n${position} by week — what I hold, and how many free options exist\n`);
      for (const r of rows) {
        const holds = r.held.map((h) => `${h.name} ${describeOpponent(h.opponent)}`).join(', ') || 'nothing rostered';
        const flag = r.must_add ? '  <-- NOTHING I HOLD CAN PLAY' : '';
        const label = `W${r.week}${r.playoffs ? '*' : ''}`;
        console.log(`  ${label.padEnd(5)}${holds.padEnd(42)} ${String(r.playable_candidates.length).padStart(2)} free${flag}`);
      }
      console.log('\n  (* = fantasy playoffs)');
      console.log('\nMatchup quality is not in here — it is the report\'s call, from news and rankings.');
    }
  } else {
    const r = streamOptions(snapshot, { week: weekArg ? Number(weekArg) : undefined, position });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`\nWeek ${r.week} — ${r.position}\n`);
      for (const h of r.held) {
        console.log(`  hold:  ${h.name} (${h.team}) ${describeOpponent(h.opponent)}${h.starting ? ' — starting' : ' — benched'}${h.playable ? '' : '  <-- cannot play'}`);
      }
      if (!r.held.length) console.log('  hold:  nothing rostered at this position');
      if (r.must_add) console.log('\n  Nothing I hold can play this week. The slot is empty unless I add one.');
      console.log(`\n  Unrostered and playable (${r.playable_candidates.length}), alphabetical — the order is NOT a ranking:`);
      for (const c of r.playable_candidates) {
        console.log(`    ${String(c.team).padEnd(4)} ${c.name.padEnd(24)} ${describeOpponent(c.opponent).padEnd(8)} bye W${String(c.bye_week ?? '?').padEnd(3)} ${c.net_adds >= 0 ? '+' : ''}${c.net_adds} net adds`);
      }
      if (r.on_bye_candidates.length) {
        console.log(`\n  Unrostered but on bye this week, so not an option: ${r.on_bye_candidates.map((c) => c.team).join(', ')}`);
      }
      console.log('\nMatchup quality is not in here — it is the report\'s call, from news and rankings.');
    }
  }
}
