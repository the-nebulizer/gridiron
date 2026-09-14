// Detect whether Ben's roster has changed since reports were last generated.
// Compares a fingerprint of the current snapshot (run sync.mjs first) against
// the committed reports/.roster-fingerprint.json.
//
// Usage:
//   node scripts/roster-changed.mjs            # prints CHANGED or UNCHANGED, exits 0
//   node scripts/roster-changed.mjs --update   # writes the current fingerprint
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(
  await readFile(path.join(root, 'data', 'league', 'snapshot.json'), 'utf8')
);
const fpFile = path.join(root, 'reports', '.roster-fingerprint.json');

const me = snapshot.teams.find((t) => t.roster_id === snapshot.my_roster_id);
// Slot assignment matters (starters vs bench vs IR), not just membership — and so
// does a player's status changing underneath you. Someone going to IR while sitting
// on the bench never moves between slots, so membership alone stays quiet: that is
// how Malik Davis's hip injury went unreported until Ben noticed the dead roster
// spot himself. Questionable is deliberately left out — it flips week to week and
// would force a full regeneration for a tag that changes no decision.
const MATERIAL_STATUS = /^(out|ir|pup|doubtful|sus|na)$/i;
const roster = [...me.starters, ...me.bench, ...me.reserve].filter(Boolean);
const material = {
  starters: me.starters.map((p) => p?.id ?? null),
  bench: me.bench.map((p) => p.id).sort(),
  reserve: me.reserve.map((p) => p.id).sort(),
  hurt: roster
    .filter((p) => MATERIAL_STATUS.test(p.injury_status ?? ''))
    .map((p) => `${p.id}:${p.injury_status}`)
    .sort(),
};
const fingerprint = createHash('sha256').update(JSON.stringify(material)).digest('hex');

if (process.argv.includes('--update')) {
  await writeFile(
    fpFile,
    JSON.stringify({ fingerprint, updated_at: snapshot.fetched_at, roster: material }, null, 2)
  );
  console.log(`fingerprint written: ${fingerprint}`);
  process.exit(0);
}

let previous = null;
try {
  previous = JSON.parse(await readFile(fpFile, 'utf8'));
} catch {
  console.log('CHANGED (no previous fingerprint)');
  process.exit(0);
}
if (previous.fingerprint === fingerprint) {
  console.log('UNCHANGED');
  process.exit(0);
}

// Name what moved, so the run doesn't have to work it out from raw ids — and so a
// status change, the case nothing else catches, is stated outright.
console.log('CHANGED');
const name = new Map(roster.map((p) => [p.id, `${p.name} (${p.position})`]));
const before = previous.roster ?? {};
const wasOn = new Set([...(before.starters ?? []), ...(before.bench ?? []), ...(before.reserve ?? [])].filter(Boolean));
const nowOn = new Set([...material.starters, ...material.bench, ...material.reserve].filter(Boolean));
for (const id of nowOn) if (!wasOn.has(id)) console.log(`  added: ${name.get(id) ?? id}`);
for (const id of wasOn) if (!nowOn.has(id)) console.log(`  dropped: ${id}`);
const wasHurt = new Set(before.hurt ?? []);
for (const h of material.hurt) {
  if (wasHurt.has(h)) continue;
  const [id, status] = h.split(':');
  if (nowOn.has(id) && wasOn.has(id)) console.log(`  now ${status}: ${name.get(id) ?? id}`);
}
