// Build ask/index.html — the "Ask about this card" page Ben publishes to
// claude.ai as an Artifact. It bundles:
//   1. ask/template.html         — markup + client JS (owned by another routine/agent)
//   2. the snapshot + reports/actions.json -> a self-contained data blob
//   3. docs/index.html's do-now renderer   — so the ask page draws the exact
//      same card the dashboard does, not a re-description of it
//   4. scripts/outlook-core.mjs             — so a "what if I add/drop X" question
//      can run the real forward-outlook solver in the page, live
//
// This script never talks to Sleeper and never re-derives a fact the snapshot
// or the compiled actions already settled — it only repackages them for a
// page that has no server behind it.
//
// Usage:
//   node scripts/ask-bundle.mjs           # build ask/index.html
//   node scripts/ask-bundle.mjs --check   # verify the emitted file, no rebuild
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'data', 'league', 'snapshot.json');
const actionsPath = path.join(root, 'reports', 'actions.json');
const templatePath = path.join(root, 'ask', 'template.html');
const outlookCorePath = path.join(root, 'scripts', 'outlook-core.mjs');
const dashboardPath = path.join(root, 'docs', 'index.html');
const outPath = path.join(root, 'ask', 'index.html');

const DATA_BUDGET_BYTES = 45_000;
const MAX_SNAPSHOT_AGE_MS = 3 * 60 * 60 * 1000; // same freshness gate as actions.mjs / outlook.mjs

const die = (msg) => { console.error(msg); process.exit(1); };
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// ---- placeholders ----

const PLACEHOLDERS = ['/*__DATA__*/', '/*__DONOW_PURE__*/', '/*__OUTLOOK_CORE__*/', '__AS_OF__'];

// A minimal template so the bundler is testable before the real one lands.
// Never written over an existing template.html — see the module doc above.
const STAND_IN_TEMPLATE = `<!-- STAND-IN — replaced by the real template -->
<title>Ask the Card (stand-in)</title>
<p>Data as of __AS_OF__.</p>
<script id="data" type="application/json">/*__DATA__*/</script>
<script>/*__OUTLOOK_CORE__*/</script>
<script>/*__DONOW_PURE__*/</script>
`;

// ---- Chicago-local "as of" stamp ----

function chicagoAsOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? 'unknown time');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(d).map((p) => [p.type, p.value])
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

// ---- the do-now renderer, lifted from docs/index.html ----
// Same slice scripts/selftest.mjs uses ("dashboard — dependency resolution"): the first
// <script> block's `const URGENCY =` through `/* ——— end do-now pure ——— */`. That slice
// alone calls `esc`, which is defined earlier in the same script (~line 241) — so both
// come along, in the order they'd run in docs/index.html.
function extractDoNowPure(html) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('docs/index.html: no inline <script> block found');
  const src = scriptMatch[1];

  const escIdx = src.indexOf('const esc = ');
  if (escIdx === -1) throw new Error('docs/index.html: "const esc = " not found');
  const escLineEnd = src.indexOf('\n', escIdx);
  const escLine = src.slice(escIdx, escLineEnd === -1 ? undefined : escLineEnd);

  const from = src.indexOf('const URGENCY =');
  const to = src.indexOf('/* ——— end do-now pure ——— */');
  if (from === -1) throw new Error('docs/index.html: "const URGENCY =" not found');
  if (to === -1) throw new Error('docs/index.html: end-of-do-now-pure marker not found');
  const region = src.slice(from, to);

  return `${escLine}\n${region}`;
}

// ---- outlook-core, inlined ----
// Strip only the leading "export " off each declaration so the same object/function bodies
// run in the page. scripts/outlook.mjs re-exports these unchanged, so this text is identical
// to what scripts/actions.mjs and scripts/selftest.mjs already import and trust.
function inlineOutlookCore(src) {
  return src.replace(/^export /gm, '');
}

// ---- data assembly ----

const compactPlayer = (p) => p && ({
  id: p.id, name: p.name, pos: p.position, team: p.team, bye: p.bye_week, status: p.injury_status ?? null,
});

function buildStarters(rosterPositions, starters) {
  const slotNames = (rosterPositions ?? []).filter((s) => s !== 'BN');
  return slotNames.map((slot, i) => {
    const p = starters[i];
    return p ? { slot, ...compactPlayer(p) } : { slot, empty: true };
  });
}

function buildTeams(snapshot) {
  return snapshot.teams.map((t) => {
    const starterIds = new Set((t.starters ?? []).filter(Boolean).map((p) => p.id));
    const reserveIds = new Set((t.reserve ?? []).filter(Boolean).map((p) => p.id));
    const all = [...(t.starters ?? []), ...(t.bench ?? []), ...(t.reserve ?? [])].filter(Boolean);
    return {
      roster_id: t.roster_id,
      owner: t.owner,
      faab_remaining: t.faab_remaining,
      players: all.map((p) => ({
        ...compactPlayer(p),
        starting: starterIds.has(p.id),
        ir: reserveIds.has(p.id),
      })),
    };
  });
}

function buildAvailable(snapshot, perPosition) {
  const out = {};
  for (const [pos, list] of Object.entries(snapshot.available ?? {})) {
    out[pos] = list.slice(0, perPosition).map(compactPlayer);
  }
  return out;
}

function buildTrending(snapshot, count) {
  return (snapshot.trending?.adds ?? []).slice(0, count).map((p) => ({
    id: p.id, name: p.name, pos: p.position, team: p.team,
    adds: p.add_count, drops: p.drop_count, net: p.net_adds,
    rostered_in_league: p.rostered_in_league,
  }));
}

function buildOutlookSection(outlook) {
  // downgraded_slots (the QB-in-SUPER_FLEX case) has to keep a week in this list on its
  // own, same as empty_slots — outlook-core.mjs's own crunch_weeks filter already counts
  // a downgraded-only week as a crunch week, so dropping it here left the Ask page naming
  // a week as a crunch week with nothing in `weeks` to say why.
  const weeks = (outlook.weeks ?? []).filter(
    (w) => (w.byes?.length ?? 0) || (w.empty_slots?.length ?? 0) || (w.empty_slots_if_injured_stay_out?.length ?? 0) || (w.downgraded_slots?.length ?? 0)
  );
  return {
    roster_shape: outlook.roster_shape,
    crunch_weeks: outlook.crunch_weeks,
    playoff_weeks: outlook.playoff_weeks,
    weeks_until_trade_deadline: outlook.weeks_until_trade_deadline,
    trade_deadline_week: outlook.trade_deadline_week,
    weeks,
  };
}

function buildLeague(league) {
  const scoring = {};
  for (const k of ['pass_td', 'rec', 'rush_td', 'rec_td']) {
    if (typeof league.scoring?.[k] === 'number') scoring[k] = league.scoring[k];
  }
  return {
    name: league.name,
    roster_positions: league.roster_positions,
    reserve_slots: league.reserve_slots,
    ir_eligible_statuses: league.ir_eligible_statuses,
    waiver_budget: league.waiver_budget,
    trade_deadline: league.trade_deadline,
    playoff_week_start: league.playoff_week_start,
    max_keepers: league.max_keepers,
    league_average_match: league.median_matchup,
    scoring,
  };
}

// Exactly what outlook-core.mjs's buildOutlook needs to solve a what-if IN the page: my own
// roster (raw player objects, nulls kept in slot position) plus every unrostered player named
// anywhere in the (possibly trimmed) available/trending sections, so a name Ben asks about
// resolves to a real id instead of "I can't see that from here."
function buildSnapshotLite(snapshot, availableOut, trendingOut) {
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
  const rawPlayer = (compact) => compact && {
    id: compact.id, name: compact.name, position: compact.pos ?? compact.position,
    team: compact.team, bye_week: compact.bye ?? compact.bye_week, injury_status: compact.status ?? compact.injury_status ?? null,
  };
  // The trending section is trimmed for display — buildTrending drops bye_week and
  // injury_status — so a player who appears in both lists keeps his richer available-list
  // record, and a trending-only player gets his bye/injury back off the raw snapshot entry.
  // Without this, adding a popular free agent hid his own bye week from the solver.
  const trendingRaw = new Map((snapshot.trending?.adds ?? []).map((p) => [p.id, p]));
  const pool = new Map();
  for (const list of Object.values(availableOut)) for (const p of list) pool.set(p.id, rawPlayer(p));
  for (const p of trendingOut) {
    if (pool.has(p.id)) continue;
    const full = trendingRaw.get(p.id);
    pool.set(p.id, rawPlayer(full ? { ...full, pos: full.position } : p));
  }
  return {
    week: snapshot.week,
    my_roster_id: snapshot.my_roster_id,
    league: {
      roster_positions: snapshot.league.roster_positions,
      reserve_slots: snapshot.league.reserve_slots,
      playoff_week_start: snapshot.league.playoff_week_start,
      trade_deadline: snapshot.league.trade_deadline,
    },
    teams: [{
      roster_id: me.roster_id,
      starters: me.starters ?? [],
      bench: me.bench ?? [],
      reserve: me.reserve ?? [],
    }],
    pool: [...pool.values()],
  };
}

function buildData(snapshot, actions) {
  const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);

  // Two knobs the size guard turns, in the order docs/ask-bundle.mjs's contract names them:
  // available first (8/pos, then 5/pos), then trending (15, then progressively fewer).
  let availablePerPos = 8;
  let trendingCount = 15;

  const assemble = () => {
    const availableOut = buildAvailable(snapshot, availablePerPos);
    const trendingOut = buildTrending(snapshot, trendingCount);
    return {
      as_of: snapshot.fetched_at,
      week: snapshot.week,
      season: snapshot.season,
      games_have_started: snapshot.games_have_started,
      dashboard_url: 'https://the-nebulizer.github.io/gridiron/',
      me: {
        roster_id: me.roster_id,
        owner: me.owner,
        faab_remaining: me.faab_remaining,
        starters: buildStarters(snapshot.league.roster_positions, me.starters ?? []),
        bench: (me.bench ?? []).map(compactPlayer),
        reserve: (me.reserve ?? []).map(compactPlayer),
      },
      teams: buildTeams(snapshot),
      available: availableOut,
      trending: trendingOut,
      outlook: buildOutlookSection(snapshot.outlook),
      league: buildLeague(snapshot.league),
      faab: snapshot.teams.map((t) => ({ owner: t.owner, remaining: t.faab_remaining })),
      card: { sources: actions.sources, actions: actions.actions },
      snapshot_lite: buildSnapshotLite(snapshot, availableOut, trendingOut),
    };
  };

  let data = assemble();
  let size = bytesOf(JSON.stringify(data));

  // Step 1: available down to 5/position.
  if (size > DATA_BUDGET_BYTES && availablePerPos > 5) {
    availablePerPos = 5;
    data = assemble();
    size = bytesOf(JSON.stringify(data));
  }
  // Step 2: trending shrinks in steps until it fits or runs out.
  while (size > DATA_BUDGET_BYTES && trendingCount > 0) {
    trendingCount = trendingCount > 6 ? Math.ceil(trendingCount / 2) : 0;
    data = assemble();
    size = bytesOf(JSON.stringify(data));
  }
  if (size > DATA_BUDGET_BYTES) {
    die(
      `ask-bundle: data is ${size} bytes even with available trimmed to 5/position and trending dropped ` +
      `— something else in the bundle (rosters, the card's actions) is too big. Not writing ask/index.html.`
    );
  }

  return data;
}

// ---- build ----

async function build() {
  if (!(await exists(snapshotPath))) {
    die('ask-bundle: no snapshot at data/league/snapshot.json. Run `node scripts/sync.mjs` first.');
  }
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const ageMs = Date.now() - new Date(snapshot.fetched_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > MAX_SNAPSHOT_AGE_MS) {
    die(`ask-bundle: snapshot is stale (fetched_at ${snapshot.fetched_at}). Run \`node scripts/sync.mjs\` first.`);
  }

  if (!(await exists(actionsPath))) {
    die('ask-bundle: no reports/actions.json. Run `node scripts/actions.mjs` first.');
  }
  const actions = JSON.parse(await readFile(actionsPath, 'utf8'));

  let template;
  let usedStandIn = false;
  if (await exists(templatePath)) {
    template = await readFile(templatePath, 'utf8');
  } else {
    template = STAND_IN_TEMPLATE;
    usedStandIn = true;
  }
  for (const ph of PLACEHOLDERS) {
    if (!template.includes(ph)) {
      die(`ask-bundle: template is missing placeholder ${ph}${usedStandIn ? ' (in the stand-in template!)' : ' — ask/template.html needs it'}.`);
    }
  }

  const dashboardHtml = await readFile(dashboardPath, 'utf8');
  const doNowPure = extractDoNowPure(dashboardHtml);

  const outlookCoreSrc = inlineOutlookCore(await readFile(outlookCorePath, 'utf8'));

  const data = buildData(snapshot, actions);
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  for (const [label, src] of [['do-now renderer', doNowPure], ['outlook core', outlookCoreSrc]]) {
    if (/<\/script/i.test(src)) die(`ask-bundle: ${label} contains a literal "</script" — refusing to inline it unescaped.`);
  }

  const asOf = chicagoAsOf(snapshot.fetched_at);

  let html = template;
  html = html.replaceAll('/*__DATA__*/', dataJson);
  html = html.replaceAll('/*__DONOW_PURE__*/', doNowPure);
  html = html.replaceAll('/*__OUTLOOK_CORE__*/', outlookCoreSrc);
  html = html.replaceAll('__AS_OF__', asOf);

  await writeFile(outPath, html);

  const totalBytes = bytesOf(html);
  const dataBytes = bytesOf(dataJson);
  console.log(`wrote ask/index.html — ${totalBytes} bytes, data ${dataBytes} bytes, as of ${asOf}`);
  if (usedStandIn) {
    console.log('NOTE: ask/template.html did not exist — built against the bundler\'s own stand-in template.');
  }
}

// ---- --check ----
// Re-reads the emitted file and re-verifies the four things a build must have gotten right,
// without touching Sleeper, the snapshot, or the template. For CI / a pre-publish gate.

async function check() {
  if (!(await exists(outPath))) die('ask-bundle --check: ask/index.html does not exist. Run `node scripts/ask-bundle.mjs` first.');
  const html = await readFile(outPath, 'utf8');

  const dataMatch = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!dataMatch) die('ask-bundle --check: no <script id="data"> block found.');
  let parsed;
  try {
    parsed = JSON.parse(dataMatch[1]);
  } catch (e) {
    die(`ask-bundle --check: the data block does not parse as JSON: ${e.message}`);
  }
  const dataBytes = bytesOf(dataMatch[1]);
  if (dataBytes >= DATA_BUDGET_BYTES) {
    die(`ask-bundle --check: data block is ${dataBytes} bytes, at or over the ${DATA_BUDGET_BYTES}-byte cap.`);
  }

  const requiredSnippets = [
    ['do-now renderer', 'function renderDoNow'],
    ['do-now renderer', 'function resolveDependencies'],
    ['outlook core', 'function buildOutlook'],
    ['outlook core', 'SLOT_ELIGIBILITY'],
  ];
  for (const [label, needle] of requiredSnippets) {
    if (!html.includes(needle)) die(`ask-bundle --check: ${label} region missing — no "${needle}" in ask/index.html.`);
  }

  console.log(`ask-bundle --check: OK — data ${dataBytes} bytes, week ${parsed.week}, ${parsed.card?.actions?.length ?? 0} action(s).`);
}

// ---- entry ----

const args = process.argv.slice(2);
if (args.includes('--check')) {
  await check();
} else {
  await build();
}
