// Validate report "actions" blocks against a fresh snapshot and compile
// reports/actions.json — the data source for the dashboard's "Do now" card.
// See docs/ACTIONS.md for the full contract.
//
// `week` is required on every block but is never checked for equality against
// snapshot.week and is never a hard error by itself — a source is marked
// `stale: true` when its week is behind the live snapshot week (informational
// only). Staleness only drops `start` actions at compile time; every other
// kind stays open. Every compiled action carries its source's `week`.
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
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { SLOT_ELIGIBILITY } from './outlook.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(root, 'reports');

const TYPES = ['waivers', 'lineup', 'trades', 'inactives'];
const KINDS = ['add', 'drop', 'start', 'ir', 'activate', 'trade'];
const URGENCIES = ['now', 'before_kickoff', 'by_tuesday', 'this_week', 'optional'];
const ADD_MODES = ['fcfs', 'waiver'];
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const rel = (p) => path.relative(root, p);

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

// ---- lifecycle: has the world already moved past this action? ----

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
      return mine.has(p) ? 'open' : 'gone';
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
  const { state = 'open', strict = true, warnings = [] } = opts;
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
        }
        if (getOk) {
          out.get = get;
          out.get_names = getNames;
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
  // (drop's own player, add's drop if any, trade's give, for's benched
  // starter, ir/activate's subject). Empty array when none. `add` also
  // flags needs_slot when it has no drop, since it will occupy an open
  // bench spot rather than replace someone.
  if (kind === 'drop') {
    out.consumes = out.player !== undefined ? [out.player] : [];
  } else if (kind === 'add') {
    out.consumes = out.drop !== undefined ? [out.drop] : [];
    if (out.drop === undefined) out.needs_slot = true;
  } else if (kind === 'start') {
    out.consumes = out.for !== undefined ? [out.for] : [];
  } else if (kind === 'ir' || kind === 'activate') {
    out.consumes = out.player !== undefined ? [out.player] : [];
  } else if (kind === 'trade') {
    out.consumes = out.give !== undefined ? [...out.give] : [];
  } else {
    out.consumes = [];
  }

  return bad ? null : out;
}

// ---- top-level block validation ----

async function validateReportBlock(block, snapshot, index, { lifecycle = false } = {}) {
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
    });
    if (built && state !== 'open') {
      built.state = state;
      // A finished or impossible action consumes nothing and needs no bench
      // slot, so it must not trip the sequencing rules against live actions.
      built.consumes = [];
      delete built.needs_slot;
    }
    actionResults.push({ index: i, ok: localProblems.length === 0, problems: localProblems, action: built });
    problems.push(...localProblems);
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
  out.consumes = action.consumes ?? [];
  if (action.needs_slot) out.needs_slot = true;
  out.urgency = action.urgency;
  if (action.deadline_label !== undefined) out.deadline_label = action.deadline_label;
  out.why = action.why;
  return out;
}

// ---- sequencing: after/if_not resolution, cycle detection, conflict rules ----

// Infer the source type from a report's filename, per the `-<type>.md`
// suffix rule. Falls back to whatever follows the last "-" (or the whole
// basename) for files that don't follow the YYYY-MM-DD-<type>.md convention,
// so a check against an ad-hoc file still gets a stable, self-consistent
// source string for generating same-file ids.
function inferSource(basename) {
  const m = basename.match(/^\d{4}-\d{2}-\d{2}-([a-zA-Z0-9_]+)\.md$/);
  if (m) return m[1];
  const m2 = basename.match(/-([a-zA-Z0-9_]+)\.md$/);
  if (m2) return m2[1];
  return basename.replace(/\.md$/, '');
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

// Two actions are "linked" for the conflict rules when one directly points
// at the other via after or if_not (either direction, either field).
function directlyLinked(a, b) {
  return a.after === b.id || a.if_not === b.id || b.after === a.id || b.if_not === a.id;
}

// Union-find over after/if_not edges, treated as undirected, so a chain of
// links (A after B, B if_not C) groups A/B/C together even though A and C
// aren't directly linked. Used only for the bench-slot rule, where the
// contract explicitly counts transitive links.
function groupLinked(actions) {
  const parent = new Map(actions.map((a) => [a.id, a.id]));
  const ids = new Set(parent.keys());
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(x, y) {
    if (!ids.has(x) || !ids.has(y)) return;
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  }
  for (const a of actions) {
    if (a.after !== undefined) union(a.id, a.after);
    if (a.if_not !== undefined) union(a.id, a.if_not);
  }
  return find;
}

// The three conflict rules from docs/ACTIONS.md "Sequencing", run over a
// combined set of finalized actions (compile: the whole compiled set;
// check: the file's own actions plus reports/actions.json's other-source
// actions). Returns { errors, warnings } — errors fail the run, the faab
// warning does not.
async function checkConflictRules(allActions, snapshot, index) {
  const errors = [];
  const warnings = [];
  // Done and gone actions are history: they hold no player, need no bench
  // slot, and spend no FAAB. Counting them would manufacture conflicts with
  // the live ones.
  const actions = allActions.filter((a) => a.state === undefined || a.state === 'open');

  // Rule 1: two actions that consume the same rostered player must be
  // directly linked.
  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[i], b = actions[j];
      const aC = a.consumes ?? [];
      const bC = b.consumes ?? [];
      if (!aC.length || !bC.length) continue;
      const overlap = aC.filter((id) => bC.includes(id));
      if (!overlap.length) continue;
      if (directlyLinked(a, b)) continue;
      for (const pid of overlap) {
        const resolved = await resolvePlayer(index, pid);
        const name = resolved?.name ?? pid;
        errors.push(`actions ${a.id} and ${b.id} both use ${name}; link them with after/if_not`);
      }
    }
  }

  // Rule 2: adds with no drop (needs_slot) that aren't linked (transitively)
  // to each other must not exceed the open bench slots.
  const needsSlotActions = actions.filter((a) => a.kind === 'add' && a.needs_slot);
  if (needsSlotActions.length) {
    const find = groupLinked(actions);
    const groups = new Set(needsSlotActions.map((a) => find(a.id)));
    const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
    const bnCount = (snapshot.league.roster_positions ?? []).filter((p) => p === 'BN').length;
    const benchLen = me?.bench.length ?? 0;
    const openSlots = bnCount - benchLen;
    if (groups.size > openSlots) {
      errors.push(
        `${needsSlotActions.length} add(s) needing an open bench slot form ${groups.size} unlinked group(s) (${needsSlotActions.map((a) => a.id).join(', ')}), but only ${openSlots} bench slot(s) are open (${bnCount} BN slot(s) - ${benchLen} on bench); link them with after/if_not or add a drop`
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

  // Rule 5: the faab of adds not directly linked to another add should not
  // exceed faab_remaining. Warning only — Sleeper just skips an unfunded claim.
  const waiverAdds = actions.filter((a) => a.kind === 'add' && a.mode === 'waiver' && Number.isInteger(a.faab));
  const unlinkedAdds = waiverAdds.filter((a) => !waiverAdds.some((b) => b.id !== a.id && directlyLinked(a, b)));
  const faabSum = unlinkedAdds.reduce((s, a) => s + a.faab, 0);
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const cap = me?.faab_remaining ?? 0;
  if (unlinkedAdds.length && faabSum > cap) {
    warnings.push(
      `unlinked waiver add(s) [${unlinkedAdds.map((a) => `${a.id} $${a.faab}`).join(', ')}] total $${faabSum}, more than faab_remaining ($${cap})`
    );
  }

  return { errors, warnings };
}

const describe = (a) =>
  a.kind === 'trade'
    ? `trade with ${a.with_owner ?? a.with} (${(a.give_names ?? []).join(', ')} for ${(a.get_names ?? []).join(', ')})`
    : `${a.kind} ${a.name ?? a.player}${a.for_name ? ` for ${a.for_name}` : ''}${a.drop_name ? ` (drop ${a.drop_name})` : ''}`;

// ---- compile mode ----

async function compile() {
  const snapshot = await loadSnapshot();
  const index = buildIndex(snapshot);
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
    const result = await validateReportBlock(block, snapshot, index, { lifecycle: true });
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

  // Dedupe across sources by kind+player (kind+with for trade); keep the newest report file.
  // Filenames are `YYYY-MM-DD-<type>.md`, so comparing them as strings orders
  // by date correctly — but two different types published on the same date
  // compare by type name instead, which is an accident of alphabetization,
  // not a real recency signal. That can't be resolved from filenames alone,
  // so at least say it happened instead of picking one in silence.
  const byKey = new Map();
  for (const entry of collected) {
    const key = entry.action.kind === 'trade' ? `trade:${entry.action.with}` : `${entry.action.kind}:${entry.action.player}`;
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
      byKey.set(key, winner);
    }
  }
  const finalActions = [...byKey.values()].map((e) => finalizeAction(e.action, e.source, e.report, e.week));

  // Resolve after/if_not across the full compiled set: dangling refs and
  // cycles are hard errors, same as any other validation failure.
  const linkResult = resolveLinksAndDetectProblems(finalActions);
  if (linkResult.problems.length) {
    console.error('actions.mjs: validation failed\n' + linkResult.problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }

  // Enforce the conflict rules over the whole compiled set.
  const conflict = await checkConflictRules(finalActions, snapshot, index);
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
  const openCount = finalActions.length - done.length - gone.length;
  console.log(
    `wrote reports/actions.json — week ${output.week}, ${openCount} open action(s) (${dependentCount} dependent on another action), sources: ${Object.keys(sources).join(', ') || '(none)'}`
  );
  // Say what has already happened rather than letting it pass in silence: a
  // done action is advice that worked, a gone one is advice overtaken.
  for (const a of done) console.log(`  done — ${describe(a)}`);
  for (const a of gone) console.log(`  gone — ${describe(a)} (no longer possible)`);
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

  const { error, block } = await loadReportBlock(filePath);
  if (error) {
    console.error(`${fileArg}: ${error}`);
    process.exit(1);
  }
  const result = await validateReportBlock(block, snapshot, index);

  if (result.actionResults) {
    for (const r of result.actionResults) {
      if (r.ok) {
        const a = r.action;
        const label = a.kind === 'trade' ? `trade with roster ${a.with}` : `${a.kind} ${a.player} (${a.name})`;
        console.log(`  action[${r.index}] OK — ${label}`);
      } else {
        for (const p of r.problems) console.log(`  ${p}`);
      }
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
  const source = inferSource(path.basename(filePath));
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
  const conflict = await checkConflictRules(conflictSet, snapshot, index);
  if (conflict.errors.length) {
    for (const p of conflict.errors) console.log(`  ${p}`);
    console.error(`\n${fileArg}: FAILED (${conflict.errors.length} problem(s))`);
    process.exit(1);
  }
  for (const w of conflict.warnings) console.error(`actions.mjs: warning — ${w}`);

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

const [, , mode, arg] = process.argv;
if (mode === '--check') {
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
