// Validate report "actions" blocks against a fresh snapshot and compile
// reports/actions.json — the data source for the dashboard's "Do now" card.
// See docs/ACTIONS.md for the full contract.
//
// `week` is required on every block but is never checked for equality against
// snapshot.week and is never a hard error by itself — a source is marked
// `stale: true` when its week is behind the live snapshot week (informational
// only). Staleness only drops `start` actions at compile time; every other
// kind stays open. Every compiled action carries its source's `week`. A
// `start` can also go stale on its own, mid-week: an open one whose player or
// benched `for` has already kicked off compiles with `state: 'stale'` (see
// lifecycleState) rather than sitting on the card as an instruction Sleeper
// will no longer let Ben carry out.
//
// Two modes, deliberately different in strictness:
//
//   --check <file>  strict. Everything must be doable RIGHT NOW. This is the
//                   write-time gate: a routine runs it on the report it just
//                   wrote, and a report that names a move you cannot make is
//                   a bug in the report.
//   (no args)       compile. Runs over the newest report of every type,
//                   including ones written days ago, so an action may since
//                   have been DONE (you made the move) or GONE (someone else
//                   took the player). Those are expected outcomes, not report
//                   bugs: they are carried through with a `state` so the card
//                   can show them, and only genuinely open actions are held
//                   to the strict rules. Acting on the advice used to break
//                   the next routine's compile outright — see docs/ACTIONS.md.
//
// Usage:
//   node scripts/actions.mjs                 # compile newest report per type -> reports/actions.json
//   node scripts/actions.mjs --check <file>  # strict validation of one report, no write
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SLOT_ELIGIBILITY, buildOutlook } from './outlook.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(root, 'reports');

const TYPES = ['waivers', 'lineup', 'trades', 'inactives'];
const KINDS = ['add', 'drop', 'start', 'ir', 'activate', 'trade'];
const URGENCIES = ['now', 'before_kickoff', 'by_tuesday', 'this_week', 'optional'];
const ADD_MODES = ['fcfs', 'waiver'];
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
// docs/ACTIONS.md "the case": a slotless waiver add at a position that isn't
// thin AND isn't otherwise uncovered is depth, and depth priced above 10% of
// remaining FAAB is priced like a starter — that's the rule "depth is priced
// like depth" enforces.
const DEPTH_BID_CAP = 0.1;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const rel = (p) => path.relative(root, p);
// Two player-id arrays name the exact same set, order aside — used to tell
// "the same offer restated" from "two different offers to one partner" (see
// the same-report trade-id check in validateReportBlock).
function sameIdSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---- snapshot loading + freshness gate ----

async function loadSnapshot() {
  let raw;
  try {
    raw = await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8');
  } catch {
    console.error(
      'No snapshot found at data/league/snapshot.json. Run `node scripts/sync.mjs` first.'
    );
    process.exit(1);
  }
  const snapshot = JSON.parse(raw);
  const ageMs = Date.now() - new Date(snapshot.fetched_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) {
    console.error(
      `Snapshot at data/league/snapshot.json is stale (fetched_at ${snapshot.fetched_at}). Run \`node scripts/sync.mjs\` first.`
    );
    process.exit(1);
  }
  return snapshot;
}

// ---- id resolution: snapshot (rosters/trending/transactions) first, then data/players.json ----

/**
 * Is the unrostered pool first-come-first-serve right now?
 *
 * Before kickoff it always is — that is pre-season, and CLAUDE.md's calendar
 * calibration covers it. The part that was wrong: in season, an `fcfs` add
 * was rejected outright on `games_have_started`, on the reasoning that once
 * games begin every unrostered player sits behind Wednesday's waiver run.
 * That is true only until that run happens. Afterwards, and for the rest of
 * the week, Sleeper hands the pool back out first-come-first-serve, and a
 * streamed defense or kicker is almost always picked up in exactly that
 * window — after Thursday's injury news, not in Tuesday's blind bids.
 *
 * So this asks the league's own transaction log instead of the calendar: a
 * `free_agent` add that COMPLETED this week is proof the pool is open, since
 * a claim that had to clear waivers would have been logged as `waiver` with a
 * bid. No such evidence yet this week means we do not claim it is open — the
 * safe direction, because telling Ben "add now, $0" about a player who
 * actually locks until Wednesday is the mistake with a deadline on it.
 */
export function freeAgencyIsOpen(snapshot) {
  if (!snapshot.games_have_started) return true;
  return (snapshot.transactions ?? []).some((t) =>
    t?.type === 'free_agent' && t.status === 'complete'
    && t.week === snapshot.week && (t.adds ?? []).length > 0);
}

export function buildIndex(snapshot) {
  const byId = new Map(); // id -> { name, pos, team }
  const ownerOf = new Map(); // id -> roster_id
  const teamIds = new Map(); // roster_id -> Set(all ids on that roster)
  const teamStarterIds = new Map();
  const teamReserveIds = new Map();
  const ownerName = new Map(); // roster_id -> owner display name

  const remember = (p) => {
    if (!p || p.id == null) return;
    if (!byId.has(p.id)) {
      byId.set(p.id, {
        name: p.name,
        pos: p.position ?? null,
        team: p.team ?? null,
        bye_week: p.bye_week ?? null,
        injury_status: p.injury_status ?? null,
      });
    }
  };

  for (const t of snapshot.teams ?? []) {
    ownerName.set(t.roster_id, t.owner);
    const starters = new Set();
    const reserve = new Set();
    const all = new Set();
    for (const p of t.starters ?? []) {
      remember(p);
      if (p) {
        starters.add(p.id);
        all.add(p.id);
        ownerOf.set(p.id, t.roster_id);
      }
    }
    for (const p of t.bench ?? []) {
      remember(p);
      if (p) {
        all.add(p.id);
        ownerOf.set(p.id, t.roster_id);
      }
    }
    for (const p of t.reserve ?? []) {
      remember(p);
      if (p) {
        reserve.add(p.id);
        all.add(p.id);
        ownerOf.set(p.id, t.roster_id);
      }
    }
    teamStarterIds.set(t.roster_id, starters);
    teamReserveIds.set(t.roster_id, reserve);
    teamIds.set(t.roster_id, all);
  }
  for (const p of snapshot.trending?.adds ?? []) remember(p);
  for (const p of snapshot.trending?.drops ?? []) remember(p);
  for (const tx of snapshot.transactions ?? []) {
    for (const p of tx.adds ?? []) remember(p);
    for (const p of tx.drops ?? []) remember(p);
  }

  return { byId, ownerOf, teamIds, teamStarterIds, teamReserveIds, ownerName };
}

let playersFileCache = null;
async function loadPlayersFile() {
  if (playersFileCache) return playersFileCache;
  try {
    playersFileCache = JSON.parse(
      await readFile(path.join(root, 'data', 'players.json'), 'utf8')
    );
  } catch {
    playersFileCache = {};
  }
  return playersFileCache;
}

async function resolvePlayer(index, id) {
  if (index.byId.has(id)) return index.byId.get(id);
  const players = await loadPlayersFile();
  const p = players[id];
  if (!p) return null;
  const name = p.full_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || id);
  const pos = p.position ?? p.fantasy_positions?.[0] ?? null;
  const team = p.team ?? null;
  const resolved = { name, pos, team };
  index.byId.set(id, resolved);
  return resolved;
}

// ---- parsing the ```actions block out of a report ----

async function loadReportBlock(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    // A routine runs --check on a path it built from today's date; a typo
    // there used to surface as a raw Node stack trace, which reads like the
    // tool is broken rather than like the filename is wrong.
    return { error: e.code === 'ENOENT' ? 'no such file' : `could not read it: ${e.message}` };
  }
  const re = /```actions[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  const first = re.exec(raw);
  if (!first) return { error: 'no fenced ```actions``` block found' };
  if (re.exec(raw)) {
    // The contract allows exactly one ```actions block per report. Two is
    // always a mistake (a leftover draft, a bad merge) and guessing which one
    // is "real" is exactly the kind of silent judgment call this file exists
    // to refuse — so it's a hard error, not a first-wins-and-hope.
    return { error: 'found more than one ```actions``` block; a report must have exactly one' };
  }
  try {
    return { block: JSON.parse(first[1]) };
  } catch (e) {
    return { error: `invalid JSON in actions block: ${e.message}` };
  }
}

// ---- my starting lineup, by slot ----
// snapshot.teams[].starters is positional: index i is roster_positions' i-th
// non-BN slot. Both helpers rely on that alignment, which sync.mjs preserves.
function myStarterRow(snapshot) {
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const slots = (snapshot.league.roster_positions ?? []).filter((p) => p !== 'BN');
  return slots.map((slot, i) => ({ slot, player: me?.starters?.[i] ?? null }));
}

// Which slot a player is currently starting in, or null if he isn't starting.
function starterSlotOf(snapshot, playerId) {
  const row = myStarterRow(snapshot).find((r) => r.player?.id === playerId);
  return row ? row.slot : null;
}

// True when at least one slot of that name has nobody in it.
function slotIsEmpty(snapshot, slot) {
  return myStarterRow(snapshot).some((r) => r.slot === slot && !r.player);
}

// ---- "the case": four plain-English lines computed from the snapshot, never
// decorated by the routine. See docs/ACTIONS.md "The case — why this move,
// in four lines". buildCase is pure: everything it needs (names, positions,
// the outlook) is already resolved onto the built action or reachable
// through snapshot/index/baseline, so it does no I/O of its own.

// The card prints SUPER_FLEX as SUPERFLEX; every other slot name is shown as-is.
function slotLabel(slot) {
  return slot === 'SUPER_FLEX' ? 'SUPERFLEX' : slot;
}

// A player object shaped like a snapshot roster player, built from whatever
// buildIndex/resolvePlayer already learned about this id — buildOutlook needs
// {id, name, position, team, bye_week, injury_status}.
function playerObjFor(index, id) {
  const r = index.byId.get(id) ?? {};
  return {
    id,
    name: r.name ?? id,
    position: r.pos ?? null,
    team: r.team ?? null,
    bye_week: r.bye_week ?? null,
    injury_status: r.injury_status ?? null,
  };
}

// The players currently starting at `pos`: dedicated-slot holders first (in
// roster-slot order), then flex holders of that position — the "behind
// McMillan, Diggs" list in an add's bench case.
function startersAtPosition(snapshot, pos) {
  const dedicated = [];
  const flex = [];
  for (const { slot, player } of myStarterRow(snapshot)) {
    if (!player || player.position !== pos) continue;
    if (slot === pos) dedicated.push(player.name);
    else if (SLOT_ELIGIBILITY[slot]?.includes(pos)) flex.push(player.name);
  }
  return [...dedicated, ...flex];
}

function namesList(names) {
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
}

// Weeks whose empty_slots shrink (a hole this move fixes) or grow (a hole it
// opens), AND weeks whose downgraded_slots shrink or grow (a downgrade this
// move fixes or opens), between a baseline outlook and a what-if outlook,
// week by week. downgraded_slots (outlook-core.mjs) is a week that is still
// a LEGAL lineup but a worse one — no QB left for a QB-eligible flex slot,
// so a flex body starts there instead — which the empty_slots comparison
// alone can never see. Without this half, a trade or add that only ever
// creates or removes downgraded weeks (never a fully empty one) read "opens
// no holes" even when it spent the only quarterback covering a future bye.
// Each entry carries `kind` ('hole' or 'downgrade') so opensLine can group
// and word the two kinds separately rather than merging them.
// The same fixes/opens the `later` line reads, kept as structured data so the
// card can act on it instead of the reader having to parse a sentence.
//
// This is the gap that let the worst move of 2026-09-22 sit at the top of the
// card: the compiler had already worked out that the claim fixed nothing on
// the calendar and opened a Week 11 tight-end hole, printed both facts in the
// case grid — and then drew the row exactly like a good move. Two neutral
// lines of evidence against a move are easy to read past when everything
// around them looks the same. `net` names the verdict the lines add up to, so
// the page can show it.
function tradeoffOf(fixes, opens) {
  const shape = (xs) => xs.map(({ week, slot, kind }) => ({ week, slot, kind }));
  const net = opens.length && !fixes.length ? 'costs_only'
    : fixes.length && !opens.length ? 'fixes_only'
    : fixes.length && opens.length ? 'mixed'
    : 'neutral';
  return { net, fixes: shape(fixes), opens: shape(opens) };
}

function diffWeeks(baseline, whatIf) {
  const fixes = []; // { week, slot, kind }
  const opens = []; // { week, slot, kind }
  const baseByWeek = new Map(baseline.weeks.map((w) => [w.week, w]));
  for (const w of whatIf.weeks) {
    const base = baseByWeek.get(w.week);
    const baseEmpty = new Set(base?.empty_slots ?? []);
    const nowEmpty = new Set(w.empty_slots ?? []);
    for (const slot of baseEmpty) if (!nowEmpty.has(slot)) fixes.push({ week: w.week, slot, kind: 'hole' });
    for (const slot of nowEmpty) if (!baseEmpty.has(slot)) opens.push({ week: w.week, slot, kind: 'hole' });

    const baseDowngraded = new Set(base?.downgraded_slots ?? []);
    const nowDowngraded = new Set(w.downgraded_slots ?? []);
    for (const slot of baseDowngraded) if (!nowDowngraded.has(slot)) fixes.push({ week: w.week, slot, kind: 'downgrade' });
    for (const slot of nowDowngraded) if (!baseDowngraded.has(slot)) opens.push({ week: w.week, slot, kind: 'downgrade' });
  }
  return { fixes, opens };
}

// "W5, W7, W11" up to four weeks; past that a span reads better than a list —
// dropping your only kicker opens a hole in every remaining week, and fifteen
// "W" tokens on the card say less than "15 weeks (W3–W17)".
function weeksLabel(weeks) {
  const ws = [...new Set(weeks)].sort((a, b) => a - b);
  if (ws.length <= 4) return ws.map((w) => `W${w}`).join(', ');
  return `${ws.length} weeks (W${ws[0]}–W${ws[ws.length - 1]})`;
}

function fixesSuffix(fixes) {
  const weeks = fixes.map((f) => f.week);
  return weeks.length ? ` · fixes ${weeksLabel(weeks)}` : ' · fixes nothing on the calendar';
}

// "opens no holes" / "opens a W7 WR hole, a W9 K hole" / "opens a K hole in
// 15 weeks (W3–W17)" / "opens a W13 SUPER_FLEX downgrade" — used where the
// need line already carries the fixes half (add). Grouped by slot AND kind
// (not slot alone) so a hole and a downgrade at the same slot stay two
// clauses — a season-long gap is still one clause per kind.
function opensLine(opens) {
  if (!opens.length) return 'opens no holes';
  const bySlot = new Map(); // "slot|kind" -> { slot, kind, weeks }
  for (const o of [...opens].sort((a, b) => a.week - b.week)) {
    const key = `${o.slot}|${o.kind}`;
    if (!bySlot.has(key)) bySlot.set(key, { slot: o.slot, kind: o.kind, weeks: [] });
    bySlot.get(key).weeks.push(o.week);
  }
  const clauses = [...bySlot.values()].map(({ slot, kind, weeks }) => {
    const noun = kind === 'downgrade' ? 'downgrade' : 'hole';
    return weeks.length >= 3
      ? `a ${slotLabel(slot)} ${noun} in ${weeksLabel(weeks)}`
      : weeks.map((w) => `a W${w} ${slotLabel(slot)} ${noun}`).join(', ');
  });
  return `opens ${clauses.join(', ')}`;
}

// fixes + opens together — used where nothing else in the case carries the
// fixes half (trade, drop, ir, activate).
function fixesAndOpensLine(fixes, opens) {
  const parts = [];
  if (fixes.length) parts.push(`fixes ${weeksLabel(fixes.map((f) => f.week))}`);
  parts.push(opensLine(opens));
  return parts.join(' · ');
}

function rankAt(baseline, pos) {
  return (baseline.roster_shape.active_by_position[pos] ?? 0) + 1;
}

// Three readings, strongest first: can't fill the dedicated slot, can't cover
// what the lineup actually starts (the superflex QB, the flex RB — invisible
// to a dedicated-slot count), or genuine depth.
function needLine(baseline, pos, label = 'your thinnest spot') {
  const shape = baseline.roster_shape;
  const have = shape.active_by_position[pos] ?? 0;
  if (shape.thin_positions.includes(pos)) return `${pos}: you have ${have} — ${label}`;
  if ((shape.no_cover_positions ?? []).includes(pos)) {
    return `${pos}: you have ${have} — starts ${shape.lineup_demand[pos]}, no cover`;
  }
  return `${pos}: you have ${have} — not thin`;
}

// "the drop/removed player emptied a thin spot" suffix shared by add's drop
// and by drop/ir's own subject leaving the active roster.
function lossSuffix(baseline, pos) {
  if (!pos) return '';
  const have = baseline.roster_shape.active_by_position[pos] ?? 0;
  if (have === 1) return ` · drops your only ${pos}`;
  if (baseline.roster_shape.thin_positions.includes(pos)) return ` · leaves ${pos} thin`;
  return '';
}

function addCaseCost(action, snapshot, index) {
  if (action.mode === 'fcfs') {
    let cost = '$0, first come first served';
    if (action.drop) {
      const dropPos = index.byId.get(action.drop)?.pos ?? '?';
      const starting = (snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id)?.starters ?? [])
        .some((p) => p?.id === action.drop);
      cost += ` · drops ${action.drop_name} (${dropPos}, ${starting ? 'starter' : 'bench'})`;
    }
    return cost;
  }
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const cap = me?.faab_remaining ?? 0;
  const budget = snapshot.league.waiver_budget;
  const atBudget = snapshot.teams.filter((t) => t.faab_remaining === budget).length;
  let budgetPart;
  if (atBudget === snapshot.teams.length) budgetPart = ` · every team still has $${budget}`;
  else if (atBudget > 0) budgetPart = ` · ${atBudget} of ${snapshot.teams.length} teams still have $${budget}`;
  else {
    const avg = Math.round(snapshot.teams.reduce((s, t) => s + (t.faab_remaining ?? 0), 0) / snapshot.teams.length);
    budgetPart = ` · league average $${avg} left`;
  }
  const rankIdx = (snapshot.trending?.adds ?? []).findIndex((p) => p.id === action.player);
  const rankPart = rankIdx === -1 ? ' · not trending' : ` · #${rankIdx + 1} most-added in Sleeper this week`;
  let cost = `$${action.faab} of $${cap}${budgetPart}${rankPart}`;
  if (action.drop) {
    const dropPos = index.byId.get(action.drop)?.pos ?? '?';
    const starting = (snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id)?.starters ?? [])
      .some((p) => p?.id === action.drop);
    cost += ` · drops ${action.drop_name} (${dropPos}, ${starting ? 'starter' : 'bench'})`;
  }
  return cost;
}

function buildAddCase(action, snapshot, index, baseline) {
  const c = {};
  const pos = action.pos;

  if (action.displaces_missing) {
    c.starts = "The report didn't say who he displaces";
  } else if (action.displaces) {
    const slot = starterSlotOf(snapshot, action.displaces);
    c.starts = `Starts over ${action.displaces_name} at ${slotLabel(slot)}`;
  } else {
    const n = rankAt(baseline, pos);
    c.starts = `Bench — ${pos}${n} behind ${namesList(startersAtPosition(snapshot, pos))}`;
  }

  const player = playerObjFor(index, action.player);
  const whatIf = buildOutlook(snapshot, { add: [player], drop: action.drop ? [action.drop] : [] });
  const { fixes, opens } = diffWeeks(baseline, whatIf);
  c.tradeoff = tradeoffOf(fixes, opens);

  if (!action.displaces_missing && !action.displaces) {
    const fixWeeks = [...new Set(fixes.map((f) => f.week))].sort((a, b) => a - b);
    if (fixWeeks.length) c.starts += `; starts Week ${fixWeeks[0]}`;
  }

  c.need = needLine(baseline, pos) + fixesSuffix(fixes);
  c.cost = addCaseCost(action, snapshot, index);

  let later = opensLine(opens);
  if (action.needs_slot && baseline.roster_shape.bench_open === 1) later += ' · uses your last bench slot';
  if (action.drop) later += lossSuffix(baseline, index.byId.get(action.drop)?.pos);
  c.later = later;

  return c;
}

// What the deal asks of the OTHER manager, read off their roster instead of
// asserted in prose. A trades report argued an offer was easy because the
// player was "still on Tally241's bench" when the snapshot had him in their
// starting lineup — a fact the compiler already held and never checked, so
// the card repeated the mistake and the offer sat unanswered for four days.
// The partner's own side is computed here so a report cannot misdescribe it.
//
// Returns '' when the partner can't be resolved: a missing line is drawn as
// nothing, which is honest, where a "?" would read as a fact.
export function partnerAskLine(action, snapshot, index) {
  const partner = action.with;
  const theirTeam = (snapshot.teams ?? []).find((t) => t.roster_id === partner);
  if (!theirTeam) return '';
  const owner = index.ownerName.get(partner) ?? action.with_owner ?? `roster ${partner}`;
  const theirStarters = index.teamStarterIds.get(partner) ?? new Set();
  const theirReserve = index.teamReserveIds.get(partner) ?? new Set();
  const theirAll = [...(theirTeam.starters ?? []), ...(theirTeam.bench ?? []), ...(theirTeam.reserve ?? [])]
    .filter(Boolean);

  const clauses = (action.get ?? []).map((id) => {
    const info = index.byId.get(id) ?? {};
    const name = info.name ?? id;
    const where = theirStarters.has(id) ? 'starts' : theirReserve.has(id) ? 'has on IR' : 'benches';
    const hurt = info.injury_status ? `, ${info.injury_status}` : '';
    const atPos = info.pos ? theirAll.filter((p) => p.position === info.pos).length : 0;
    const depth = info.pos ? ` — one of ${atPos} ${info.pos}${atPos === 1 ? '' : 's'} they carry` : '';
    return `${owner} ${where} ${name}${hurt}${depth}`;
  });
  if (!clauses.length) return '';

  // The shape that does not get accepted, and the one the false premise hid:
  // asking a manager to pull a starter out of their lineup while sending them
  // nothing that starts in mine. Stated, not scored — whether it is worth
  // sending is still the report's call.
  const myStarters = index.teamStarterIds.get(snapshot.my_roster_id) ?? new Set();
  const asksStarter = (action.get ?? []).some((id) => theirStarters.has(id));
  const sendsStarter = (action.give ?? []).some((id) => myStarters.has(id));
  const tail = asksStarter && !sendsStarter ? ' · asks them to bench a starter for bench pieces' : '';
  return clauses.join('; ') + tail;
}

function buildTradeCase(action, snapshot, index, baseline) {
  const c = {};
  const getIds = action.get ?? [];
  const giveIds = action.give ?? [];

  if (action.displaces_missing) {
    c.starts = "The report didn't say who he displaces";
  } else {
    const clauses = getIds.map((id, idx) => {
      const info = index.byId.get(id) ?? {};
      const name = info.name ?? id;
      if (idx === 0 && action.displaces) {
        const slot = starterSlotOf(snapshot, action.displaces);
        return `${name} starts over ${action.displaces_name} at ${slotLabel(slot)}`;
      }
      // A position the snapshot can't name gets words, never a bare "?".
      return info.pos ? `${name} is depth (${info.pos}${rankAt(baseline, info.pos)})` : `${name} is depth`;
    });
    c.starts = clauses.join('; ');
  }

  const incomingPos = [...new Set(getIds.map((id) => index.byId.get(id)?.pos).filter(Boolean))];
  // Say so when the headline player's position is unknown, rather than
  // quietly leaving him out of the need line.
  const unknownIncoming = getIds.filter((id) => !index.byId.get(id)?.pos).map((id) => index.byId.get(id)?.name ?? id);
  const givePos = [...new Set(giveIds.map((id) => index.byId.get(id)?.pos).filter(Boolean))];
  const needParts = incomingPos.map((p) => needLine(baseline, p));
  // "start N" is the outlook's lineup demand — the dedicated slots plus the
  // flex slots the lineup actually fills at that position. Counting starter
  // bodies instead under-reported whenever a starting slot sat empty, and
  // dedicated slots alone would say Ben starts one QB in a superflex league.
  const giveParts = givePos.map((p) => {
    const have = baseline.roster_shape.active_by_position[p] ?? 0;
    const starts = baseline.roster_shape.lineup_demand?.[p] ?? 0;
    return `gives ${p} depth (you have ${have}, start ${starts})`;
  });
  if (unknownIncoming.length) needParts.push(`${unknownIncoming.join(', ')}: position unknown`);
  c.need = needParts.join('; ') + giveParts.map((g) => ` · ${g}`).join('');

  const myStarters = new Set((snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id)?.starters ?? [])
    .filter(Boolean).map((p) => p.id));
  const giveNames = action.give_names ?? [];
  let starters = 0, bench = 0;
  for (const id of giveIds) (myStarters.has(id) ? starters++ : bench++);
  c.cost = `gives ${giveNames.join(', ')} — ${starters} starter${starters === 1 ? '' : 's'}, ${bench} bench · no FAAB`;

  const asks = partnerAskLine(action, snapshot, index);
  if (asks) c.asks = asks;

  const getPlayers = getIds.map((id) => playerObjFor(index, id));
  const whatIf = buildOutlook(snapshot, { add: getPlayers, drop: giveIds });
  const { fixes, opens } = diffWeeks(baseline, whatIf);
  c.tradeoff = tradeoffOf(fixes, opens);
  let later = fixesAndOpensLine(fixes, opens);
  const freed = giveIds.length - getIds.length;
  if (freed > 0) later += ` · frees ${freed} bench slot${freed === 1 ? '' : 's'}`;
  // The what-if outlook is a season-long "can some legal lineup be fielded"
  // check — it will happily reassign a same-position bench body into a slot
  // a given-away starter vacates, so the diff above can read clean even
  // though nobody has actually moved in the live Sleeper lineup yet. Trade
  // review is 0 days, so the deal can process minutes before kickoff; name
  // the emptied slot(s) so the card still says a manual swap is owed, without
  // requiring this action to carry a paired `start` (that's a bigger,
  // separate contract change — this just makes sure it's never silent).
  const vacated = [...new Set(
    giveIds.filter((id) => myStarters.has(id)).map((id) => starterSlotOf(snapshot, id)).filter(Boolean)
  )];
  if (vacated.length) {
    later += ` · empties ${vacated.map(slotLabel).join(', ')} this week — set a starter there before kickoff`;
  }
  c.later = later;

  return c;
}

function buildStartCase(action, snapshot, index) {
  const c = {};
  const slot = slotLabel(action.slot);
  c.starts = action.for ? `${action.name} in at ${slot}, ${action.for_name} to the bench` : `${action.name} in at ${slot}`;
  if (action.for) {
    const info = index.byId.get(action.for) ?? {};
    // Only the facts the snapshot actually has: no "? bye W?" when a player
    // came from the players file without a team or bye.
    const facts = [info.injury_status || 'healthy'];
    if (info.team && info.bye_week != null) facts.push(`${info.team} bye W${info.bye_week}`);
    else if (info.bye_week != null) facts.push(`bye W${info.bye_week}`);
    c.need = `${action.for_name}: ${facts.join(', ')}`;
  }
  return c;
}

function buildRemovalCase(action, snapshot, index, baseline) {
  const c = {};
  const pos = action.pos;
  c.need = needLine(baseline, pos);

  const player = playerObjFor(index, action.player);
  const whatIf = action.kind === 'activate'
    ? buildOutlook(snapshot, { add: [player] })
    : buildOutlook(snapshot, { drop: [action.player] });
  const { fixes, opens } = diffWeeks(baseline, whatIf);
  c.tradeoff = tradeoffOf(fixes, opens);
  let later = fixesAndOpensLine(fixes, opens);
  if (action.kind === 'drop' || action.kind === 'ir') later += lossSuffix(baseline, pos);
  c.later = later;

  return c;
}

// The one pure, exported piece of "the case": computed the same way for
// --check and compile so the number on the card always matches what the
// snapshot can prove. `action` is the built action (post-validation);
// `baseline` is buildOutlook(snapshot), computed once per run.
export function buildCase(action, snapshot, index, baseline) {
  switch (action.kind) {
    case 'add': return buildAddCase(action, snapshot, index, baseline);
    case 'trade': return buildTradeCase(action, snapshot, index, baseline);
    case 'start': return buildStartCase(action, snapshot, index);
    case 'drop':
    case 'ir':
    case 'activate':
      return buildRemovalCase(action, snapshot, index, baseline);
    default:
      return {};
  }
}

// ---- lifecycle: has the world already moved past this action? ----

// A team's kickoff locks every one of its players' roster slots — Sleeper
// refuses a start/for swap once the game has left pre_game, and (once a real
// kickoff time exists in the schedule payload — it doesn't yet, see
// scripts/sync.mjs buildGames) once that time has passed even if the status
// field hasn't flipped. Returns the snapshot.games entry when the team is
// locked, else null, so a team with no game this week (a bye) reads the same
// as one that's still pre_game rather than throwing on a missing lookup.
function kickedOffGame(snapshot, team) {
  const game = team ? snapshot.games?.[team] : null;
  if (!game) return null;
  const hasKickoffTime = typeof game.kickoff === 'string' && /[T:]/.test(game.kickoff);
  const kickoffPassed = hasKickoffTime && !Number.isNaN(Date.parse(game.kickoff)) && Date.parse(game.kickoff) < Date.now();
  return game.status !== 'pre_game' || kickoffPassed ? game : null;
}

// The one-sentence version of kickedOffGame, for the `state_reason` a stale
// start carries — without it the card (or anyone reading actions.json) would
// have to reverse-engineer "kicked off" from a bare state string. Only ever
// called once lifecycleState has already decided the action is stale, so one
// of the two lookups here is guaranteed to hit.
function staleStartReason(action, snapshot, index) {
  const playerGame = kickedOffGame(snapshot, index.byId.get(action.player)?.team);
  if (playerGame) {
    return `${index.byId.get(action.player)?.name ?? action.player}'s game has already kicked off (${playerGame.status})`;
  }
  const forId = action.for;
  const forGame = isNonEmptyString(forId) ? kickedOffGame(snapshot, index.byId.get(forId)?.team) : null;
  if (forGame) {
    return `${index.byId.get(forId)?.name ?? forId}'s game has already kicked off (${forGame.status})`;
  }
  return 'kickoff has passed';
}

// The same done/gone tests docs/ACTIONS.md section 3 defines and docs/index.html
// applies live. Exported so the suite can hold the page's copy to it —
// the compiler and the card must never disagree about what "done" means. Computed from the RAW action (before validation) so that an
// action which is already done or gone is never held to "can you still do
// this" rules it cannot possibly pass.
export function lifecycleState(action, snapshot, index) {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return 'open';
  const myId = snapshot.my_roster_id;
  const mine = index.teamIds.get(myId) ?? new Set();
  const starters = index.teamStarterIds.get(myId) ?? new Set();
  const reserve = index.teamReserveIds.get(myId) ?? new Set();
  const p = action.player;

  switch (action.kind) {
    case 'add': {
      if (!isNonEmptyString(p)) return 'open';
      if (mine.has(p)) return 'done';
      const owner = index.ownerOf.get(p);
      return owner !== undefined ? 'gone' : 'open';
    }
    case 'drop':
      return isNonEmptyString(p) && !mine.has(p) ? 'done' : 'open';
    case 'start': {
      if (!isNonEmptyString(p)) return 'open';
      if (starters.has(p) && (!isNonEmptyString(action.for) || !starters.has(action.for))) return 'done';
      if (!mine.has(p)) return 'gone';
      // Sleeper locks a player's starting slot at his own kickoff — a start
      // still open after either side's game has left pre_game can no longer
      // be carried out, so it goes stale the same as a start whose week has
      // rolled over (docs/ACTIONS.md "stale").
      const forTeam = isNonEmptyString(action.for) ? index.byId.get(action.for)?.team : null;
      if (kickedOffGame(snapshot, index.byId.get(p)?.team) || kickedOffGame(snapshot, forTeam)) return 'stale';
      return 'open';
    }
    case 'ir':
      if (!isNonEmptyString(p)) return 'open';
      if (reserve.has(p)) return 'done';
      return mine.has(p) ? 'open' : 'gone';
    case 'activate':
      if (!isNonEmptyString(p)) return 'open';
      if (mine.has(p) && !reserve.has(p)) return 'done';
      return reserve.has(p) ? 'open' : 'gone';
    case 'trade': {
      const get = Array.isArray(action.get) ? action.get : [];
      const give = Array.isArray(action.give) ? action.give : [];
      if (get.length && get.every((id) => mine.has(id))) return 'done';
      // A player you no longer have cannot be given away: the offer is moot,
      // whether it was accepted, withdrawn, or the player went elsewhere.
      if (give.length && !give.every((id) => mine.has(id))) return 'gone';
      // Same the other way: the other manager may have moved the player this
      // offer asks for, which kills the offer without anyone answering it.
      const withIds = index.teamIds.get(Number(action.with));
      if (withIds && get.length && !get.every((id) => withIds.has(id))) return 'gone';
      return 'open';
    }
    default:
      return 'open';
  }
}

// ---- per-action validation + build ----

// Shape and ids are always checked — a garbled id is a bug in any mode.
// What differs is how a mismatch with the CURRENT world is treated:
//
//   strict (--check, at write time)  an error. A report should never be
//                                    written naming a move you cannot make.
//   compile (over older reports)     a warning, and the stale part of the
//                                    action is dropped rather than the whole
//                                    run. Reality moving on is not a bug in
//                                    a report written before it moved.
//
// An action already `done` or `gone` skips these checks altogether: the
// answer is knowably no and saying so again is noise.
async function validateAndBuildAction(action, i, snapshot, index, problems, opts = {}) {
  const { state = 'open', strict = true, warnings = [], baseline = null } = opts;
  const live = state === 'open';
  const requireWorld = live && strict;
  const push = (msg) => problems.push(`action[${i}]: ${msg}`);
  // Returns true when the mismatch was fatal (strict mode), so the caller can
  // decide what to keep when it wasn't.
  const worldFail = (msg) => {
    if (!live) return false;
    if (strict) { push(msg); return true; }
    warnings.push(`action[${i}] (${action.kind}): ${msg}`);
    return false;
  };

  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    push('must be an object');
    return null;
  }

  const kind = action.kind;
  if (!KINDS.includes(kind)) {
    push(`kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
    return null;
  }

  let bad = false;
  if (!URGENCIES.includes(action.urgency)) {
    push(`(${kind}) urgency must be one of ${URGENCIES.join(', ')} (got ${JSON.stringify(action.urgency)})`);
    bad = true;
  }
  if (!isNonEmptyString(action.why) || action.why.length > 200) {
    push(`(${kind}) why is required, non-empty, and at most 200 characters`);
    bad = true;
  }
  if (action.deadline_label !== undefined && !isNonEmptyString(action.deadline_label)) {
    push(`(${kind}) deadline_label must be a non-empty string when present`);
    bad = true;
  }
  if (action.id !== undefined && !isNonEmptyString(action.id)) {
    push(`(${kind}) id must be a non-empty string when present`);
    bad = true;
  }
  if (action.after !== undefined && !isNonEmptyString(action.after)) {
    push(`(${kind}) after must be a non-empty string when present`);
    bad = true;
  }
  if (action.if_not !== undefined && !isNonEmptyString(action.if_not)) {
    push(`(${kind}) if_not must be a non-empty string when present`);
    bad = true;
  }

  const myId = snapshot.my_roster_id;
  const myIds = index.teamIds.get(myId) ?? new Set();
  const myStarters = index.teamStarterIds.get(myId) ?? new Set();
  const myReserve = index.teamReserveIds.get(myId) ?? new Set();

  const out = {
    kind,
    urgency: action.urgency,
    deadline_label: action.deadline_label,
    why: action.why,
    id: isNonEmptyString(action.id) ? action.id : undefined,
    after: isNonEmptyString(action.after) ? action.after : undefined,
    if_not: isNonEmptyString(action.if_not) ? action.if_not : undefined,
  };

  // ---- displaces: required on add/trade — docs/ACTIONS.md "The case". The
  // id of the starter the incoming player replaces this week, or null if he
  // doesn't start. For a trade it answers for get[0]; `incoming` is that
  // player's resolved {name, pos}. Only checked live — an already done/gone
  // action skips it, same as every other world check.
  async function resolveDisplaces(incoming) {
    if (!live) return;
    if (!('displaces' in action)) {
      // No kind prefix: worldFail's compile-mode warning already carries one.
      const msg = `displaces is required: the id of the starter he replaces this week, or null if he does not start`;
      if (worldFail(msg)) bad = true;
      else out.displaces_missing = true;
      return;
    }
    if (action.displaces === null) {
      out.displaces = null;
      out.displaces_name = null;
      return;
    }
    if (!isNonEmptyString(action.displaces)) {
      push(`(${kind}) displaces must be a player id string or null`);
      bad = true;
      return;
    }
    const dId = action.displaces;
    const dResolved = await resolvePlayer(index, dId);
    const dName = dResolved?.name ?? dId;
    if (!myStarters.has(dId)) {
      push(`(${kind}) displaces "${dId}" (${dName}) is not in my starters`);
      bad = true;
      return;
    }
    const dSlot = starterSlotOf(snapshot, dId);
    const eligible = dSlot ? SLOT_ELIGIBILITY[dSlot] : null;
    if (incoming?.pos && eligible && !eligible.includes(incoming.pos)) {
      push(`(${kind}) ${incoming.name} is a ${incoming.pos}, which cannot take ${dName}'s ${dSlot} slot`);
      bad = true;
      return;
    }
    out.displaces = dId;
    out.displaces_name = dName;
  }

  // ---- evidence: required on add/trade — docs/ACTIONS.md "The case".
  //
  // The snapshot settles who is rostered, and the compiler checks every claim
  // it can. What it cannot check is the one class of claim these moves
  // actually turn on: a player's role, health, or return date, which comes
  // from web research and lands in the report as unfalsifiable prose. On
  // 2026-09-22 a waivers report argued a $20 bid with "Charbonnet's return is
  // still weeks off the earliest optimistic date, and he's not close to being
  // activated" when his own coach had him on an aggressive timetable he was
  // on track to meet, targeting Week 5 — the bid was for two weeks of a
  // backup who was about to be third in that backfield.
  //
  // So the field is not a citation for its own sake: it makes the claim
  // auditable on the card, where Ben can click it. It follows `displaces`
  // exactly — an explicit answer is required, and `null` is a real answer
  // meaning "decided from the roster alone, no outside claim" — so a routine
  // that cannot research is never blocked from publishing, only from being
  // silent about which it is.
  function resolveEvidence() {
    if (!live) return;
    if (!('evidence' in action)) {
      const msg = `evidence is required: {note, url} for the injury/role claim this rests on, or null if it rests only on the roster`;
      if (worldFail(msg)) bad = true;
      else out.evidence_missing = true;
      return;
    }
    const e = action.evidence;
    if (e === null) { out.evidence = null; return; }
    if (typeof e !== 'object' || Array.isArray(e)) {
      push(`(${kind}) evidence must be an object {note, url[, as_of]} or null`);
      bad = true;
      return;
    }
    if (!isNonEmptyString(e.note) || e.note.length > 200) {
      push(`(${kind}) evidence.note must be a non-empty string of at most 200 characters`);
      bad = true;
      return;
    }
    // Only http(s). The card turns this into a link, and a "javascript:" or
    // "data:" url in a file the page re-reads is a script injection, not a
    // source — rejected here as well as escaped there.
    if (!isNonEmptyString(e.url) || !/^https?:\/\//i.test(e.url)) {
      push(`(${kind}) evidence.url must be an http(s) link to where the claim came from`);
      bad = true;
      return;
    }
    if (e.as_of !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.as_of))) {
      push(`(${kind}) evidence.as_of must be a YYYY-MM-DD date when present`);
      bad = true;
      return;
    }
    out.evidence = { note: e.note, url: e.url, ...(e.as_of !== undefined ? { as_of: String(e.as_of) } : {}) };
  }

  if (kind !== 'trade') {
    if (!isNonEmptyString(action.player)) {
      push(`(${kind}) player is required`);
      return null;
    }
    const player = action.player;
    const resolved = await resolvePlayer(index, player);
    if (!resolved) {
      push(`(${kind}) player id "${player}" not found in snapshot or data/players.json`);
      return null;
    }
    out.player = player;
    out.name = resolved.name;
    out.pos = resolved.pos;
    out.team = resolved.team;

    if (kind === 'add') {
      const owner = index.ownerOf.get(player);
      if (owner !== undefined) {
        const oName = index.ownerName.get(owner) ?? String(owner);
        if (worldFail(`${resolved.name} is already rostered by ${oName} (roster ${owner}) — not a free agent`)) bad = true;
      }
      if (!ADD_MODES.includes(action.mode)) {
        push(`(add) mode must be "fcfs" or "waiver" (got ${JSON.stringify(action.mode)})`);
        bad = true;
      } else {
        out.mode = action.mode;
        // Pre-kickoff, unrostered players are instant, $0, first-come adds;
        // CLAUDE.md's calendar calibration section is explicit that this
        // flips the moment a game leaves pre_game — after that, Sleeper
        // locks every add behind Tuesday-night waivers. games_have_started
        // was recorded in the snapshot and echoed to the compiled output but
        // never checked here, so a stale "fcfs" mode validated clean well
        // past kickoff.
        if (action.mode === 'fcfs' && !freeAgencyIsOpen(snapshot) &&
            worldFail(`nothing in this week's transactions shows the pool is first-come-first-serve yet — this add needs mode: "waiver", not fcfs`)) {
          bad = true;
        }
      }
      if (action.drop !== undefined) {
        if (!isNonEmptyString(action.drop)) {
          push('(add) drop must be a player id string');
          bad = true;
        } else if (!myIds.has(action.drop) && live) {
          if (worldFail(`drop "${action.drop}" is no longer on my roster`)) {
            bad = true;
          } else {
            // He already left, so the add no longer needs him gone — it needs
            // a bench slot, which the sequencing rules will check for.
            out.drop_gone = true;
          }
        } else {
          const dropResolved = await resolvePlayer(index, action.drop);
          if (!dropResolved) {
            push(`(add) drop id "${action.drop}" not found in snapshot or data/players.json`);
            bad = true;
          } else {
            out.drop = action.drop;
            out.drop_name = dropResolved.name;
          }
        }
      }
      if (action.faab !== undefined) {
        if (action.mode !== 'waiver') {
          push('(add) faab is only valid when mode is "waiver"');
          bad = true;
        } else {
          const me = snapshot.teams.find((t) => t.roster_id === myId);
          const cap = me?.faab_remaining ?? 0;
          if (!Number.isInteger(action.faab) || action.faab < 0) {
            push(`(add) faab must be a non-negative integer, got ${JSON.stringify(action.faab)}`);
            bad = true;
          } else if (action.faab > cap && live) {
            if (worldFail(`bid $${action.faab} is more than my remaining FAAB ($${cap})`)) bad = true;
            else out.faab = action.faab;
          } else {
            out.faab = action.faab;
          }
        }
      }

      await resolveDisplaces(resolved);
      resolveEvidence();

      // "Depth is priced like depth": a slotless waiver add at a position
      // that isn't thin, bidding more than DEPTH_BID_CAP of my remaining
      // FAAB, is a starter's price for a player who isn't starting. Exempt
      // the same two tiers needLine() reads real need from, not thin alone —
      // thin_positions (can't fill the dedicated slot) and no_cover_positions
      // (no spare body for what the lineup actually starts, flex/SUPER_FLEX
      // included). Checking thin_positions only used to cap a backup QB's
      // bid to stash money even with just two QBs on the roster — no dedicated
      // slot was short, but SUPER_FLEX was, and losing either one breaks it.
      if (live && action.mode === 'waiver' && Number.isInteger(out.faab) &&
          (out.displaces === null || out.displaces_missing) &&
          !baseline.roster_shape.thin_positions.includes(resolved.pos) &&
          !(baseline.roster_shape.no_cover_positions ?? []).includes(resolved.pos)) {
        const me = snapshot.teams.find((t) => t.roster_id === myId);
        const cap = Math.floor((me?.faab_remaining ?? 0) * DEPTH_BID_CAP);
        if (out.faab > cap) {
          const n = rankAt(baseline, resolved.pos);
          const msg = `${resolved.name} would be ${resolved.pos}${n} and doesn't start — a $${out.faab} bid is a starter's price; name who he displaces, or price him as a stash ($${cap} or less)`;
          if (worldFail(msg)) bad = true;
        }
      }
    }

    // Unreachable in compile mode — a drop whose player has left is `done` —
    // so in practice this is the write-time check.
    if (kind === 'drop' && !myIds.has(player) && worldFail(`${resolved.name} is not on my roster`)) {
      bad = true;
    }

    if (kind === 'start') {
      // Likewise: a start whose player has left my roster is `gone`.
      if (!myIds.has(player) && worldFail(`${resolved.name} is not on my roster`)) {
        bad = true;
      }
      // myIds counts reserve as "mine" too (it has to, for drop/trade), so
      // roster membership alone let a start into the IR slot validate clean —
      // Sleeper won't move a reserve player straight into a starting slot,
      // he has to be activated first.
      if (myReserve.has(player) && worldFail(`${resolved.name} is on IR/reserve — activate him before starting him`)) {
        bad = true;
      }
      // Nothing else in the pipeline compares the incoming player's own bye
      // to the live week — buildStartCase only reports the benched player's
      // status — so a start naming someone on a bye validated clean and
      // scored zero.
      if (resolved.bye_week === snapshot.week && worldFail(`${resolved.name} is on a bye this week`)) {
        bad = true;
      }
      // Sleeper locks a player's starting slot at his own kickoff — a swap
      // naming him once his game has left pre_game is a move Ben can no
      // longer make, the same as a bye or an IR player above.
      const playerGame = kickedOffGame(snapshot, resolved.team);
      if (playerGame && worldFail(`${resolved.name}'s game has already kicked off (${playerGame.status}) — his slot is locked`)) {
        bad = true;
      }
      const nonBnSlots = (snapshot.league.roster_positions ?? []).filter((p) => p !== 'BN');
      const slotOk = isNonEmptyString(action.slot) && nonBnSlots.includes(action.slot);
      if (!slotOk) {
        push(`(start) slot must be one of ${[...new Set(nonBnSlots)].join(', ')} (got ${JSON.stringify(action.slot)})`);
        bad = true;
      } else {
        out.slot = action.slot;
        // Sleeper will not accept a player into a slot his position can't
        // fill, so a report that asks for it is asking for a move Ben cannot
        // make. Roster membership alone used to be the whole check — a kicker
        // in the QB slot validated clean.
        const eligible = SLOT_ELIGIBILITY[action.slot];
        if (eligible && resolved.pos && !eligible.includes(resolved.pos)) {
          push(`(start) ${resolved.name} is a ${resolved.pos}, which cannot fill the ${action.slot} slot (${action.slot} takes ${eligible.join('/')})`);
          bad = true;
        }
      }
      if (action.for !== undefined) {
        if (!isNonEmptyString(action.for)) {
          push('(start) for must be a player id string');
          bad = true;
        } else {
          const forResolved = await resolvePlayer(index, action.for);
          if (!forResolved) {
            push(`(start) for id "${action.for}" not found in snapshot or data/players.json`);
            bad = true;
          } else {
            out.for = action.for;
            out.for_name = forResolved.name;
          }
          if (live && !myStarters.has(action.for)) {
            if (worldFail(`"${action.for}" (${forResolved?.name ?? 'unknown'}) is not in my starters`)) bad = true;
          } else if (live && slotOk) {
            // The swap has to be in place. If the benched player is holding a
            // DIFFERENT slot, his slot is left empty and the lineup is
            // illegal — "never emit an action that leaves a starting slot
            // empty", which nothing enforced before.
            const forSlot = starterSlotOf(snapshot, action.for);
            if (forSlot !== null && forSlot !== action.slot) {
              if (worldFail(`${resolved.name} is going into ${action.slot} but ${forResolved?.name ?? action.for} is starting at ${forSlot} — that leaves ${forSlot} empty; bench the player who holds ${action.slot} instead`)) bad = true;
            }
          }
          // The benched player's own kickoff locks him in just as surely as
          // the incoming player's does — Sleeper won't move either side of a
          // slot once that slot's game has started.
          if (live && forResolved) {
            const forGame = kickedOffGame(snapshot, forResolved.team);
            if (forGame && worldFail(`${forResolved.name}'s game has already kicked off (${forGame.status}) — his slot is locked`)) bad = true;
          }
        }
      } else if (live && slotOk) {
        // No `for` means the named slot must already be empty, otherwise the
        // instruction silently displaces whoever is in it.
        if (!slotIsEmpty(snapshot, action.slot) && worldFail(`${action.slot} is already filled, so this needs a "for" naming the starter being benched`)) {
          bad = true;
        }
      }
    }

    if (kind === 'ir' && requireWorld) {
      if (!myIds.has(player)) {
        push(`(ir) player ${player} (${resolved.name}) is not on my roster`);
        bad = true;
      } else if (myReserve.has(player)) {
        push(`(ir) player ${player} (${resolved.name}) is already in reserve`);
        bad = true;
      }
    }

    if (kind === 'activate' && requireWorld && !myReserve.has(player)) {
      push(`(activate) player ${player} (${resolved.name}) is not in my reserve`);
      bad = true;
    }
  } else {
    // trade
    const withRaw = action.with;
    const withNum = typeof withRaw === 'number' ? withRaw : Number(withRaw);
    if (withRaw === undefined || withRaw === null || withRaw === '' || !Number.isInteger(withNum)) {
      push('(trade) with must be a roster id');
      bad = true;
    } else if (withNum === myId) {
      push(`(trade) with must not be my own roster (${myId})`);
      bad = true;
    } else if (!index.teamIds.has(withNum)) {
      push(`(trade) with roster ${withNum} does not exist in this league`);
      bad = true;
    } else {
      out.with = withNum;
      out.with_owner = index.ownerName.get(withNum) ?? String(withNum);
      const withIds = index.teamIds.get(withNum);

      const give = Array.isArray(action.give) ? action.give : null;
      if (!give || give.length === 0) {
        push('(trade) give must be a non-empty array of player ids');
        bad = true;
      } else {
        const giveNames = [];
        let giveOk = true;
        for (const gid of give) {
          if (!myIds.has(gid) && requireWorld) {
            push(`(trade) give id "${gid}" is not on my roster`);
            giveOk = false;
            continue;
          }
          const r = await resolvePlayer(index, gid);
          if (!r) {
            push(`(trade) give id "${gid}" not found in snapshot or data/players.json`);
            giveOk = false;
            continue;
          }
          giveNames.push(r.name);
        }
        if (giveOk) {
          out.give = give;
          out.give_names = giveNames;
        } else {
          bad = true;
        }
      }

      const get = Array.isArray(action.get) ? action.get : null;
      if (!get || get.length === 0) {
        push('(trade) get must be a non-empty array of player ids');
        bad = true;
      } else {
        const getNames = [];
        const getResolved = [];
        let getOk = true;
        for (const gid of get) {
          if (!withIds.has(gid) && requireWorld) {
            push(`(trade) get id "${gid}" is not on roster ${withNum}`);
            getOk = false;
            continue;
          }
          const r = await resolvePlayer(index, gid);
          if (!r) {
            push(`(trade) get id "${gid}" not found in snapshot or data/players.json`);
            getOk = false;
            continue;
          }
          getNames.push(r.name);
          getResolved.push(r);
        }
        if (getOk) {
          out.get = get;
          out.get_names = getNames;
          // displaces refers to get[0] — the player the trade actually
          // installs in my lineup; the rest of `get` is depth (see the case).
          await resolveDisplaces(getResolved[0]);
          resolveEvidence();
          // A warning in both modes, never fatal: whether an offer is worth
          // sending is the report's judgment, and a report that says why it
          // is asking for a starter anyway is doing its job. What is not
          // allowed is not noticing — so this is printed even on --check.
          const theirStarters = index.teamStarterIds.get(withNum) ?? new Set();
          const askedStarters = get.filter((gid) => theirStarters.has(gid));
          const sendsStarter = give && give.some((gid) => myStarters.has(gid));
          if (live && askedStarters.length && !sendsStarter) {
            const names = askedStarters.map((gid) => index.byId.get(gid)?.name ?? gid);
            warnings.push(`action[${i}] (trade): asks ${out.with_owner} to give up ${names.join(', ')} — in their starting lineup — while sending only bench players; say why they would take it`);
          }
        } else {
          bad = true;
        }
      }
    }
    if (action.message !== undefined) {
      if (!isNonEmptyString(action.message)) {
        push('(trade) message must be a non-empty string when present');
        bad = true;
      } else {
        out.message = action.message;
      }
    }
  }

  // ---- consumes: the rostered player ids this action uses up ----
  // (drop's own player, add's drop if any, trade's give, start's incoming
  // player and its benched `for`, ir/activate's subject). Empty array when
  // none. `add` also flags needs_slot when it has no drop, since it will
  // occupy an open bench spot rather than replace someone.
  if (kind === 'drop') {
    out.consumes = out.player !== undefined ? [out.player] : [];
  } else if (kind === 'add') {
    out.consumes = out.drop !== undefined ? [out.drop] : [];
    if (out.drop === undefined) out.needs_slot = true;
  } else if (kind === 'start') {
    // The player going IN is a resource this action uses up too, same as
    // `for` (the player coming out) — without him here, an unlinked start
    // and a trade/drop giving that same incoming player away never showed
    // up as the same player under Rule 1, so the card could carry both
    // "start him" and "give him away" live at once.
    out.consumes = out.for !== undefined ? [out.for, out.player] : [out.player];
  } else if (kind === 'ir' || kind === 'activate') {
    out.consumes = out.player !== undefined ? [out.player] : [];
  } else if (kind === 'trade') {
    out.consumes = out.give !== undefined ? [...out.give] : [];
  } else {
    out.consumes = [];
  }

  // "The case" — docs/ACTIONS.md "The case — why this move, in four lines".
  // Only computed for a genuinely open action: done/gone actions get no case,
  // the same reasoning that already exempts them from the world checks above.
  if (!bad && live) {
    out.case = buildCase(out, snapshot, index, baseline);
  }

  return bad ? null : out;
}

// ---- top-level block validation ----

async function validateReportBlock(block, snapshot, index, baseline, { lifecycle = false, source = null } = {}) {
  const driftWarnings = [];
  const problems = [];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return { problems: ['actions block must be a JSON object'] };
  }
  if (!Number.isInteger(block.week)) problems.push('week must be an integer');
  if (!isNonEmptyString(block.verdict)) problems.push('verdict is required and must be a non-empty string');
  if (!isNonEmptyString(block.next_check)) problems.push('next_check is required and must be a non-empty string');
  if (!Array.isArray(block.actions)) problems.push('actions must be an array');
  if (problems.length) return { problems };

  // week is required but is never a hard error against snapshot.week — it's
  // informational only. A source is "stale" when its week has fallen behind
  // the live snapshot week; that only matters for dropping `start` actions
  // (see compile()), not for validity.
  const stale = block.week < snapshot.week;

  const actionResults = []; // { index, ok, action }
  for (let i = 0; i < block.actions.length; i++) {
    const localProblems = [];
    // In compile mode an action that is already done or gone is exempt from
    // the "can you still do this" checks — the world moved, the report didn't
    // lie. In --check mode everything is held to the strict standard.
    const state = lifecycle ? lifecycleState(block.actions[i], snapshot, index) : 'open';
    const built = await validateAndBuildAction(block.actions[i], i, snapshot, index, localProblems, {
      state,
      strict: !lifecycle,
      warnings: driftWarnings,
      baseline,
    });
    if (built && state !== 'open') {
      built.state = state;
      // "stale" is the one lifecycle state that isn't self-explanatory from
      // the action's own fields (done/gone both are: the player just is or
      // isn't where the action says) — a reason string is what the card, or
      // anyone reading actions.json, would show for it.
      if (state === 'stale') built.state_reason = staleStartReason(block.actions[i], snapshot, index);
      // A finished or impossible action consumes nothing and needs no bench
      // slot, so it must not trip the sequencing rules against live actions.
      built.consumes = [];
      delete built.needs_slot;
    }
    actionResults.push({ index: i, ok: localProblems.length === 0, problems: localProblems, action: built });
    problems.push(...localProblems);
  }

  // Same-report trade-id collisions: two offers to one partner default to
  // the SAME id (`<source>:trade:<with>`) unless each carries its own
  // explicit `id` — and a second offer to a manager already offered is a
  // real, documented pattern (a primary offer plus an if_not fallback, or
  // two genuinely separate offers), not an accident to silently drop. This
  // used to only surface as a silent loss two steps downstream, in
  // compile()'s cross-source dedupe, which keys trades by partner alone and
  // has only ever had to pick between reports, never within one — checked
  // here instead, once, so both --check and compile give the same answer
  // about the report actually being written. A literal restatement (same
  // give and get to the same partner) is treated as the accidental
  // duplicate it almost certainly is.
  const tradesByPartner = new Map(); // with -> [{ index, action }]
  for (const r of actionResults) {
    const a = r.action;
    if (!r.ok || !a || a.kind !== 'trade' || a.with === undefined) continue;
    if (!tradesByPartner.has(a.with)) tradesByPartner.set(a.with, []);
    tradesByPartner.get(a.with).push({ index: r.index, action: a });
  }
  for (const [withId, entries] of tradesByPartner) {
    if (entries.length < 2) continue;
    const idOf = (a) => a.id ?? `${source}:trade:${withId}`;
    const seenIds = new Map(); // effective id -> first index it appeared at
    for (const { index, action } of entries) {
      const eid = idOf(action);
      if (seenIds.has(eid)) {
        problems.push(
          `action[${index}]: (trade) two offers to roster ${withId} in this report need distinct "id"s — action[${seenIds.get(eid)}] and action[${index}] would both default to "${eid}"`
        );
      } else {
        seenIds.set(eid, index);
      }
    }
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i], B = entries[j];
        if (sameIdSet(A.action.give, B.action.give) && sameIdSet(A.action.get, B.action.get)) {
          problems.push(
            `action[${B.index}]: (trade) offers roster ${withId} the exact same give/get as action[${A.index}] — likely a duplicate, not a second offer`
          );
        }
      }
    }
  }

  if (problems.length) return { problems, actionResults, driftWarnings };
  return { block, stale, actions: actionResults.map((r) => r.action), actionResults, driftWarnings };
}

// ---- newest-report-per-type selection ----

async function pickNewestReports() {
  let files;
  try {
    files = await readdir(reportsDir);
  } catch {
    files = [];
  }
  const picks = {};
  for (const type of TYPES) {
    const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${type}\\.md$`);
    const matches = files
      .map((f) => ({ f, date: f.match(re)?.[1] }))
      .filter((x) => x.date)
      .sort((a, b) => (a.date === b.date ? (a.f < b.f ? 1 : -1) : a.date < b.date ? 1 : -1));
    if (matches.length) picks[type] = matches[0].f;
  }
  return picks;
}

function buildRosterMaterial(snapshot) {
  // The starters/bench/reserve part of reports/.roster-fingerprint.json's
  // material — never the `hurt` list, which is fingerprint-only.
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  return {
    starters: me.starters.map((p) => p?.id ?? null),
    bench: me.bench.map((p) => p.id).sort(),
    reserve: me.reserve.map((p) => p.id).sort(),
  };
}

function finalizeAction(action, source, report, week) {
  const idKey = action.kind === 'trade' ? action.with : action.player;
  const id = action.id ?? `${source}:${action.kind}:${idKey}`;
  const out = { id, source, report, kind: action.kind, week };
  if (action.state !== undefined) out.state = action.state;
  if (action.state_reason !== undefined) out.state_reason = action.state_reason;
  if (action.after !== undefined) out.after = action.after;
  if (action.if_not !== undefined) out.if_not = action.if_not;
  if (action.player !== undefined) {
    out.player = action.player;
    out.name = action.name;
    out.pos = action.pos;
    out.team = action.team;
  }
  if (action.drop !== undefined) {
    out.drop = action.drop;
    out.drop_name = action.drop_name;
  }
  if (action.mode !== undefined) out.mode = action.mode;
  if (action.faab !== undefined) out.faab = action.faab;
  if (action.slot !== undefined) out.slot = action.slot;
  if (action.for !== undefined) {
    out.for = action.for;
    out.for_name = action.for_name;
  }
  if (action.with !== undefined) {
    out.with = action.with;
    out.with_owner = action.with_owner;
  }
  if (action.give !== undefined) {
    out.give = action.give;
    out.give_names = action.give_names;
  }
  if (action.get !== undefined) {
    out.get = action.get;
    out.get_names = action.get_names;
  }
  if (action.message !== undefined) out.message = action.message;
  // displaces is `undefined` (never set) when the report predates the rule
  // and this is a compile — see resolveDisplaces above — vs. explicitly
  // `null` when the routine said the player doesn't start; that distinction
  // has to survive into the JSON, so this checks presence, not truthiness.
  if (action.displaces !== undefined) {
    out.displaces = action.displaces;
    out.displaces_name = action.displaces_name;
  }
  // Same presence-not-truthiness reasoning as displaces: an explicit null
  // ("no outside claim") must survive into the JSON distinct from a report
  // written before the rule, which carries evidence_missing instead.
  if (action.evidence !== undefined) out.evidence = action.evidence;
  if (action.evidence_missing) out.evidence_missing = true;
  out.consumes = action.consumes ?? [];
  if (action.needs_slot) out.needs_slot = true;
  out.urgency = action.urgency;
  if (action.deadline_label !== undefined) out.deadline_label = action.deadline_label;
  out.why = action.why;
  if (action.case !== undefined) out.case = action.case;
  return out;
}

// ---- sequencing: after/if_not resolution, cycle detection, conflict rules ----

// Infer the source type from a report's filename: `<date>-<type>.md`,
// `<anything>-<type>.md` or bare `<type>.md`, where <type> is one of TYPES.
// Returns null for anything else. The source names which routine's actions
// a --check replaces in reports/actions.json, so it must be a real routine
// name — an ad-hoc fallback like "draft" would leave the real waivers
// actions in the conflict set and the draft would collide with itself.
function inferSource(basename) {
  const re = new RegExp(`(?:^|-)(${TYPES.join('|')})\\.md$`);
  const m = basename.match(re);
  return m ? m[1] : null;
}

async function loadActionsJson() {
  try {
    const raw = await readFile(path.join(reportsDir, 'actions.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
  }
}

// Directed-graph cycle detection over after/if_not edges (an action points
// at the action it depends on / is a fallback for). `actions` must each
// carry `id`, and optionally `after` / `if_not`. Edges to ids outside the
// set are ignored here — those are dangling references, reported separately.
function findCycle(actions) {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const edgesOf = (id) => {
    const a = byId.get(id);
    const out = [];
    if (a.after !== undefined && byId.has(a.after)) out.push(a.after);
    if (a.if_not !== undefined && byId.has(a.if_not)) out.push(a.if_not);
    return out;
  };
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(actions.map((a) => [a.id, WHITE]));
  let cyclePath = null;

  function dfs(id, stack) {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of edgesOf(id)) {
      if (color.get(next) === GRAY) {
        const idx = stack.indexOf(next);
        cyclePath = stack.slice(idx).concat(next);
        return true;
      }
      if (color.get(next) === WHITE && dfs(next, stack)) return true;
    }
    stack.pop();
    color.set(id, BLACK);
    return false;
  }

  for (const a of actions) {
    if (color.get(a.id) === WHITE && dfs(a.id, [])) return cyclePath;
  }
  return null;
}

// Dangling-reference + cycle check over a set of already-finalized actions
// (each with `id`, optional `after` / `if_not`). Used both at compile time
// (full compiled set) and at check time (the file's own actions plus every
// id currently in reports/actions.json).
function resolveLinksAndDetectProblems(actions) {
  const problems = [];
  const byId = new Map(actions.map((a) => [a.id, a]));
  for (const a of actions) {
    if (a.after !== undefined && !byId.has(a.after)) {
      problems.push(`action "${a.id}": after references unknown id "${a.after}"`);
    }
    if (a.if_not !== undefined && !byId.has(a.if_not)) {
      problems.push(`action "${a.id}": if_not references unknown id "${a.if_not}"`);
    }
  }
  if (problems.length) return { problems };

  const cycle = findCycle(actions);
  if (cycle) {
    problems.push(`cycle detected in after/if_not links: ${cycle.join(' -> ')}`);
    return { problems };
  }
  return { problems: [] };
}

// ---- link reconciliation: remap ids superseded by dedupe, drop the rest ----
// Dedupe (in compile()) can make an after/if_not target disappear from the
// compiled set in two different ways, and they need different treatment:
//   - the target was a dedupe LOSER: the same move is still in the compiled
//     set, just under the winner's id (a newer report of the same kind+
//     player/with). `remap` carries loser id -> { winner, report }; the link
//     is retargeted, not dropped, because the dependency still holds.
//   - the target isn't present under any id: the report that carried it was
//     superseded by a newer report from its own source that simply no longer
//     contains that action (this week's trades report dropped an offer last
//     week's waivers report still points `if_not` at). That's not a broken
//     link for Ben to fix — see docs/ACTIONS.md "Sequencing" — so the field
//     is dropped and the action stands on its own.
// Pure (no I/O, no process.exit) so it can be unit-tested directly; compile()
// prints `notes` and `warnings` to stderr.
function reconcileLinks(finalActions, remap) {
  const notes = [];
  const warnings = [];

  const retargeted = finalActions.map((a) => {
    const out = { ...a };
    for (const field of ['after', 'if_not']) {
      const val = out[field];
      if (val === undefined) continue;
      const hit = remap.get(val);
      if (hit) {
        notes.push(
          `action "${out.id}": ${field} "${val}" was superseded by "${hit.winner}" from ${hit.report}; link retargeted`
        );
        out[field] = hit.winner;
      }
    }
    return out;
  });

  const ids = new Set(retargeted.map((a) => a.id));
  const reconciled = retargeted.map((a) => {
    const out = { ...a };
    for (const field of ['after', 'if_not']) {
      const val = out[field];
      if (val === undefined || ids.has(val)) continue;
      warnings.push(
        `action "${out.id}": ${field} references "${val}" which is not in the compiled set (the report that carried it has been superseded or its action expired); link dropped, action stands on its own`
      );
      delete out[field];
    }
    return out;
  });

  return { actions: reconciled, notes, warnings };
}

// Union-find over a chosen set of edges, treated as undirected: an edge
// a[field] -> a.id is only added when BOTH endpoints are in `memberIds` and
// `field` is one of `fields`. This lets each rule below draw its own graph
// (e.g. "if_not edges between slotless adds only") without the rule having
// to hand-roll union-find. Returns the `find` function; two ids are in the
// same component iff `find(x) === find(y)`.
function componentsOver(actions, memberIds, fields) {
  const parent = new Map(actions.map((a) => [a.id, a.id]));
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(x, y) {
    if (!parent.has(x) || !parent.has(y)) return;
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  }
  for (const a of actions) {
    for (const field of fields) {
      const val = a[field];
      if (val === undefined) continue;
      if (memberIds.has(a.id) && memberIds.has(val)) union(a.id, val);
    }
  }
  return find;
}

// Union-find over after/if_not edges, treated as undirected, so a chain of
// links (A after B, B if_not C) groups A/B/C together even though A and C
// aren't directly linked. The all-actions/all-fields case of componentsOver.
function groupLinked(actions) {
  const allIds = new Set(actions.map((a) => a.id));
  return componentsOver(actions, allIds, ['after', 'if_not']);
}

// The three conflict rules from docs/ACTIONS.md "Sequencing", run over a
// combined set of finalized actions (compile: the whole compiled set;
// check: the file's own actions plus reports/actions.json's other-source
// actions). Returns { errors, warnings } — errors fail the run, the faab
// warning does not.
async function checkConflictRules(allActions, snapshot, index, baseline, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  // Done and gone actions are history: they hold no player, need no bench
  // slot, and spend no FAAB. Counting them would manufacture conflicts with
  // the live ones.
  const actions = allActions.filter((a) => a.state === undefined || a.state === 'open');

  // Rule 1: two actions that consume the same rostered player are fine as
  // long as they sit in the same after/if_not component — any path of
  // links, not just a direct one. A correctly sequenced fallback chain
  // (a <- b if_not a <- c if_not b, all touching the same player) is not a
  // conflict just because a and c aren't directly linked to each other.
  const find1 = groupLinked(actions);
  const rule1Flagged = new Set();
  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[i], b = actions[j];
      const aC = a.consumes ?? [];
      const bC = b.consumes ?? [];
      if (!aC.length || !bC.length) continue;
      const overlap = aC.filter((id) => bC.includes(id));
      if (!overlap.length) continue;
      if (find1(a.id) === find1(b.id)) continue;
      for (const pid of overlap) {
        rule1Flagged.add(pid);
        const resolved = await resolvePlayer(index, pid);
        const name = resolved?.name ?? pid;
        errors.push(`actions ${a.id} and ${b.id} both use ${name}; link them with after/if_not`);
      }
    }
  }

  // Rule 1a: the same collision one level up — two unlinked actions that give
  // up DIFFERENT players at the same position. Every action's case lines are
  // measured against one baseline on purpose, so that two actions in a
  // compile agree with each other; the cost is that neither can see the
  // other's give. Two trades each shedding a quarterback therefore both
  // reported the four on the roster today, and the card showed two live
  // offers that between them left two. The compiler cannot pick which world
  // is true, so the report has to say: `if_not` for alternatives, `after`
  // for a sequence. Only bites when the combined loss actually reaches the
  // lineup's demand — shedding two of six wide receivers is just depth.
  // Players Rule 1 already named are skipped; the same pair of actions
  // should not fail twice for one mistake.
  //
  // `start` is deliberately never in this set. Its `consumes` carries the
  // incoming player (for Rule 1, above) as well as the benched `for`, but
  // starting a bench player doesn't shed him from the roster — the opposite —
  // so counting a `start` here would falsely read "puts a QB in" as "gives a
  // QB up" and could flag a real, single trade give as a same-position
  // conflict against a start that isn't one.
  const SHEDDING_KINDS = new Set(['trade', 'add', 'drop', 'ir']);
  const shedByPos = new Map(); // pos -> Map(component root -> Set(player ids))
  for (const a of actions) {
    if (!SHEDDING_KINDS.has(a.kind)) continue;
    for (const pid of a.consumes ?? []) {
      if (rule1Flagged.has(pid)) continue;
      const pos = index.byId.get(pid)?.pos;
      if (!pos) continue;
      if (!shedByPos.has(pos)) shedByPos.set(pos, new Map());
      const groups = shedByPos.get(pos);
      const root = find1(a.id);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root).add(pid);
    }
  }
  const shape = baseline?.roster_shape;
  for (const [pos, groups] of shedByPos) {
    if (!shape || groups.size < 2) continue;
    const shed = new Set([...groups.values()].flatMap((s) => [...s]));
    const left = (shape.active_by_position[pos] ?? 0) - shed.size;
    const starts = shape.lineup_demand?.[pos] ?? shape.dedicated_slots?.[pos] ?? 0;
    if (left > starts) continue;
    const ids = actions
      .filter((a) => SHEDDING_KINDS.has(a.kind) && (a.consumes ?? []).some((pid) => shed.has(pid)))
      .map((a) => a.id);
    errors.push(
      `actions ${ids.join(', ')} each give up a ${pos} and are not linked; if all of them land you keep ${left} ${pos} against a lineup that starts ${starts}, but each one's case is measured as if the others never happened — link them with after/if_not`
    );
  }

  // Rule 1b: Rule 1a's mirror image, on the ACQUIRING side — two or more
  // unlinked actions that each bring in a body at the SAME position, where
  // between them they leave the roster well past what the lineup starts
  // there. It is the same blind spot for the same reason: every action's case
  // is measured against one baseline, so none of them can see the others'
  // arrivals, and each one's `need` line reads "you have 3" while together
  // they make it 5.
  //
  // This shipped. On 2026-09-22 the card carried three open actions at once —
  // a $20 waiver claim for a fourth running back, and two trade offers each
  // bringing back a running back — all three arguing the same thin-RB need,
  // none of them aware of the others. Two of them landing would have left six
  // backs behind a lineup that starts three, with the kicker and defense
  // holes that actually break weeks still unaddressed.
  //
  // `if_not` alternatives are one claim, as everywhere else: components are
  // collapsed with the same union-find Rule 1a uses, and a component counts
  // once, at its largest single arrival. Only bites at an overshoot of two or
  // more, so genuinely filling a hole is never flagged — a roster two backs
  // deep behind three starting slots wants two arrivals and gets no warning.
  // `activate` counts as an arrival: bringing a body back off IR raises the
  // active count at that position exactly as an add does, so "activate the
  // running back on IR" plus "claim a running back" is the same double-buy.
  const ARRIVING_KINDS = new Set(['add', 'trade', 'activate']);
  // Each action's NET effect at a position, not its arrivals: an add with a
  // drop at the same position, or a trade sending back what it brings home,
  // is a swap and changes no count. Counting arrivals alone would flag two
  // routines each replacing the kicker with "you carry 3 K" — a number that
  // is simply untrue, and the real conflict there (both consuming a body) is
  // Rule 1's and Rule 1a's to report.
  const netAtPos = (a, pos) => {
    const incoming = a.kind === 'trade' ? (a.get ?? []) : (a.player !== undefined ? [a.player] : []);
    const outgoing = a.kind === 'trade' ? (a.give ?? []) : (a.drop !== undefined ? [a.drop] : []);
    const at = (ids) => ids.filter((pid) => index.byId.get(pid)?.pos === pos).length;
    return at(incoming) - at(outgoing);
  };
  const positionsTouched = new Set();
  for (const a of actions) {
    if (!ARRIVING_KINDS.has(a.kind)) continue;
    const incoming = a.kind === 'trade' ? (a.get ?? []) : (a.player !== undefined ? [a.player] : []);
    for (const pid of incoming) {
      const pos = index.byId.get(pid)?.pos;
      if (pos) positionsTouched.add(pos);
    }
  }
  for (const pos of positionsTouched) {
    if (!shape) break;
    // Within one if_not chain only one alternative can land, so a component
    // contributes its largest net gain, not the sum of its members'.
    const byComponent = new Map(); // component root -> largest net gain
    for (const a of actions) {
      if (!ARRIVING_KINDS.has(a.kind)) continue;
      const net = netAtPos(a, pos);
      if (net <= 0) continue;
      const root = find1(a.id);
      byComponent.set(root, Math.max(byComponent.get(root) ?? 0, net));
    }
    if (byComponent.size < 2) continue;
    const gained = [...byComponent.values()].reduce((t, n) => t + n, 0);
    const have = shape.active_by_position[pos] ?? 0;
    const starts = shape.lineup_demand?.[pos] ?? shape.dedicated_slots?.[pos] ?? 0;
    const after = have + gained;
    if (after - starts < 2) continue;
    const ids = actions.filter((a) => ARRIVING_KINDS.has(a.kind) && netAtPos(a, pos) > 0).map((a) => a.id);
    const msg = `actions ${ids.join(', ')} each bring in a ${pos} and are not linked; if they all land you carry ${after} ${pos} against a lineup that starts ${starts}, but each one's case is measured as if the others never happened — link them with after/if_not, or drop one`;
    if (strict) errors.push(msg); else warnings.push(msg);
  }

  // Rule 2: adds with no drop (needs_slot) must not outnumber the bench
  // slots that will actually be open, and (Rule 2b, below) neither must a
  // trade whose `get` outnumbers its `give` — Sleeper refuses either move
  // when there's nowhere on the roster to put the extra body.
  //
  // Baseline open slots credits this set's own `drop` and `ir` actions
  // (they free a slot) and debits its `activate` actions (they fill one) —
  // trades are NOT credited here, since whether an offer lands is unknown.
  // A slotless add that is `after` a trade instead gets its own
  // conditional "world": follow the after chain to the trade it is waiting
  // on, and check it against an allowance that includes *that* trade's net
  // roster-size effect (give.length - get.length), since if the trade
  // lands, it does change the count. Computed unconditionally (not only
  // when there's a slotless add) because Rule 2b needs the same baseline.
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const bnCount = (snapshot.league.roster_positions ?? []).filter((p) => p === 'BN').length;
  const benchLen = me?.bench.length ?? 0;
  const dropCount = actions.filter((a) => a.kind === 'drop').length;
  const irCount = actions.filter((a) => a.kind === 'ir').length;
  const activateCount = actions.filter((a) => a.kind === 'activate').length;
  const openSlots = bnCount - benchLen + dropCount + irCount - activateCount;

  const creditParts = [];
  if (dropCount) creditParts.push(`+ ${dropCount} drop${dropCount === 1 ? '' : 's'}`);
  if (irCount) creditParts.push(`+ ${irCount} ir`);
  if (activateCount) creditParts.push(`- ${activateCount} activate${activateCount === 1 ? '' : 's'}`);
  const creditStr = creditParts.length ? ` ${creditParts.join(' ')}` : '';

  // Mutual exclusion (adds that cover the same slot) is if_not links
  // between slotless adds themselves — after never merges two adds into
  // one group (both run), and an add if_not a trade doesn't group with
  // another add if_not the same trade (each is its own claim on a slot;
  // if the trade falls through both still want a slot).
  const needsSlotActions = actions.filter((a) => a.kind === 'add' && a.needs_slot);
  if (needsSlotActions.length) {
    const byId = new Map(actions.map((a) => [a.id, a]));
    function worldOf(action) {
      let cur = action;
      const visited = new Set();
      while (cur.after !== undefined) {
        if (visited.has(cur.id)) return null; // cycle guard; shouldn't happen post cycle-check
        visited.add(cur.id);
        const parent = byId.get(cur.after);
        if (!parent) return null; // dangling; treat as unconditional
        if (parent.kind === 'trade') return parent.id;
        cur = parent;
      }
      return null;
    }

    const memberIds = new Set(needsSlotActions.map((a) => a.id));
    const findGroup = componentsOver(actions, memberIds, ['if_not']);

    const worlds = new Map(); // world (null or trade id) -> add ids
    for (const a of needsSlotActions) {
      const w = worldOf(a);
      if (!worlds.has(w)) worlds.set(w, []);
      worlds.get(w).push(a.id);
    }

    for (const [world, ids] of worlds) {
      const groups = new Set(ids.map((id) => findGroup(id)));
      let allowance;
      if (world === null) {
        allowance = openSlots;
      } else {
        const trade = byId.get(world);
        allowance = openSlots + (trade?.give?.length ?? 0) - (trade?.get?.length ?? 0);
      }
      if (groups.size > allowance) {
        if (world === null) {
          errors.push(
            `${ids.length} add(s) needing an open bench slot form ${groups.size} unlinked group(s) (${ids.join(', ')}), but only ${allowance} bench slot(s) are open (${bnCount} BN slot(s) - ${benchLen} on bench${creditStr}); link them with if_not or add a drop`
          );
        } else {
          errors.push(
            `${ids.length} add(s) waiting on ${world} (${ids.join(', ')}) need ${groups.size} bench slot(s) but only ${allowance} would be open if it lands; link them with if_not or add a drop`
          );
        }
      }
    }
  }

  // Rule 2b: a trade whose `get` outnumbers its `give` brings home more
  // bodies than it sends away, and needs that many bench slots open to
  // land — Sleeper refuses a trade the roster has no room for, same as it
  // refuses an overflowing add. Checked against the same `openSlots`
  // baseline as Rule 2, above (a trade is never credited toward it, for the
  // same "landing is unknown" reason Rule 2 isn't credited by other
  // trades). Unlike an add, a single trade can need more than one slot, so
  // this sums surplus rather than counting groups. `if_not`-linked trades
  // are alternatives — only one can land, so the group counts once at its
  // largest surplus — `after`-linked or unlinked trades are not, and each
  // counts in full, the same distinction Rule 2's if_not-only grouping
  // already draws.
  const tradeGetSurplus = (a) => (a.get?.length ?? 0) - (a.give?.length ?? 0);
  const surplusTrades = actions.filter((a) => a.kind === 'trade' && tradeGetSurplus(a) > 0);
  if (surplusTrades.length) {
    const memberIds = new Set(surplusTrades.map((a) => a.id));
    const findGroup = componentsOver(actions, memberIds, ['if_not']);
    const groups = new Map(); // group root -> trade actions
    for (const a of surplusTrades) {
      const g = findGroup(a.id);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    }
    let surplusSum = 0;
    const parts = [];
    for (const group of groups.values()) {
      const top = group.reduce((m, a) => (tradeGetSurplus(a) > tradeGetSurplus(m) ? a : m), group[0]);
      surplusSum += tradeGetSurplus(top);
      parts.push(
        group.length === 1
          ? `${top.id} (+${tradeGetSurplus(top)})`
          : `max of ${group.map((a) => `${a.id} (+${tradeGetSurplus(a)})`).join(' / ')}`
      );
    }
    if (surplusSum > openSlots) {
      errors.push(
        `trade(s) ${parts.join(', ')} would bring home ${surplusSum} more player(s) than they send out, but only ${openSlots} bench slot(s) would be open (${bnCount} BN slot(s) - ${benchLen} on bench${creditStr}); link them with if_not or add a drop`
      );
    }
  }

  // Rule 3: the IR slot has a real capacity. An `ir` action for a full IR is a
  // move Sleeper will refuse, so it is an error — but an `activate` in the same
  // set frees a slot, so the two are netted rather than counted separately.
  const slots = snapshot.league?.reserve_slots;
  if (Number.isInteger(slots)) {
    const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
    const inReserve = me?.reserve.length ?? 0;
    const irs = actions.filter((a) => a.kind === 'ir');
    const activates = actions.filter((a) => a.kind === 'activate');
    const net = inReserve + irs.length - activates.length;
    if (irs.length && net > slots) {
      errors.push(
        `${irs.length} ir action(s) [${irs.map((a) => a.id).join(', ')}] would put ${net} player(s) in ${slots} IR slot(s) (${inReserve} already there, ${activates.length} activate(s) to free one); activate or drop someone first`
      );
    }
  }

  // Rule 4: Sleeper only accepts certain injury designations into the IR slot.
  // A warning, not an error: the league's reserve_allow_* flags don't map
  // one-to-one onto every tag Sleeper shows (a PUP player sits on this IR
  // today), so this flags a likely-refused move without blocking a report.
  const irStatuses = snapshot.league?.ir_eligible_statuses;
  if (Array.isArray(irStatuses) && irStatuses.length) {
    for (const a of actions.filter((x) => x.kind === 'ir')) {
      const status = (await resolvePlayer(index, a.player))?.injury_status ?? null;
      const ok = status && irStatuses.some((s) => s.toLowerCase() === String(status).toLowerCase());
      if (!ok) {
        warnings.push(
          `${a.id}: ${a.name} carries ${status ? `status "${status}"` : 'no injury designation'}, and this league's IR accepts ${irStatuses.join('/')} — Sleeper may refuse the move`
        );
      }
    }
  }

  // Rule 5: projected FAAB spend should not exceed faab_remaining. Waiver
  // adds linked by if_not to each other are alternatives — only the most
  // expensive one in that group can actually be claimed, so the group
  // counts once, at its max bid. after-linked adds are NOT alternatives
  // (both run), so each contributes its own bid. Warning only — Sleeper
  // just skips a claim it can't fund.
  const waiverAdds = actions.filter((a) => a.kind === 'add' && a.mode === 'waiver' && Number.isInteger(a.faab));
  if (waiverAdds.length) {
    const memberIds = new Set(waiverAdds.map((a) => a.id));
    const findGroup = componentsOver(actions, memberIds, ['if_not']);
    const groups = new Map(); // group root -> waiver adds
    for (const a of waiverAdds) {
      const g = findGroup(a.id);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    }
    let faabSum = 0;
    const parts = [];
    for (const group of groups.values()) {
      const top = group.reduce((m, a) => (a.faab > m.faab ? a : m), group[0]);
      faabSum += top.faab;
      parts.push(
        group.length === 1
          ? `${top.id} $${top.faab}`
          : `max of ${group.map((a) => `${a.id} $${a.faab}`).join(' / ')}`
      );
    }
    const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
    const cap = me?.faab_remaining ?? 0;
    if (faabSum > cap) {
      warnings.push(
        `waiver bids could total $${faabSum} (${parts.join(', ')}), more than faab_remaining ($${cap})`
      );
    }
  }

  return { errors, warnings };
}

const describe = (a) =>
  a.kind === 'trade'
    ? `trade with ${a.with_owner ?? a.with} (${(a.give_names ?? []).join(', ')} for ${(a.get_names ?? []).join(', ')})`
    : `${a.kind} ${a.name ?? a.player}${a.for_name ? ` for ${a.for_name}` : ''}${a.drop_name ? ` (drop ${a.drop_name})` : ''}`;


// When a report was actually written, as the dashboard's "next check" line
// needs it. Filenames carry only a date, so on a day all four routines publish
// the page's "freshest report" sort fell through to alphabetical order of the
// type name — waivers always won, and the empty card pointed at "Lineup, Thu
// 7am" on a Saturday. The last commit time is the honest answer for anything
// already on main; a report that isn't committed yet, or has been edited
// since, is the one being written right now, and its mtime says so. Any git
// failure (no repo, no git, a fresh sandbox) falls back to mtime the same
// way — this is a sort key, never a reason to fail the compile.
async function reportWrittenAt(filePath) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', filePath], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!dirty) {
      const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', filePath], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (committed && !Number.isNaN(Date.parse(committed))) return new Date(committed).toISOString();
    }
  } catch { /* not a git checkout, or git missing — mtime below */ }
  return (await stat(filePath)).mtime.toISOString();
}

// ---- compile mode ----

async function compile() {
  const snapshot = await loadSnapshot();
  const index = buildIndex(snapshot);
  // Computed once per run, not per action — every action's "need"/"cost"/
  // "later" is measured against the SAME snapshot of where the roster stands
  // right now, so two actions in the same compile agree with each other.
  const baseline = buildOutlook(snapshot);
  const picks = await pickNewestReports();

  const problems = [];
  const drift = [];
  const sources = {};
  const collected = []; // { action, source, report }

  for (const type of TYPES) {
    const file = picks[type];
    if (!file) continue;
    const filePath = path.join(reportsDir, file);
    const { error, block } = await loadReportBlock(filePath);
    if (error) {
      problems.push(`${rel(filePath)}: ${error}`);
      continue;
    }
    const result = await validateReportBlock(block, snapshot, index, baseline, { lifecycle: true, source: type });
    if (result.problems) {
      problems.push(...result.problems.map((p) => `${rel(filePath)} ${p}`));
      continue;
    }
    for (const w of result.driftWarnings ?? []) drift.push(`${rel(filePath)} ${w}`);
    sources[type] = {
      report: file,
      week: block.week,
      verdict: block.verdict,
      next_check: block.next_check,
      stale: result.stale,
      written_at: await reportWrittenAt(filePath),
    };
    // A stale source (week behind the live snapshot) only expires its `start`
    // actions — everything else stays open until done or superseded.
    for (const action of result.actions) {
      if (result.stale && action.kind === 'start') continue;
      collected.push({ action, source: type, report: file, week: block.week });
    }
  }

  if (problems.length) {
    console.error('actions.mjs: validation failed\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }

  // Dedupe across sources by kind+player; keep the newest report file.
  // Filenames are `YYYY-MM-DD-<type>.md`, so comparing them as strings orders
  // by date correctly — but two different types published on the same date
  // compare by type name instead, which is an accident of alphabetization,
  // not a real recency signal. That can't be resolved from filenames alone,
  // so at least say it happened instead of picking one in silence.
  // Same id rule finalizeAction uses, applied to a pre-finalize collected
  // entry — needed here so a dedupe loser's id can be recorded before it's
  // dropped from byKey.
  const computeId = (entry) => {
    const idKey = entry.action.kind === 'trade' ? entry.action.with : entry.action.player;
    return entry.action.id ?? `${entry.source}:${entry.action.kind}:${idKey}`;
  };

  const remap = new Map(); // loser id -> { winner: winner id, report: winner's report file }
  const byKey = new Map();
  for (const entry of collected) {
    if (entry.action.kind === 'trade') continue; // trades dedupe by partner, below
    const key = `${entry.action.kind}:${entry.action.player}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
    } else if (entry.report !== existing.report) {
      const sameDay = entry.report.slice(0, 10) === existing.report.slice(0, 10);
      const winner = entry.report > existing.report ? entry : existing;
      const loser = winner === entry ? existing : entry;
      if (sameDay) {
        console.error(
          `actions.mjs: warning — same-day duplicate action (${key}) in ${existing.report} and ${entry.report}; keeping ${winner.report} (alphabetical tie-break, not true recency), dropping ${loser.report}`
        );
      }
      remap.set(computeId(loser), { winner: computeId(winner), report: winner.report });
      byKey.set(key, winner);
    }
  }

  // Trades dedupe by PARTNER, not by a single winner-takes-the-key rule, and
  // the two directions are deliberately different: cross-report supersession
  // is a feature (a newer trades report revising or re-sending an offer to
  // roster 8 must still replace an older report's offer to roster 8), but
  // within ONE report every offer to a partner is real and survives — a
  // primary offer plus an if_not fallback, or two genuinely separate
  // offers. The old flat `trade:${with}` key couldn't tell those apart: a
  // second same-report offer to a partner hit neither the "new key" nor the
  // "different report" branch above, so it was silently dropped. Same-report
  // collisions (literal duplicates, or two offers with no distinct id) are
  // now rejected earlier, in validateReportBlock, so every entry reaching
  // this point is already known-distinct within its own report.
  const tradesByPartner = new Map(); // with -> entries[]
  for (const entry of collected) {
    if (entry.action.kind !== 'trade') continue;
    const w = entry.action.with;
    if (!tradesByPartner.has(w)) tradesByPartner.set(w, []);
    tradesByPartner.get(w).push(entry);
  }
  const tradeEntries = [];
  for (const [withId, entries] of tradesByPartner) {
    const maxReport = entries.reduce((m, e) => (e.report > m ? e.report : m), entries[0].report);
    const winners = entries.filter((e) => e.report === maxReport);
    const losers = entries.filter((e) => e.report !== maxReport);
    for (const loser of losers) {
      const sameDay = loser.report.slice(0, 10) === maxReport.slice(0, 10);
      if (sameDay) {
        console.error(
          `actions.mjs: warning — same-day duplicate trade offer to roster ${withId} in ${loser.report} and ${maxReport}; keeping ${maxReport}'s offer(s) (alphabetical tie-break, not true recency), dropping ${loser.report}'s`
        );
      }
      // Only remap when there's exactly one surviving offer to retarget a
      // stale link onto — with more than one, which offer a link "really"
      // meant is a guess this won't make; the link is left to drop instead,
      // the same as any other target no longer in the compiled set (see
      // reconcileLinks below).
      if (winners.length === 1) {
        remap.set(computeId(loser), { winner: computeId(winners[0]), report: winners[0].report });
      }
    }
    tradeEntries.push(...winners);
  }

  const deduped = [...byKey.values(), ...tradeEntries].map((e) => finalizeAction(e.action, e.source, e.report, e.week));

  // A link can point at an id dedupe just removed. Retarget links to a
  // dedupe loser onto the winner that replaced it, then drop (with a
  // warning) any link that still doesn't resolve — see reconcileLinks above
  // and docs/ACTIONS.md "Sequencing". check() does neither of these: there
  // the author is looking at one report and can fix a bad reference by hand,
  // so a dangling link stays a hard error instead of being silently dropped.
  const { actions: finalActions, notes, warnings: linkWarnings } = reconcileLinks(deduped, remap);
  for (const n of notes) console.error(`actions.mjs: note — ${n}`);
  for (const w of linkWarnings) console.error(`actions.mjs: warning — ${w}`);

  // Resolve after/if_not across the full compiled set: dangling refs (any
  // that survived reconcileLinks — there shouldn't be any) and cycles are
  // hard errors, same as any other validation failure.
  const linkResult = resolveLinksAndDetectProblems(finalActions);
  if (linkResult.problems.length) {
    console.error('actions.mjs: validation failed\n' + linkResult.problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }

  // Enforce the conflict rules over the whole compiled set.
  const conflict = await checkConflictRules(finalActions, snapshot, index, baseline);
  if (conflict.errors.length) {
    console.error('actions.mjs: validation failed\n' + conflict.errors.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  for (const w of conflict.warnings) console.error(`actions.mjs: warning — ${w}`);

  const output = {
    compiled_at: new Date().toISOString(),
    season: snapshot.season,
    week: snapshot.week,
    games_have_started: snapshot.games_have_started,
    roster: buildRosterMaterial(snapshot),
    sources,
    actions: finalActions,
  };

  await writeFile(path.join(reportsDir, 'actions.json'), JSON.stringify(output, null, 2));
  const dependentCount = finalActions.filter((a) => a.after !== undefined || a.if_not !== undefined).length;
  const done = finalActions.filter((a) => a.state === 'done');
  const gone = finalActions.filter((a) => a.state === 'gone');
  const stale = finalActions.filter((a) => a.state === 'stale');
  const openCount = finalActions.length - done.length - gone.length - stale.length;
  console.log(
    `wrote reports/actions.json — week ${output.week}, ${openCount} open action(s) (${dependentCount} dependent on another action), sources: ${Object.keys(sources).join(', ') || '(none)'}`
  );
  // Say what has already happened rather than letting it pass in silence: a
  // done action is advice that worked, a gone one is advice overtaken, and a
  // stale one is a start whose own kickoff (or whose week) passed it by.
  for (const a of done) console.log(`  done — ${describe(a)}`);
  for (const a of gone) console.log(`  gone — ${describe(a)} (no longer possible)`);
  for (const a of stale) console.log(`  stale — ${describe(a)} (${a.state_reason ?? 'week behind'})`);
  // Parts of a still-open action that reality has overtaken. Not fatal here —
  // the report was written before the move — but the next run of that routine
  // should rewrite it, so say so every time.
  for (const d of drift) console.error(`actions.mjs: note — ${d}`);
}

// ---- check mode ----

async function check(fileArg) {
  const filePath = path.resolve(process.cwd(), fileArg);
  const snapshot = await loadSnapshot();
  const index = buildIndex(snapshot);
  const baseline = buildOutlook(snapshot);

  const { error, block } = await loadReportBlock(filePath);
  if (error) {
    console.error(`${fileArg}: ${error}`);
    process.exit(1);
  }
  // Inferred from the filename, once we know the file itself is readable —
  // a bad filename is a real problem, but "the file doesn't exist" should
  // say so rather than being masked by "can't tell which routine". The
  // same-report trade-id check inside validateReportBlock needs to know the
  // source's default id prefix before it can tell two same-partner offers
  // apart, same as compile() already does per report, so this still runs
  // before validateReportBlock.
  const source = inferSource(path.basename(filePath));
  if (source === null) {
    console.error(
      `${fileArg}: can't tell which routine this report belongs to — name it <date>-<type>.md or <anything>-<type>.md, where <type> is one of ${TYPES.join(', ')}`
    );
    process.exit(1);
  }
  const result = await validateReportBlock(block, snapshot, index, baseline, { source });

  if (result.actionResults) {
    for (const r of result.actionResults) {
      if (r.ok) {
        const a = r.action;
        const label = a.kind === 'trade' ? `trade with roster ${a.with}` : `${a.kind} ${a.player} (${a.name})`;
        console.log(`  action[${r.index}] OK — ${label}`);
        // So the routine can see what the card will actually say before it
        // publishes — the case is computed here the same way compile() does.
        for (const key of ['starts', 'need', 'cost', 'asks', 'later']) {
          if (a.case?.[key] !== undefined) console.log(`      ${key}: ${a.case[key]}`);
        }
      } else {
        for (const p of r.problems) console.log(`  ${p}`);
      }
    }
    // Some problems are cross-action (e.g. two trade offers to the same
    // partner colliding on id, or an exact give/get restatement) and are
    // never attached to any single action's own `problems` — they land
    // directly in the block-level list below, computed after every action
    // already validated OK on its own. Print those too, or a report could
    // exit non-zero here while every line above says "OK" and nothing says
    // why the run still failed.
    const perActionProblems = new Set(result.actionResults.flatMap((r) => r.problems));
    for (const p of result.problems ?? []) {
      if (!perActionProblems.has(p)) console.log(`  ${p}`);
    }
  } else if (result.problems) {
    // Block-level failures (bad week/verdict/next_check/actions, or a block
    // that isn't even an object) never reach the per-action loop above — say
    // what's wrong instead of just how many things are wrong.
    for (const p of result.problems) console.log(`  ${p}`);
  }

  if (result.problems) {
    console.error(`\n${fileArg}: FAILED (${result.problems.length} problem(s))`);
    process.exit(1);
  }

  // ---- after/if_not: resolve, detect cycles, enforce the conflict rules ----
  // A reference may point at another action in this same file (by the
  // generated id rule, source inferred from the filename) or at any id
  // already in reports/actions.json, so a single-report check can still
  // validate cross-source links. Conflict rules run against actions.json's
  // *other-source* actions only — the source being checked is about to
  // replace whatever it currently holds there.
  const reportName = path.basename(filePath);
  const localActions = result.actions.map((a) => finalizeAction(a, source, reportName, block.week));
  const compiledActions = await loadActionsJson();

  const graphSet = [...localActions, ...compiledActions.filter((a) => !localActions.some((l) => l.id === a.id))];
  const linkResult = resolveLinksAndDetectProblems(graphSet);
  if (linkResult.problems.length) {
    for (const p of linkResult.problems) console.log(`  ${p}`);
    console.error(`\n${fileArg}: FAILED (${linkResult.problems.length} problem(s))`);
    process.exit(1);
  }

  const otherSourceActions = compiledActions.filter((a) => a.source !== source);
  const conflictSet = [...localActions, ...otherSourceActions];
  const conflict = await checkConflictRules(conflictSet, snapshot, index, baseline, { strict: true });
  if (conflict.errors.length) {
    for (const p of conflict.errors) console.log(`  ${p}`);
    console.error(`\n${fileArg}: FAILED (${conflict.errors.length} problem(s))`);
    process.exit(1);
  }
  for (const w of conflict.warnings) console.error(`actions.mjs: warning — ${w}`);
  // Per-action warnings used to be dropped on the floor here. Nothing
  // populated them in strict mode when this path was written — worldFail
  // routes to `problems` under --check — so the omission was invisible until
  // a check gained a warning that is deliberately never fatal (a trade that
  // asks a manager for a starter). A warning a routine cannot see is a
  // warning that does nothing.
  for (const w of result.driftWarnings ?? []) console.error(`actions.mjs: warning — ${w}`);

  const linkCount = localActions.filter((a) => a.after !== undefined || a.if_not !== undefined).length;
  const linkSummary = `, ${linkCount} after/if_not link(s) resolved`;

  if (result.stale) {
    const dropped = result.actions.filter((a) => a.kind === 'start').length;
    const kept = result.actions.length - dropped;
    console.log(
      `\n${fileArg}: OK — week ${block.week} (stale vs snapshot week ${snapshot.week}), ${result.actions.length} action(s) valid${linkSummary}` +
        (dropped ? `; ${dropped} start action(s) would be dropped at compile time, ${kept} other action(s) kept` : ' (none are `start`, so none would be dropped)')
    );
  } else {
    console.log(`\n${fileArg}: OK — week ${block.week}, ${result.actions.length} action(s) valid${linkSummary}`);
  }
}

// ---- entry ----

// Only when run as a command. This file also exports lifecycleState and buildIndex for
// the test suite, and an unguarded entry meant importing it silently ran a full compile —
// which worked in a checkout that happened to have a snapshot and failed in a clean clone.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const [, , mode, arg] = process.argv;
if (!invokedDirectly) {
  // imported: expose the helpers and do nothing else
} else if (mode === '--check') {
  if (!arg) {
    console.error('usage: node scripts/actions.mjs --check <file>');
    process.exit(1);
  }
  await check(arg);
} else if (!mode) {
  await compile();
} else {
  console.error('usage: node scripts/actions.mjs [--check <file>]');
  process.exit(1);
}
