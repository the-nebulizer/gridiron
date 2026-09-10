// Publish a finished report to `main`, where the dashboard reads from.
//
// Scheduled runs happen on their own session branch, so an ordinary commit and
// push leaves the report on a branch nobody looks at — indistinguishable from
// never having written it. That is exactly how four reports were lost between
// Sep 3 and Sep 8. This pushes HEAD to main explicitly, rebases once if the
// branch moved underneath, and fails loudly with the fallback if it can't.
//
// The one promise this script makes: it only says "Published" after it has
// looked at origin/main and seen this exact report there. Everything else is
// a failure, said out loud.
//
// `--replace` declares this version of the report authoritative: if main
// already holds a different same-name report (an earlier run of the same day,
// say), the rebase keeps ours instead of stopping on the conflict. A conflict
// on any other file still fails the same way as before.
//
// Usage: node scripts/publish-report.mjs <file> "<commit message>" [--dry-run] [--replace]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
const [file, message] = args.filter((a) => a !== '--dry-run' && a !== '--replace');

if (!file || !message) {
  console.error('Usage: node scripts/publish-report.mjs <file> "<commit message>" [--dry-run] [--replace]');
  process.exit(2);
}
if (!existsSync(path.resolve(root, file))) {
  console.error(`No such file: ${file}`);
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => {
  try {
    return { ok: true, out: git(...a) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

// Blob of the report as origin/main currently has it (null if absent there).
// Fetch first so the comparison is against main as it is now, not as it was.
function blobOnMain() {
  const fetch = tryGit('fetch', 'origin', 'main');
  if (!fetch.ok) {
    console.log(`Could not fetch origin/main (${fetch.out.split('\n')[0]}); continuing without it.`);
    return null;
  }
  const r = tryGit('rev-parse', '--verify', '--quiet', `origin/main:${file}`);
  return r.ok ? r.out : null;
}

if (dryRun) {
  // Look, don't touch: nothing is staged, so the index is left exactly as found.
  const inHead = tryGit('cat-file', '-e', `HEAD:${file}`).ok;
  const changed = !inHead || !tryGit('diff', '--quiet', 'HEAD', '--', file).ok;
  const working = git('hash-object', '--', file);
  console.log(changed ? `[dry run] would commit ${file} as "${message}"` : `[dry run] ${file} is already committed on this branch; nothing to commit`);
  const onMain = blobOnMain();
  if (onMain === working) console.log(`[dry run] ${file} is already on main as-is; would exit without pushing`);
  else if (replace && onMain !== null) console.log(`[dry run] main has a different ${file}; would replace it with this version (--replace), then confirm the report is on origin/main`);
  else console.log('[dry run] would run: git push origin HEAD:main, then confirm the report is on origin/main');
  process.exit(0);
}

// Stage and commit only the report. Anything else already staged stays staged
// and stays out of this commit — a report commit must contain the report.
git('add', '--', file);
const staged = git('diff', '--cached', '--name-only', '--', file);
if (staged) {
  const commit = tryGit('commit', '-m', message, '--', file);
  if (!commit.ok) {
    console.error(`Could not commit ${file}: ${commit.out.split('\n').filter(Boolean).pop() ?? 'git commit failed'}`);
    process.exit(1);
  }
  console.log(`Committed ${file}`);
} else {
  console.log(`${file} is already committed on this branch.`);
}

// Never skip the push on the strength of "already committed": a commit on a
// session branch is exactly the failure mode this script exists to prevent.
const local = git('rev-parse', `HEAD:${file}`);
if (blobOnMain() === local) {
  console.log(`${file} is already on main — nothing to publish.`);
  process.exit(0);
}

// --replace: rebase onto main, and if the only thing in conflict is the report
// itself, keep this branch's version. During a rebase "theirs" is the commit
// being replayed — ours. A conflict on anything else is left for the caller to
// abort, exactly as without the flag.
function rebaseReplacing() {
  const fetch = tryGit('fetch', 'origin', 'main');
  if (!fetch.ok) return fetch;
  let rebase = tryGit('rebase', 'origin/main');
  while (!rebase.ok) {
    const conflicted = tryGit('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    if (conflicted.length !== 1 || conflicted[0] !== file) return rebase;
    git('checkout', '--theirs', '--', file);
    git('add', '--', file);
    rebase = tryGit('-c', 'core.editor=true', 'rebase', '--continue');
  }
  return rebase;
}

let push = tryGit('push', 'origin', 'HEAD:main');
if (!push.ok) {
  console.log(replace ? 'Push rejected; rebasing on main (keeping this version of the report) and retrying.' : 'Push rejected; rebasing on main and retrying.');
  const rebase = replace ? rebaseReplacing() : tryGit('pull', '--rebase', 'origin', 'main');
  if (rebase.ok) {
    push = tryGit('push', 'origin', 'HEAD:main');
  } else {
    // Leave nothing half-rebased behind, and do not push over a conflict.
    tryGit('rebase', '--abort');
    console.log(rebase.out);
    push = { ok: false, out: 'Rebase onto main failed (conflict); aborted it.' };
  }
}

// Trust the remote, not the push's exit code: "Published" means origin/main
// holds this exact report.
if (push.ok) {
  if (blobOnMain() === local) {
    console.log('Published to main — it will show on the dashboard within a couple of minutes.');
    process.exit(0);
  }
  push = { ok: false, out: 'The push reported success but origin/main does not contain this report.' };
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
