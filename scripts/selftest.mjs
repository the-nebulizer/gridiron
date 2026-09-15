// Offline regression suite for the parts that decide what Ben is told to do.
//
// Every case here is a bug that actually shipped, or a rule whose failure
// would be silent. It runs against synthetic fixtures — no network, no live
// league — so it can run before a commit and mean something.
//
// Usage: npm test   (node scripts/selftest.mjs [-v])
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildOutlook, SLOT_ELIGIBILITY } from './outlook.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('-v');

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    if (verbose) console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? `\n       ${detail.split('\n').join('\n       ')}` : ''}`);
    console.log(`  FAIL ${name}`);
  }
}

// ---- fixtures -------------------------------------------------------------

const P = {
  // mine
  qb1: { id: 'qb1', name: 'Quinn One', position: 'QB', team: 'AAA', bye_week: 13, injury_status: null },
  qb2: { id: 'qb2', name: 'Quinn Two', position: 'QB', team: 'BBB', bye_week: 6, injury_status: null },
  qb3: { id: 'qb3', name: 'Quinn Three', position: 'QB', team: 'CCC', bye_week: 13, injury_status: null },
  rb1: { id: 'rb1', name: 'Rush One', position: 'RB', team: 'DDD', bye_week: 9, injury_status: null },
  rb2: { id: 'rb2', name: 'Rush Two', position: 'RB', team: 'EEE', bye_week: 10, injury_status: null },
  rb3: { id: 'rb3', name: 'Rush Three', position: 'RB', team: 'FFF', bye_week: 7, injury_status: 'PUP' },
  wr1: { id: 'wr1', name: 'Wide One', position: 'WR', team: 'GGG', bye_week: 5, injury_status: null },
  wr2: { id: 'wr2', name: 'Wide Two', position: 'WR', team: 'HHH', bye_week: 7, injury_status: null },
  wr3: { id: 'wr3', name: 'Wide Three', position: 'WR', team: 'III', bye_week: 11, injury_status: null },
  te1: { id: 'te1', name: 'Tight One', position: 'TE', team: 'JJJ', bye_week: 11, injury_status: null },
  k1: { id: 'k1', name: 'Kick One', position: 'K', team: 'KKK', bye_week: 7, injury_status: null },
  df1: { id: 'df1', name: 'Def One', position: 'DEF', team: 'LLL', bye_week: 7, injury_status: null },
  // theirs
  opp1: { id: 'opp1', name: 'Other One', position: 'RB', team: 'MMM', bye_week: 8, injury_status: null },
  opp2: { id: 'opp2', name: 'Other Two', position: 'WR', team: 'NNN', bye_week: 8, injury_status: null },
  // free agents
  fa1: { id: 'fa1', name: 'Free One', position: 'TE', team: 'OOO', bye_week: 6, injury_status: null },
  fa2: { id: 'fa2', name: 'Free Two', position: 'K', team: 'PPP', bye_week: 9, injury_status: null },
  // bench depth for the outlook fixture, on byes that collide with nothing
  // interesting — without it every single bye reads as an empty FLEX.
  rb4: { id: 'rb4', name: 'Rush Four', position: 'RB', team: 'QQQ', bye_week: 8, injury_status: null },
  rb5: { id: 'rb5', name: 'Rush Five', position: 'RB', team: 'RRR', bye_week: 14, injury_status: null },
  wr4: { id: 'wr4', name: 'Wide Four', position: 'WR', team: 'SSS', bye_week: 12, injury_status: null },
};

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF'];

// starters are positional: index i is SLOTS[i].
function fixture(overrides = {}) {
  const snap = {
    fetched_at: new Date().toISOString(),
    season: '2026',
    week: 2,
    games_have_started: true,
    league: {
      roster_positions: [...SLOTS, 'BN', 'BN', 'BN', 'BN', 'BN'],
      reserve_slots: 1,
      ir_eligible_statuses: ['Out'],
      waiver_budget: 100,
      trade_deadline: 11,
      playoff_week_start: 15,
    },
    my_roster_id: 1,
    teams: [
      {
        roster_id: 1,
        owner: 'Me',
        faab_remaining: 100,
        starters: [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1],
        bench: [P.qb3],
        reserve: [P.rb3],
      },
      { roster_id: 2, owner: 'Them', faab_remaining: 100, starters: [P.opp1, P.opp2], bench: [], reserve: [] },
    ],
    transactions: [],
    trending: { adds: [{ ...P.fa1, add_count: 1, net_adds: 1, rostered_in_league: false }, { ...P.fa2, add_count: 1, net_adds: 1, rostered_in_league: false }], drops: [] },
    available: {},
  };
  return { ...snap, ...overrides };
}

const block = (actions, extra = {}) =>
  '# Fixture report\n\n```actions\n' +
  JSON.stringify({ week: 2, verdict: 'Fixture.', next_check: 'Lineup, Thu 7am', actions, ...extra }, null, 2) +
  '\n```\n';

// A throwaway repo with our scripts and the given fixtures, so actions.mjs
// runs exactly as it does in production, against paths it controls.
let sandboxRoot = null;
async function sandbox(snapshot, reports) {
  sandboxRoot ??= await mkdtemp(path.join(tmpdir(), 'gridiron-selftest-'));
  const dir = await mkdtemp(path.join(sandboxRoot, 'case-'));
  await mkdir(path.join(dir, 'data', 'league'), { recursive: true });
  await mkdir(path.join(dir, 'reports'), { recursive: true });
  await cp(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'league', 'snapshot.json'), JSON.stringify(snapshot));
  // Production always has the 5MB players dump as a last-resort resolver, so a
  // player who has left every roster in the league still gets a name. Without
  // one here, "gone" cases would fail for the wrong reason.
  await writeFile(
    path.join(dir, 'data', 'players.json'),
    JSON.stringify(Object.fromEntries(Object.values(P).map((p) => [p.id, { full_name: p.name, position: p.position, team: p.team }])))
  );
  for (const [name, body] of Object.entries(reports)) await writeFile(path.join(dir, 'reports', name), body);
  return dir;
}

function runActions(dir, args = []) {
  const r = spawnSync(process.execPath, ['scripts/actions.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  // Notes and warnings are written to stderr; a test that only read stdout
  // would pass while saying nothing about them.
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- 1. lifecycle: acting on the advice must not break the next run -------

console.log('\nlifecycle — the world moving on is not a report bug');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Fixture swap.' }]),
  });
  const r = runActions(dir);
  check('a still-open report compiles', r.code === 0, r.out);
}

{
  // Ben made the swap: qb3 is now starting in SUPER_FLEX, qb2 is benched.
  const snap = fixture();
  const me = snap.teams[0];
  me.starters[7] = P.qb3;
  me.bench = [P.qb2];
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Fixture swap.' }]),
  });
  const r = runActions(dir);
  check('making the recommended lineup swap does not fail the compile', r.code === 0, r.out);
  check('...and the action is reported done', /done — start Quinn Three/.test(r.out), r.out);
}

{
  // Claim won: the free agent is now on my bench.
  const snap = fixture();
  snap.teams[0].bench.push(P.fa1);
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'Fixture add.' }]),
  });
  const r = runActions(dir);
  check('winning the recommended claim does not fail the compile', r.code === 0, r.out);
  check('...and the add is reported done', /done — add Free One/.test(r.out), r.out);
}

{
  // Claim lost: a rival rostered him first.
  const snap = fixture();
  snap.teams[1].bench.push(P.fa1);
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'Fixture add.' }]),
  });
  const r = runActions(dir);
  check('losing the claim to a rival does not fail the compile', r.code === 0, r.out);
  check('...and the add is reported gone', /gone — add Free One/.test(r.out), r.out);
}

{
  // Trade accepted: the players changed hands.
  const snap = fixture();
  snap.teams[0].bench = [P.opp1];
  snap.teams[1].bench = [P.qb3];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Fixture trade.' }]),
  });
  const r = runActions(dir);
  check('an accepted trade does not fail the compile', r.code === 0, r.out);
  check('...and the trade is reported done', /done — trade with Them/.test(r.out), r.out);
}

{
  // Offer still unanswered, but I dropped the player it was built on.
  const snap = fixture();
  snap.teams[0].bench = [];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Fixture trade.' }]),
  });
  const r = runActions(dir);
  check('an offer I can no longer honour does not fail the compile', r.code === 0, r.out);
  check('...and the trade is reported gone', /gone — trade with Them/.test(r.out), r.out);
}

{
  // The other manager moved the player I was asking for.
  const snap = fixture();
  snap.teams[1].starters = [P.opp2];
  snap.teams[1].bench = [];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Fixture trade.' }]),
  });
  const r = runActions(dir);
  check('an offer whose target left the other roster does not fail the compile', r.code === 0, r.out);
}

{
  // Open action, partly overtaken: the named drop already left.
  const snap = fixture();
  snap.teams[0].bench = [];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'Fixture add.' }]),
  });
  const r = runActions(dir);
  check('a drop that already left is a note, not a failure', r.code === 0, r.out);
  check('...and the note names it', /note —.*drop "qb3" is no longer on my roster/.test(r.out), r.out);
}

{
  // Open action, partly overtaken: FAAB spent below the standing bid.
  const snap = fixture();
  snap.teams[0].faab_remaining = 3;
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'Fixture add.' }]),
  });
  const r = runActions(dir);
  check('a bid above what is left is a note, not a failure', r.code === 0 && /note —.*more than my remaining FAAB/.test(r.out), r.out);
}

{
  // A genuinely bad report still fails, in both modes.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'nobody-at-all', mode: 'waiver', urgency: 'now', why: 'Fixture.' }]),
  });
  const r = runActions(dir);
  check('an unresolvable player id still fails the compile', r.code === 1 && /not found/.test(r.out), r.out);
}

// ---- 2. strict mode: --check is the write-time gate -----------------------

console.log('\nstrict --check — a report must never name a move you cannot make');

const strict = async (name, actions, { shouldPass = false, expect = null } = {}) => {
  const dir = await sandbox(fixture(), { '2026-09-15-lineup.md': block(actions) });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  if (shouldPass) check(name, r.code === 0, r.out);
  else check(name, r.code === 1 && (!expect || expect.test(r.out)), r.out);
};

await strict('a legal in-place swap passes', [{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Legal.' }], { shouldPass: true });
await strict('a kicker cannot be started at QB', [{ kind: 'start', player: 'k1', for: 'qb1', slot: 'QB', urgency: 'before_kickoff', why: 'Illegal.' }], { expect: /cannot fill the QB slot/ });
await strict('a WR cannot be started at TE', [{ kind: 'start', player: 'qb3', for: 'te1', slot: 'TE', urgency: 'before_kickoff', why: 'Illegal.' }], { expect: /cannot fill the TE slot/ });
await strict('a swap that empties another slot is rejected', [{ kind: 'start', player: 'qb3', for: 'te1', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Empties TE.' }], { expect: /leaves TE empty/ });
await strict('a start with no "for" into a filled slot is rejected', [{ kind: 'start', player: 'qb3', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Displaces nobody named.' }], { expect: /needs a "for"/ });
await strict('a start for a player who is not starting is rejected', [{ kind: 'start', player: 'qb3', for: 'rb3', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Not a starter.' }], { expect: /is not in my starters/ });
await strict('an unknown slot is rejected', [{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'LOLWUT', urgency: 'before_kickoff', why: 'No such slot.' }], { expect: /slot must be one of/ });
await strict('a strict run still rejects an add already rostered elsewhere', [{ kind: 'add', player: 'opp1', mode: 'waiver', urgency: 'now', why: 'Not free.' }], { expect: /already rostered by Them/ });

// ---- 3. the IR slot is real capacity -------------------------------------

console.log('\nIR — one slot, and it only takes some designations');

{
  const dir = await sandbox(fixture(), { '2026-09-15-waivers.md': block([{ kind: 'ir', player: 'qb3', urgency: 'now', why: 'IR is already full.' }]) });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a second body into a one-slot IR is rejected', r.code === 1 && /IR slot/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'activate', player: 'rb3', urgency: 'now', why: 'Off PUP, bring him back.' },
      { kind: 'ir', player: 'qb3', urgency: 'now', why: 'Into the slot just vacated.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('activate-then-IR in the same set is allowed', r.code === 0, r.out);
  check('...but warns that the designation may be refused', /may refuse the move/.test(r.out), r.out);
}

// ---- 4. sequencing between routines --------------------------------------

console.log('\nsequencing — four routines, one card');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Drops qb3.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Also gives qb3.' }]),
  });
  const r = runActions(dir);
  check('two routines spending the same player unlinked is rejected', r.code === 1 && /both use Quinn Three/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', id: 'w1', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'trades:trade:2', why: 'Fallback if the trade dies.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Also gives qb3.' }]),
  });
  const r = runActions(dir);
  check('...and accepted once linked with if_not', r.code === 0, r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'now', after: 'nothing:like:this', why: 'Dangling reference.' }]),
  });
  const r = runActions(dir);
  check('a dangling after reference is rejected', r.code === 1 && /unknown id/.test(r.out), r.out);
}

// ---- 5. the forward view --------------------------------------------------

console.log('\noutlook — counts are not an answer; the assignment is');

const outlookSnap = (starters, bench, reserve = []) => ({
  week: 1,
  my_roster_id: 1,
  league: { roster_positions: [...SLOTS, 'BN', 'BN', 'BN', 'BN', 'BN'], reserve_slots: 1, playoff_week_start: 15, trade_deadline: 11 },
  teams: [{ roster_id: 1, starters, bench, reserve }],
});

{
  const o = buildOutlook({
    week: 1,
    my_roster_id: 1,
    league: { roster_positions: ['QB', 'SUPER_FLEX'], reserve_slots: 0, playoff_week_start: 15, trade_deadline: 11 },
    teams: [{ roster_id: 1, starters: [P.qb1], bench: [P.wr1], reserve: [] }],
  });
  check('SUPER_FLEX gives up its QB so the QB slot can be filled', !o.weeks[0].empty_slots, JSON.stringify(o.weeks[0]));
}
{
  const o = buildOutlook({
    week: 1,
    my_roster_id: 1,
    league: { roster_positions: ['QB', 'QB'], reserve_slots: 0, playoff_week_start: 15, trade_deadline: 11 },
    teams: [{ roster_id: 1, starters: [P.qb1], bench: [P.wr1], reserve: [] }],
  });
  check('one QB cannot fill two QB slots', JSON.stringify(o.weeks[0].empty_slots) === '["QB"]', JSON.stringify(o.weeks[0]));
}
{
  const o = buildOutlook(outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1], [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]));
  const w7 = o.weeks.find((w) => w.week === 7);
  check('the week the only K and DEF are both on bye is flagged', JSON.stringify(w7.empty_slots) === '["K","DEF"]', JSON.stringify(w7));
  const w11 = o.weeks.find((w) => w.week === 11);
  check('the week the only TE is on bye is flagged', JSON.stringify(w11.empty_slots) === '["TE"]', JSON.stringify(w11));
  const w13 = o.weeks.find((w) => w.week === 13);
  check('a week that loses two QBs but is still legal is NOT flagged unfillable', !w13.empty_slots, JSON.stringify(w13));
  check('thin positions are the ones with no cover', JSON.stringify(o.roster_shape.thin_positions) === '["TE","K","DEF"]', JSON.stringify(o.roster_shape.thin_positions));
  check('a player on IR is not counted as active', o.roster_shape.active_by_position.RB === 4 && !o.roster_shape.active_by_position.RB5, JSON.stringify(o.roster_shape.active_by_position));
  check('...and shows up under reserve instead', o.roster_shape.reserve_by_position.RB === 1, JSON.stringify(o.roster_shape.reserve_by_position));
  check('past weeks are not reported', o.weeks[0].week === 1 && o.from_week === 1, String(o.from_week));
  check('open roster room counts bodies against total capacity', o.roster_shape.bench_open === 1, `bench_open=${o.roster_shape.bench_open}`);
}
{
  // An empty starting slot must not read as extra bench room: the roster cap
  // is on the whole active roster, so 14 bodies in 15 places is one space.
  const starters = [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, null, P.k1, P.df1];
  const o = buildOutlook(outlookSnap(starters, [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]));
  check('an empty starting slot does not inflate open roster room', o.roster_shape.bench_open === 2, `bench_open=${o.roster_shape.bench_open} (13 bodies, 15 places)`);
}
{
  const base = outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1], [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]);
  const fixed = buildOutlook(base, { add: [P.fa1], drop: ['qb3'] });
  check('what-if: adding a second TE fixes the TE week', !fixed.weeks.find((w) => w.week === 11).empty_slots, JSON.stringify(fixed.weeks.find((w) => w.week === 11)));
  const broken = buildOutlook(base, { drop: ['te1'] });
  check('what-if: dropping the only TE breaks every week', broken.weeks.every((w) => (w.empty_slots ?? []).includes('TE')), JSON.stringify(broken.weeks[0]));
}
{
  let threw = false;
  try {
    buildOutlook({ week: 1, my_roster_id: 1, league: { roster_positions: ['QB', 'LOLWUT'] }, teams: [{ roster_id: 1, starters: [P.qb1], bench: [], reserve: [] }] });
  } catch { threw = true; }
  check('an unknown slot throws rather than silently under-reporting a hole', threw);
}

// ---- 6. the command line itself -------------------------------------------
// A what-if tool that ignores an argument answers "this move changes nothing"
// when it has in fact ignored the move. That is worse than crashing.

console.log('\ncommand line — a misunderstood argument must never look like an answer');

function runOutlook(dir, args) {
  const r = spawnSync(process.execPath, ['scripts/outlook.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

{
  const dir = await sandbox(fixture(), {});
  const spaced = runOutlook(dir, ['--add', 'fa1', '--drop', 'qb3']);
  const equals = runOutlook(dir, ['--add=fa1', '--drop=qb3']);
  check('--add <id> is honoured', spaced.code === 0 && /add Free One/.test(spaced.out), spaced.out);
  check('--add=<id> is honoured too, not silently dropped', equals.code === 0 && /add Free One/.test(equals.out), equals.out);
  check('...and both forms agree', spaced.out === equals.out, 'the two forms produced different output');

  const unknown = runOutlook(dir, ['--bogus']);
  check('an unrecognised argument is an error, not a shrug', unknown.code === 2 && /Unknown argument/.test(unknown.out), unknown.out);

  const missingValue = runOutlook(dir, ['--add']);
  check('a flag with no value is an error', missingValue.code === 2 && /needs a player id/.test(missingValue.out), missingValue.out);

  const badDrop = runOutlook(dir, ['--drop', 'not-on-my-roster']);
  check('dropping someone who is not on the roster is an error', badDrop.code === 2 && /Cannot drop/.test(badDrop.out), badDrop.out);

  const plain = runOutlook(dir, []);
  check('no arguments prints the roster as it stands', plain.code === 0 && /as it stands/.test(plain.out), plain.out);
}

{
  const dir = await sandbox(fixture(), {});
  const r = runActions(dir, ['--check', 'reports/does-not-exist.md']);
  check('--check on a missing file says so instead of throwing', r.code === 1 && /no such file/.test(r.out) && !/at async/.test(r.out), r.out);
}

// ---- 7. publish: the recompile must not churn main -------------------------
// The first live run proved the recompile-after-rebase works, and also that it
// committed a file whose only change was its own timestamp.

console.log('\npublish — a recompile that changes nothing must not commit');

{
  const dir = await sandbox(fixture(), { '2026-09-15-lineup.md': block([]) });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'selftest@example.invalid');
  git('config', 'user.name', 'selftest');
  spawnSync(process.execPath, ['scripts/actions.mjs'], { cwd: dir, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const before = git('rev-parse', 'HEAD').stdout.trim();

  // Recompile by hand the way the rebase path does, then confirm the only
  // difference is the timestamp — the condition the fix keys on.
  const first = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  spawnSync(process.execPath, ['scripts/actions.mjs'], { cwd: dir, encoding: 'utf8' });
  const second = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  check('a repeat compile changes only compiled_at', first.compiled_at !== second.compiled_at &&
    JSON.stringify({ ...first, compiled_at: 0 }) === JSON.stringify({ ...second, compiled_at: 0 }));
  check('...and the fixture repo is otherwise untouched', git('rev-parse', 'HEAD').stdout.trim() === before);
}

// ---- 8. the dashboard must agree with the engine ---------------------------
// docs/index.html carries its own copy of the slot matching, because it runs in a
// browser with no access to these modules. Two implementations of the same rule drift;
// this pins them together. The page used to guess coverage from the position on bye and
// would tell Ben his QB bye was uncoverable while he held three other quarterbacks.

console.log('\ndashboard — its bye coverage must match scripts/outlook.mjs exactly');

{
  const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const from = src.indexOf('const SLOT_TAKES'), to = src.indexOf('/* ——— what needs Ben ——— */');
  check('the page still carries the slot model', from !== -1 && to > from);

  const ctx = { };
  vm.createContext(ctx);
  new vm.Script(src.slice(from, to) + ';this.emptySlots=emptySlots;this.SLOT_TAKES=SLOT_TAKES;').runInContext(ctx);

  // Same eligibility table on both sides.
  const enginePairs = Object.entries(SLOT_ELIGIBILITY).filter(([k]) => ctx.SLOT_TAKES[k]);
  check('the page and the engine agree on what each slot accepts',
    enginePairs.every(([k, v]) => JSON.stringify(v) === JSON.stringify(ctx.SLOT_TAKES[k])),
    enginePairs.filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(ctx.SLOT_TAKES[k])).map(([k]) => k).join(', '));

  // And the same answer, week by week, on a roster with real holes.
  const snap = outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1],
                           [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]);
  const engine = buildOutlook(snap);
  const active = [...snap.teams[0].starters, ...snap.teams[0].bench].filter(Boolean)
    .map(p => ({ id: p.id, pos: p.position, team: p.team, bye: p.bye_week }));
  const slotNames = snap.league.roster_positions.filter(x => x !== 'BN');
  const disagreements = engine.weeks.filter((w) => {
    const page = ctx.emptySlots(slotNames, active.filter(p => p.bye !== w.week)).slice().sort();
    return JSON.stringify(page) !== JSON.stringify((w.empty_slots ?? []).slice().sort());
  }).map(w => `W${w.week}`);
  check('every week ahead gets the same verdict from both', disagreements.length === 0, disagreements.join(', '));

  // The specific false alarm: a QB bye with quarterbacks to spare is covered.
  const qbByeWeek = ctx.emptySlots(slotNames, active.filter(p => p.pos !== 'QB' || p.id !== 'qb1'));
  check('a QB on bye with cover behind him is not reported as a hole', qbByeWeek.length === 0, qbByeWeek.join(','));
}

// ---- done ------------------------------------------------------------------

if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
