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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Which positions Sleeper allows in each starting slot. An unknown slot is
// never treated as fillable-by-anyone — that would silently under-report a
// hole — so buildOutlook throws on one instead.
export const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL'], LB: ['LB'], DB: ['DB'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

// Statuses that mean a player is not going to fill an active slot. Used to
// report the pessimistic view alongside the plain bye view — "who is out" is
// knowable today; "who is still out in week 13" is not, so both are shown
// rather than one being quietly chosen.
const LONG_TERM_OUT = /^(ir|pup|na|nfi|sus|dnr)$/i;

// Maximum bipartite matching (Kuhn's) of players onto starting slots.
// Slots are tried most-restrictive first so that when the lineup can't be
// filled, the slot reported empty is the specific one nobody can play (K, TE)
// rather than whichever flex spot happened to be processed last.
function fillSlots(slotNames, players) {
  const order = slotNames
    .map((name, idx) => ({ name, idx }))
    .sort((a, b) => SLOT_ELIGIBILITY[a.name].length - SLOT_ELIGIBILITY[b.name].length);
  const playerInSlot = new Array(slotNames.length).fill(null);
  const slotOfPlayer = new Map();

  function augment(slotIdx, visited) {
    for (const p of players) {
      if (visited.has(p.id)) continue;
      if (!SLOT_ELIGIBILITY[slotNames[slotIdx]].includes(p.position)) continue;
      visited.add(p.id);
      const held = slotOfPlayer.get(p.id);
      if (held === undefined || augment(held, visited)) {
        slotOfPlayer.set(p.id, slotIdx);
        playerInSlot[slotIdx] = p;
        return true;
      }
    }
    return false;
  }

  for (const { idx } of order) augment(idx, new Set());
  const empty = slotNames.map((name, idx) => ({ name, idx })).filter(({ idx }) => !playerInSlot[idx]);
  return { playerInSlot, empty: empty.map((e) => e.name), benched: players.filter((p) => !slotOfPlayer.has(p.id)) };
}

const countByPosition = (players) => {
  const counts = {};
  for (const p of players) counts[p.position ?? '?'] = (counts[p.position ?? '?'] ?? 0) + 1;
  return counts;
};

/**
 * Build the forward outlook for my roster.
 *
 * @param snapshot a snapshot object (or snapshot-shaped input mid-build in sync.mjs)
 * @param opts.add / opts.drop  player objects / ids for a what-if roster
 */
export function buildOutlook(snapshot, { add = [], drop = [] } = {}) {
  const league = snapshot.league ?? {};
  const slotNames = (league.roster_positions ?? []).filter((p) => p !== 'BN');
  for (const slot of slotNames) {
    if (!SLOT_ELIGIBILITY[slot]) {
      throw new Error(`outlook: unknown starting slot "${slot}" — add it to SLOT_ELIGIBILITY before trusting any lineup or bye plan.`);
    }
  }

  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const dropIds = new Set(drop.map((d) => (typeof d === 'string' ? d : d.id)));
  const active = [...me.starters, ...me.bench].filter(Boolean).filter((p) => !dropIds.has(p.id));
  for (const p of add) if (!active.some((x) => x.id === p.id)) active.push(p);
  const reserve = me.reserve.filter(Boolean).filter((p) => !dropIds.has(p.id));

  const benchSlots = (league.roster_positions ?? []).filter((p) => p === 'BN').length;
  const irSlots = league.reserve_slots ?? 0;

  // Required bodies per position if every slot were filled by its most
  // natural position: the dedicated slots only. FLEX/SUPER_FLEX are counted
  // separately because they are the whole reason a count-based read misleads.
  const dedicated = {};
  const flexSlots = [];
  for (const slot of slotNames) {
    if (SLOT_ELIGIBILITY[slot].length === 1) dedicated[slot] = (dedicated[slot] ?? 0) + 1;
    else flexSlots.push(slot);
  }

  const activeCounts = countByPosition(active);
  // A position is "thin" when losing one body to a bye or an injury makes the
  // dedicated slots unfillable — the single-TE, single-K, single-DEF trap.
  const thin = Object.entries(dedicated)
    .filter(([pos, need]) => (activeCounts[pos] ?? 0) <= need)
    .map(([pos]) => pos);

  const firstWeek = Math.max(snapshot.week ?? 1, 1);
  const playoffStart = league.playoff_week_start ?? 15;
  // Sleeper's fantasy playoffs are playoff_week_start through the end of the
  // NFL regular season it schedules against; W17 is the last fantasy week in
  // a 3-round bracket, and byes never fall that late anyway.
  const lastWeek = Math.max(playoffStart + 2, 17);

  const weeks = [];
  for (let week = firstWeek; week <= lastWeek; week++) {
    const onBye = active.filter((p) => p.bye_week === week);
    const availableAll = active.filter((p) => p.bye_week !== week);
    const hurt = availableAll.filter((p) => LONG_TERM_OUT.test(p.injury_status ?? ''));
    const availableHealthy = availableAll.filter((p) => !LONG_TERM_OUT.test(p.injury_status ?? ''));

    const best = fillSlots(slotNames, availableAll);
    const ifHurtStayOut = fillSlots(slotNames, availableHealthy);

    const entry = {
      week,
      playoffs: week >= playoffStart,
      available: countByPosition(availableAll),
      bench_depth: Math.max(availableAll.length - slotNames.length, 0),
    };
    if (onBye.length) entry.byes = onBye.map((p) => ({ id: p.id, name: p.name, pos: p.position }));
    if (best.empty.length) entry.empty_slots = best.empty;
    // Only worth saying when the injured bodies are what stand between a legal
    // lineup and an illegal one — otherwise it is noise every single week.
    if (!best.empty.length && ifHurtStayOut.empty.length) {
      entry.empty_slots_if_injured_stay_out = ifHurtStayOut.empty;
      entry.injured_counted = hurt.map((p) => ({ id: p.id, name: p.name, pos: p.position, status: p.injury_status }));
    }
    weeks.push(entry);
  }

  const crunch = weeks
    .filter((w) => w.empty_slots || w.empty_slots_if_injured_stay_out || (w.byes?.length ?? 0) >= 2)
    .map((w) => w.week);

  const deadline = league.trade_deadline ?? null;

  return {
    from_week: firstWeek,
    through_week: lastWeek,
    playoff_weeks: Array.from({ length: lastWeek - playoffStart + 1 }, (_, i) => playoffStart + i),
    trade_deadline_week: deadline,
    weeks_until_trade_deadline: deadline == null ? null : Math.max(deadline - firstWeek, 0),
    roster_shape: {
      starting_slots: slotNames,
      dedicated_slots: dedicated,
      flex_slots: flexSlots,
      active_by_position: activeCounts,
      reserve_by_position: countByPosition(reserve),
      active_count: active.length,
      bench_slots: benchSlots,
      // Sleeper caps the ACTIVE roster as a whole (starting slots + bench),
      // not each section, so open room is capacity minus bodies. Deriving it
      // as "bench minus (active - starting slots)" over-counted whenever a
      // starting slot sat empty — exactly when you most need the number.
      bench_open: Math.max(slotNames.length + benchSlots - active.length, 0),
      ir_slots: irSlots,
      ir_used: reserve.length,
      ir_open: Math.max(irSlots - reserve.length, 0),
      thin_positions: thin,
    },
    crunch_weeks: crunch,
    weeks,
  };
}

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
