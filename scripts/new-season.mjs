// Adopt next season's league. Sleeper makes a NEW league (new id, new roster
// ids) every season, so nothing in config.json carries over by itself.
//
//   node scripts/new-season.mjs --season 2027            # look: find the league, show what changed, write nothing
//   node scripts/new-season.mjs --season 2027 --write    # adopt it: config.json + docs/league-constants.json
//
// It does not touch CLAUDE.md or the skills. It prints every rule that moved so
// the prose can be corrected by a person looking at the list, which is the
// whole point: a setting changing silently (FAAB, scoring, a roster slot) is
// how last season's advice gets applied to this season's league.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sleeper from './sleeper.mjs';
import { leagueFacts, diffFacts, describeDiff, pickNewLeague, buildLeagueBlock } from './league-facts.mjs';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const season = opt('--season');
  const write = args.includes('--write');
  if (!season || !/^\d{4}$/.test(season)) { console.error('Usage: node scripts/new-season.mjs --season <YYYY> [--write]'); process.exit(1); }

  const configPath = path.join(root, 'config.json');
  const constantsPath = path.join(root, 'docs', 'league-constants.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  let expected = null;
  try { expected = JSON.parse(await readFile(constantsPath, 'utf8')); } catch { /* first adoption */ }

  const leagues = await sleeper.getUserLeagues(config.user_id, season);
  if (!leagues?.length) { console.error(`Sleeper lists no ${season} league for ${config.username}. The new league usually appears when the commissioner rolls it over — try again later.`); process.exit(2); }
  const pick = pickNewLeague(leagues, { previousLeagueId: config.league_id, leagueName: config.league_name });
  if (!pick.league) {
    console.error(`Could not choose a ${season} league (${pick.how}). Candidates:`);
    for (const l of pick.candidates) console.error(`  ${l.league_id}  ${l.name}  (previous ${l.previous_league_id ?? 'none'})`);
    console.error('Set league_id in config.json by hand, then rerun with --write.');
    process.exit(2);
  }
  const league = await sleeper.getLeague(pick.league.league_id);
  const rosters = await sleeper.getRosters(league.league_id);
  const mine = rosters.find((r) => String(r.owner_id) === String(config.user_id));
  if (!mine) { console.error(`${config.username} owns no roster in ${league.name} (${league.league_id}). Not adopting it.`); process.exit(2); }

  const facts = leagueFacts(buildLeagueBlock(league));

  console.log(`${league.name} ${season}: league ${league.league_id} (matched by ${pick.how}), roster ${mine.roster_id}, status ${league.status}`);
  if (!expected) {
    console.log('No docs/league-constants.json yet — this will be the baseline.');
  } else {
    const lines = describeDiff(diffFacts(expected.facts, facts));
    console.log(lines.length ? `\nRULES THAT CHANGED since ${expected.season} — correct CLAUDE.md, docs/LEAGUE.md and the skills where they quote these:\n${lines.map((l) => `  - ${l}`).join('\n')}` : '\nNo rule changed from last season.');
  }
  console.log('\nAlso by hand: routine crons/prompts live in the claude.ai UI (docs/ROUTINES.md); the dashboard URL and ask_url do not change; docs/SEASON-PLAN.md and docs/RESUME.md need a fresh state section.');

  if (write) {
    await writeFile(configPath, JSON.stringify({ ...config, season, league_id: league.league_id, roster_id: mine.roster_id, league_name: league.name }, null, 2) + '\n');
    await writeFile(constantsPath, JSON.stringify({ season, league_id: league.league_id, facts }, null, 2) + '\n');
    console.log(`\nWrote config.json and docs/league-constants.json. Next: node scripts/sync.mjs`);
  } else {
    console.log('\n(dry run — rerun with --write to adopt it)');
  }
}
