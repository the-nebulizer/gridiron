// Publish a finished report to `main`, where the dashboard reads from.
//
// Scheduled runs happen on their own session branch, so an ordinary commit and
// push leaves the report on a branch nobody looks at — indistinguishable from
// never having written it. That is exactly how four reports were lost between
// Sep 3 and Sep 8. This pushes HEAD to main explicitly, rebases once if the
// branch moved underneath, and fails loudly with the fallback if it can't.
//
// Usage: node scripts/publish-report.mjs <file> "<commit message>" [--dry-run]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [file, message] = args.filter((a) => a !== '--dry-run');

if (!file || !message) {
  console.error('Usage: node scripts/publish-report.mjs <file> "<commit message>" [--dry-run]');
  process.exit(2);
}
if (!existsSync(path.resolve(root, file))) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const tryGit = (...a) => {
  try {
    return { ok: true, out: git(...a) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

git('add', '--', file);
const staged = git('diff', '--cached', '--name-only');
if (!staged) {
  console.log(`Nothing to publish — ${file} is already committed and unchanged.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[dry run] would commit ${staged.split('\n').join(', ')} as "${message}"`);
  console.log('[dry run] would run: git push origin HEAD:main');
  git('reset', '--', file);
  process.exit(0);
}

git('commit', '-m', message);
console.log(`Committed ${file}`);

let push = tryGit('push', 'origin', 'HEAD:main');
if (!push.ok) {
  console.log('Push rejected; rebasing on main and retrying.');
  const rebase = tryGit('pull', '--rebase', 'origin', 'main');
  if (!rebase.ok) console.log(rebase.out);
  push = tryGit('push', 'origin', 'HEAD:main');
}

if (push.ok) {
  console.log('Published to main — it will show on the dashboard within a couple of minutes.');
  process.exit(0);
}

// Couldn't reach main. Get the work somewhere visible and say so plainly.
console.error('Could not push to main:');
console.error(push.out);
const branch = `report/${path.basename(file, '.md')}`;
const fallback = tryGit('push', 'origin', `HEAD:refs/heads/${branch}`);
console.error(
  fallback.ok
    ? `Pushed to the branch ${branch} instead. THE REPORT IS NOT ON THE DASHBOARD YET — open a pull request from ${branch} and say so in your final message.`
    : 'Could not push anywhere. Say so explicitly in your final message — do not finish quietly.'
);
process.exit(1);
