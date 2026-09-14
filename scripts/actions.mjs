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
// Usage:
//   node scripts/actions.mjs                 # validate newest report per type, write reports/actions.json
//   node scripts/actions.mjs --check <file>  # validate one report only, no write
import { readFile, writeFile, readdir } from 'node:fs/promises';
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

function buildIndex(snapshot) {
  const byId = new Map(); // id -> { name, pos, team }
  const ownerOf = new Map(); // id -> roster_id
  const teamIds = new Map(); // roster_id -> Set(all ids on that roster)
  const teamStarterIds = new Map();
  const teamReserveIds = new Map();
  const ownerName = new Map(); // roster_id -> owner display name

  const remember = (p) => {
    if (!p || p.id == null) return;
    if (!byId.has(p.id)) {
      byId.set(p.id, { name: p.name, pos: p.position ?? null, team: p.team ?? null });
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
  const raw = await readFile(filePath, 'utf8');
  const match = raw.match(/```actions[ \t]*\r?\n([\s\S]*?)\r?\n```/);
  if (!match) return { error: 'no fenced ```actions``` block found' };
  try {
    return { block: JSON.parse(match[1]) };
  } catch (e) {
    return { error: `invalid JSON in actions block: ${e.message}` };
  }
}

// ---- per-action validation + build ----

async function validateAndBuildAction(action, i, snapshot, index, problems) {
  const push = (msg) => problems.push(`action[${i}]: ${msg}`);

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
        push(`(add) player ${player} (${resolved.name}) is already rostered by ${oName} (roster ${owner}) — not a free agent`);
        bad = true;
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
        } else if (!myIds.has(action.drop)) {
          push(`(add) drop id "${action.drop}" is not on my roster`);
          bad = true;
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
          if (!Number.isInteger(action.faab) || action.faab < 0 || action.faab > cap) {
            push(`(add) faab must be an integer between 0 and my faab_remaining (${cap}), got ${JSON.stringify(action.faab)}`);
            bad = true;
          } else {
            out.faab = action.faab;
          }
        }
      }
    }

    if (kind === 'drop' && !myIds.has(player)) {
      push(`(drop) player ${player} (${resolved.name}) is not on my roster`);
      bad = true;
    }

    if (kind === 'start') {
      if (!myIds.has(player)) {
        push(`(start) player ${player} (${resolved.name}) is not on my roster`);
        bad = true;
      }
      const nonBnSlots = (snapshot.league.roster_positions ?? []).filter((p) => p !== 'BN');
      if (!isNonEmptyString(action.slot) || !nonBnSlots.includes(action.slot)) {
        push(`(start) slot must be one of ${[...new Set(nonBnSlots)].join(', ')} (got ${JSON.stringify(action.slot)})`);
        bad = true;
      } else {
        out.slot = action.slot;
      }
      if (action.for !== undefined) {
        if (!isNonEmptyString(action.for)) {
          push('(start) for must be a player id string');
          bad = true;
        } else if (!myStarters.has(action.for)) {
          push(`(start) for id "${action.for}" is not currently in my starters`);
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
        }
      }
    }

    if (kind === 'ir') {
      if (!myIds.has(player)) {
        push(`(ir) player ${player} (${resolved.name}) is not on my roster`);
        bad = true;
      } else if (myReserve.has(player)) {
        push(`(ir) player ${player} (${resolved.name}) is already in reserve`);
        bad = true;
      }
    }

    if (kind === 'activate' && !myReserve.has(player)) {
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
          if (!myIds.has(gid)) {
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
          if (!withIds.has(gid)) {
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

  return bad ? null : out;
}

// ---- top-level block validation ----

async function validateReportBlock(block, snapshot, index) {
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
    const built = await validateAndBuildAction(block.actions[i], i, snapshot, index, localProblems);
    actionResults.push({ index: i, ok: localProblems.length === 0, problems: localProblems, action: built });
    problems.push(...localProblems);
  }

  if (problems.length) return { problems, actionResults };
  return { block, stale, actions: actionResults.map((r) => r.action), actionResults };
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
  out.urgency = action.urgency;
  if (action.deadline_label !== undefined) out.deadline_label = action.deadline_label;
  out.why = action.why;
  return out;
}

// ---- compile mode ----

async function compile() {
  const snapshot = await loadSnapshot();
  const index = buildIndex(snapshot);
  const picks = await pickNewestReports();

  const problems = [];
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
    const result = await validateReportBlock(block, snapshot, index);
    if (result.problems) {
      problems.push(...result.problems.map((p) => `${rel(filePath)} ${p}`));
      continue;
    }
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
  const byKey = new Map();
  for (const entry of collected) {
    const key = entry.action.kind === 'trade' ? `trade:${entry.action.with}` : `${entry.action.kind}:${entry.action.player}`;
    const existing = byKey.get(key);
    if (!existing || entry.report > existing.report) byKey.set(key, entry);
  }
  const finalActions = [...byKey.values()].map((e) => finalizeAction(e.action, e.source, e.report, e.week));

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
  console.log(
    `wrote reports/actions.json — week ${output.week}, ${finalActions.length} action(s), sources: ${Object.keys(sources).join(', ') || '(none)'}`
  );
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
  }

  if (result.problems) {
    console.error(`\n${fileArg}: FAILED (${result.problems.length} problem(s))`);
    process.exit(1);
  }

  if (result.stale) {
    const dropped = result.actions.filter((a) => a.kind === 'start').length;
    const kept = result.actions.length - dropped;
    console.log(
      `\n${fileArg}: OK — week ${block.week} (stale vs snapshot week ${snapshot.week}), ${result.actions.length} action(s) valid` +
        (dropped ? `; ${dropped} start action(s) would be dropped at compile time, ${kept} other action(s) kept` : ' (none are `start`, so none would be dropped)')
    );
  } else {
    console.log(`\n${fileArg}: OK — week ${block.week}, ${result.actions.length} action(s) valid`);
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
