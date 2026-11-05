// The league's rules, as data, so a change between seasons (or mid-season) is
// noticed instead of discovered. CLAUDE.md quotes these constants in prose and
// docs/LEAGUE.md has gone stale before (a dropped player's bye week sat in it
// for a week); `docs/league-constants.json` is the machine-checked copy:
// sync.mjs compares the live league to it on every run and prints
// LEAGUE RULES CHANGED when they differ, and scripts/new-season.mjs rewrites
// it when a new season's league is adopted.
//
// Pure functions only — importing this does nothing.

// Every setting a recommendation can turn on. If Sleeper adds a field that
// matters, add it here; unknown fields are ignored on purpose, so a harmless
// API addition never raises a false alarm.
export const FACT_KEYS = [
  'teams', 'divisions', 'roster_positions', 'bench_slots', 'reserve_slots', 'taxi_slots',
  'ir_eligible_statuses', 'pass_td', 'rec', 'scoring',
  'waiver_type', 'waiver_budget', 'waiver_bid_min', 'waiver_clear_days', 'waiver_day_of_week',
  'trade_deadline', 'trade_review_days', 'veto_votes_needed', 'trades_disabled', 'draft_pick_trading',
  'max_keepers', 'playoff_teams', 'playoff_week_start', 'median_matchup',
];

export function leagueFacts(league) {
  const out = {};
  for (const k of FACT_KEYS) if (league && k in league) out[k] = league[k];
  return out;
}

// Key order must not matter: Sleeper returns scoring maps in no promised order.
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function diffFacts(expected, actual) {
  const out = [];
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  for (const key of [...keys].sort()) {
    if (!(key in (expected ?? {}))) out.push({ key, was: undefined, now: actual[key], kind: 'new' });
    else if (!(key in (actual ?? {}))) out.push({ key, was: expected[key], now: undefined, kind: 'gone' });
    else if (canon(expected[key]) !== canon(actual[key])) out.push({ key, was: expected[key], now: actual[key], kind: 'changed' });
  }
  return out;
}

// scoring is a map: show only the entries that moved, not two walls of JSON.
export function describeDiff(diffs) {
  const short = (v) => (v === undefined ? '(absent)' : typeof v === 'object' ? canon(v) : String(v));
  const lines = [];
  for (const d of diffs) {
    if (d.key === 'scoring' && d.was && d.now) {
      const keys = new Set([...Object.keys(d.was), ...Object.keys(d.now)]);
      for (const k of [...keys].sort()) {
        if (canon(d.was[k]) !== canon(d.now[k])) lines.push(`scoring.${k}: ${short(d.was[k])} -> ${short(d.now[k])}`);
      }
    } else {
      lines.push(`${d.key}: ${short(d.was)} -> ${short(d.now)}`);
    }
  }
  return lines;
}

// Pick the new season's league out of a user's leagues. Sleeper creates a new
// league every season and links it back (`previous_league_id`), which is the
// reliable match; the name is only a fallback, and two name matches is
// ambiguous — say so rather than pick one.
export function pickNewLeague(leagues, { previousLeagueId, leagueName }) {
  const byLink = leagues.filter((l) => String(l.previous_league_id ?? '') === String(previousLeagueId));
  if (byLink.length === 1) return { league: byLink[0], how: 'previous_league_id' };
  if (byLink.length > 1) return { league: null, how: 'ambiguous', candidates: byLink };
  const byName = leagues.filter((l) => l.name === leagueName);
  if (byName.length === 1) return { league: byName[0], how: 'name' };
  if (byName.length > 1) return { league: null, how: 'ambiguous', candidates: byName };
  return { league: null, how: 'none', candidates: leagues };
}

// The `league` block of the snapshot, from Sleeper's /league payload. One
// definition: sync.mjs writes it on every run and scripts/new-season.mjs
// compares it across seasons, so the two can never disagree about what a
// setting means.
export function buildLeagueBlock(league) {
  return {
    name: league.name,
    teams: league.total_rosters ?? league.settings?.num_teams ?? null,
    divisions: league.settings?.divisions ?? 0,
    roster_positions: league.roster_positions,
    bench_slots: (league.roster_positions ?? []).filter((p) => p === 'BN').length,
    reserve_slots: league.settings?.reserve_slots ?? 0,
    taxi_slots: league.settings?.taxi_slots ?? 0,
    // Which injury designations Sleeper will let into the IR slot. An `ir`
    // recommendation for a player carrying anything else is a move the app
    // will simply refuse.
    ir_eligible_statuses: Object.entries({
      Out: league.settings?.reserve_allow_out,
      Doubtful: league.settings?.reserve_allow_doubtful,
      NA: league.settings?.reserve_allow_na,
      Sus: league.settings?.reserve_allow_sus,
      DNR: league.settings?.reserve_allow_dnr,
      COV: league.settings?.reserve_allow_cov,
    }).filter(([, allowed]) => allowed === 1).map(([status]) => status),
    pass_td: league.scoring_settings?.pass_td,
    rec: league.scoring_settings?.rec,
    scoring: league.scoring_settings,
    waiver_type: league.settings?.waiver_type === 2 ? 'faab' : String(league.settings?.waiver_type ?? ''),
    waiver_budget: league.settings?.waiver_budget,
    waiver_bid_min: league.settings?.waiver_bid_min ?? 0,
    waiver_clear_days: league.settings?.waiver_clear_days,
    // Sleeper counts the week from Sunday, so 2 is Tuesday night's deadline
    // for the Wednesday run.
    waiver_day_of_week: league.settings?.waiver_day_of_week,
    trade_deadline: league.settings?.trade_deadline,
    trade_review_days: league.settings?.trade_review_days,
    veto_votes_needed: league.settings?.veto_votes_needed,
    trades_disabled: league.settings?.disable_trades === 1,
    draft_pick_trading: league.settings?.pick_trading === 1,
    max_keepers: league.settings?.max_keepers ?? 0,
    playoff_teams: league.settings?.playoff_teams,
    playoff_week_start: league.settings?.playoff_week_start,
    // With league_average_match on, every team also plays the league median
    // each week — a second result that rewards a high floor over a boom bench.
    median_matchup: league.settings?.league_average_match === 1,
  };
}
