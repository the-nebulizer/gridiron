// Publish finished report file(s) to `main`, where the dashboard reads from.
//
// Scheduled runs happen on their own session branch, so an ordinary commit and
// push leaves the report on a branch nobody looks at — indistinguishable from
// never having written it. That is exactly how four reports were lost between
// Sep 3 and Sep 8. This pushes HEAD to main explicitly, rebases once if the
// branch moved underneath, and fails loudly with the fallback if it can't.
//
// Takes one or more files so a report and reports/actions.json can publish in
// a single commit — the dashboard should never see one without the other.
//
// The one promise this script makes: it only says "Published" after it has
// looked at origin/main and seen every one of these exact files there.
// Everything else is a failure, said out loud.
//
// `--replace` declares this branch's version of every given file authoritative:
// if main already holds a different version of any of them (an earlier run of
// the same day, say), the rebase keeps ours for any conflicted file that is in
// the given set instead of stopping on the conflict. A conflict on any other
// file still fails the same way as before.
//
// Usage: node scripts/publish-report.mjs <file> [<file>...] "<commit message>" [--dry-run] [--replace]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const replace = args.includes('--replace');
const positional = args.filter((a) => a !== '--dry-run' && a !== '--replace');
// The last positional argument is the commit message; everything before it is a file.
const message = positional.length > 1 ? positional[positional.length - 1] : undefined;
const files = positional.length > 1 ? positional.slice(0, -1) : [];

if (files.length === 0 || !message) {
  console.error('Usage: node scripts/publish-report.mjs <file> [<file>...] "<commit message>" [--dry-run] [--replace]');
  process.exit(2);
}
for (const file of files) {
  if (!existsSync(path.resolve(root, file))) {
    console.error(`No such file: ${file}`);
    process.exit(2);
  }
}

const plural = files.length > 1;
const fileList = files.join(', ');

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => {
  try {
    return { ok: true, out: git(...a) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

// Fetch origin/main once per check so a blob comparison is against main as it
// is right now, not as it was when the process started.
function fetchMain() {
  const fetch = tryGit('fetch', 'origin', 'main');
  if (!fetch.ok) {
    console.log(`Could not fetch origin/main (${fetch.out.split('\n')[0]}); continuing without it.`);
    return false;
  }
  return true;
}

// Blob of one file as origin/main currently has it (null if absent there).
// Call fetchMain() first — this does no fetching of its own.
function mainBlobOf(file) {
  const r = tryGit('rev-parse', '--verify', '--quiet', `origin/main:${file}`);
  return r.ok ? r.out : null;
}

if (dryRun) {
  // Look, don't touch: nothing is staged, so the index is left exactly as found.
  for (const file of files) {
    const inHead = tryGit('cat-file', '-e', `HEAD:${file}`).ok;
    const changed = !inHead || !tryGit('diff', '--quiet', 'HEAD', '--', file).ok;
    console.log(changed ? `[dry run] would commit ${file} as "${message}"` : `[dry run] ${file} is already committed on this branch; nothing to commit`);
  }
  fetchMain();
  const workingBlobs = files.map((f) => git('hash-object', '--', f));
  const mainBlobs = files.map((f) => mainBlobOf(f));
  const allMatch = files.every((f, i) => mainBlobs[i] === workingBlobs[i]);
  if (allMatch) {
    console.log(`[dry run] ${fileList} ${plural ? 'are' : 'is'} already on main as-is; would exit without pushing`);
  } else if (replace && mainBlobs.some((b) => b !== null)) {
    console.log(`[dry run] main has a different version of one or more of these files; would replace it with this branch's version (--replace) for any of ${fileList} that conflict, then confirm every file is on origin/main`);
  } else {
    console.log('[dry run] would run: git push origin HEAD:main, then confirm every file is on origin/main');
  }
  process.exit(0);
}

// Stage and commit only the given files. Anything else already staged stays
// staged and stays out of this commit — a report commit must contain the report.
git('add', '--', ...files);
const staged = git('diff', '--cached', '--name-only', '--', ...files);
if (staged) {
  const commit = tryGit('commit', '-m', message, '--', ...files);
  if (!commit.ok) {
    console.error(`Could not commit ${fileList}: ${commit.out.split('\n').filter(Boolean).pop() ?? 'git commit failed'}`);
    process.exit(1);
  }
  console.log(`Committed ${fileList}`);
} else {
  console.log(`${fileList} ${plural ? 'are' : 'is'} already committed on this branch.`);
}

// Never skip the push on the strength of "already committed": a commit on a
// session branch is exactly the failure mode this script exists to prevent.
const localBlobs = new Map(files.map((f) => [f, git('rev-parse', `HEAD:${f}`)]));
fetchMain();
if (files.every((f) => mainBlobOf(f) === localBlobs.get(f))) {
  console.log(`${fileList} ${plural ? 'are' : 'is'} already on main — nothing to publish.`);
  process.exit(0);
}

// --replace: rebase onto main, and if everything in conflict is among the
// files we were given, keep this branch's version of each. During a rebase
// "theirs" is the commit being replayed — ours. A conflict on anything else
// is left for the caller to abort, exactly as without the flag.
function rebaseReplacing() {
  const fetch = tryGit('fetch', 'origin', 'main');
  if (!fetch.ok) return fetch;
  const fileSet = new Set(files);
  let rebase = tryGit('rebase', 'origin/main');
  while (!rebase.ok) {
    const conflicted = tryGit('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    if (conflicted.length === 0 || !conflicted.every((f) => fileSet.has(f))) return rebase;
    for (const f of conflicted) {
      git('checkout', '--theirs', '--', f);
      git('add', '--', f);
    }
    rebase = tryGit('-c', 'core.editor=true', 'rebase', '--continue');
  }
  return rebase;
}

// reports/actions.json is COMPILED from the report files beside it. If the
// rebase pulled another session's newer report onto this branch, the copy we
// are about to publish was compiled without it — the card would disagree with
// the reports it claims to summarise. Recompile before pushing, always.
function recompileActionsAfterRebase() {
  const compiled = 'reports/actions.json';
  if (!files.includes(compiled)) return { ok: true };
  try {
    execFileSync(process.execPath, ['scripts/actions.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, out: `Recompiling ${compiled} after the rebase failed:\n${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}` };
  }
  if (tryGit('diff', '--quiet', '--', compiled).ok) return { ok: true };
  git('add', '--', compiled);
  const commit = tryGit('commit', '-m', `${message} (recompiled actions.json against the rebased reports)`, '--', compiled);
  if (!commit.ok) return { ok: false, out: `Could not commit the recompiled ${compiled}: ${commit.out.split('\n').filter(Boolean).pop() ?? ''}` };
  localBlobs.set(compiled, git('rev-parse', `HEAD:${compiled}`));
  console.log(`Recompiled ${compiled} against the reports the rebase brought in.`);
  return { ok: true };
}

let push = tryGit('push', 'origin', 'HEAD:main');
if (!push.ok) {
  console.log(replace ? "Push rejected; rebasing on main (keeping this branch's version of any conflicted files given here) and retrying." : 'Push rejected; rebasing on main and retrying.');
  const rebase = replace ? rebaseReplacing() : tryGit('pull', '--rebase', 'origin', 'main');
  if (rebase.ok) {
    const recompiled = recompileActionsAfterRebase();
    if (recompiled.ok) {
      push = tryGit('push', 'origin', 'HEAD:main');
    } else {
      console.error(recompiled.out);
      push = { ok: false, out: 'Could not recompile reports/actions.json after the rebase; refusing to publish a card that disagrees with its reports.' };
    }
  } else {
    // Leave nothing half-rebased behind, and do not push over a conflict.
    tryGit('rebase', '--abort');
    console.log(rebase.out);
    push = { ok: false, out: 'Rebase onto main failed (conflict); aborted it.' };
  }
}

// Trust the remote, not the push's exit code: "Published" means origin/main
// holds every one of these exact files.
if (push.ok) {
  fetchMain();
  if (files.every((f) => mainBlobOf(f) === localBlobs.get(f))) {
    console.log('Published to main — it will show on the dashboard within a couple of minutes.');
    process.exit(0);
  }
  push = { ok: false, out: 'The push reported success but origin/main does not contain all of these files as committed.' };
}

// Couldn't reach main. Get the work somewhere visible and say so plainly.
console.error('Could not push to main:');
console.error(push.out);
const branch = `report/${path.basename(files[0], path.extname(files[0]))}`;
const fallback = tryGit('push', 'origin', `HEAD:refs/heads/${branch}`);
console.error(
  fallback.ok
    ? `Pushed to the branch ${branch} instead. THE REPORT IS NOT ON THE DASHBOARD YET — open a pull request from ${branch} and say so in your final message.`
    : 'Could not push anywhere. Say so explicitly in your final message — do not finish quietly.'
);
process.exit(1);
