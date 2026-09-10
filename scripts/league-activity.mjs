// What has changed in the league since you last looked: every add, drop, waiver
// and trade the other 11 managers have made, and which of the players they let
// go are still sitting there claimable.
//
// This surfaces facts and stops. It does not decide whether a player is worth
// adding — that judgment belongs to /waivers, with the roster and the season
// plan in front of it.
//
// Usage: node scripts/league-activity.mjs [--since <ISO date>] [--json]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(
  await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8')
);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const sinceArg = args[args.indexOf('--since') + 1];
const since = args.includes('--since') ? new Date(sinceArg).getTime() : null;
if (since !== null && Number.isNaN(since)) {
  console.error(`Not a date: ${sinceArg}`);
  process.exit(1);
}

// The snapshot only carries the current and previous week's transactions. A
// --since further back than that can't be answered from it — say so up front
// instead of quietly reporting fewer moves than actually happened.
if (since !== null) {
  const earliestWeek = snapshot.week > 1 ? snapshot.week - 1 : snapshot.week;
  const stamps = snapshot.transactions.map((t) => t.at).filter(Boolean);
  const earliestAt = stamps.length ? Math.min(...stamps) : null;
  if (earliestAt === null || since < earliestAt) {
    console.warn(
      `WARNING: the snapshot only holds moves from ${earliestWeek === snapshot.week ? `week ${snapshot.week}` : `weeks ${earliestWeek}–${snapshot.week}`}` +
        (earliestAt === null ? ' (none recorded)' : ` (earliest ${new Date(earliestAt).toISOString().slice(0, 10)})`) +
        `; anything before that is not in it, so this window is incomplete.`
    );
  }
}

const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
const rosteredBy = new Map();
for (const team of snapshot.teams) {
  for (const p of [...team.starters, ...team.bench, ...team.reserve].filter(Boolean)) {
    rosteredBy.set(p.id, team.owner);
  }
}

// Sleeper-wide add/drop counts: how the wider market is moving on a player.
const addCount = new Map(snapshot.trending.adds.map((t) => [t.id, t.add_count]));
const dropCount = new Map(snapshot.trending.drops.map((t) => [t.id, t.add_count]));
const marketFor = (p) => {
  if (!p) return null;
  const up = addCount.get(p.id) ?? 0;
  const down = dropCount.get(p.id) ?? 0;
  if (!up && !down) return null;
  return { up, down, net: up - down };
};

// The draft itself arrives as one commissioner transaction per team — not news.
const moves = snapshot.transactions
  .filter((t) => t.type !== 'commissioner' && t.status === 'complete')
  .filter((t) => (since === null ? true : (t.at ?? 0) >= since));

// A player another manager dropped who nobody has picked up is claimable today.
const claimable = [];
for (const move of moves) {
  for (const p of move.drops.filter(Boolean)) {
    if (rosteredBy.has(p.id)) continue;
    if (claimable.some((c) => c.id === p.id)) continue;
    claimable.push({ ...p, droppedBy: move.by.join(', '), at: move.at, market: marketFor(p) });
  }
}
claimable.sort((a, b) => (b.market?.net ?? 0) - (a.market?.net ?? 0));

// Positions each rival is stacking up, which is what makes them a trade partner.
const rivalDepth = snapshot.teams
  .filter((t) => t.roster_id !== snapshot.my_roster_id)
  .map((t) => {
    const all = [...t.starters, ...t.bench, ...t.reserve].filter(Boolean);
    const count = (pos) => all.filter((p) => p.position === pos).length;
    return { owner: t.owner, QB: count('QB'), RB: count('RB'), WR: count('WR'), TE: count('TE') };
  });

if (asJson) {
  console.log(JSON.stringify({ generated_at: snapshot.fetched_at, moves, claimable, rivalDepth }, null, 2));
  process.exit(0);
}

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—');
const named = (list) => list.filter(Boolean).map((p) => `${p.name} (${p.position ?? '?'})`).join(', ');

console.log(`League activity${since === null ? '' : ` since ${sinceArg}`} — as of ${when(new Date(snapshot.fetched_at).getTime())}`);
console.log(`My bench: ${me.bench.map((p) => `${p.name} (${p.position})`).join(', ') || 'empty'}\n`);

if (!moves.length) {
  console.log('No moves by anyone in this window.');
} else {
  for (const m of moves) {
    const bid = m.faab_bid == null ? '' : ` [$${m.faab_bid} FAAB]`;
    console.log(`${when(m.at)}  ${m.by.join(', ')}${bid}`);
    if (m.adds.length) console.log(`    added   ${named(m.adds)}`);
    if (m.drops.length) console.log(`    dropped ${named(m.drops)}`);
  }
}

console.log(`\nDropped and still unclaimed (${claimable.length}):`);
if (!claimable.length) console.log('  nothing — every player let go has been picked up');
for (const p of claimable) {
  const m = p.market;
  const signal = m
    ? `${m.net >= 0 ? '+' : ''}${m.net.toLocaleString()} net (${m.up.toLocaleString()} adding, ${m.down.toLocaleString()} dropping)`
    : 'no market signal';
  console.log(`  ${p.name} (${p.position} ${p.team}) — let go by ${p.droppedBy} on ${when(p.at)}; ${signal}`);
}

console.log('\nRival roster shape (who is deep, who is thin):');
for (const r of rivalDepth.sort((a, b) => b.QB - a.QB)) {
  console.log(`  ${r.owner.padEnd(18)} QB ${r.QB}  RB ${r.RB}  WR ${r.WR}  TE ${r.TE}`);
}
