// Points, not impressions: what a move does to my best lineup, in projected
// points, this week and every week after. See scripts/value-core.mjs.
//
//   node scripts/value.mjs                       # drop order: what losing each player costs
//   node scripts/value.mjs --add <id>            # every possible drop for that add, best first
//   node scripts/value.mjs --add <id> --drop <id># one move, week by week
//   node scripts/value.mjs --trade --give <id,..> --get <id,..>
//   node scripts/value.mjs --lineup [week]       # best lineup by projection (injury tags applied this week)
//   --json                                       # machine-readable
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropTable, swapTable, moveValue, projectedLineup } from './value-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(await readFile(path.join(root, 'data/league/snapshot.json'), 'utf8'));
if (!snapshot.production) {
  console.error('Snapshot has no production data — run node scripts/sync.mjs first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const ids = (s) => (s ? s.split(',').filter(Boolean) : []);
const json = args.includes('--json');
const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
const pad = (s, n) => String(s ?? '-').padEnd(n);
const lpad = (s, n) => String(s ?? '-').padStart(n);

function weeksLine(v) {
  return v.by_week.length ? v.by_week.map((x) => `W${x.week} ${sign(x.delta)}`).join(', ') : 'no week changes';
}

if (args.includes('--lineup')) {
  const w = Number(opt('--lineup')) || snapshot.week;
  const out = projectedLineup(snapshot, w);
  if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  console.log(`Best lineup by projection, Week ${w} — ${out.total} pts (injury tags applied for the current week only)`);
  for (const x of out.lineup) console.log(`  ${pad(x.slot, 11)} ${pad(x.name ?? 'EMPTY', 24)} ${lpad(x.pts, 5)}`);
  console.log('  bench:');
  for (const b of out.bench) console.log(`    ${pad(`${b.name} (${b.pos})`, 30)} ${lpad(b.pts, 5)}${b.status ? `  ${b.status}` : ''}`);
} else if (args.includes('--trade')) {
  const v = moveValue(snapshot, { add: ids(opt('--get')), drop: ids(opt('--give')) });
  if (json) { console.log(JSON.stringify(v, null, 2)); process.exit(0); }
  console.log(`Trade: this week ${sign(v.this_week)} · next 3 ${sign(v.next_3)} · rest of season ${sign(v.rest_of_season)} · playoffs ${sign(v.playoffs)}`);
  console.log(`  ${weeksLine(v)}`);
} else if (opt('--add') && opt('--drop')) {
  const v = moveValue(snapshot, { add: [opt('--add')], drop: [opt('--drop')] });
  if (json) { console.log(JSON.stringify(v, null, 2)); process.exit(0); }
  console.log(`Add ${opt('--add')} / drop ${opt('--drop')}: this week ${sign(v.this_week)} · next 3 ${sign(v.next_3)} · rest of season ${sign(v.rest_of_season)} · playoffs ${sign(v.playoffs)}`);
  console.log(`  ${weeksLine(v)}`);
} else if (opt('--add')) {
  const t = swapTable(snapshot, opt('--add'));
  if (json) { console.log(JSON.stringify(t, null, 2)); process.exit(0); }
  console.log(`Add ${t.add.name} (${t.add.pos} ${t.add.team}) — every possible drop, best first (projected lineup points vs standing pat)`);
  console.log(`  ${pad('drop', 26)} ${lpad('this wk', 8)} ${lpad('next 3', 7)} ${lpad('ROS', 7)} ${lpad('playoffs', 9)} ${lpad('cover lost', 11)}   weeks`);
  for (const o of t.options) {
    console.log(`  ${pad(`${o.drop_name}${o.drop_pos ? ` (${o.drop_pos})` : ''}`, 26)} ${lpad(sign(o.this_week), 8)} ${lpad(sign(o.next_3), 7)} ${lpad(sign(o.rest_of_season), 7)} ${lpad(sign(o.playoffs), 9)} ${lpad(o.cover_lost, 11)}   ${weeksLine(o)}`);
  }
  console.log('\n  "cover lost" = average points per week the dropped player would save if a starter he can replace missed a game (next 3 weeks).');
} else {
  const rows = dropTable(snapshot);
  if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  console.log(`What losing each player costs (no replacement), cheapest first — Week ${snapshot.week} on`);
  console.log(`  ${pad('player', 30)} ${lpad('avg', 5)} ${lpad('gp', 3)} ${lpad('last3', 6)} ${lpad('proj', 5)} ${lpad('lost now', 9)} ${lpad('lost ROS', 9)} ${lpad('playoffs', 9)} ${lpad('cover', 6)}`);
  for (const r of rows) {
    console.log(`  ${pad(`${r.name} (${r.pos} ${r.team})${r.status ? ` ${r.status}` : ''}`, 30)} ${lpad(r.avg, 5)} ${lpad(r.gp, 3)} ${lpad(r.last3, 6)} ${lpad(r.proj_this_week, 5)} ${lpad(r.lost_this_week, 9)} ${lpad(r.lost_rest_of_season, 9)} ${lpad(r.lost_playoffs, 9)} ${lpad(r.cover, 6)}`);
  }
  console.log('\n  lost = projected starting-lineup points gone if he left with no replacement. cover = points/week he saves when a starter he can replace misses a game.');
}
