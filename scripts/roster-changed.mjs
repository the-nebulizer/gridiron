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
// Slot assignment matters (starters vs bench vs IR), not just membership.
const material = {
  starters: me.starters.map((p) => p?.id ?? null),
  bench: me.bench.map((p) => p.id).sort(),
  reserve: me.reserve.map((p) => p.id).sort(),
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
console.log(previous.fingerprint === fingerprint ? 'UNCHANGED' : 'CHANGED');
