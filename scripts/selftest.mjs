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
import { lifecycleState, buildIndex } from './actions.mjs';

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
  // Spare arms, used only where a test needs genuine QB surplus to prove the
  // give-away rule stays quiet when there is cover.
  qb4: { id: 'qb4', name: 'Quinn Four', position: 'QB', team: 'UUU', bye_week: 9, injury_status: null },
  qb5: { id: 'qb5', name: 'Quinn Five', position: 'QB', team: 'VVV', bye_week: 10, injury_status: null },
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
  fa3: { id: 'fa3', name: 'Free Three', position: 'WR', team: 'TTT', bye_week: 3, injury_status: null },
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

// Fixtures predate the `displaces` rule (docs/ACTIONS.md "The case"), so
// inject `displaces: null` into add/trade actions that don't declare one —
// every fixture here is written as depth/no-starter unless a test says
// otherwise by setting `displaces` itself.
const block = (actions, extra = {}) => {
  const withDisplaces = actions.map((a) =>
    (a?.kind === 'add' || a?.kind === 'trade') && !('displaces' in a) ? { ...a, displaces: null } : a
  );
  return (
    '# Fixture report\n\n```actions\n' +
    JSON.stringify({ week: 2, verdict: 'Fixture.', next_check: 'Lineup, Thu 7am', actions: withDisplaces, ...extra }, null, 2) +
    '\n```\n'
  );
};

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
  // The compiler now treats an after/if_not target missing from the whole
  // compiled set as reality moving on, not a report bug — reconcileLinks
  // drops the link (with a warning) and the action stands on its own.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'now', after: 'nothing:like:this', why: 'Dangling reference.' }]),
  });
  const r = runActions(dir);
  check('a dangling after reference is dropped rather than failing the compile', r.code === 0 && /link dropped/.test(r.out), r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const action = written.actions.find((a) => a.player === 'fa1');
  check('...and the compiled action carries no after field', !!action && !('after' in action), JSON.stringify(action));
}
{
  // --check is the write-time gate on the one report the author is looking
  // at right now, so the same dangling reference still fails outright there.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'now', after: 'nothing:like:this', why: 'Dangling reference.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...but --check on the same report still rejects it as an unknown id', r.code === 1 && /unknown id/.test(r.out), r.out);
}

console.log('\nsequencing — the seven fixes, pinned down permanently');

{
  // Rule 1: a chain of links, not just a direct one, keeps three actions
  // that all consume Quinn Three out of conflict.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'w1', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'First claim on Quinn Three.' },
      { kind: 'add', id: 'w2', player: 'fa2', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'w1', why: 'Fallback if w1 fails.' },
    ]),
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', if_not: 'w2', why: 'Last resort if both waiver claims fail.' },
    ]),
  });
  const r = runActions(dir);
  check('a transitive chain of if_not links keeps three actions on one player out of conflict', r.code === 0, r.out);
}
{
  // Control: break the chain and the same three actions collide.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'w1', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'First claim on Quinn Three.' },
      { kind: 'add', id: 'w2', player: 'fa2', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'w1', why: 'Fallback if w1 fails.' },
    ]),
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Not linked to the waiver claims.' },
    ]),
  });
  const r = runActions(dir);
  check('...but only when every consumer is actually in the chain', r.code === 1 && /both use Quinn Three/.test(r.out), r.out);
}

// Rule 1a: the same collision one position up. Two live trade offers each
// gave away a different quarterback, and because every case is measured
// against one baseline, both cards reported the quarterbacks on the roster
// today — while between them they left the lineup short. Shipped Sep 2026.
{
  const threeTeams = () => {
    const snap = fixture();
    snap.teams.push({ roster_id: 3, owner: 'Third', faab_remaining: 100, starters: [P.fa3], bench: [], reserve: [] });
    return snap;
  };
  {
    const dir = await sandbox(threeTeams(), {
      '2026-09-15-trades.md': block([
        { kind: 'trade', id: 't1', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Gives one quarterback.' },
        { kind: 'trade', id: 't2', with: 3, give: ['qb2'], get: ['fa3'], urgency: 'optional', why: 'Gives another quarterback.' },
      ]),
    });
    const r = runActions(dir);
    check('two unlinked trades that each give away a QB are rejected', r.code === 1 && /each give up a QB/.test(r.out), r.out);
    check('...and the message says what the roster is left with against what it starts',
      /you keep 1 QB against a lineup that starts 2/.test(r.out), r.out);
  }
  {
    const dir = await sandbox(threeTeams(), {
      '2026-09-15-trades.md': block([
        { kind: 'trade', id: 't1', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Gives one quarterback.' },
        { kind: 'trade', id: 't2', with: 3, give: ['qb2'], get: ['fa3'], urgency: 'optional', if_not: 't1', why: 'The cheaper alternative, not a second deal.' },
      ]),
    });
    const r = runActions(dir);
    check('...and accepted once the second is marked the alternative to the first', r.code === 0, r.out);
  }
  {
    // Control: real surplus. Five quarterbacks against the two the lineup
    // starts still leaves cover after both offers land, so the rule is silent.
    const snap = threeTeams();
    snap.teams[0].bench = [P.qb3, P.qb4, P.qb5, P.rb4];
    const dir = await sandbox(snap, {
      '2026-09-15-trades.md': block([
        { kind: 'trade', id: 't1', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Gives one of five quarterbacks.' },
        { kind: 'trade', id: 't2', with: 3, give: ['qb4'], get: ['fa3'], urgency: 'optional', why: 'Gives another of five.' },
      ]),
    });
    const r = runActions(dir);
    check('...while two unlinked gives from genuine surplus stay legal', r.code === 0, r.out);
  }
  {
    // Control: the rule is scoped to a position, not to "two trades".
    const dir = await sandbox(threeTeams(), {
      '2026-09-15-trades.md': block([
        { kind: 'trade', id: 't1', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Gives a quarterback.' },
        { kind: 'trade', id: 't2', with: 3, give: ['rb1'], get: ['fa3'], urgency: 'optional', why: 'Gives a running back — a different position.' },
      ]),
    });
    const r = runActions(dir);
    check('...and two gives at different positions are not linked into a false conflict',
      r.code === 0 || !/each give up/.test(r.out), r.out);
  }
}
{
  // Rule 2: this set's own drop credits the open-bench-slot count, letting
  // two slotless adds share the one slot it frees.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4]; // 4 on bench, 5 BN slots: 1 open
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'drop', player: 'qb3', urgency: 'now', why: 'Makes room.' },
      { kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Needs a slot.' },
      { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Needs a slot.' },
    ]),
  });
  const r = runActions(dir);
  check('a drop in the same set credits the open-bench-slot count', r.code === 0, r.out);
}
{
  // Control: same two adds, no drop to credit — one open slot cannot hold two.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Needs a slot.' },
      { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Needs a slot.' },
    ]),
  });
  const r = runActions(dir);
  check('...and without it, two slotless adds outrun the one open bench slot', r.code === 1 && /bench slot/.test(r.out), r.out);
  check('...with the shortfall spelled out as arithmetic', /5 BN slot\(s\) - 4 on bench/.test(r.out), r.out);
}
{
  // Rule 2, trade worlds: two adds waiting on an even trade need bench room
  // the trade itself does not free — its give and get are the same size.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Even trade.' },
    ]),
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', after: 'trades:trade:2', why: 'Only if the trade lands.' },
      { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', after: 'trades:trade:2', why: 'Only if the trade lands.' },
    ]),
  });
  const r = runActions(dir);
  check('two adds waiting on a trade that frees no net slot outrun its allowance', r.code === 1 && /waiting on trades:trade:2/.test(r.out), r.out);
}
{
  // Same shape, but the trade gives up two for one — that net gain is
  // exactly the second bench slot the two waiting adds need.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3', 'rb4'], get: ['opp1'], urgency: 'this_week', why: 'Gives up two for one.' },
    ]),
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', after: 'trades:trade:2', why: 'Only if the trade lands.' },
      { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', after: 'trades:trade:2', why: 'Only if the trade lands.' },
    ]),
  });
  const r = runActions(dir);
  check('...and with that net gain counted in, the same two adds fit', r.code === 0, r.out);
}
{
  // if_not is the only link Rule 2 treats as a shared claim on one slot.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'a', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Primary.' },
      { kind: 'add', id: 'b', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'a', why: 'Fallback.' },
    ]),
  });
  const r = runActions(dir);
  check('if_not groups two slotless adds into one claim on the open slot', r.code === 0, r.out);
}
{
  // Control: after does not merge them — both are expected to run, so both
  // still want their own slot.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'a', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Primary.' },
      { kind: 'add', id: 'b', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', after: 'a', why: 'Runs after a, not instead of it.' },
    ]),
  });
  const r = runActions(dir);
  check('...but after does not, since both actions are expected to run', r.code === 1 && /bench slot/.test(r.out), r.out);
}
{
  // Two adds each if_not the SAME trade are still two separate claims — if
  // the trade falls through, both still want a slot, so they are not grouped
  // with each other just because they share a target.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Even trade.' },
    ]),
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'trades:trade:2', why: 'If the trade falls through.' },
      { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'trades:trade:2', why: 'If the trade falls through.' },
    ]),
  });
  const r = runActions(dir);
  check('two adds if_not the same trade are not grouped with each other', r.code === 1 && /bench slot/.test(r.out), r.out);
}
{
  // Rule 5: after-linked bids are not alternatives — both could land — so
  // both count toward the projected spend.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'a', player: 'fa1', mode: 'waiver', faab: 60, urgency: 'by_tuesday', why: 'Primary bid.' },
      { kind: 'add', id: 'b', player: 'fa2', mode: 'waiver', faab: 50, urgency: 'by_tuesday', after: 'a', why: 'Both can land.' },
    ]),
  });
  const r = runActions(dir);
  check('after-linked bids are not alternatives, so both count toward the projected spend', r.code === 0 && /could total \$110/.test(r.out), r.out);
}
{
  // if_not-linked bids ARE alternatives, so that group counts once at its
  // highest bid — alongside an unrelated third bid that counts on its own.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'a', player: 'fa1', mode: 'waiver', faab: 80, urgency: 'by_tuesday', why: 'Primary bid.' },
      { kind: 'add', id: 'b', player: 'fa2', mode: 'waiver', faab: 90, urgency: 'by_tuesday', if_not: 'a', why: 'Alternative to a.' },
      { kind: 'add', id: 'c', player: 'fa3', mode: 'waiver', faab: 70, urgency: 'by_tuesday', why: 'Unrelated bid.' },
    ]),
  });
  const r = runActions(dir);
  check('an if_not group counts once at its highest bid, alongside an unlinked bid',
    r.code === 0 && /could total \$160/.test(r.out) && /max of a \$80 \/ b \$90/.test(r.out), r.out);
}
{
  // Under budget: no warning at all.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'a', player: 'fa1', mode: 'waiver', faab: 30, urgency: 'by_tuesday', why: 'Primary bid.' },
      { kind: 'add', id: 'b', player: 'fa2', mode: 'waiver', faab: 40, urgency: 'by_tuesday', if_not: 'a', why: 'Alternative to a.' },
    ]),
  });
  const r = runActions(dir);
  check('a bid group within budget prints no total-spend warning', r.code === 0 && !/could total/.test(r.out), r.out);
}
{
  // Dedupe retarget: when the same trade appears in two reports, the
  // compiler keeps the newer file's copy and must move any if_not pointed
  // at the loser's id onto the winner's, instead of dropping it.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Original offer.' },
    ]),
    '2026-09-16-inactives.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Same offer, carried by the newer report.' },
    ]),
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', if_not: 'trades:trade:2', why: 'Fallback if the trade dies.' },
    ]),
  });
  const r = runActions(dir);
  check('a dedupe loser retargets a link pointed at it, rather than dropping it', r.code === 0 && /link retargeted/.test(r.out), r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const waiver = written.actions.find((a) => a.player === 'fa1');
  check("...onto the winning report's id", waiver?.if_not === 'inactives:trade:2', JSON.stringify(waiver));
}
{
  // --check names the routine from the filename; a name it can't match to
  // any TYPE is now a hard error instead of a guessed fallback that could
  // silently collide with, or silently dodge, this file's own prior report.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Case 7 fixture.' },
    ]),
  });
  runActions(dir); // compile once so reports/actions.json holds this same drop under source "waivers"

  await writeFile(path.join(dir, 'reports', 'draft-waivers.md'), block([
    { kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Case 7 fixture.' },
  ]));
  const r1 = runActions(dir, ['--check', 'reports/draft-waivers.md']);
  check('--check infers the source off a "-waivers.md" suffix, with no self-collision against its own prior report', r1.code === 0, r1.out);

  await writeFile(path.join(dir, 'reports', 'draft.md'), block([
    { kind: 'add', player: 'fa1', drop: 'qb3', mode: 'waiver', faab: 5, urgency: 'by_tuesday', why: 'Case 7 fixture.' },
  ]));
  const r2 = runActions(dir, ['--check', 'reports/draft.md']);
  check('...but a filename that names no routine at all is rejected outright', r2.code === 1 && /can't tell which routine/.test(r2.out), r2.out);
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

// A superflex lineup starts two quarterbacks every week, but the dedicated
// slots say one — so a roster cut to two QBs read "not thin", and a week
// with only one left read "full lineup" because a wide receiver in
// SUPER_FLEX is legal. Legal, and materially worse at 6-point passing TDs.
console.log('\noutlook — the SUPER_FLEX the lineup fills with a QB is demand, not a spare seat');

{
  const base = outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1], [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]);
  const o = buildOutlook(base);
  check('the flex slots are read off the submitted lineup, not guessed',
    JSON.stringify(o.roster_shape.flex_preferences) === '[{"slot":"FLEX","position":"WR"},{"slot":"SUPER_FLEX","position":"QB"}]',
    JSON.stringify(o.roster_shape.flex_preferences));
  check('...so lineup demand counts two QBs and three WRs, where dedicated slots say one and two',
    o.roster_shape.lineup_demand.QB === 2 && o.roster_shape.lineup_demand.WR === 3 && o.roster_shape.dedicated_slots.QB === 1,
    JSON.stringify(o.roster_shape.lineup_demand));
  check('three QBs against two started is still cover', !o.roster_shape.no_cover_positions.includes('QB'),
    JSON.stringify(o.roster_shape.no_cover_positions));

  const cut = buildOutlook(base, { drop: ['qb3'] });
  check('two QBs against two started has none', cut.roster_shape.no_cover_positions.includes('QB'),
    JSON.stringify(cut.roster_shape.no_cover_positions));
  check('...but it is still not "thin", which asks a narrower question', !cut.roster_shape.thin_positions.includes('QB'),
    JSON.stringify(cut.roster_shape.thin_positions));

  const w13 = o.weeks.find((w) => w.week === 13);
  check('the week two of three QBs are on bye downgrades the SUPER_FLEX',
    JSON.stringify(w13.downgraded_slots) === '["SUPER_FLEX"]', JSON.stringify(w13));
  check('...and the same week is still reported as a legal lineup', !w13.empty_slots, JSON.stringify(w13));
  check('...and counts as a crunch week to plan around', o.crunch_weeks.includes(13), JSON.stringify(o.crunch_weeks));
  const w9 = o.weeks.find((w) => w.week === 9);
  check('a week with both QBs available is not downgraded', !w9.downgraded_slots, JSON.stringify(w9));

  // The bug in full: a swap that trades a quarterback away reads as free on
  // the calendar, because every week it touches is still legal.
  const traded = buildOutlook(base, { drop: ['qb3'] });
  const newlyDowngraded = traded.weeks.filter((w) => w.downgraded_slots).map((w) => w.week);
  check('dropping the third QB downgrades a week the empty-slot test cannot see',
    newlyDowngraded.includes(6) && traded.weeks.find((w) => w.week === 6).empty_slots === undefined,
    JSON.stringify(newlyDowngraded));
}
{
  // No QB in the flex slot means no QB-flex: a lineup that starts a running
  // back there must not be told it is short a quarterback.
  const o = buildOutlook(outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.rb4, P.k1, P.df1], [P.rb5, P.wr4], []));
  check('a SUPER_FLEX the lineup fills with an RB creates no QB demand',
    o.roster_shape.lineup_demand.QB === 1 && o.weeks.every((w) => !w.downgraded_slots),
    JSON.stringify(o.roster_shape.lineup_demand));
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

// ---- 9. the card and the compiler must mean the same thing by "done" -------

console.log('\ndashboard — actionState must agree with the compiler on every lifecycle');

{
  const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const from = src.indexOf('const URGENCY ='), to = src.indexOf('/* ——— end do-now pure ——— */');
  const slice = to > from ? src.slice(from, to) : src.slice(from);
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(slice + ';this.actionState=actionState;this.resolveDependencies=resolveDependencies;').runInContext(ctx);
  check('the page still exposes actionState and resolveDependencies',
    typeof ctx.actionState === 'function' && typeof ctx.resolveDependencies === 'function');

  // Same world, described the two different ways the two sides read it.
  const scenarios = [
    ['add still free',        fixture(), { kind:'add', player:'fa1', mode:'waiver' }],
    ['add I won',             (()=>{const f=fixture(); f.teams[0].bench.push(P.fa1); return f;})(), { kind:'add', player:'fa1' }],
    ['add a rival took',      (()=>{const f=fixture(); f.teams[1].bench.push(P.fa1); return f;})(), { kind:'add', player:'fa1' }],
    ['start not yet made',    fixture(), { kind:'start', player:'qb3', for:'qb2', slot:'SUPER_FLEX' }],
    ['start already made',    (()=>{const f=fixture(); f.teams[0].starters[7]=P.qb3; f.teams[0].bench=[P.qb2]; return f;})(), { kind:'start', player:'qb3', for:'qb2' }],
    ['start whose man left',  (()=>{const f=fixture(); f.teams[0].bench=[]; return f;})(), { kind:'start', player:'qb3', for:'qb2' }],
    ['drop not yet made',     fixture(), { kind:'drop', player:'qb3' }],
    ['drop already made',     (()=>{const f=fixture(); f.teams[0].bench=[]; return f;})(), { kind:'drop', player:'qb3' }],
    ['ir with room',          (()=>{const f=fixture(); f.teams[0].reserve=[]; return f;})(), { kind:'ir', player:'qb3' }],
    ['ir already done',       (()=>{const f=fixture(); f.teams[0].reserve=[P.qb3]; f.teams[0].bench=[]; return f;})(), { kind:'ir', player:'qb3' }],
    ['activate pending',      fixture(), { kind:'activate', player:'rb3' }],
    ['activate done',         (()=>{const f=fixture(); f.teams[0].reserve=[]; f.teams[0].bench.push(P.rb3); return f;})(), { kind:'activate', player:'rb3' }],
    ['trade pending',         fixture(), { kind:'trade', with:2, with_owner:'Them', give:['qb3'], get:['opp1'] }],
    ['trade accepted',        (()=>{const f=fixture(); f.teams[0].bench=[P.opp1]; f.teams[1].bench=[P.qb3]; return f;})(), { kind:'trade', with:2, with_owner:'Them', give:['qb3'], get:['opp1'] }],
    ['trade I cannot honour', (()=>{const f=fixture(); f.teams[0].bench=[]; return f;})(), { kind:'trade', with:2, with_owner:'Them', give:['qb3'], get:['opp1'] }],
    ['trade target moved on', (()=>{const f=fixture(); f.teams[1].starters=[P.opp2]; f.teams[1].bench=[]; return f;})(), { kind:'trade', with:2, with_owner:'Them', give:['qb3'], get:['opp1'] }],
  ];

  const disagreed = [];
  for (const [label, snap, action] of scenarios) {
    const me = snap.teams[0];
    const mineIds = [...me.starters, ...me.bench, ...me.reserve].filter(Boolean).map(p => p.id);
    const ownerOf = (id) => {
      const t = snap.teams.find(x => x.roster_id !== snap.my_roster_id &&
        [...x.starters, ...x.bench, ...x.reserve].filter(Boolean).some(p => p.id === String(id)));
      return t ? t.owner : null;
    };
    const live = { week: snap.week, players: new Set(mineIds), starters: me.starters.filter(Boolean).map(p => p.id),
                   reserve: me.reserve.map(p => p.id), ownerOf, dismissed: new Set() };
    const page = ctx.actionState({ ...action, week: snap.week }, live).state;
    const engine = lifecycleState(action, snap, buildIndex(snap));
    if (page !== engine) disagreed.push(`${label}: card says "${page}", compiler says "${engine}"`);
  }
  check('all sixteen lifecycle scenarios agree', disagreed.length === 0, disagreed.join('\n'));
}

console.log('\ndashboard — dependency resolution');

{
  const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const from = src.indexOf('const URGENCY ='), to = src.indexOf('/* ——— end do-now pure ——— */');
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script((to > from ? src.slice(from, to) : src.slice(from)) + ';this.resolveDependencies=resolveDependencies;').runInContext(ctx);
  const R = (items) => Object.fromEntries(ctx.resolveDependencies(items).map(i => [i.id, i.state]));

  check('a fallback waits while its parent is open',
    R([{id:'t', kind:'trade', state:'open'}, {id:'w', kind:'add', state:'open', if_not:'t'}]).w === 'waiting');
  check('a fallback is shelved once its parent is done',
    R([{id:'t', kind:'trade', state:'done'}, {id:'w', kind:'add', state:'open', if_not:'t'}]).w === 'superseded');
  check('a fallback is promoted when its parent falls through',
    R([{id:'t', kind:'trade', state:'gone'}, {id:'w', kind:'add', state:'open', if_not:'t'}]).w === 'open');
  check('an "after" child waits, then promotes when the parent is done',
    R([{id:'a', kind:'activate', state:'open'}, {id:'b', kind:'ir', state:'open', after:'a'}]).b === 'waiting' &&
    R([{id:'a', kind:'activate', state:'done'}, {id:'b', kind:'ir', state:'open', after:'a'}]).b === 'open');
  check('an "after" child dies with a parent that became impossible',
    R([{id:'a', kind:'add', state:'gone'}, {id:'b', kind:'drop', state:'open', after:'a'}]).b === 'gone');
  check('a reference to an action that is not here leaves the child standing',
    R([{id:'w', kind:'add', state:'open', if_not:'nobody'}]).w === 'open');
  const cyc = R([{id:'x', kind:'add', state:'open', after:'y'}, {id:'y', kind:'add', state:'open', after:'x'}]);
  check('a cycle resolves instead of hanging', !!cyc.x && !!cyc.y, JSON.stringify(cyc));
  check('junk in the list is skipped, not thrown on',
    ctx.resolveDependencies([null, 'nope', {id:'ok', kind:'add', state:'open'}]).length === 1);

  // Fix: a child whose own state is already gone/done must stay that way —
  // an open (blocking) parent must not override it back to "waiting".
  check('a fallback already gone stays gone even under a still-open parent',
    R([{id:'t', kind:'trade', state:'open'}, {id:'w', kind:'add', state:'gone', if_not:'t'}]).w === 'gone');
  check('a fallback already done stays done even under a still-open parent',
    R([{id:'t', kind:'trade', state:'open'}, {id:'w', kind:'add', state:'done', if_not:'t'}]).w === 'done');
}

// ---- the case — the card has to convince in four lines ---------------------
// docs/ACTIONS.md "The case — why this move, in four lines" and the `case`
// example in section 2. The routine supplies one field, `displaces`; every
// other line — starts/need/cost/later — is computed by the compiler from the
// snapshot so it can't be decorated. Pinning the compiler's actual sentences
// here (not the shape of a sentence) is the point: a routine reads these
// lines off the card exactly as written.

console.log('\nthe case — the card has to convince in four lines');

// block() (above) injects `displaces: null` into every add/trade fixture that
// doesn't declare one, so the two cases below that need a report with NO
// displaces key at all have to go around it and build the JSON by hand.
function blockRaw(actions, extra = {}) {
  return (
    '# Fixture report\n\n```actions\n' +
    JSON.stringify({ week: 2, verdict: 'Fixture.', next_check: 'Lineup, Thu 7am', actions, ...extra }, null, 2) +
    '\n```\n'
  );
}

console.log('\n  displaces — the one field the routine supplies');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'No displaces key at all.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('--check rejects an add with no displaces key at all', r.code === 1 && /displaces is required/.test(r.out), r.out);
}

await strict('displaces naming a bench player is rejected', [
  { kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, displaces: 'qb3', urgency: 'by_tuesday', why: 'qb3 is on the bench, not in my starters.' },
], { expect: /is not in my starters/ });

await strict('displaces naming a slot the add cannot fill is rejected', [
  { kind: 'add', player: 'fa2', mode: 'waiver', faab: 5, displaces: 'qb1', urgency: 'by_tuesday', why: 'A K cannot take the QB slot.' },
], { expect: /cannot take/ });

console.log('\n  starts — named displacement vs. bench depth');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 5, displaces: 'wr1', urgency: 'by_tuesday', why: 'Starts over a starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a WR add naming who it displaces reads "Starts over ... at WR"',
    r.code === 0 && /starts: Starts over Wide One at WR/.test(r.out), r.out);
}

{
  // fa3 is a THIRD active WR against two dedicated slots — not thin — so the
  // bench line names WR4 behind the three already starting (dedicated slots
  // first, then the flex holder). It does NOT stop at "Wide Three" the way a
  // one-line contract example does: this fixture's Week 5 has a FLEX/WR
  // crunch a spare active WR happens to fix, so the compiler appends "; starts
  // Week 5" — read off the real output rather than assumed.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'Depth, not a starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a WR add with no displaces reads "Bench — WR4 behind Wide One, Wide Two, Wide Three" (plus the week it starts, in this fixture)',
    r.code === 0 && /starts: Bench — WR4 behind Wide One, Wide Two, Wide Three; starts Week 5/.test(r.out), r.out);
}

console.log('\n  depth is priced like depth — DEPTH_BID_CAP');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 15, displaces: null, urgency: 'by_tuesday', why: 'A fourth WR at a starter price.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a non-thin depth add priced above 10% of remaining FAAB fails --check', r.code === 1 && /starter's price/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'Right at the cap.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...but exactly 10% of remaining FAAB passes', r.code === 0, r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 15, displaces: null, urgency: 'by_tuesday', why: 'TE is thin, so the cap does not apply.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...and a thin position is exempt from the cap entirely, at any bid', r.code === 0, r.out);
}

console.log('\n  a report written before this rule existed still compiles');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, urgency: 'by_tuesday', why: 'A pre-rule report.' }]),
  });
  const r = runActions(dir);
  check('compiling a report whose add has no displaces key exits 0', r.code === 0, r.out);
  check('...and warns that displaces is required', /displaces is required/.test(r.out), r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const action = written.actions.find((a) => a.player === 'fa1');
  check('...the compiled case says so, in words Ben can read',
    action?.case?.starts === "The report didn't say who he displaces", JSON.stringify(action?.case));
  check('...and the compiled action carries no displaces property at all',
    !!action && !('displaces' in action), JSON.stringify(action));
}

console.log('\n  need — thinness and the position count');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'TE need line.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a TE add\'s need line names TE as the thinnest spot', /need: TE: you have 1 — your thinnest spot/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'WR need line.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  // Three WRs against two dedicated slots used to read "not thin" — but the
  // fixture lineup also fills FLEX with a wide receiver, so it starts three
  // of the three it owns. Dedicated slots alone can't see that.
  check('a WR add\'s need line counts the FLEX the lineup fills with a WR',
    /need: WR: you have 3 — starts 3, no cover/.test(r.out), r.out);
}
{
  // Depth still reads as depth: four WRs against the same three the lineup
  // starts leaves a spare body, so the line must not cry "no cover".
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'WR need line with cover.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...and says "not thin" once there is a spare body behind those starts',
    /need: WR: you have 4 — not thin/.test(r.out), r.out);
}

console.log('\n  cost — the bid, the market, and the trending rank');

{
  // Both fixture teams sit at the full waiver budget — confirm it rather than
  // assume it, so "every team still has $100" below is actually honest.
  const f = fixture();
  check('the fixture keeps every team at the full waiver_budget, so "every team still has" is an honest claim',
    Number.isInteger(f.league.waiver_budget) && f.teams.every((t) => t.faab_remaining === f.league.waiver_budget));

  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'w1', player: 'fa1', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'fa1 is #1 in trending.adds.' },
      { kind: 'add', id: 'w2', player: 'fa3', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'fa3 is not in trending at all.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a waiver add\'s cost line names the bid against my remaining cap', /cost: \$10 of \$100/.test(r.out), r.out);
  check('...and that every team still has the full budget', /every team still has \$100/.test(r.out), r.out);
  check('...and fa1\'s rank as #1 most-added', /#1 most-added/.test(r.out), r.out);
  check('...while fa3, absent from trending.adds, reads "not trending"', /not trending/.test(r.out), r.out);
}

console.log('\n  later — bench slots, dropped positions, and the outlook diff');

{
  // Four on the bench against five BN slots: exactly one is open, so a
  // slotless add uses the last one.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa2', mode: 'waiver', faab: 10, displaces: null, urgency: 'by_tuesday', why: 'Last bench slot.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('an add with no drop into the last open bench slot says so', /uses your last bench slot/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'drop', player: 'k1', urgency: 'now', why: 'The only kicker on the roster.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('dropping the only K says so', /drops your only K/.test(r.out), r.out);
}
{
  // Trading the only WR who covers a Week 7 hole for a TE (which doesn't
  // offset a WR loss) opens a real hole — read straight off scripts/outlook.mjs
  // rather than guessed: with wr1 gone, Week 7's FLEX/WR cover collapses.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', drop: 'wr1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'Trades a starting WR for bench TE depth.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('dropping the only cover for a bye week opens a hole the outlook can name', /opens a W\d+ \w+ hole/.test(r.out), r.out);
}

console.log('\n  a trade case — the incoming player, the give, and the outlook diff');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], displaces: 'rb1', urgency: 'this_week', why: 'Trade case.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('a trade naming who the incoming player displaces reads "... starts over ... at RB"',
    /starts: Other One starts over Rush One at RB/.test(r.out), r.out);
  check('...its cost line counts what leaves, starters vs. bench, no FAAB',
    /cost: gives Quinn Three — 0 starters, 1 bench · no FAAB/.test(r.out), r.out);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3', 'rb1'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Gives up two for one.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('a trade that gives more than it gets frees a bench slot', /frees 1 bench slot/.test(r.out), r.out);
}

console.log('\n  a start case — who comes in, who sits, and the bench player\'s status');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Start case.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  check('a start case names who comes in, at what slot, and who it benches',
    /starts: Quinn Three in at SUPERFLEX, Quinn Two to the bench/.test(r.out), r.out);
  check('...and names the benched player\'s health and bye',
    /need: Quinn Two: healthy, BBB bye W6/.test(r.out), r.out);
}

console.log('\n  --check prints the case so a routine can see what the card will say before publishing');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Prints on stdout.' }]),
  });
  const r = spawnSync(process.execPath, ['scripts/actions.mjs', '--check', 'reports/2026-09-15-lineup.md'], { cwd: dir, encoding: 'utf8' });
  check('the case lines print under the OK action, on stdout',
    r.status === 0 && /starts:/.test(r.stdout ?? '') && /need:/.test(r.stdout ?? ''), r.stdout);
}

console.log('\n  the dashboard: caseGrid, kindTag — extending the do-now pure slice with a local esc');

{
  const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const from = src.indexOf('const URGENCY ='), to = src.indexOf('/* ——— end do-now pure ——— */');
  const slice = to > from ? src.slice(from, to) : src.slice(from);
  // esc() is defined outside the pure slice (docs/index.html line ~241, shared
  // by the whole page), so the slice alone throws the moment actionRow/
  // caseGrid/actionHeadline call it. Define a local copy in the same script
  // scope rather than widening the slice — the same workaround the card
  // agent's harness used.
  const escSrc = "const esc=(s)=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n";
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(escSrc + slice + ';this.actionRow=actionRow;this.caseGrid=caseGrid;this.kindTag=kindTag;').runInContext(ctx);

  const openAdd = {
    id: 'w1', kind: 'add', mode: 'waiver', state: 'open', urgency: 'by_tuesday',
    name: 'Free Three', pos: 'WR', team: 'TTT',
    case: {
      starts: 'Bench — WR4 behind Wide One, Wide Two, Wide Three',
      need: 'WR: you have 3 — not thin',
      cost: '$10 of $100 · every team still has $100 · not trending',
      later: 'opens no holes',
    },
    why: 'Depth.', report: '2026-09-15-waivers.md', source: 'waivers',
  };
  const row = ctx.actionRow(openAdd, { now: '14:02' }, { num: 1 });
  check('an open add with a four-line case renders a case grid', row.includes('class="case"'), row);
  const idx = ['>Starts<', '>Need<', '>Cost<', '>Later<'].map((l) => row.indexOf(l));
  check('...with the labels Starts / Need / Cost / Later, in that order',
    idx.every((n) => n !== -1) && idx.every((n, i) => i === 0 || n > idx[i - 1]), JSON.stringify(idx));
  check('...and the row is tagged claim, not a bare number', row.includes('<span class="kind">claim</span>'), row);

  const doneRow = ctx.actionRow({ ...openAdd, state: 'done' }, { now: '14:02' }, { num: 1 });
  check('a done add with the same case does NOT render the case grid — the argument is over',
    !doneRow.includes('class="case"'), doneRow);

  check('a start row is tagged lineup', ctx.kindTag({ kind: 'start' }) === 'lineup');
  check('a fcfs add is tagged add, not claim (pre-season, first-come-first-served)',
    ctx.kindTag({ kind: 'add', mode: 'fcfs' }) === 'add');
}

// ---- the modules must be importable without doing anything ------------
// Importing scripts/actions.mjs used to run a full compile as a side effect, because its
// CLI entry was unguarded. It passed here only because this checkout happened to have a
// snapshot; a clean clone failed. Nothing should act merely because it was imported.

console.log('\nmodules — importing must not run anything');

{
  const dir = await mkdtemp(path.join(sandboxRoot ?? tmpdir(), 'import-'));
  await cp(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  // No data/, no reports/ — exactly a fresh clone.
  for (const mod of ['actions.mjs', 'outlook.mjs', 'sleeper.mjs']) {
    const r = spawnSync(process.execPath, ['-e', `import('./scripts/${mod}').then(()=>console.log('clean'))`],
      { cwd: dir, encoding: 'utf8' });
    check(`importing ${mod} does nothing and exits clean`,
      r.status === 0 && /clean/.test(r.stdout ?? ''), `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 200));
  }
}

// ---- done ------------------------------------------------------------------

if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
