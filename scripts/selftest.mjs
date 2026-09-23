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
import { buildOutlook, SLOT_ELIGIBILITY, fillSlots } from './outlook.mjs';
import { streamOptions, streamSeason, parseOpponent } from './stream.mjs';
import { lifecycleState, buildIndex, freeAgencyIsOpen } from './actions.mjs';

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
  // A body on the OTHER manager's bench, so the partner-side case line has a
  // "benches" case to describe and not only a "starts" one.
  opp3: { id: 'opp3', name: 'Other Three', position: 'RB', team: 'OP3', bye_week: 12, injury_status: null },
  // free agents
  fa1: { id: 'fa1', name: 'Free One', position: 'TE', team: 'OOO', bye_week: 6, injury_status: null },
  fa2: { id: 'fa2', name: 'Free Two', position: 'K', team: 'PPP', bye_week: 9, injury_status: null },
  fa3: { id: 'fa3', name: 'Free Three', position: 'WR', team: 'TTT', bye_week: 3, injury_status: null },
  // Two unrostered backs, so a test can have two independent claims land at
  // one position — the shape Rule 1b exists to catch.
  fa4: { id: 'fa4', name: 'Free Four', position: 'RB', team: 'F4F', bye_week: 12, injury_status: null },
  fa5: { id: 'fa5', name: 'Free Five', position: 'RB', team: 'F5F', bye_week: 14, injury_status: null },
  // bench depth for the outlook fixture, on byes that collide with nothing
  // interesting — without it every single bye reads as an empty FLEX.
  rb4: { id: 'rb4', name: 'Rush Four', position: 'RB', team: 'QQQ', bye_week: 8, injury_status: null },
  rb5: { id: 'rb5', name: 'Rush Five', position: 'RB', team: 'RRR', bye_week: 14, injury_status: null },
  wr4: { id: 'wr4', name: 'Wide Four', position: 'WR', team: 'SSS', bye_week: 12, injury_status: null },
  // A second tight end and kicker, so a no-cover test can hand a position
  // genuine cover instead of proving the point by accident.
  te2: { id: 'te2', name: 'Tight Two', position: 'TE', team: 'E1E', bye_week: 12, injury_status: null },
  k2: { id: 'k2', name: 'Kick Two', position: 'K', team: 'E2E', bye_week: 12, injury_status: null },
  // a bye pair for the crunch-week tightening tests below: shares a week
  // with nothing else, so on their own they isolate the bye-count clause.
  safe_rb: { id: 'safe_rb', name: 'Safe RB', position: 'RB', team: 'WWW', bye_week: 4, injury_status: null },
  safe_wr: { id: 'safe_wr', name: 'Safe WR', position: 'WR', team: 'XXX', bye_week: 4, injury_status: null },
  drain_rb: { id: 'drain_rb', name: 'Drain RB', position: 'RB', team: 'YYY', bye_week: 3, injury_status: null },
  drain_wr: { id: 'drain_wr', name: 'Drain WR', position: 'WR', team: 'ZZZ', bye_week: 3, injury_status: null },
  // Never placed on any roster or in trending/transactions — exists only so
  // sandbox()'s synthetic players.json carries a dump-only entry with no
  // team, the shape a retired/inactive player actually has (see the
  // "unknown player id" CLI tests below).
  retired1: { id: 'retired1', name: 'Retired One', position: 'QB', team: null, bye_week: null, injury_status: null },
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
  // `evidence` is filled the same way and for the same reason: every fixture
  // here predates the rule, and a fixture written to probe some other rule
  // must not fail on a field it was never about. null is the honest default —
  // these rosters carry no outside claim. Tests that probe the field itself
  // use blockRaw, or pass an explicit `evidence`.
  const filled = actions.map((a) => {
    if (a?.kind !== 'add' && a?.kind !== 'trade') return a;
    let out = a;
    if (!('displaces' in out)) out = { ...out, displaces: null };
    if (!('evidence' in out)) out = { ...out, evidence: null };
    return out;
  });
  return (
    '# Fixture report\n\n```actions\n' +
    JSON.stringify({ week: 2, verdict: 'Fixture.', next_check: 'Lineup, Thu 7am', actions: filled, ...extra }, null, 2) +
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

{
  // A start still open once its own kickoff has passed can't be carried out
  // any more — Sleeper already locked the slot — so it goes stale at compile
  // time the same way a week-behind start does, rather than sitting on the
  // card as an instruction Ben can no longer act on.
  const snap = fixture();
  snap.games = {
    BBB: { kickoff: '2026-09-21', status: 'pre_game', opponent: 'CCC', home: true },
    CCC: { kickoff: '2026-09-21', status: 'in_game', opponent: 'BBB', home: false },
  };
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Fixture swap.' }]),
  });
  const r = runActions(dir);
  check('a start whose own kickoff has passed still compiles', r.code === 0, r.out);
  check('...and it is reported stale', /stale — start Quinn Three.*kicked off/.test(r.out), r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const action = written.actions.find((a) => a.player === 'qb3');
  check('...carrying state: "stale" with a reason naming who kicked off',
    action?.state === 'stale' && /Quinn Three.*kicked off/.test(action?.state_reason ?? ''), JSON.stringify(action));
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
// rb3 sits in `reserve` in the fixture — myIds counts reserve as "mine" too
// (it has to, for drop/trade), so roster membership alone let a start into
// the IR slot validate clean. Sleeper won't move a reserve player straight
// into a starting slot; he has to be activated first.
await strict('a start naming a player on IR/reserve is rejected', [{ kind: 'start', player: 'rb3', for: 'rb1', slot: 'RB', urgency: 'before_kickoff', why: 'Still on IR.' }], { expect: /on IR\/reserve/ });
{
  // No check anywhere compared the incoming player's own bye to the live
  // week — buildStartCase only ever reported the benched player's status —
  // so a start naming someone on a bye validated clean and scored zero.
  const snap = fixture();
  snap.teams[0].bench = [{ ...P.qb3, bye_week: snap.week }];
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'On a bye.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  check('a start naming a player on a bye this week is rejected', r.code === 1 && /on a bye this week/.test(r.out), r.out);
}
{
  // Sleeper locks a player's starting slot at his own kickoff — a swap
  // naming either side of a locked slot is a move Ben can no longer make in
  // the app, the same as a bye or an IR player above. Both games still
  // pre_game is the control: the swap is legal right up to kickoff.
  const snap = fixture();
  snap.games = {
    BBB: { kickoff: '2026-09-21', status: 'pre_game', opponent: 'CCC', home: true },
    CCC: { kickoff: '2026-09-21', status: 'pre_game', opponent: 'BBB', home: false },
  };
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Still pre-game.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  check('a swap between two players whose games are still pre_game passes', r.code === 0, r.out);
}
{
  // The incoming player's own game has left pre_game.
  const snap = fixture();
  snap.games = {
    BBB: { kickoff: '2026-09-21', status: 'pre_game', opponent: 'CCC', home: true },
    CCC: { kickoff: '2026-09-21', status: 'in_game', opponent: 'BBB', home: false },
  };
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Too late.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  check('a start naming a player whose own game is already in_game is rejected', r.code === 1 && /Quinn Three.*already kicked off/.test(r.out), r.out);
}
{
  // The bench side of the swap has kicked off instead — same lock, other end.
  const snap = fixture();
  snap.games = {
    BBB: { kickoff: '2026-09-21', status: 'in_game', opponent: 'CCC', home: true },
    CCC: { kickoff: '2026-09-21', status: 'pre_game', opponent: 'BBB', home: false },
  };
  const dir = await sandbox(snap, {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'The bench side kicked off.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-lineup.md']);
  check('a start whose benched "for" is already in_game is also rejected', r.code === 1 && /Quinn Two.*already kicked off/.test(r.out), r.out);
}
await strict('a strict run still rejects an add already rostered elsewhere', [{ kind: 'add', player: 'opp1', mode: 'waiver', urgency: 'now', why: 'Not free.' }], { expect: /already rostered by Them/ });
// games_have_started flips once and stays flipped — the fixture's default
// (true) matches "the season is underway", so a routine still writing an
// instant, $0 fcfs add here is the exact stale-report bug this rule stops.
await strict('an fcfs add is rejected once games have started', [{ kind: 'add', player: 'fa1', mode: 'fcfs', urgency: 'now', why: 'Games are already underway.' }], { expect: /needs mode: "waiver"/ });
{
  // Control: before kickoff, fcfs is exactly right — an instant, $0 add,
  // never a waiver bid — so the identical mode passes when it's still true.
  const dir = await sandbox(fixture({ games_have_started: false }), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'fcfs', urgency: 'now', why: 'Pre-season, first come first served.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...but the same fcfs add is fine before games have started', r.code === 0, r.out);
}

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
  // The sandbox is not a git checkout, so this is the mtime fallback — it
  // still has to be a real ISO timestamp, or the dashboard's next-check sort
  // silently degrades to comparing filenames again.
  const wa = written.sources?.waivers?.written_at;
  check('every compiled source carries a written_at the page can sort on, even with no git',
    typeof wa === 'string' && !Number.isNaN(Date.parse(wa)) && wa.endsWith('Z'), JSON.stringify(written.sources));
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

// `start`'s own consumes never listed the player being put IN — only `for`,
// the player coming out — so an unlinked start and a trade/drop giving that
// same incoming player away never collided under Rule 1. Fixed Sep 2026.
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Start Quinn Three.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Also gives Quinn Three away.' }]),
  });
  const r = runActions(dir);
  check('a start and an unlinked trade giving away the same incoming player collide', r.code === 1 && /both use Quinn Three/.test(r.out), r.out);
}
{
  // Control: linking the two with if_not clears Rule 1, same as any other pair.
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', if_not: 'trades:trade:2', why: 'Only if the trade falls through.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Primary plan: trade Quinn Three.' }]),
  });
  const r = runActions(dir);
  check('...and accepted once linked with if_not', r.code === 0, r.out);
}
{
  // Rule 1a is scoped to SHEDDING_KINDS (trade/add/drop/ir) on purpose: a
  // start's consumes now includes the incoming player, but starting a bench
  // QB doesn't shed a QB from the roster — the opposite — so it must never
  // count as a second unlinked "gives up a QB" alongside a real trade give.
  const dir = await sandbox(fixture(), {
    '2026-09-15-lineup.md': block([{ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', urgency: 'before_kickoff', why: 'Start Quinn Three.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb1'], get: ['opp1'], urgency: 'this_week', why: 'Trades away Quinn One.' }]),
  });
  const r = runActions(dir);
  check('a start does not count as shedding a QB under Rule 1a', r.code === 0 && !/each give up a QB/.test(r.out), r.out);
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

// Rule 2b: a trade's own `get` can outnumber its `give` — it brings home
// more bodies than it sends away — and nothing checked that against open
// bench room, unlike an add with no drop. Sleeper refuses a trade the
// roster has no room for the same as it refuses an overflowing add.
{
  const snap = fixture();
  snap.teams[0].bench = [P.qb4, P.qb5, P.rb4, P.rb5, P.wr4]; // all 5 BN slots full
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb4'], get: ['opp1', 'opp2'], urgency: 'this_week', why: 'Brings home two for one.' },
    ]),
  });
  const r = runActions(dir);
  check('a single trade that nets more players in than out is rejected when the bench is full',
    r.code === 1 && /bring home/.test(r.out), r.out);
}
{
  // Control: the identical shape trade is fine when the bench has room for
  // the extra body it brings home.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1', 'opp2'], urgency: 'this_week', why: 'Brings home two for one, room to spare.' },
    ]),
  });
  const r = runActions(dir);
  check('...but the identical shape trade is fine when the bench has room for the extra body',
    r.code === 0, r.out);
}
{
  // Two trades to different partners, each netting one body in, unlinked:
  // the roster cannot actually absorb both landing at once, but each one's
  // case is measured as if the other never happened — mirroring how Rule 1a
  // already sums unlinked same-position gives instead of checking each
  // action alone.
  const snap = fixture();
  snap.teams.push({ roster_id: 3, owner: 'Third', faab_remaining: 100, starters: [P.fa3, P.fa2], bench: [], reserve: [] });
  snap.teams[0].bench = [P.qb4, P.rb4, P.rb5, P.wr4]; // 4 on bench, 5 BN slots: 1 open
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', id: 't1', with: 2, give: ['qb4'], get: ['opp1', 'opp2'], urgency: 'this_week', why: 'Nets one body from roster 2.' },
      { kind: 'trade', id: 't2', with: 3, give: ['rb4'], get: ['fa3', 'fa2'], urgency: 'optional', why: 'Nets one body from roster 3.' },
    ]),
  });
  const r = runActions(dir);
  check('two unlinked trades that each net a body combine to overflow the one open bench slot',
    r.code === 1 && /bring home/.test(r.out), r.out);
}
{
  // Control: marking the second an alternative to the first — only one can
  // actually land — clears it, the same if_not-only grouping Rule 2 already
  // applies to slotless adds.
  const snap = fixture();
  snap.teams.push({ roster_id: 3, owner: 'Third', faab_remaining: 100, starters: [P.fa3, P.fa2], bench: [], reserve: [] });
  snap.teams[0].bench = [P.qb4, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([
      { kind: 'trade', id: 't1', with: 2, give: ['qb4'], get: ['opp1', 'opp2'], urgency: 'this_week', why: 'Primary offer.' },
      { kind: 'trade', id: 't2', with: 3, give: ['rb4'], get: ['fa3', 'fa2'], urgency: 'optional', if_not: 't1', why: 'Fallback, not a second deal.' },
    ]),
  });
  const r = runActions(dir);
  check('...and accepted once the second is marked the fallback to the first', r.code === 0, r.out);
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

// Two trade offers to the SAME partner used to collapse to one with no error
// or warning: the old flat `trade:${with}` key in compile()'s dedupe hit
// neither "first sighting" nor "different report" branch for a second
// same-report offer, so it silently dropped it. Cross-report supersession by
// partner is deliberate (a newer trades report revising an offer to one
// partner must still replace the older one) — only the SAME-report case was
// the bug. Fixed Sep 2026.
{
  // Two genuinely separate, distinctly-id'd offers to one partner both
  // survive a compile — neither the primary-plus-if_not-fallback pattern nor
  // two independent offers should ever be dropped for sharing a partner.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', id: 'offerA', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'First offer.' },
      { kind: 'trade', id: 'offerB', with: 2, give: ['rb1'], get: ['opp2'], urgency: 'this_week', why: 'A second, separate offer.' },
    ]),
  });
  const r = runActions(dir);
  check('two distinctly-id\'d offers to the same partner in one report both survive compile',
    r.code === 0 && /2 open action/.test(r.out), r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const ids = written.actions.filter((a) => a.kind === 'trade').map((a) => a.id).sort();
  check('...and both ids are in the compiled set', ids.join(',') === 'offerA,offerB', ids.join(','));
}
{
  // With no explicit id on either, both default to the same
  // `<source>:trade:<with>` key — that collision is now a write-time error
  // instead of a silent drop two steps downstream.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'First offer.' },
      { kind: 'trade', with: 2, give: ['rb1'], get: ['opp2'], urgency: 'this_week', why: 'A second, separate offer.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('two offers to the same partner with no explicit ids are rejected as a default-id collision',
    r.code === 1 && /need distinct "id"s/.test(r.out), r.out);
}
{
  // A literal restatement — same give and same get to the same partner — is
  // the accidental duplicate it looks like, even with distinct ids attached.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', id: 'x', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'First offer.' },
      { kind: 'trade', id: 'y', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Same offer restated.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('an exact give/get restatement to the same partner is rejected as a likely duplicate even with distinct ids',
    r.code === 1 && /likely a duplicate/.test(r.out), r.out);
}
{
  // Cross-report supersession still replaces a partner's WHOLE set, not just
  // a matching key: a newer report with one offer to roster 2 drops both of
  // an older report's offers to roster 2, not just one of them.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([
      { kind: 'trade', id: 'old1', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'Old offer one.' },
      { kind: 'trade', id: 'old2', with: 2, give: ['rb1'], get: ['opp2'], urgency: 'this_week', why: 'Old offer two.' },
    ]),
    '2026-09-16-inactives.md': block([
      { kind: 'trade', id: 'new1', with: 2, give: ['wr1'], get: ['opp1'], urgency: 'this_week', why: 'Revised offer, carried by the newer report.' },
    ]),
  });
  const r = runActions(dir);
  check('a newer report\'s offer set to a partner replaces the older report\'s whole set', r.code === 0, r.out);
  const written = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const trades = written.actions.filter((a) => a.kind === 'trade' && a.with === 2);
  check('...leaving exactly the newer offer, not a merge of both', trades.length === 1 && trades[0].id === 'new1', JSON.stringify(trades));
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
  // The same empty SUPER_FLEX (a drop with no waiver replacement chosen yet,
  // or simply an unset lineup) must not silently erase the QB demand that
  // slot carries every other week — flex_preferences used to read `null` and
  // just skip the slot, so lineup_demand.QB quietly fell to 1 and QB dropped
  // out of no_cover_positions at the exact moment the roster was thinnest.
  check('an empty SUPER_FLEX still falls back to a QB preference, not none at all',
    JSON.stringify(o.roster_shape.flex_preferences) === '[{"slot":"FLEX","position":"WR"},{"slot":"SUPER_FLEX","position":"QB"}]',
    JSON.stringify(o.roster_shape.flex_preferences));
  check('...so lineup_demand.QB still counts the unset slot', o.roster_shape.lineup_demand.QB === 2, JSON.stringify(o.roster_shape.lineup_demand));
  check('...and QB shows up as uncovered rather than reading as safe', o.roster_shape.no_cover_positions.includes('QB'), JSON.stringify(o.roster_shape.no_cover_positions));
}
{
  // Contrast: an empty flex slot that CANNOT hold a quarterback must not
  // manufacture QB demand out of thin air — only a slot whose eligibility
  // actually admits QB gets the fallback.
  const o = buildOutlook({
    week: 1,
    my_roster_id: 1,
    league: { roster_positions: ['QB', 'FLEX'], reserve_slots: 0, playoff_week_start: 15, trade_deadline: 11 },
    teams: [{ roster_id: 1, starters: [P.qb1, null], bench: [P.rb1], reserve: [] }],
  });
  check('an empty non-QB flex slot contributes no preference at all',
    o.roster_shape.flex_preferences.length === 0, JSON.stringify(o.roster_shape.flex_preferences));
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

// "No cover" used to be a count — activeCount <= lineup_demand — and
// lineup_demand credits a flex slot to whatever position is sitting in it.
// So three backs behind RB/RB/FLEX read "no cover at RB" while the week walk
// in the same object showed every RB bye fielding a full lineup off the spare
// receivers. Three live recommendations were argued from that flag on
// 2026-09-22, and because the "depth is priced like depth" guard exempts
// every position no_cover names, the same flag switched off the check that
// would have capped a $20 bid on a bench back.
console.log('\noutlook — no cover means the lineup actually breaks, not that a count is tight');

{
  // Three RBs for RB, RB and an RB-held FLEX — but four WRs behind two WR
  // slots, so the flex has cover even though the count looks tight.
  const base = outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb3, P.qb2, P.k1, P.df1],
    [P.qb3, P.wr3, P.wr4, P.te2, P.k2],
    []
  );
  const o = buildOutlook(base);
  check('the flex is read as RB demand, so the count still looks tight',
    o.roster_shape.lineup_demand.RB === 3 && o.roster_shape.active_by_position.RB === 3,
    JSON.stringify(o.roster_shape.lineup_demand));
  check('...but RB is NOT uncovered, because a receiver fills the flex',
    !o.roster_shape.no_cover_positions.includes('RB'),
    JSON.stringify(o.roster_shape.no_cover_positions));
  check('...and that agrees with the week walk: no RB bye empties a slot a back fills',
    o.weeks.every((w) => !(w.empty_slots ?? []).some((slot) => SLOT_ELIGIBILITY[slot].includes('RB'))),
    JSON.stringify(o.weeks.filter((w) => w.empty_slots)));

  // This fixture carries one defense on purpose, so a week really does break,
  // and here that break is at a position the flag names. Note what is NOT
  // claimed: no_cover asks "if one body goes down today", while a bye can
  // take two at once, so a week can break at a position that is covered
  // today. That question is `weeks[]`, and conflating the two is how the old
  // count came to be trusted for something it never measured.
  const holes = o.weeks.filter((w) => w.empty_slots).flatMap((w) => w.empty_slots);
  check('...and the week that does break here breaks at a position it names',
    holes.length > 0 && holes.every((slot) =>
      SLOT_ELIGIBILITY[slot].some((pos) => o.roster_shape.no_cover_positions.includes(pos))),
    JSON.stringify({ holes, no_cover: o.roster_shape.no_cover_positions }));
}
{
  // Strip the spare receivers and tight ends: now the flex genuinely has
  // nobody behind it, and RB must be reported uncovered.
  const bare = outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb3, P.qb2, P.k1, P.df1],
    [P.qb3],
    []
  );
  const o = buildOutlook(bare);
  check('with no spare receiver or tight end, RB really is uncovered',
    o.roster_shape.no_cover_positions.includes('RB'),
    JSON.stringify(o.roster_shape.no_cover_positions));
}
{
  // A single tight end is the shape the flag was always right about.
  const o = buildOutlook(outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb3, P.qb2, P.k1, P.df1],
    [P.qb3, P.wr3, P.wr4, P.rb4, P.k2],
    []
  ));
  check('one tight end is uncovered and thin at once',
    o.roster_shape.no_cover_positions.includes('TE') && o.roster_shape.thin_positions.includes('TE'),
    JSON.stringify(o.roster_shape));
  check('every thin position is still an uncovered one',
    o.roster_shape.thin_positions.every((p) => o.roster_shape.no_cover_positions.includes(p)),
    JSON.stringify(o.roster_shape));
}
{
  // The QB case the count got right for the wrong reason: two QBs against a
  // QB slot and a QB-held SUPER_FLEX is legal after a loss but downgraded,
  // so it stays uncovered even though no slot goes empty.
  const o = buildOutlook(outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb3, P.qb2, P.k1, P.df1],
    [P.wr3, P.wr4, P.rb4, P.te2, P.k2],
    []
  ));
  check('two QBs for a QB slot plus a QB-held SUPER_FLEX is uncovered',
    o.roster_shape.no_cover_positions.includes('QB'),
    JSON.stringify(o.roster_shape.no_cover_positions));
  check('...and a third arm gives it cover',
    !buildOutlook(outlookSnap(
      [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb3, P.qb2, P.k1, P.df1],
      [P.qb3, P.wr3, P.wr4, P.rb4, P.te2],
      []
    )).roster_shape.no_cover_positions.includes('QB'));
}

{
  // The invariant the fix actually rests on, swept rather than sampled: for
  // every position, no_cover must agree exactly with re-solving the lineup
  // without one body there. The old count agreed by accident on some rosters
  // and not others, which is why one flag could contradict the week walk
  // beside it. Deterministic generator — a flaky suite proves nothing.
  let seed = 20260922;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  let falsePositives = 0, falseNegatives = 0, notSubset = 0, rosters = 0;
  for (let trial = 0; trial < 600; trial++) {
    const n = 1 + Math.floor(rnd() * 18);
    const players = Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, name: `S ${i}`, position: POS[Math.floor(rnd() * POS.length)],
      team: `T${i}`, bye_week: 1 + Math.floor(rnd() * 18), injury_status: null,
    }));
    const starters = players.slice(0, 10);
    while (starters.length < 10) starters.push(null);
    const o = buildOutlook(outlookSnap(starters, players.slice(10), []));
    const sh = o.roster_shape;
    const nc = sh.no_cover_positions;
    rosters++;
    if (!sh.thin_positions.every((x) => nc.includes(x))) notSubset++;
    const qbFlex = (sh.flex_preferences ?? []).filter((f) => f.position === 'QB').length;
    const qbWanted = (sh.dedicated_slots.QB ?? 0) + qbFlex;
    for (const pos of Object.keys(sh.lineup_demand)) {
      const have = sh.active_by_position[pos] ?? 0;
      let breaks;
      if (have === 0) breaks = true;
      else {
        const idx = players.findIndex((x) => x.position === pos);
        const solved = fillSlots(SLOTS, players.filter((_, i) => i !== idx));
        breaks = solved.empty.length > 0 || (pos === 'QB' && qbFlex > 0 && qbWanted > have - 1);
      }
      if (nc.includes(pos) && !breaks) falsePositives++;
      if (!nc.includes(pos) && breaks) falseNegatives++;
    }
  }
  check(`no_cover never names a position that survives losing one body (${rosters} rosters)`,
    falsePositives === 0, `${falsePositives} false positive(s)`);
  check('...and never misses one that does not', falseNegatives === 0, `${falseNegatives} false negative(s)`);
  check('...and thin stays a subset of it throughout', notSubset === 0, `${notSubset} roster(s)`);
}

// A flat "2+ byes" threshold flagged any two unrelated players sharing a
// week as crunch even with a full bench sitting behind them — burying the
// weeks that actually can't field a legal kicker or defense in a longer list
// that meant nothing.
console.log('\noutlook — a bye-only week is only crunch when it actually costs something');

{
  const base = outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1],
    [P.qb3, P.rb4, P.rb5, P.wr4, P.safe_rb, P.safe_wr],
    []
  );
  const o = buildOutlook(base);
  const w4 = o.weeks.find((w) => w.week === 4);
  check('two bench players sharing a bye with depth to spare is not itself a crunch',
    !o.crunch_weeks.includes(4) && !w4.empty_slots && !w4.downgraded_slots && w4.bench_depth > 0,
    JSON.stringify(w4));
}
{
  const base = outlookSnap(
    [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1],
    [P.drain_rb, P.drain_wr],
    []
  );
  const o = buildOutlook(base);
  const w3 = o.weeks.find((w) => w.week === 3);
  check('...but the same shape of bye pair IS a crunch once it drains bench depth to zero',
    o.crunch_weeks.includes(3) && !w3.empty_slots && w3.bench_depth === 0,
    JSON.stringify(w3));
}
{
  // Control: the QB-bye week from the SUPER_FLEX block above stays a crunch
  // week under the tightened rule too — it earns it on downgraded_slots, not
  // on the bye count, so tightening the bye clause must not touch it.
  const base = outlookSnap([P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1], [P.qb3, P.rb4, P.rb5, P.wr4], [P.rb3]);
  const o = buildOutlook(base);
  check('a week already flagged by downgraded_slots is untouched by the bye-only tightening',
    o.crunch_weeks.includes(13), JSON.stringify(o.crunch_weeks));
}

// scripts/sync.mjs always does a live fetch at import time (no CLI guard, per
// its own usage comment), so it can't be imported or run here the way
// outlook.mjs is — the guard is pulled out of the file as text and run
// standalone instead, the same way section 8 below runs a slice of
// docs/index.html's script through vm rather than a browser.
// "Which defense do I stream" is a weekly question, and the snapshot could not
// answer the half that decides it: who each team plays. The full-season
// schedule was fetched on every sync (it is where byes come from) and thrown
// away except for the current week. Kicker and defense were also the two
// positions whose free-agent pool was capped — at 8 of 19 unrostered defenses,
// sorted by how many people had added them, which is the opposite of where a
// good matchup hides.
// An `fcfs` add was rejected on games_have_started alone, which is only right
// until the week's waiver run happens. Afterwards Sleeper hands the pool back
// out first-come-first-serve for the rest of the week — and that window is
// exactly when a streamed defense or kicker gets picked up, after Thursday's
// news rather than in Tuesday's blind bids. So the mode a weekly stream needs
// was the one mode the compiler refused in season.
console.log('\nfirst-come-first-serve is read off the transaction log, not the calendar');

{
  const base = { games_have_started: true, week: 3, transactions: [] };
  check('before any game, the pool is open — that is pre-season',
    freeAgencyIsOpen({ ...base, games_have_started: false }) === true);
  check('in season with no evidence yet, we do NOT claim it is open',
    freeAgencyIsOpen(base) === false);
  check('a completed free-agent ADD this week proves the pool is open',
    freeAgencyIsOpen({ ...base, transactions: [
      { type: 'free_agent', status: 'complete', week: 3, adds: [{ id: 'x' }] }] }) === true);
  check('...but a drop-only free-agent move proves nothing about adding',
    freeAgencyIsOpen({ ...base, transactions: [
      { type: 'free_agent', status: 'complete', week: 3, adds: [], drops: [{ id: 'x' }] }] }) === false);
  check('...nor does a waiver claim, which is the opposite of first-come-first-serve',
    freeAgencyIsOpen({ ...base, transactions: [
      { type: 'waiver', status: 'complete', week: 3, adds: [{ id: 'x' }] }] }) === false);
  check('...nor does last week\'s open pool, which has since closed and reopened',
    freeAgencyIsOpen({ ...base, transactions: [
      { type: 'free_agent', status: 'complete', week: 2, adds: [{ id: 'x' }] }] }) === false);
  check('...nor a free-agent add that failed',
    freeAgencyIsOpen({ ...base, transactions: [
      { type: 'free_agent', status: 'failed', week: 3, adds: [{ id: 'x' }] }] }) === false);
}
{
  // End to end: the same fcfs add is refused without evidence and accepted
  // with it, so the guard still catches a stale mode rather than waving it
  // through — "add now, $0" about a player who actually locks until
  // Wednesday is the mistake with a deadline attached.
  const closed = fixture({ games_have_started: true, transactions: [] });
  const dirClosed = await sandbox(closed, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'fcfs', urgency: 'now', why: 'Claims it is a race.' }]),
  });
  const rClosed = runActions(dirClosed, ['--check', 'reports/2026-09-15-waivers.md']);
  check('an fcfs add with nothing showing the pool is open fails --check',
    rClosed.code === 1 && /first-come-first-serve yet/.test(rClosed.out), `code=${rClosed.code}\n${rClosed.out}`);

  const open = fixture({ games_have_started: true, transactions: [
    { week: 2, at: Date.now(), type: 'free_agent', status: 'complete', by: ['Them'],
      adds: [{ id: 'fa3', name: 'Free Three', position: 'WR', team: 'TTT', bye_week: 3, injury_status: null }], drops: [], faab_bid: null }] });
  const dirOpen = await sandbox(open, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa1', mode: 'fcfs', urgency: 'now', why: 'The pool really is open.' }]),
  });
  const rOpen = runActions(dirOpen, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...and passes once this week\'s log shows an instant add', rOpen.code === 0, `code=${rOpen.code}\n${rOpen.out}`);
}

console.log('\nstream — the weekly kicker/defense question, grounded in the schedule');

const streamSnap = (overrides = {}) => ({
  week: 3,
  my_roster_id: 1,
  league: { roster_positions: [...SLOTS, 'BN'], playoff_week_start: 15 },
  teams: [{
    roster_id: 1, owner: 'Me',
    starters: [{ id: 'CHI', name: 'Chicago Bears', position: 'DEF', team: 'CHI', bye_week: 10 },
               { id: 'k1', name: 'Kick One', position: 'K', team: 'LAC', bye_week: 7 }],
    bench: [], reserve: [],
  }],
  available: {
    DEF: [
      { id: 'NYG', name: 'New York Giants', position: 'DEF', team: 'NYG', bye_week: 8, net_adds: 999 },
      { id: 'ARI', name: 'Arizona Cardinals', position: 'DEF', team: 'ARI', bye_week: 3, net_adds: 0 },
      { id: 'BUF', name: 'Buffalo Bills', position: 'DEF', team: 'BUF', bye_week: 7, net_adds: 1 },
    ],
    K: [{ id: 'k9', name: 'Kick Nine', position: 'K', team: 'DAL', bye_week: 14, net_adds: 5 }],
  },
  team_schedule: {
    CHI: { 3: 'PHI', 4: '@GB', 10: 'BYE', 17: 'DET', 18: '@MIN' },
    NYG: { 3: 'TEN', 4: 'BYE', 10: '@DAL', 17: 'PHI', 18: 'DAL' },
    ARI: { 3: 'BYE', 4: 'SF', 10: 'LAR', 17: 'SEA', 18: 'SF' },
    BUF: { 3: 'LAC', 4: '@NE', 10: 'KC', 17: '@NYJ', 18: 'MIA' },
    LAC: { 3: '@LV', 4: 'DEN', 10: 'PIT', 17: 'KC', 18: '@DEN' },
    DAL: { 3: 'BAL', 4: '@NYG', 10: 'NYG', 17: 'WAS', 18: '@PHI' },
  },
  ...overrides,
});

{
  check('a home game parses as home', JSON.stringify(parseOpponent('PHI')) === '{"opp":"PHI","at":false}');
  check('an @ prefix parses as away', JSON.stringify(parseOpponent('@GB')) === '{"opp":"GB","at":true}');
  check('a bye is null, not a guess', parseOpponent('BYE') === null);
  check('a missing week is null too, so "no game" is never invented',
    parseOpponent(undefined) === null && parseOpponent('') === null);
}
{
  const r = streamOptions(streamSnap());
  check('what I hold comes back with its real opponent',
    r.held.length === 1 && r.held[0].team === 'CHI' && r.held[0].opponent.opp === 'PHI'
      && r.held[0].opponent.at === false && r.held[0].starting === true,
    JSON.stringify(r.held));
  check('...and is playable, so no add is forced', r.must_add === false);
  check('a candidate on bye this week is not offered as an option',
    r.playable_candidates.every((c) => c.team !== 'ARI') && r.on_bye_candidates.some((c) => c.team === 'ARI'),
    JSON.stringify({ playable: r.playable_candidates.map((c) => c.team), bye: r.on_bye_candidates.map((c) => c.team) }));
  check('...and every candidate offered carries the opponent that decides it',
    r.playable_candidates.every((c) => c.opponent && typeof c.opponent.opp === 'string'),
    JSON.stringify(r.playable_candidates));
  // The whole point of uncapping the pool: attention must not be the order.
  check('candidates are alphabetical, NOT sorted by how many people added them',
    JSON.stringify(r.playable_candidates.map((c) => c.team)) === '["BUF","NYG"]',
    JSON.stringify(r.playable_candidates.map((c) => [c.team, c.net_adds])));
}
{
  // The week the answer actually matters: nothing I hold can play.
  const r = streamOptions(streamSnap(), { week: 10 });
  check('the week my defense is on bye says so outright',
    r.must_add === true && r.held[0].playable === false, JSON.stringify(r.held));
  check('...and still offers the free defenses that can play it',
    r.playable_candidates.length === 3, JSON.stringify(r.playable_candidates.map((c) => c.team)));
}
{
  // A kicker is found by the team he plays for; a defense IS its team. Getting
  // this backwards would silently return "no game" for every kicker.
  const r = streamOptions(streamSnap(), { week: 3, position: 'K' });
  check('a kicker resolves through his NFL team, not his player id',
    r.held.length === 1 && r.held[0].team === 'LAC' && r.held[0].opponent.opp === 'LV' && r.held[0].opponent.at === true,
    JSON.stringify(r.held));
  check('...and the kicker pool is read, not the defense pool',
    r.playable_candidates.length === 1 && r.playable_candidates[0].team === 'DAL',
    JSON.stringify(r.playable_candidates));
}
{
  const rows = streamSeason(streamSnap());
  const weeks = rows.map((r) => r.week);
  check('the season view stops at the last fantasy week — W18 is not a week this league plays',
    !weeks.includes(18) && weeks.includes(17), JSON.stringify(weeks));
  check('...and marks the fantasy playoffs',
    rows.find((r) => r.week === 17).playoffs === true && rows.find((r) => r.week === 3).playoffs === false);
  check('...and flags exactly the weeks nothing I hold can play',
    JSON.stringify(rows.filter((r) => r.must_add).map((r) => r.week)) === '[10]',
    JSON.stringify(rows.filter((r) => r.must_add).map((r) => r.week)));
}
{
  // buildTeamSchedule, pinned the same way as buildGames below: a bye has to
  // be stated, not left as a missing key for a reader to interpret.
  const src = readFileSync(path.join(root, 'scripts', 'sync.mjs'), 'utf8');
  const from = src.indexOf('function buildTeamSchedule');
  const to = src.indexOf('\n}', from) + 2;
  check('sync.mjs still carries buildTeamSchedule as one pure function', from !== -1 && to > from);
  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(src.slice(from, to) + ';this.buildTeamSchedule=buildTeamSchedule;').runInContext(ctx);
  const sched = [
    { week: 3, home: 'CHI', away: 'PHI', status: 'pre_game' },
    { week: 3, home: 'GB', away: 'DAL', status: 'pre_game' },
    { week: 4, home: 'GB', away: 'CHI', status: 'pre_game' },
    { week: 2, home: 'CHI', away: 'MIN', status: 'complete' },
    { week: 5, home: 'CHI', away: 'DAL', status: 'canceled' },
  ];
  const out = ctx.buildTeamSchedule(sched, 3);
  check('home and away are distinguishable', out.CHI[3] === 'PHI' && out.CHI[4] === '@GB', JSON.stringify(out.CHI));
  check('a week with no game is spelled BYE rather than omitted',
    out.PHI[4] === 'BYE' && out.DAL[4] === 'BYE', JSON.stringify({ PHI: out.PHI, DAL: out.DAL }));
  check('weeks already played are left out', !(2 in out.CHI), JSON.stringify(out.CHI));
  check('a canceled game is not a game', !(5 in out.CHI) || out.CHI[5] === 'BYE', JSON.stringify(out.CHI));
}
{
  // The cap that hid eleven of nineteen defenses.
  const src = readFileSync(path.join(root, 'scripts', 'sync.mjs'), 'utf8');
  const m = src.match(/const POOL_CAP = \{([^}]*)\}/);
  check('sync.mjs still declares POOL_CAP', !!m);
  const caps = Object.fromEntries((m?.[1] ?? '').split(',').map((kv) => kv.split(':').map((x) => x.trim())).filter((kv) => kv.length === 2));
  check('the streamed positions are not capped below the whole league',
    Number(caps.DEF) >= 32 && Number(caps.K) >= 32, JSON.stringify(caps));
}

console.log('\nsync — the Tuesday/Wednesday assumption is checked, not just typed');

{
  const src = readFileSync(path.join(root, 'scripts', 'sync.mjs'), 'utf8');
  const from = src.indexOf('function waiverAssumptionWarning');
  const to = src.indexOf('\n}', from) + 2;
  check('sync.mjs still carries the waiver-assumption guard as one pure function', from !== -1 && to > from);

  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(src.slice(from, to) + ';this.waiverAssumptionWarning=waiverAssumptionWarning;').runInContext(ctx);

  check('the values every doc and skill assumes (Tuesday/Wednesday) warn about nothing',
    ctx.waiverAssumptionWarning({ waiver_day_of_week: 2, waiver_clear_days: 2 }) === null);
  check('a changed processing day is a loud warning, not a silent stale assumption',
    /waiver_day_of_week=3/.test(ctx.waiverAssumptionWarning({ waiver_day_of_week: 3, waiver_clear_days: 2 }) ?? ''));
  check('a changed clear window warns too, independent of the day',
    /waiver_clear_days=1/.test(ctx.waiverAssumptionWarning({ waiver_day_of_week: 2, waiver_clear_days: 1 }) ?? ''));
}

{
  // buildGames turns the raw schedule into snapshot.games, pulled out and
  // pinned the same way as waiverAssumptionWarning above, so a future
  // "helpfully" synthesized kickoff time, or a week filter that lets a bye
  // team's old game leak through, breaks the suite instead of shipping quietly.
  const src = readFileSync(path.join(root, 'scripts', 'sync.mjs'), 'utf8');
  const from = src.indexOf('function buildGames');
  const to = src.indexOf('\n}', from) + 2;
  check('sync.mjs still carries buildGames as one pure function', from !== -1 && to > from);

  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(src.slice(from, to) + ';this.buildGames=buildGames;').runInContext(ctx);

  const schedule = [
    { week: 2, date: '2026-09-20', home: 'ARI', away: 'SEA', status: 'pre_game', game_id: 'a' },
    { week: 2, date: '2026-09-17', home: 'BUF', away: 'DET', status: 'complete', game_id: 'b' },
    { week: 2, date: '2026-09-21', home: 'LAR', away: 'NYG', status: 'canceled', game_id: 'c' },
    // A different week's game for a team that's on bye in week 2 — proves
    // the filter is on week, not just "have I seen this team before".
    { week: 1, date: '2026-09-13', home: 'KC', away: 'MIA', status: 'complete', game_id: 'd' },
  ];
  const games = ctx.buildGames(schedule, 2);

  check('a team playing this week gets an entry naming its opponent',
    games.ARI?.opponent === 'SEA' && games.SEA?.opponent === 'ARI', JSON.stringify(games.ARI));
  check("kickoff is exactly the schedule's bare date — never a synthesized time or timezone",
    games.ARI.kickoff === '2026-09-20' && !/[T:]/.test(games.ARI.kickoff), games.ARI.kickoff);
  check('home/away is recorded per side, not copied from one team onto both',
    games.ARI.home === true && games.SEA.home === false);
  check('status passes through as the schedule has it, canceled included — silence would read as no game at all',
    games.LAR?.status === 'canceled', JSON.stringify(games.LAR));
  check("a team on bye this week (or only seen in another week's game) gets no entry",
    games.KC === undefined && games.MIA === undefined, JSON.stringify(Object.keys(games)));
  check('teams are sorted by code for a stable read, not schedule order',
    JSON.stringify(Object.keys(games)) === JSON.stringify([...Object.keys(games)].sort()), Object.keys(games).join(','));
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

  // The players dump keeps every id Sleeper has ever issued, retired and
  // inactive included — resolving one clean handed back a fully-available
  // body with no team and no bye, ever. `retired1` has team: null in the
  // synthetic dump the same way a real retired player does (see the P
  // fixture comment), and is on no roster, so --add must fall through to
  // the dump and reject it there, not fabricate a body from it.
  const retiredAdd = runOutlook(dir, ['--add', 'retired1']);
  check('adding a retired/teamless player id from the dump is rejected, not fabricated',
    retiredAdd.code === 1 && /Cannot add "retired1"/.test(retiredAdd.out), retiredAdd.out);

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
  // written_at moves too, and legitimately: the first compile saw an
  // uncommitted report (mtime), the recompile sees its commit time. Both are
  // metadata, and publish-report.mjs ignores both when deciding whether a
  // rebase-recompile is worth a commit — so the churn check here must too.
  const substance = (doc) => JSON.stringify({ ...doc, compiled_at: 0,
    sources: Object.fromEntries(Object.entries(doc.sources ?? {}).map(([k, v]) => [k, { ...v, written_at: 0 }])) });
  check('a repeat compile changes only compiled_at and written_at', first.compiled_at !== second.compiled_at &&
    substance(first) === substance(second));
  check('...and written_at moved from mtime to commit time once the report was committed',
    first.sources?.lineup?.written_at !== second.sources?.lineup?.written_at, JSON.stringify([first.sources, second.sources]));
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
    // A start still open once a kickoff has passed is the newest way for the two sides to
    // disagree: the engine reads snapshot.games (scripts/actions.mjs kickedOffGame), the card
    // reads live.games (docs/index.html teamKickedOff) — two different shapes of the same fact,
    // built from two different feeds, that have to land on the same verdict.
    ['start blocked by its own kickoff', (()=>{const f=fixture(); f.games={
        BBB:{kickoff:'2026-09-21',status:'pre_game',opponent:'CCC',home:true},
        CCC:{kickoff:'2026-09-21',status:'in_game',opponent:'BBB',home:false}}; return f;})(),
      { kind:'start', player:'qb3', for:'qb2', slot:'SUPER_FLEX', team:'CCC' }],
    ['start blocked by the benched side\'s kickoff', (()=>{const f=fixture(); f.games={
        BBB:{kickoff:'2026-09-21',status:'in_game',opponent:'CCC',home:true},
        CCC:{kickoff:'2026-09-21',status:'pre_game',opponent:'BBB',home:false}}; return f;})(),
      { kind:'start', player:'qb3', for:'qb2', slot:'SUPER_FLEX', team:'CCC' }],
    ['start still open — both games still pre_game', (()=>{const f=fixture(); f.games={
        BBB:{kickoff:'2026-09-21',status:'pre_game',opponent:'CCC',home:true},
        CCC:{kickoff:'2026-09-21',status:'pre_game',opponent:'BBB',home:false}}; return f;})(),
      { kind:'start', player:'qb3', for:'qb2', slot:'SUPER_FLEX', team:'CCC' }],
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
    // scripts/actions.mjs keys a game by {status, kickoff, opponent, home}; docs/index.html's
    // gamesByTeam keys it by {started, live, over, ...} off a richer live feed — translated here
    // so one fixture (snap.games) can drive both sides of the comparison.
    const games = snap.games && Object.fromEntries(Object.entries(snap.games).map(([team, g]) =>
      [team, { started: g.status !== 'pre_game', live: g.status === 'in_game', over: g.status === 'complete' }]));
    const teamOf = (id) => {
      const p = snap.teams.flatMap(t => [...t.starters, ...t.bench, ...t.reserve]).filter(Boolean).find(x => x.id === String(id));
      return p ? p.team : null;
    };
    const live = { week: snap.week, players: new Set(mineIds), starters: me.starters.filter(Boolean).map(p => p.id),
                   reserve: me.reserve.map(p => p.id), ownerOf, games, teamOf, dismissed: new Set() };
    const page = ctx.actionState({ ...action, week: snap.week }, live).state;
    const engine = lifecycleState(action, snap, buildIndex(snap));
    if (page !== engine) disagreed.push(`${label}: card says "${page}", compiler says "${engine}"`);
  }
  check('all nineteen lifecycle scenarios agree', disagreed.length === 0, disagreed.join('\n'));

  // The scores feed can fail to load independently of the schedule/roster feeds that carry the
  // rest of the page — live.games is then null (see render()'s `got.scores ? gamesByTeam(...) :
  // null`), and a kickoff that has genuinely happened must read as unknown, not as stale, or one
  // blip at Sleeper hides a start Ben still needs to make.
  const missingFeedLive = { week: 2, players: new Set(['qb3']), starters: ['qb1','rb1','rb2','wr1','wr2','te1','wr3','qb2','k1','df1'],
                             reserve: [], ownerOf: () => null, games: null, teamOf: () => 'CCC', dismissed: new Set() };
  const missingFeedState = ctx.actionState({ kind: 'start', player: 'qb3', for: 'qb2', slot: 'SUPER_FLEX', team: 'CCC', week: 2 }, missingFeedLive).state;
  check('a missing scores feed reads a start as open, never stale', missingFeedState === 'open', missingFeedState);
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

console.log('\ndashboard — pickNextCheck orders sources by when they were actually written');

{
  // pickNextCheck is self-contained (no esc, no other do-now helpers), so it's pulled out on its
  // own, the same source-slice + vm technique as buildGames above rather than the whole do-now
  // slice.
  const html = readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const from = src.indexOf('function pickNextCheck');
  const to = src.indexOf('function rosterDrifted');
  check('the page still carries pickNextCheck as one pure function', from !== -1 && to > from);

  const ctx = {};
  vm.createContext(ctx);
  new vm.Script(src.slice(from, to) + ';this.pickNextCheck=pickNextCheck;').runInContext(ctx);

  // Two sources compiled the same day used to be indistinguishable — the filename compare only
  // carries a date, so a 7am waivers run and a 6pm lineup run tied and fell back to alphabetical
  // order (lineup < waivers), silently showing the wrong one's next_check.
  check('written_at (a real timestamp) picks the later same-day source, filenames aside',
    ctx.pickNextCheck({
      waivers: { report: '2026-09-16-waivers.md', next_check: 'Waivers run Tue 7am', written_at: '2026-09-16T07:05:00Z' },
      lineup:  { report: '2026-09-16-lineup.md',  next_check: 'Lineup, Thu 7am',     written_at: '2026-09-16T18:20:00Z' },
    }) === 'Lineup, Thu 7am');
  check('a source with no written_at falls back to the filename compare exactly as before',
    ctx.pickNextCheck({
      waivers: { report: '2026-09-15-waivers.md', next_check: 'Waivers run Tue 7am' },
      lineup:  { report: '2026-09-16-lineup.md',  next_check: 'Lineup, Thu 7am' },
    }) === 'Lineup, Thu 7am');
  check('a stale source is skipped even when its written_at is newest',
    ctx.pickNextCheck({
      waivers: { report: '2026-09-16-waivers.md', next_check: 'Waivers run Tue 7am', written_at: '2026-09-16T07:05:00Z' },
      lineup:  { report: '2026-09-10-lineup.md',  next_check: 'Stale.', written_at: '2026-09-17T09:00:00Z', stale: true },
    }) === 'Waivers run Tue 7am');
  check('no sources at all keeps the empty-state default', ctx.pickNextCheck({}) === 'Waivers run Tue 7am');
  check('a missing sources object keeps the same default', ctx.pickNextCheck(undefined) === 'Waivers run Tue 7am');
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
  // fa3 against the bare fixture is a THIRD active WR that the lineup's FLEX
  // also starts — "you have 3 — starts 3, no cover" (see the need-line case
  // below), real need, not surplus. Genuine surplus needs a spare body
  // behind what the lineup starts, so give the bench a fourth WR (wr4)
  // first: fa3 would then be a fifth against three starts, with one already
  // spare — the cap has to apply here or it prices real need like a stash.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 15, displaces: null, urgency: 'by_tuesday', why: 'A fifth WR at a starter price.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a genuinely-surplus depth add priced above 10% of remaining FAAB fails --check', r.code === 1 && /starter's price/.test(r.out), r.out);
}
{
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.wr4];
  const dir = await sandbox(snap, {
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
{
  // The cap used to check thin_positions only, so this exact bid failed as
  // "ordinary depth" even though fa3 here is a no_cover WR (three active,
  // all three started via the dedicated slots plus FLEX) — needLine() has
  // called that real need, not depth, all along; the cap now has to agree,
  // or it prices a real need like a stash. Reachable in production as a
  // roster down to two QBs (one QB slot, one SUPER_FLEX): no dedicated slot
  // is short, so thin_positions alone missed it, but losing either QB
  // breaks the lineup all the same.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa3', mode: 'waiver', faab: 30, displaces: null, urgency: 'by_tuesday', why: 'A no-cover WR, priced like the need it is.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...and a no_cover-but-not-thin position is exempt from the cap too, same as needLine treats it',
    r.code === 0, r.out);
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
{
  // qb2 starts SUPER_FLEX in the fixture. Giving him away reads "opens no
  // holes" from the outlook diff alone, because the what-if outlook freely
  // reassigns qb3 (the bench QB) into SUPER_FLEX for its own legal-lineup
  // projection — but that reassignment only happened on paper; the live
  // Sleeper lineup still has SUPER_FLEX empty until Ben makes the swap
  // himself, and trade review is 0 days, so the deal can land minutes
  // before kickoff. Fixed Sep 2026.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb2'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Gives away the current SUPER_FLEX starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('a trade giving away a current starter names the slot it empties',
    /empties SUPERFLEX this week — set a starter there before kickoff/.test(r.out), r.out);
}
{
  // Control: giving away a bench player never empties a starting slot, so
  // the note must not appear.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Gives away a bench QB.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('...but giving away a bench player never triggers it', r.code === 0 && !/empties/.test(r.out), r.out);
}
{
  // outlook-core.mjs's downgraded_slots (a legal-but-worse week: no QB left
  // for a QB-eligible flex slot) never reached diffWeeks, so a trade that
  // only ever creates downgraded weeks — never a fully empty one — still
  // read "opens no holes". With a bench deep enough that no week actually
  // goes empty (rb4/rb5/wr4 added, matching the outlook fixture two sections
  // up), trading qb3 away leaves only qb1 to cover Week 6 — qb2's bye — so
  // SUPER_FLEX there downgrades to a flex body; Week 13 (qb1 and qb3's
  // shared bye) was already downgraded before the trade and is unaffected by
  // it, so this is specifically Week 6 the trade newly breaks. Fixed Sep 2026.
  const snap = fixture();
  snap.teams[0].bench = [P.qb3, P.rb4, P.rb5, P.wr4];
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Spends the only QB covering Week 6.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('a trade that newly downgrades a future SUPER_FLEX week names it',
    /opens a W6 SUPERFLEX downgrade/.test(r.out), r.out);
  check('...and does not also claim the already-downgraded W13 as newly opened',
    !/W13 SUPERFLEX downgrade/.test(r.out), r.out);
}

// A trades report argued an offer was easy because the player was "still on
// Tally241's bench" when the snapshot had him in their STARTING lineup. The
// compiler held that fact and never looked at it, so the card repeated the
// claim and the offer sat unanswered for four days. The partner's own side of
// a deal is computed now, not asserted.
console.log('\n  a trade case — the other manager\'s side, read off their roster');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Asks for a starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('the asks line says the partner STARTS the player being requested',
    /asks: Them starts Other One — one of 1 RB they carry/.test(r.out), r.out);
  check('...and names the shape that does not get accepted',
    /asks them to bench a starter for bench pieces/.test(r.out), r.out);
  check('...and warns about it without failing the report',
    r.code === 0 && /warning — action\[0\] \(trade\): asks Them to give up Other One — in their starting lineup/.test(r.out),
    `code=${r.code}\n${r.out}`);
}
{
  // The same offer, for a player their own bench carries: a real difference
  // in how likely it is to be taken, and the card now shows it.
  const snap = fixture();
  snap.teams = snap.teams.map((t) => (t.roster_id === 2 ? { ...t, bench: [P.opp3] } : t));
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp3'], displaces: null, urgency: 'this_week', why: 'Asks for a bench body.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('a request for a player on the partner\'s bench reads "benches"',
    /asks: Them benches Other Three — one of 2 RBs they carry/.test(r.out), r.out);
  check('...carries no "bench a starter" tail', !/bench a starter for bench pieces/.test(r.out), r.out);
  check('...and raises no warning', !/warning —/.test(r.out), r.out);
}
{
  // Asking for their starter while sending one of mine is an ordinary trade,
  // not the lopsided shape — the tail and the warning must both stay quiet.
  const dir = await sandbox(fixture(), {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['rb1'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Starter for starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('starter-for-starter draws no lopsided tail',
    /asks: Them starts Other One/.test(r.out) && !/bench a starter for bench pieces/.test(r.out), r.out);
  check('...and no warning', !/warning — action\[0\] \(trade\)/.test(r.out), r.out);
}
{
  // An injury tag the partner is carrying belongs on the line too — it is
  // half of what makes an offer look better or worse than it reads.
  const snap = fixture();
  snap.teams[1] = { ...snap.teams[1], starters: [{ ...P.opp1, injury_status: 'Questionable' }, P.opp2] };
  const dir = await sandbox(snap, {
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], displaces: null, urgency: 'this_week', why: 'Hurt starter.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-trades.md']);
  check('the partner-side line carries the incoming player\'s injury tag',
    /asks: Them starts Other One, Questionable/.test(r.out), r.out);
}

// Three open actions on the card at once (a $20 claim for a fourth back and
// two trade offers each bringing a back home), all arguing one thin-RB need,
// none aware of the others: every case is measured against a single baseline,
// so each said "you have 3" while together they made it 5. Rule 1a caught the
// mirror image — two actions SHEDDING a position — and this side went unseen.
// The class of claim the compiler cannot check, and the one these moves turn
// on: a player's role, health or return date. A waivers report argued a $20
// bid with "Charbonnet's return is still weeks off ... not close to being
// activated" while his coach had him on an aggressive timetable targeting
// Week 5 — unfalsifiable prose, and wrong. `evidence` makes the claim an
// explicit, auditable answer, exactly as `displaces` did for "who starts".
console.log('\n  the tradeoff verdict the card reads');

// Byes are what make a week break, so these fixtures put every bye past the
// last fantasy week: the baseline then has no holes at all, and any hole in
// the what-if is one the move itself opened. Reusing the shared fixture here
// measured the move against a roster that was already short, which is a
// different (and much less clear) question.
const noByes = (players) => players.map((q) => ({ ...q, bye_week: 99 }));
const calmSnap = (starters, bench) => {
  const base = fixture();
  return {
    ...base,
    teams: base.teams.map((t) => (t.roster_id === 1
      ? { ...t, starters: noByes(starters), bench: noByes(bench), reserve: [] }
      : t)),
  };
};
const CALM_STARTERS = [P.qb1, P.rb1, P.rb2, P.wr1, P.wr2, P.te1, P.rb4, P.qb2, P.k1, P.df1];

{
  // Drop the only tight end to add a fourth back: the TE slot cannot be
  // filled in any week after it, and nothing on the calendar improves. The
  // shape of the claim that led the card on 2026-09-22.
  const dir = await sandbox(calmSnap(CALM_STARTERS, [P.qb3, P.wr3, P.wr4, P.k2]), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa4', drop: 'te1', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'A back for the only TE.' }]),
  });
  const compiled = runActions(dir, []);
  check('the compile writes the card', compiled.code === 0, compiled.out);
  const doc = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const t = doc.actions[0].case.tradeoff;
  check('a move that opens a hole and closes none is net costs_only',
    t.net === 'costs_only' && t.fixes.length === 0 && t.opens.length > 0, JSON.stringify(t));
  check('...and the opened slots are named, not just counted',
    t.opens.every((o) => typeof o.week === 'number' && typeof o.slot === 'string' && typeof o.kind === 'string')
      && t.opens.every((o) => o.slot === 'TE'),
    JSON.stringify(t.opens));
}
{
  // The same roster, a plain depth add that changes no week either way. The
  // flag has to mean something when it appears, so this must not be flagged.
  const dir = await sandbox(calmSnap(CALM_STARTERS, [P.qb3, P.wr3, P.te2, P.k2]), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'Ordinary depth.' }]),
  });
  runActions(dir, []);
  const doc = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  check('depth that changes nothing on the calendar is neutral',
    doc.actions[0].case.tradeoff.net === 'neutral', JSON.stringify(doc.actions[0].case.tradeoff));
}
{
  // Whatever the fixture, the verdict must agree with the lists it is drawn
  // from — that agreement is the whole reason the card can act on it. The
  // shared fixture is deliberately a messy roster here.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa4', drop: 'te1', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'Messy roster.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'And a trade.' }]),
  });
  runActions(dir, []);
  const doc = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  const withTradeoff = doc.actions.filter((a) => a.case && a.case.tradeoff);
  check('every compiled action carries a tradeoff verdict', withTradeoff.length === doc.actions.length,
    JSON.stringify(doc.actions.map((a) => a.id)));
  check('...and every verdict matches the fixes/opens it came from',
    withTradeoff.every(({ case: c }) => {
      const f = c.tradeoff.fixes.length, o = c.tradeoff.opens.length;
      const want = o && !f ? 'costs_only' : f && !o ? 'fixes_only' : f && o ? 'mixed' : 'neutral';
      return c.tradeoff.net === want;
    }),
    JSON.stringify(withTradeoff.map((a) => a.case.tradeoff.net)));
}

console.log('\n  evidence — the claim a move rests on, or an explicit "none"');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'No evidence key at all.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('an add with no evidence key fails --check',
    r.code === 1 && /evidence is required/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, evidence: null, urgency: 'by_tuesday', why: 'Roster-only call.' }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('...and an explicit null is a real answer, not a missing one', r.code === 0, `code=${r.code}\n${r.out}`);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'Cited.',
      evidence: { note: 'Coach says he is on an aggressive timetable, targeting Week 5.', url: 'https://example.com/news', as_of: '2026-09-22' } }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a well-formed note and link validate', r.code === 0, `code=${r.code}\n${r.out}`);
  const compiled = runActions(dir, []);
  check('...and reach the card through actions.json', compiled.code === 0, compiled.out);
  const doc = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  check('...with the note, the link and the date intact',
    doc.actions[0].evidence.note.startsWith('Coach says') && doc.actions[0].evidence.url === 'https://example.com/news'
      && doc.actions[0].evidence.as_of === '2026-09-22',
    JSON.stringify(doc.actions[0].evidence));
}
{
  // The card turns the url into a link, so a non-http scheme is a script
  // injection rather than a source — refused at write time as well as escaped
  // at render time.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'Bad scheme.',
      evidence: { note: 'Looks like a citation.', url: 'javascript:alert(1)' } }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a non-http(s) evidence url is rejected',
    r.code === 1 && /evidence\.url must be an http\(s\) link/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'Note but no link.',
      evidence: { note: 'Heard it somewhere.' } }]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('a note with no link is rejected — the point is that Ben can check it',
    r.code === 1 && /evidence\.url must be an http\(s\) link/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  // Compile runs over other routines' older reports; one written before the
  // rule must never stop a publish, exactly as with displaces.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': blockRaw([{ kind: 'add', player: 'fa1', mode: 'waiver', faab: 5, displaces: null, urgency: 'by_tuesday', why: 'Predates the rule.' }]),
  });
  const r = runActions(dir, []);
  check('a pre-rule report still compiles, with the gap noted',
    r.code === 0 && /evidence is required/.test(r.out), `code=${r.code}\n${r.out}`);
  const doc = JSON.parse(readFileSync(path.join(dir, 'reports', 'actions.json'), 'utf8'));
  check('...and is marked as missing rather than silently looking sourced',
    doc.actions[0].evidence_missing === true && doc.actions[0].evidence === undefined,
    JSON.stringify(doc.actions[0]));
}

console.log('\n  two actions that buy the same need must know about each other');

{
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'One back.' },
      { kind: 'add', player: 'fa5', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'A second back, unlinked.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('two unlinked adds at one position fail --check',
    r.code === 1 && /each bring in a RB and are not linked/.test(r.out), `code=${r.code}\n${r.out}`);
  check('...and the message says what the roster would actually look like',
    /you carry 4 RB against a lineup that starts 2/.test(r.out), r.out);
}
{
  // The documented way to say "these are alternatives": one claim, not two.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([
      { kind: 'add', id: 'first', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'First choice.' },
      { kind: 'add', id: 'second', if_not: 'first', player: 'fa5', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'Fallback.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('if_not alternatives are one claim on the position, so they pass',
    r.code === 0 && !/each bring in a RB/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  // Genuinely filling a hole must never be flagged: one back for two RB
  // slots wants two arrivals, and ends level rather than two deep.
  const snap = fixture();
  snap.teams = snap.teams.map((t) => (t.roster_id === 1
    ? { ...t, starters: [P.qb1, P.rb1, null, P.wr1, P.wr2, P.te1, P.wr3, P.qb2, P.k1, P.df1] }
    : t));
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'add', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'Fills the empty RB slot.' },
      { kind: 'add', player: 'fa5', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'And the spare behind it.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('two arrivals that only fill a real hole are not a double-buy',
    r.code === 0 && !/each bring in a RB/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  // Two routines each SWAPPING at one position is not a double-buy — each
  // nets zero. Flagging it would have printed "you carry 3 K", a number that
  // is simply untrue; the real conflict, if any, is Rule 1's to report.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa4', drop: 'rb1', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'Swap a back.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['rb2'], get: ['opp1'], urgency: 'this_week', why: 'Swap another back.' }]),
  });
  const r = runActions(dir, []);
  check('two swaps at one position are not a double-buy', !/each bring in a RB/.test(r.out), r.out);
}
{
  // Bringing a body back off IR raises the active count exactly as an add
  // does, so an activate and a claim at one position are two claims on it.
  const snap = fixture();
  snap.teams = snap.teams.map((t) => (t.roster_id === 1 ? { ...t, reserve: [{ ...P.rb3, injury_status: 'Out' }] } : t));
  const dir = await sandbox(snap, {
    '2026-09-15-waivers.md': block([
      { kind: 'activate', player: 'rb3', urgency: 'this_week', why: 'Back off IR.' },
      { kind: 'add', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'And a claim at the same spot.' },
    ]),
  });
  const r = runActions(dir, ['--check', 'reports/2026-09-15-waivers.md']);
  check('an activate plus a claim at one position is caught',
    r.code === 1 && /each bring in a RB and are not linked/.test(r.out), `code=${r.code}\n${r.out}`);
}
{
  // Across sources at compile time it is a warning, not a failure: one
  // routine must never be stopped from publishing by another's open action.
  const dir = await sandbox(fixture(), {
    '2026-09-15-waivers.md': block([{ kind: 'add', player: 'fa4', mode: 'waiver', faab: 2, urgency: 'by_tuesday', why: 'A back on waivers.' }]),
    '2026-09-15-trades.md': block([{ kind: 'trade', with: 2, give: ['qb3'], get: ['opp1'], urgency: 'this_week', why: 'A back by trade.' }]),
  });
  const r = runActions(dir, []);
  check('a cross-source double-buy warns at compile time and still writes the card',
    r.code === 0 && /warning — actions .*each bring in a RB and are not linked/.test(r.out), `code=${r.code}\n${r.out}`);
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
  new vm.Script(escSrc + slice + ';this.actionRow=actionRow;this.caseGrid=caseGrid;this.kindTag=kindTag;this.renderDoNow=renderDoNow;').runInContext(ctx);

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

  // The payoff of `evidence` is that Ben can click it. A note with a good
  // link becomes an anchor; a bad scheme becomes plain text, because this file
  // is re-read from the repo at runtime and must not trust what it finds.
  const cited = { ...openAdd, evidence: { note: 'Coach: aggressive timetable, Week 5 target.', url: 'https://example.com/news', as_of: '2026-09-22' } };
  const citedRow = ctx.actionRow(cited, { now: '14:02' }, { num: 1 });
  check('an open action with evidence renders a clickable source',
    citedRow.includes('class="evidence"') && citedRow.includes('href="https://example.com/news"')
      && citedRow.includes('rel="noopener noreferrer"') && citedRow.includes('Week 5 target.'),
    citedRow);
  check('...and shows the date it was true as of', citedRow.includes('2026-09-22'), citedRow);

  const badScheme = ctx.actionRow({ ...openAdd, evidence: { note: 'Not a source.', url: 'javascript:alert(1)' } }, { now: '14:02' }, { num: 1 });
  check('a non-http evidence url is never turned into a link',
    badScheme.includes('class="evidence"') && !badScheme.includes('href') && !badScheme.includes('javascript:'),
    badScheme);

  const doneCited = ctx.actionRow({ ...cited, state: 'done' }, { now: '14:02' }, { num: 1 });
  check('a finished action drops its source line along with its case',
    !doneCited.includes('class="evidence"'), doneCited);

  // The move that fixes nothing and opens a hole used to be drawn exactly like one that helps,
  // with both facts sitting in the grid below it in the same weight and colour.
  const negative = { ...openAdd, case: { ...openAdd.case, later: 'opens a W11 TE hole',
    tradeoff: { net: 'costs_only', fixes: [], opens: [{ week: 11, slot: 'TE', kind: 'hole' }] } } };
  const negRow = ctx.actionRow(negative, { now: '14:02' }, { num: 1 });
  check('a move that only costs is flagged on the row',
    negRow.includes('class="flag"') && /costs more than it fixes/.test(negRow), negRow);

  for (const net of ['fixes_only', 'mixed', 'neutral']) {
    const row = ctx.actionRow({ ...openAdd, case: { ...openAdd.case, tradeoff: { net, fixes: [], opens: [] } } }, { now: '14:02' }, { num: 1 });
    check(`a ${net} move carries no flag`, !row.includes('class="flag"'), row);
  }
  const doneNeg = ctx.actionRow({ ...negative, state: 'done' }, { now: '14:02' }, { num: 1 });
  check('a finished move is not flagged — the decision is behind us', !doneNeg.includes('class="flag"'), doneNeg);
  const noTradeoff = ctx.actionRow(openAdd, { now: '14:02' }, { num: 1 });
  check('an action from before the field existed is not flagged either',
    !noTradeoff.includes('class="flag"'), noTradeoff);

  check('a start row is tagged lineup', ctx.kindTag({ kind: 'start' }) === 'lineup');
  check('a fcfs add is tagged add, not claim (pre-season, first-come-first-served)',
    ctx.kindTag({ kind: 'add', mode: 'fcfs' }) === 'add');

  // A stale start's own `why` argued for a move that's off the table now — state_reason (when
  // the compiler could name one) takes its place, muted, instead of piling a second explanation on top.
  const staleWithReason = {
    id: 's1', kind: 'start', state: 'stale', urgency: 'before_kickoff',
    name: 'Quinn Five', pos: 'QB', team: 'VVV', for_name: 'Quinn Four', slot: 'SUPER_FLEX',
    why: 'Better matchup this week.', state_reason: "Quinn Five's game has already kicked off (in_game)",
    report: '2026-09-14-lineup.md', source: 'lineup',
  };
  const staleRow = ctx.actionRow(staleWithReason, { now: '14:02' });
  check('a stale row carries the muted state class', staleRow.includes('class="act stale"'), staleRow);
  check('...with a one-word "stale" chip, not a kickoff deadline that has already passed',
    staleRow.includes('<div class="chip">stale</div>'), staleRow);
  check('...and the kickoff reason shown, not the routine\'s now-moot "why"',
    staleRow.includes('Quinn Five') && staleRow.includes('already kicked off') && !staleRow.includes('Better matchup'), staleRow);
  check('...in the same muted .why row every other action\'s "why" already uses',
    staleRow.includes('class="why"'), staleRow);
  check('...no case grid either — the argument for the move is over',
    !staleRow.includes('class="case"'), staleRow);

  // No state_reason (a plain week rollover carries none) — the chip alone has to say it all;
  // CLAUDE.md's dashboard rule is outcomes, not reasoning, so no prose fills the gap.
  const staleNoReason = { ...staleWithReason, state_reason: undefined };
  const staleNoReasonRow = ctx.actionRow(staleNoReason, { now: '14:02' });
  check('a stale row with no reason shows no why line at all', !staleNoReasonRow.includes('class="why"'), staleNoReasonRow);

  // The card used to drop a stale start with no trace at all (see renderDoNow's old `state!=='stale'`
  // filter) — now it's shelved like done/gone/superseded: visible, muted, not mistaken for a live ask.
  const cardHtml = ctx.renderDoNow({
    items: [
      { id: 'o1', kind: 'add', mode: 'waiver', state: 'open', urgency: 'now', name: 'Free Three', pos: 'WR', team: 'TTT', report: '2026-09-16-waivers.md', source: 'waivers' },
      staleWithReason,
    ],
    week: 2, league: '123', now: '14:02',
  });
  check('a stale start does not count toward "N open"', /<b>1 open<\/b>/.test(cardHtml), cardHtml);
  check('...it is named in the shelved summary', /stale \(1\)/.test(cardHtml), cardHtml);
  check('...and its reason is reachable inside that disclosure', /already kicked off/.test(cardHtml), cardHtml);
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
