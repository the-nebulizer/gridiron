// The block-or-trade-chip check, every waiver run (CLAUDE.md "Never pass on a
// contested player without asking who else gains").
//
//   node scripts/denial.mjs                       # every candidate that is more than "NO", worst threat first
//   node scripts/denial.mjs --player <id>         # one player in full, team by team
//   node scripts/denial.mjs --partner annaf23     # flag teams I'm negotiating with (also read from open trade actions)
//   node scripts/denial.mjs --all                 # include the NO rows
//   --json
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { denialTable, denialRow, candidatePool, bidMarket, OPPONENT_THIS_WEEK_GAIN, RIVAL_ROS_GAIN, RIVAL_PLAYOFF_GAIN, CHIP_ROS_GAIN, OWN_MERIT_GAIN } from './denial-core.mjs';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const snapshot = JSON.parse(await readFile(path.join(root, 'data/league/snapshot.json'), 'utf8'));
  if (!snapshot.production) { console.error('Snapshot has no production data — run node scripts/sync.mjs first.'); process.exit(1); }
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const json = args.includes('--json');

  // Trade partners: anyone with an open trade action on the card, plus --partner.
  const partners = [];
  try {
    const card = JSON.parse(await readFile(path.join(root, 'reports/actions.json'), 'utf8'));
    for (const a of card.actions ?? []) if (a.kind === 'trade' && a.with) {
      const t = snapshot.teams.find((x) => x.roster_id === a.with); if (t) partners.push(t.owner);
    }
  } catch { /* no card yet */ }
  if (opt('--partner')) partners.push(...opt('--partner').split(','));

  const pad = (s, n) => String(s ?? '-').padEnd(n);
  const lp = (s, n) => String(s ?? '-').padStart(n);
  const sg = (x) => (x > 0 ? `+${x}` : `${x}`);

  if (opt('--player')) {
    const p = candidatePool(snapshot).find((x) => x.id === opt('--player'));
    if (!p) { console.error('Not in the unrostered pool (or already rostered).'); process.exit(1); }
    const row = denialRow(snapshot, p, { partners });
    if (json) { console.log(JSON.stringify(row, null, 2)); process.exit(0); }
    console.log(`${row.name} (${row.pos} ${row.team}) — ${row.verdict}: ${row.reason}`);
    console.log(`  me: ${row.own ? `${sg(row.own.this_week)} now, ${sg(row.own.rest_of_season)} rest of season, ${sg(row.own.playoffs)} playoffs (best drop ${row.own.drop}, net of cover ${sg(row.own.net)})` : 'n/a'}`);
    console.log(`  bidding so far: ${row.demand.claimants.join(', ') || 'nobody'}${row.demand.dropped_by ? `; dropped by ${row.demand.dropped_by}` : ''}`);
    console.log(`  ${pad('team', 16)} ${pad('relation', 20)} ${lp('rank', 4)} ${lp('FAAB', 5)} ${lp('now', 6)} ${lp('ROS', 6)} ${lp('playoffs', 9)}  flags`);
    for (const t of [...row.teams].sort((a, b) => b.rest_of_season - a.rest_of_season)) {
      const flags = [t.material && 'THREAT', t.buyer && 'buyer', t.contesting && 'bid on him', t.partner && 'trade partner'].filter(Boolean).join(', ');
      console.log(`  ${pad(t.owner, 16)} ${pad(t.relation, 20)} ${lp(t.rank, 4)} ${lp(`$${t.faab}`, 5)} ${lp(sg(t.this_week), 6)} ${lp(sg(t.rest_of_season), 6)} ${lp(sg(t.playoffs), 9)}  ${flags}`);
    }
    process.exit(0);
  }

  const rows = denialTable(snapshot, { partners }).filter((r) => args.includes('--all') || r.verdict !== 'NO');
  if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  console.log(`Block / trade-chip check — Week ${snapshot.week}. Trade partners flagged: ${partners.join(', ') || 'none'}`);
  console.log(`  A team is a THREAT when it would start him and matters to my season: opponent this week (+${OPPONENT_THIS_WEEK_GAIN} now), or a direct rival / bubble team (+${RIVAL_ROS_GAIN} rest of season and +${RIVAL_PLAYOFF_GAIN} in the playoffs). A BUYER starts him for +${CHIP_ROS_GAIN}.`);
  if (!rows.length) console.log('\n  Nobody on the wire is a block or trade-chip case this week.');
  for (const r of rows) {
    console.log(`\n  ${r.verdict.padEnd(21)} ${r.name} (${r.pos} ${r.team}) — ${r.reason}`);
    console.log(`    me: ${r.own ? `${sg(r.own.this_week)} now / ${sg(r.own.rest_of_season)} ROS (drop ${r.own.drop})` : 'n/a'} · bidding so far: ${r.demand.claimants.join(', ') || 'nobody'}`);
    if (r.cuff_for.length) console.log(`    handcuff to: ${r.cuff_for.map((c) => `${c.player} ${c.status} (${c.mine ? 'mine' : `${c.owner}, ${c.relation}`})`).join('; ')}`);
    for (const t of (r.threats.length ? r.threats : r.buyers).slice(0, 4)) {
      console.log(`    ${r.threats.length ? 'threat' : 'buyer '} ${pad(t.owner, 14)} ${pad(t.relation, 19)} $${t.faab} left · ${sg(t.this_week)} now, ${sg(t.rest_of_season)} ROS, ${sg(t.playoffs)} playoffs${t.partner ? ' · TRADE PARTNER' : ''}`);
    }
    if (r.demand.bids.length) console.log(`    bids on him last run: ${r.demand.bids.map((b) => `${b.by} $${b.faab}${b.won ? ' (won)' : ' (lost)'}`).join(', ')}`);
    for (const b of r.price.to_beat) console.log(`    to out-bid ${b.owner}: they have paid up to $${b.top_paid} this season and have $${b.faab} left, so about $${b.bid_needed} (blind bids — evidence, not a quote)`);
  }
  const m = bidMarket(snapshot);
  console.log(`\n  Real prices last run: ${m.claims} winning claims, ${m.at_zero} at $0; paid: ${m.paid.map((x) => `$${x.faab} ${x.player} (${x.by})`).join(', ') || 'none'}. Every bid amount in the log is real, losers included.`);
  console.log('\n  This is evidence, not a decision: the report says whether the block or chip is worth the FAAB and the roster spot, and names the player dropped for it.');
}
