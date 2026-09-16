// Forward-looking roster planning: what my roster looks like in EVERY week
// still to come, not just this one.
//
// A recommendation that only weighs this week is how a roster ends up with
// four QBs and one TE, or with a kicker and a defense on bye in the same week
// and no FAAB left to cover it. Everything here is computed from the snapshot
// (byes from the schedule, slots from the league's own roster_positions) so no
// routine ever has to remember a bye week or count a position by hand.
//
// The core question per week is not "how many RBs do I have" but "can I fill
// a legal lineup at all" — with FLEX and SUPER_FLEX, those are different
// questions. So each week is solved as an actual assignment problem against
// the league's real slots rather than by comparing counts per position.
//
// Usage as a tool (what-if — does this move fix the hole or make one?):
//   node scripts/outlook.mjs                          # my roster as it stands
//   node scripts/outlook.mjs --add 11834 --drop 9228  # if I made that swap
//   node scripts/outlook.mjs --json
//
// The pure computation (slot rules, the matching solver, buildOutlook itself)
// lives in scripts/outlook-core.mjs, import-free so a bundler can inline it
// into the dashboard. This file just adds the Node CLI on top.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SLOT_ELIGIBILITY, buildOutlook } from './outlook-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { SLOT_ELIGIBILITY, buildOutlook };

// ---- CLI ----

// Compared as URLs, not strings: a space in the checkout path ("Hobby coding")
// is %20 in import.meta.url and a literal space in argv, so the old string
// comparison never matched there and the CLI silently printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Parsed strictly: an argument this doesn't understand is an error, never a
  // shrug. The old version matched only the "--add <id>" form by looking at
  // the previous token, so "--add=11834" silently added nobody and printed an
  // unchanged roster — a what-if tool answering "this move changes nothing"
  // when it had in fact ignored the move.
  const usage = 'Usage: node scripts/outlook.mjs [--add <id>]... [--drop <id>]... [--json]';
  const args = process.argv.slice(2);
  const parsed = { add: [], drop: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { parsed.json = true; continue; }
    const inline = a.match(/^--(add|drop)=(.+)$/);
    if (inline) { parsed[inline[1]].push(inline[2]); continue; }
    if (a === '--add' || a === '--drop') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`${a} needs a player id.\n${usage}`);
        process.exit(2);
      }
      parsed[a.slice(2)].push(value);
      i++;
      continue;
    }
    console.error(`Unknown argument "${a}".\n${usage}`);
    process.exit(2);
  }
  const asJson = parsed.json;
  const addIds = parsed.add;
  const dropIds = parsed.drop;

  const snapshot = JSON.parse(await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8'));
  const ageHours = (Date.now() - new Date(snapshot.fetched_at).getTime()) / 3600000;
  if (!(ageHours < 3)) {
    console.error(`Snapshot is ${Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}h old` : 'unreadable'}. Run \`node scripts/sync.mjs\` first.`);
    process.exit(1);
  }

  // Resolve any --add id the same way the rest of the tool does: the snapshot
  // first (rosters, trending, transactions), then the players dump. A bye week
  // comes from the snapshot's team->bye map, never from memory.
  const known = new Map();
  for (const t of snapshot.teams) for (const p of [...t.starters, ...t.bench, ...t.reserve].filter(Boolean)) known.set(p.id, p);
  for (const p of [...snapshot.trending.adds, ...snapshot.trending.drops]) known.set(p.id, p);
  for (const tx of snapshot.transactions) for (const p of [...tx.adds, ...tx.drops].filter(Boolean)) known.set(p.id, p);

  let playersDump = null;
  const resolveAdd = async (id) => {
    if (known.has(id)) return known.get(id);
    playersDump ??= JSON.parse(await readFile(path.join(root, 'data', 'players.json'), 'utf8'));
    const p = playersDump[id];
    if (!p) {
      console.error(`Unknown player id "${id}" — not in the snapshot or the players dump.`);
      process.exit(1);
    }
    const team = p.team ?? null;
    return {
      id,
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id,
      position: p.position ?? null,
      team,
      bye_week: (snapshot.byes ?? {})[team] ?? null,
      injury_status: p.injury_status ?? null,
    };
  };

  // A drop id that isn't actually on the roster would drop nobody and quietly
  // report the status quo — the same silent-wrong-answer failure as above.
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const mine = new Set([...me.starters, ...me.bench, ...me.reserve].filter(Boolean).map((p) => p.id));
  for (const id of dropIds) {
    if (!mine.has(id)) {
      console.error(`Cannot drop "${id}" — not on my roster. Roster ids: ${[...mine].join(', ')}`);
      process.exit(2);
    }
  }

  const add = [];
  for (const id of addIds) add.push(await resolveAdd(id));
  const outlook = buildOutlook(snapshot, { add, drop: dropIds });

  if (asJson) {
    console.log(JSON.stringify(outlook, null, 2));
    process.exit(0);
  }

  const label = addIds.length || dropIds.length
    ? `What-if: ${[add.length ? `add ${add.map((p) => p.name).join(', ')}` : null, dropIds.length ? `drop ${dropIds.map((id) => known.get(id)?.name ?? id).join(', ')}` : null].filter(Boolean).join('; ')}`
    : 'My roster as it stands';
  console.log(`# Forward outlook — ${label}`);
  console.log(`Weeks ${outlook.from_week}–${outlook.through_week}; playoffs W${outlook.playoff_weeks[0]}–W${outlook.playoff_weeks.at(-1)}; trade deadline W${outlook.trade_deadline_week} (${outlook.weeks_until_trade_deadline} week(s) away).`);

  const shape = outlook.roster_shape;
  console.log(`\nRoster: ${Object.entries(shape.active_by_position).map(([p, n]) => `${n} ${p}`).join(', ')} (${shape.active_count} active)`);
  console.log(`Bench ${shape.bench_slots - shape.bench_open}/${shape.bench_slots} used, IR ${shape.ir_used}/${shape.ir_slots} used.`);
  if (shape.thin_positions.length) {
    console.log(`Thin (no cover if one is lost): ${shape.thin_positions.join(', ')}`);
  }

  console.log(`\nWeek-by-week:`);
  for (const w of outlook.weeks) {
    const bits = [];
    if (w.byes) bits.push(`bye: ${w.byes.map((p) => `${p.name} (${p.pos})`).join(', ')}`);
    if (w.empty_slots) bits.push(`CANNOT FILL: ${w.empty_slots.join(', ')}`);
    if (w.empty_slots_if_injured_stay_out) bits.push(`only fillable if ${w.injured_counted.map((p) => p.name).join('/')} returns (else ${w.empty_slots_if_injured_stay_out.join(', ')} is empty)`);
    if (!bits.length) bits.push('full lineup, no byes');
    console.log(`  W${String(w.week).padEnd(2)}${w.playoffs ? '*' : ' '} ${bits.join(' · ')}`);
  }
  console.log(`  (* = fantasy playoffs)`);
  if (outlook.crunch_weeks.length) {
    console.log(`\nCrunch weeks to plan FAAB and trades around: ${outlook.crunch_weeks.map((w) => `W${w}`).join(', ')}`);
  } else {
    console.log(`\nNo crunch weeks ahead — every remaining week fields a legal lineup.`);
  }
}
