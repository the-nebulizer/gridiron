// Pure core of the forward outlook — no imports, no Node builtins, so a
// bundler can inline this file verbatim into a browser page. See
// scripts/outlook.mjs for the CLI, the usage notes, and why this exists.

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
export const LONG_TERM_OUT = /^(ir|pup|na|nfi|sus|dnr)$/i;

// Maximum bipartite matching (Kuhn's) of players onto starting slots.
// Slots are tried most-restrictive first so that when the lineup can't be
// filled, the slot reported empty is the specific one nobody can play (K, TE)
// rather than whichever flex spot happened to be processed last.
export function fillSlots(slotNames, players) {
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

export const countByPosition = (players) => {
  const counts = {};
  for (const p of players) counts[p.position ?? '?'] = (counts[p.position ?? '?'] ?? 0) + 1;
  return counts;
};

// Resolve a possibly-string add/drop entry against every place a player
// could be found: the pool of free agents (not on my roster), my own roster,
// and every other team's players. Thrown, not silently dropped, when an id
// resolves to nobody — the same silent-wrong-answer trap the CLI already
// guards against for drops.
function resolvePlayerId(id, snapshot, me) {
  const pool = snapshot.pool ?? [];
  const mine = [...me.starters, ...me.bench, ...me.reserve].filter(Boolean);
  const found = pool.find((p) => p.id === id)
    ?? mine.find((p) => p.id === id)
    ?? snapshot.teams.flatMap((t) => [...t.starters, ...t.bench, ...t.reserve].filter(Boolean)).find((p) => p.id === id);
  if (!found) {
    throw new Error(`outlook: unknown player id "${id}" — not in the snapshot's pool, my roster, or any team's players.`);
  }
  return found;
}

/**
 * Build the forward outlook for my roster.
 *
 * @param snapshot a snapshot object (or snapshot-shaped input mid-build in sync.mjs)
 * @param opts.add / opts.drop  player objects OR ids for a what-if roster
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
  const addPlayers = add.map((a) => (typeof a === 'string' ? resolvePlayerId(a, snapshot, me) : a));
  for (const p of addPlayers) if (!active.some((x) => x.id === p.id)) active.push(p);
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

  // What the lineup actually consumes at each position. Counting the
  // dedicated slots alone says one QB is starting in a superflex league —
  // the SUPER_FLEX filled with a quarterback every week is demand too, and
  // missing it is why a roster could be cut to two QBs and still read
  // "not thin". The preference is READ OFF the submitted lineup rather than
  // inferred from scoring, and it is the lineup's shape, not its bodies, so
  // a what-if add/drop doesn't move it.
  const flexPreferences = [];
  for (let i = 0; i < slotNames.length; i++) {
    const slot = slotNames[i];
    if (SLOT_ELIGIBILITY[slot].length === 1) continue;
    const held = (me.starters ?? [])[i];
    if (held?.position && SLOT_ELIGIBILITY[slot].includes(held.position)) {
      flexPreferences.push({ slot, index: i, position: held.position });
    }
  }
  const lineupDemand = { ...dedicated };
  for (const { position } of flexPreferences) {
    lineupDemand[position] = (lineupDemand[position] ?? 0) + 1;
  }

  const activeCounts = countByPosition(active);
  // A position is "thin" when losing one body to a bye or an injury makes the
  // dedicated slots unfillable — the single-TE, single-K, single-DEF trap.
  const thin = Object.entries(dedicated)
    .filter(([pos, need]) => (activeCounts[pos] ?? 0) <= need)
    .map(([pos]) => pos);
  // The same question asked against what the lineup starts rather than what
  // it dedicates: no spare body for a slot I fill at that position every
  // week. Strictly wider than `thin` — every thin position is also uncovered.
  const noCover = Object.entries(lineupDemand)
    .filter(([pos, need]) => (activeCounts[pos] ?? 0) <= need)
    .map(([pos]) => pos);

  // A flex slot that admits a quarterback and that the lineup fills with one
  // is a QB slot in all but name: at 6-point passing touchdowns a startable
  // QB there beats a WR/TE almost every time, so a week that can only put a
  // flex body in it is a real loss the "can I field a legal lineup" test
  // cannot see. This is the only flex downgrade the scoring makes
  // categorical — an RB at FLEX instead of a WR is an ordinary week.
  const qbFlexSlots = flexPreferences.filter((f) => f.position === 'QB').map((f) => f.slot);
  const qbSlotsWanted = (dedicated.QB ?? 0) + qbFlexSlots.length;

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
    // Legal but worse: not enough quarterbacks left for the QB-flex slots, so
    // one of them takes a flex body. Only worth saying when the week is
    // otherwise fillable — where it isn't, the empty slot is the bigger news.
    if (qbFlexSlots.length && !best.empty.length) {
      const short = qbSlotsWanted - (entry.available.QB ?? 0);
      if (short > 0) entry.downgraded_slots = qbFlexSlots.slice(0, short);
    }
    weeks.push(entry);
  }

  const crunch = weeks
    .filter((w) => w.empty_slots || w.empty_slots_if_injured_stay_out || w.downgraded_slots || (w.byes?.length ?? 0) >= 2)
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
      // How each flex slot is actually being used, and the per-position
      // demand that follows from it — see the comment where they are built.
      flex_preferences: flexPreferences.map(({ slot, position }) => ({ slot, position })),
      lineup_demand: lineupDemand,
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
      no_cover_positions: noCover,
    },
    crunch_weeks: crunch,
    weeks,
  };
}
