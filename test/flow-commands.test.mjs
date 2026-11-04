// Runs scripts/flow.mjs itself, with a real git repository and a local "origin", against canned gh replies.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(root, 'test', 'fixtures', 'plugin');
const PLUGIN_FOLDER = 'com.example.fixture.ulanziPlugin';
const FLOW = join(root, 'scripts', 'flow.mjs');
const FAKE_GH = pathToFileURL(join(root, 'test', 'support', 'fake-gh.mjs')).href;
const VERSION_FILES = ['package.json', 'package-lock.json', `${PLUGIN_FOLDER}/package.json`, `${PLUGIN_FOLDER}/package-lock.json`, `${PLUGIN_FOLDER}/manifest.json`];
const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

let dir;
let work;
let log;

const inDir = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => inDir(work, ...args);
const onOrigin = (...args) => inDir(join(dir, 'origin.git'), ...args);

function setManifestVersion(version) {
  const file = join(work, PLUGIN_FOLDER, 'manifest.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/"Version":\s*"[^"]*"/, `"Version": "${version}"`));
}

function flow(command, { replies = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, ['--import', FAKE_GH, FLOW, command], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: 'fake',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_SHA: git('rev-parse', 'HEAD'),
      FAKE_GH_LOG: log,
      FAKE_GH_REPLIES: JSON.stringify(replies),
      ...env,
    },
  });
  return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
}

const callsTo = (calls, ...start) => calls.filter((args) => start.every((word, i) => args[i] === word));
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

/** Merges a branch into develop the way GitHub does. */
function mergeIntoDevelop(branch, number = 1) {
  git('switch', '-c', branch, 'develop');
  writeFileSync(join(work, `${branch.replaceAll('/', '-')}.txt`), branch);
  git('add', '.');
  git('commit', '-m', `Work on ${branch}`);
  git('switch', 'develop');
  git('merge', '--no-ff', branch, '-m', `Merge pull request #${number} from owner/${branch}`);
  git('push', 'origin', 'develop', '--quiet');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ulanzi-pipeline-flow-'));
  log = join(dir, 'gh.log');
  inDir(dir, 'init', '--bare', '--quiet', '--initial-branch=main', 'origin.git');
  inDir(dir, 'clone', '--quiet', join(dir, 'origin.git'), 'work');
  work = join(dir, 'work');
  git('switch', '--quiet', '-C', 'main');
  cpSync(FIXTURE, work, { recursive: true });
  git('add', '.');
  git('commit', '-m', 'First');
  git('push', 'origin', 'main', '--quiet');
  git('tag', `v${JSON.parse(readFileSync(join(work, PLUGIN_FOLDER, 'manifest.json'), 'utf8')).Version}`);
  git('push', 'origin', '--tags', '--quiet');
  git('switch', '--quiet', '-c', 'develop');
  git('push', 'origin', 'develop', '--quiet');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const currentVersion = () => JSON.parse(readFileSync(join(work, PLUGIN_FOLDER, 'manifest.json'), 'utf8')).Version;
const nextPatch = (version) => version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const nextMinor = (version) => version.replace(/\.\d+\.\d+$/, (rest) => `.${Number(rest.split('.')[1]) + 1}.0`);

test('a pushed branch gets a pull request to develop, named after its first commit', () => {
  git('switch', '--quiet', '-c', 'fix/thing');
  writeFileSync(join(work, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-m', 'Fix the thing');
  writeFileSync(join(work, 'b.txt'), 'b');
  git('add', '.');
  git('commit', '-m', 'Fix it better');

  const { status, calls } = flow('open-pull-request', { replies: [['pr list', []]], env: { BRANCH: 'fix/thing' } });

  assert.equal(status, 0);
  const [create] = callsTo(calls, 'pr', 'create');
  assert.equal(argAfter(create, '--base'), 'develop');
  assert.equal(argAfter(create, '--head'), 'fix/thing');
  assert.equal(argAfter(create, '--title'), 'Fix the thing');
  assert.match(argAfter(create, '--body'), /- Fix the thing\n- Fix it better/);
});

for (const [state, reason] of [['OPEN', 'one is already open'], ['CLOSED', 'a person closed it']]) {
  test(`no new pull request when ${reason}`, () => {
    git('switch', '--quiet', '-c', 'fix/thing');
    writeFileSync(join(work, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-m', 'Fix the thing');
    const { status, calls } = flow('open-pull-request', { replies: [['pr list', [{ number: 9, state }]]], env: { BRANCH: 'fix/thing' } });
    assert.equal(status, 0);
    assert.equal(callsTo(calls, 'pr', 'create').length, 0);
  });
}

test('a branch whose last pull request merged gets a new one for its new commits', () => {
  git('switch', '--quiet', '-c', 'fix/thing');
  writeFileSync(join(work, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-m', 'One more fix');
  const { calls } = flow('open-pull-request', { replies: [['pr list', [{ number: 9, state: 'MERGED' }]]], env: { BRANCH: 'fix/thing' } });
  assert.equal(callsTo(calls, 'pr', 'create').length, 1);
});

test('a new branch with no commits of its own opens nothing', () => {
  git('switch', '--quiet', '-c', 'fix/empty');
  const { status, calls } = flow('open-pull-request', { env: { BRANCH: 'fix/empty' } });
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
});

test('without the token the step fails and says what to set, instead of looking fine', () => {
  git('switch', '--quiet', '-c', 'fix/thing');
  for (const command of ['next', 'open-pull-request', 'after-develop', 'draft-release', 'open-main-pull-request', 'publish', 'sync-develop']) {
    const { status, stderr } = flow(command, { env: { GH_TOKEN: '', BRANCH: 'fix/thing' } });
    assert.equal(status, 1, command);
    assert.match(stderr, /GitHub App/, command);
  }
});

test('a merge into develop at a released version pushes a bump branch and asks it to merge itself', () => {
  const before = currentVersion();
  mergeIntoDevelop('fix/thing');

  const { status, calls, stderr } = flow('after-develop', { replies: [['pr list', []]] });

  assert.equal(status, 0, stderr);
  const wanted = nextPatch(before);
  const branch = `bump/v${wanted}`;
  const pushed = JSON.parse(onOrigin('show', `${branch}:${PLUGIN_FOLDER}/manifest.json`)).Version;
  assert.equal(pushed, wanted);
  assert.equal(onOrigin('rev-list', '--count', `develop..${branch}`), '1');
  assert.equal(onOrigin('log', '-1', '--format=%an', branch), 'github-actions[bot]');
  assert.deepEqual(onOrigin('diff', '--name-only', `develop..${branch}`).split('\n').sort(), [...VERSION_FILES].sort());

  const [create] = callsTo(calls, 'pr', 'create');
  assert.equal(argAfter(create, '--base'), 'develop');
  assert.equal(argAfter(create, '--head'), branch);
  assert.deepEqual(callsTo(calls, 'pr', 'merge')[0], ['pr', 'merge', branch, '--auto', '--merge']);
});

test('a new feature asks for the second number', () => {
  const before = currentVersion();
  mergeIntoDevelop('feat/thing');
  const { calls } = flow('after-develop', { replies: [['pr list', []]] });
  assert.equal(argAfter(callsTo(calls, 'pr', 'create')[0], '--head'), `bump/v${nextMinor(before)}`);
});

test('what already reached main does not count towards the next version', () => {
  const before = currentVersion();
  git('switch', '--quiet', 'main');
  git('switch', '--quiet', '-c', 'feat/listing');
  writeFileSync(join(work, 'listing.txt'), 'store text');
  git('add', '.');
  git('commit', '-m', 'New store text');
  git('switch', '--quiet', 'main');
  git('merge', '--no-ff', 'feat/listing', '-m', 'Merge pull request #1 from owner/feat/listing');
  git('push', 'origin', 'main', '--quiet');
  git('switch', '--quiet', 'develop');
  git('merge', '--no-ff', 'origin/main', '-m', 'Merge pull request #2 from owner/main');
  git('push', 'origin', 'develop', '--quiet');

  const idle = flow('after-develop', { replies: [['pr list', []]] });
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(callsTo(idle.calls, 'pr', 'create').length, 0, 'bringing main back asks for nothing');

  rmSync(log);
  mergeIntoDevelop('fix/thing', 3);
  const { calls } = flow('after-develop', { replies: [['pr list', []]] });
  assert.equal(argAfter(callsTo(calls, 'pr', 'create')[0], '--head'), `bump/v${nextPatch(before)}`, 'a patch, though a feature reached main');
});

test('if auto-merge cannot be turned on, the pull request is still there and the job says so', () => {
  mergeIntoDevelop('fix/thing');
  const { status, stdout, calls } = flow('after-develop', { replies: [['pr list', []], ['pr merge', { fail: true }]] });
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'pr', 'create').length, 1);
  assert.match(stdout, /needs a merge by hand/);
});

test('an open bump for the same version is left alone', () => {
  const wanted = `bump/v${nextPatch(currentVersion())}`;
  mergeIntoDevelop('fix/thing');
  const { calls } = flow('after-develop', { replies: [['pr list', [{ number: 3, headRefName: wanted, baseRefName: 'develop' }]]] });
  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
  assert.equal(callsTo(calls, 'pr', 'close').length, 0);
});

test('a free version creates the release branch from main and opens the pull request', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');

  const main = git('rev-parse', 'origin/main');
  const { status, calls, stderr } = flow('after-develop', { replies: [['pr list', []], ['api repos/{owner}/{repo}/compare', { ahead_by: 2 }]] });

  assert.equal(status, 0, stderr);
  const [create] = callsTo(calls, 'api', '-X', 'POST', 'repos/{owner}/{repo}/git/refs');
  assert.ok(create.includes(`ref=refs/heads/release/v${version}`));
  assert.ok(create.includes(`sha=${main}`));
  const [pull] = callsTo(calls, 'pr', 'create');
  assert.equal(argAfter(pull, '--base'), `release/v${version}`);
  assert.equal(argAfter(pull, '--head'), 'develop');
  assert.match(argAfter(pull, '--body'), /`fix\/thing`/);
});

test('a release pull request already open takes the new merge, with no second one', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');
  onOrigin('branch', `release/v${version}`, 'main');

  const { calls } = flow('after-develop', { replies: [['pr list', [{ number: 4, headRefName: 'develop', baseRefName: `release/v${version}` }]]] });

  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
  assert.equal(callsTo(calls, 'api', '-X', 'POST').length, 0);
});

test('a release branch with everything in develop already opens nothing', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');
  onOrigin('branch', `release/v${version}`, 'develop');

  const { status, calls } = flow('after-develop', { replies: [['pr list', []], ['api repos/{owner}/{repo}/compare', { ahead_by: 0 }]] });

  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
});

test('moving on to a new version closes the old release pull request and removes its empty branch', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');

  const { calls } = flow('after-develop', {
    replies: [
      ['pr list', [{ number: 4, headRefName: 'develop', baseRefName: 'release/v0.0.1' }]],
      ['api repos/{owner}/{repo}/compare/main...release/v0.0.1', { ahead_by: 0 }],
      ['api repos/{owner}/{repo}/compare', { ahead_by: 1 }],
    ],
  });

  assert.equal(callsTo(calls, 'pr', 'close')[0][2], '4');
  assert.deepEqual(callsTo(calls, 'api', '-X', 'DELETE')[0], ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/release/v0.0.1']);
  assert.equal(argAfter(callsTo(calls, 'pr', 'create')[0], '--base'), `release/v${version}`);
});

test('an old release branch with a draft stays, because it can still go ahead', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');

  const { calls } = flow('after-develop', {
    replies: [
      ['pr list', [{ number: 4, headRefName: 'develop', baseRefName: 'release/v0.0.1' }]],
      ['api repos/{owner}/{repo}/compare', { ahead_by: 3 }],
    ],
  });

  assert.equal(callsTo(calls, 'api', '-X', 'DELETE').length, 0);
});

test('bump branches no longer needed go away: open ones closed, merged ones deleted', () => {
  const version = nextPatch(currentVersion());
  mergeIntoDevelop('fix/thing');
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  git('push', 'origin', 'develop', '--quiet');
  onOrigin('branch', 'bump/v0.0.1', 'main');
  onOrigin('branch', 'bump/v0.0.2', 'main');

  const { calls } = flow('after-develop', {
    replies: [
      ['pr list', [{ number: 8, headRefName: 'bump/v0.0.2', baseRefName: 'develop' }]],
      ['api repos/{owner}/{repo}/compare', { ahead_by: 1 }],
    ],
  });

  assert.deepEqual(callsTo(calls, 'api', '-X', 'DELETE').map((args) => args[3]), ['repos/{owner}/{repo}/git/refs/heads/bump/v0.0.1']);
  const [close] = callsTo(calls, 'pr', 'close');
  assert.equal(close[2], '8');
  assert.ok(close.includes('--delete-branch'));
});

test('running it again with nothing merged since the tag does nothing', () => {
  const { status, calls } = flow('after-develop', { replies: [['pr list', []]] });
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
});

test('a release branch must match the versions in the code and be unused', () => {
  const version = currentVersion();
  const free = flow('check-release', { env: { BRANCH: `release/v${nextPatch(version)}` } });
  assert.equal(free.status, 1);
  assert.match(free.stderr, /manifest\.json says/);

  const used = flow('check-release', { env: { BRANCH: `release/v${version}` } });
  assert.equal(used.status, 1);
  assert.match(used.stderr, /was already released/);

  assert.equal(flow('check-release', { env: { BRANCH: 'release/oops' } }).status, 1);
});

function releaseBranchChecks(version) {
  mkdirSync(join(work, 'dist'), { recursive: true });
  mkdirSync(join(work, 'measure'), { recursive: true });
  writeFileSync(join(work, 'measure', 'measure.txt'), 'CPU idle 0.00%\n');
  return { BRANCH: `release/v${version}` };
}

test('the first draft is created on the validated commit, with no tag in git', () => {
  const version = nextPatch(currentVersion());
  const env = releaseBranchChecks(version);
  const { status, calls, stderr } = flow('draft-release', { env, replies: [['api -X POST repos/{owner}/{repo}/releases/generate-notes', { body: '## Changes' }], ['release list', []]] });
  assert.equal(status, 0, stderr);
  const [create] = callsTo(calls, 'release', 'create');
  assert.equal(create[2], `v${version}`);
  assert.ok(create.includes('--draft'));
  assert.equal(argAfter(create, '--target'), git('rev-parse', 'HEAD'));
  assert.ok(create.some((arg) => arg.endsWith(`${PLUGIN_FOLDER}.zip`)));
  assert.ok(create.some((arg) => arg.endsWith('SHA256SUMS.txt')));
  assert.match(argAfter(create, '--notes'), /CPU idle 0\.00%/);
  assert.match(argAfter(create, '--notes'), /^WRITE THIS FOR CUSTOMERS\./);
  assert.equal(git('tag', '--list', `v${version}`), '');
});

test('validating again updates the draft instead of adding one, and keeps what a person wrote', () => {
  const version = nextPatch(currentVersion());
  const env = releaseBranchChecks(version);
  const { calls } = flow('draft-release', {
    env,
    replies: [['api -X POST', { body: '## Changes' }], ['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { body: 'Better alerts.\n\n## Technical details\n\nOld numbers.' }]],
  });
  assert.equal(callsTo(calls, 'release', 'create').length, 0);
  const [edit] = callsTo(calls, 'release', 'edit');
  assert.equal(argAfter(edit, '--target'), git('rev-parse', 'HEAD'));
  assert.match(argAfter(edit, '--notes'), /^Better alerts\./);
  assert.match(argAfter(edit, '--notes'), /CPU idle 0\.00%/);
  assert.doesNotMatch(argAfter(edit, '--notes'), /Old numbers/);
  assert.ok(callsTo(calls, 'release', 'upload')[0].includes('--clobber'));
});

test('the pull request to main opens asking for the maintainer approval', () => {
  const version = nextPatch(currentVersion());
  const env = releaseBranchChecks(version);
  const { calls } = flow('open-main-pull-request', { env, replies: [['pr list', []]] });
  const [create] = callsTo(calls, 'pr', 'create');
  assert.equal(argAfter(create, '--base'), 'main');
  assert.equal(argAfter(create, '--head'), `release/v${version}`);
  assert.match(argAfter(create, '--body'), /approval is what allows the merge/);
});

test('validating again rewrites the description, and with it the old approval stops counting', () => {
  const env = releaseBranchChecks(nextPatch(currentVersion()));
  const { calls } = flow('open-main-pull-request', { env, replies: [['pr list', [{ number: 5 }]]] });
  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
  assert.match(argAfter(callsTo(calls, 'pr', 'edit')[0], '--body'), /takes back the approval/);
});

const WRITTEN = 'Better alerts.\n\n## Technical details\n\nNumbers.';

function mergedRelease() {
  const version = nextPatch(currentVersion());
  setManifestVersion(version);
  git('commit', '-a', '-m', 'Raise');
  const validated = git('rev-parse', 'HEAD');
  git('switch', '--quiet', 'main');
  git('merge', '--no-ff', 'develop', '-m', `Merge pull request #9 from owner/release/v${version}`);
  onOrigin('branch', `release/v${version}`, 'main');
  return { version, validated };
}

const RELEASE_PR = (version) => ({ PR_BASE: 'main', PR_HEAD: `release/v${version}`, PR_HEAD_REPO: 'owner/repo', PR_HEAD_SHA: 'abc123' });

function checkReleasePr(replies, env = {}) {
  const version = currentVersion();
  return flow('check-pull-request', { env: { ...RELEASE_PR(version), ...env }, replies: replies(version) });
}

test('the merge into main waits for the notes, so it can never leave main ahead of a draft', () => {
  const { status, stderr } = checkReleasePr((version) => [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: 'abc123', body: 'WRITE THIS FOR CUSTOMERS.' }]]);
  assert.equal(status, 1);
  assert.match(stderr, /Write the top of the notes/);
});

test('the merge into main waits for a draft to exist', () => {
  const { status, stderr } = checkReleasePr(() => [['release list', []]]);
  assert.equal(status, 1);
  assert.match(stderr, /There is no draft/);
});

test('the merge into main waits for a draft of the end of the branch, after a newer merge', () => {
  const { status, stderr } = checkReleasePr((version) => [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: 'older', body: WRITTEN }]]);
  assert.equal(status, 1);
  assert.match(stderr, /holds older/);
});

test('with the notes written and the draft up to date, the merge into main may go ahead', () => {
  const { status, stderr } = checkReleasePr((version) => [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: 'abc123', body: WRITTEN }]]);
  assert.equal(status, 0, stderr);
});

test('the draft is not read for a pull request to develop or from a fork, which has no token', () => {
  const version = currentVersion();
  const toDevelop = flow('check-pull-request', { env: { ...RELEASE_PR(version), PR_BASE: 'develop', PR_HEAD: 'fix/x' } });
  assert.equal(toDevelop.status, 0);
  assert.equal(callsTo(toDevelop.calls, 'release').length, 0);
  assert.equal(flow('check-pull-request', { env: { ...RELEASE_PR(version), GH_TOKEN: '' } }).status, 0);
  rmSync(log, { force: true });
  const toAnotherBranch = flow('check-pull-request', { env: { ...RELEASE_PR(version), PR_BASE: 'feat/x' } });
  assert.equal(toAnotherBranch.status, 0);
  assert.equal(toAnotherBranch.calls.length, 0, 'only a merge into main publishes');
});

test('a release published by hand gets its branch removed and latest moved on the next run', () => {
  const version = currentVersion();
  onOrigin('branch', `release/v${version}`, 'main');
  onOrigin('branch', 'latest', 'main');
  const { status, calls } = flow('publish');
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'release').length, 0);
  assert.equal(callsTo(calls, 'api', '-X', 'DELETE')[0][3], `repos/{owner}/{repo}/git/refs/heads/release/v${version}`);
  assert.equal(callsTo(calls, 'api', '-X', 'PATCH')[0][3], 'repos/{owner}/{repo}/git/refs/heads/latest');
});

test('notes still to write keep the release a draft, because customers read them, and the job can run again', () => {
  const { version, validated } = mergedRelease();
  const { status, calls, stderr } = flow('publish', {
    replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: 'WRITE THIS FOR CUSTOMERS. Replace it.' }]],
  });
  assert.equal(status, 1);
  assert.match(stderr, /written for customers/);
  assert.equal(callsTo(calls, 'release', 'edit').length, 0);
  assert.equal(callsTo(calls, 'api', '-X', 'DELETE').length, 0, 'the release branch stays until it is out');
});

test('a version older than the newest tag stays a draft, because the store would show it as current', () => {
  const { version, validated } = mergedRelease();
  git('tag', 'v99.0.0');
  const { status, calls, stderr } = flow('publish', {
    replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 1);
  assert.match(stderr, /v99\.0\.0 is already out/);
  assert.equal(callsTo(calls, 'release', 'edit').length, 0);
});

test('merging into main publishes the draft and removes the release branch, and the tag lands on the validated commit', () => {
  const { version, validated } = mergedRelease();
  const { status, calls, stderr } = flow('publish', {
    replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(callsTo(calls, 'release', 'edit')[0], ['release', 'edit', `v${version}`, '--draft=false', '--latest']);
  assert.deepEqual(callsTo(calls, 'api', '-X', 'DELETE')[0][3], `repos/{owner}/{repo}/git/refs/heads/release/v${version}`);
});

test('the latest branch follows the release when it exists, and without force', () => {
  const { version, validated } = mergedRelease();
  onOrigin('branch', 'latest', 'main');
  const replies = [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]];

  const { status, calls } = flow('publish', { replies });

  assert.equal(status, 0);
  const [move] = callsTo(calls, 'api', '-X', 'PATCH');
  assert.equal(move[3], 'repos/{owner}/{repo}/git/refs/heads/latest');
  assert.ok(move.includes(`sha=${git('rev-parse', 'HEAD')}`));
  assert.equal(move.includes('force=true'), false);
});

test('a latest branch that cannot move does not undo the publishing', () => {
  const { version, validated } = mergedRelease();
  onOrigin('branch', 'latest', 'main');
  const { status, stdout, calls } = flow('publish', {
    replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }], ['api -X PATCH', { fail: true }]],
  });
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'release', 'edit').length, 1);
  assert.match(stdout, /could not follow/);
});

test('with no latest branch, publishing does not create one', () => {
  const { version, validated } = mergedRelease();
  const { calls } = flow('publish', { replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]] });
  assert.equal(callsTo(calls, 'api', '-X', 'PATCH').length, 0);
});

test('main with other code than the draft was validated on stays unpublished', () => {
  const { version, validated } = mergedRelease();
  writeFileSync(join(work, 'surprise.txt'), 'not validated');
  git('add', '.');
  git('commit', '-m', 'Something else');
  const { status, calls, stderr } = flow('publish', {
    replies: [['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 1);
  assert.match(stderr, /stays a draft/);
  assert.equal(callsTo(calls, 'release', 'edit').length, 0);
});

test('main with no draft for its version fails loudly', () => {
  const { version } = mergedRelease();
  const { status, stderr } = flow('publish', { replies: [['release list', []]] });
  assert.equal(status, 1);
  assert.match(stderr, new RegExp(`no draft for v${version}`));
});

test('a version already out is left alone, so running publish again is safe', () => {
  const { status, calls } = flow('publish');
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
});

test('a failure to delete the release branch does not undo the publishing', () => {
  const { version, validated } = mergedRelease();
  const { status, stdout, calls } = flow('publish', {
    replies: [
      ['release list', [{ tagName: `v${version}`, isDraft: true }]],
      ['release view', { targetCommitish: validated, body: WRITTEN }],
      ['api -X DELETE', { fail: true }],
    ],
  });
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'release', 'edit').length, 1);
  assert.match(stdout, /could not be deleted/);
});

const SYNC_REPLIES = [['pr list', []], ['pr create', 'https://example.com/pull/7']];

function commitDirectlyOnMain() {
  git('switch', '--quiet', 'main');
  writeFileSync(join(work, 'straight.txt'), 'came straight to main');
  git('add', '.');
  git('commit', '-m', 'Store text');
  git('push', 'origin', 'main', '--quiet');
}

test('something that came straight to main goes back to develop by itself', () => {
  commitDirectlyOnMain();
  const { status, calls, stderr } = flow('sync-develop', { replies: SYNC_REPLIES });
  assert.equal(status, 0, stderr);
  const [create] = callsTo(calls, 'pr', 'create');
  assert.equal(argAfter(create, '--base'), 'develop');
  assert.equal(argAfter(create, '--head'), 'main');
  assert.deepEqual(callsTo(calls, 'pr', 'merge')[0], ['pr', 'merge', 'https://example.com/pull/7', '--auto', '--merge']);
});

test('a pull request already bringing main back is enough', () => {
  commitDirectlyOnMain();
  const { calls } = flow('sync-develop', { replies: [['pr list', [{ number: 7 }]]] });
  assert.equal(callsTo(calls, 'pr', 'create').length, 0);
});

test('new work on develop does not look like something main lacks', () => {
  mergeIntoDevelop('fix/thing');
  git('switch', '--quiet', 'main');
  const { status, calls } = flow('sync-develop', { replies: SYNC_REPLIES });
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
});

test('after a release, main has nothing develop lacks, though develop lacks its merge commit', () => {
  mergeIntoDevelop('fix/thing');
  git('switch', '--quiet', 'main');
  git('merge', '--no-ff', 'develop', '-m', 'Merge pull request #9 from owner/release/v9.9.9');
  git('push', 'origin', 'main', '--quiet');
  assert.notEqual(git('rev-list', '--count', 'origin/develop..HEAD'), '0');
  const { status, calls } = flow('sync-develop', { replies: SYNC_REPLIES });
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
});

test('a push to a work branch opens its pull request', () => {
  git('switch', '--quiet', '-c', 'fix/thing');
  writeFileSync(join(work, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-m', 'Fix the thing');
  const { status, calls, stderr } = flow('next', { replies: [['pr list', []]], env: { BRANCH: 'fix/thing' } });
  assert.equal(status, 0, stderr);
  assert.equal(argAfter(callsTo(calls, 'pr', 'create')[0], '--base'), 'develop');
});

test('a push to develop goes on to the next version or release', () => {
  mergeIntoDevelop('fix/thing');
  const { status, calls, stderr } = flow('next', { replies: [['pr list', []]], env: { BRANCH: 'develop' } });
  assert.equal(status, 0, stderr);
  assert.match(argAfter(callsTo(calls, 'pr', 'create')[0], '--head'), /^bump\/v/);
});

test('a push to main brings back what came straight to it, and publishes', () => {
  const { version, validated } = mergedRelease();
  writeFileSync(join(work, 'straight.txt'), 'came straight to main');
  git('add', '.');
  git('commit', '-m', 'Store text');
  const { status, calls, stderr } = flow('next', {
    env: { BRANCH: 'main' },
    replies: [['pr list', []], ['pr create', 'https://example.com/pull/7'], ['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 1, 'that code was not validated, so this one stays a draft');
  assert.match(stderr, /stays a draft/);
  assert.equal(argAfter(callsTo(calls, 'pr', 'create')[0], '--head'), 'main');
});

test('a push to main with what was validated publishes', () => {
  const { version, validated } = mergedRelease();
  const { status, calls, stderr } = flow('next', {
    env: { BRANCH: 'main' },
    replies: [['pr list', []], ['pr create', 'https://example.com/pull/7'], ['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 0, stderr);
  assert.ok(callsTo(calls, 'release', 'edit')[0].includes('--draft=false'));
});

test('failing to bring main back does not stop the publishing', () => {
  const { version, validated } = mergedRelease();
  const { status, stdout, calls } = flow('next', {
    env: { BRANCH: 'main' },
    replies: [['pr list', { fail: true }], ['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: WRITTEN }]],
  });
  assert.equal(status, 0);
  assert.match(stdout, /could not be brought back/);
  assert.ok(callsTo(calls, 'release', 'edit')[0].includes('--draft=false'));
});

test('a draft that has to wait does not stop main from going back to develop, and the step fails', () => {
  const { version, validated } = mergedRelease();
  const { status, calls } = flow('next', {
    env: { BRANCH: 'main' },
    replies: [['pr list', []], ['pr create', 'https://example.com/pull/7'], ['release list', [{ tagName: `v${version}`, isDraft: true }]], ['release view', { targetCommitish: validated, body: 'WRITE THIS FOR CUSTOMERS.' }]],
  });
  assert.equal(status, 1);
  assert.equal(callsTo(calls, 'pr', 'create').length, 1);
  assert.equal(callsTo(calls, 'release', 'edit').length, 0);
});

test('Branch flow reads the pull request from the environment and fails with the reason', () => {
  const env = { PR_BASE: 'main', PR_HEAD: 'feat/x', PR_HEAD_REPO: 'owner/repo' };
  const { status, stderr } = flow('check-pull-request', { env });
  assert.equal(status, 1);
  assert.match(stderr, /must come from a release/);
  assert.equal(flow('check-pull-request', { env: { ...env, PR_BASE: 'develop' } }).status, 0);
});

const APPROVAL_ENV = { PR_BASE: 'main', PR_NUMBER: '7', PR_AUTHOR: 'bot', PR_HEAD_SHA: 'abc123' };
const review = (user, state, commit = 'abc123') => ({ user: { login: user }, state, commit_id: commit });

test('Maintainer approval passes at once for any base but main, without reading anything', () => {
  const { status, calls } = flow('check-approval', { env: { ...APPROVAL_ENV, PR_BASE: 'develop' } });
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
});

test('Maintainer approval reads the reviews and the permission of the approver, and passes for an admin', () => {
  const { status, calls, stderr } = flow('check-approval', { env: APPROVAL_ENV, replies: [['api --paginate --slurp repos/{owner}/{repo}/pulls/7/reviews', [[review('maint', 'APPROVED')]]], ['api repos/{owner}/{repo}/collaborators/maint/permission', { permission: 'admin' }]] });
  assert.equal(status, 0, stderr);
  assert.equal(callsTo(calls, 'api').length, 2);
});

test('Maintainer approval fails with nobody, with a writer only, and with the token missing', () => {
  const none = flow('check-approval', { env: APPROVAL_ENV, replies: [['api --paginate', [[]]]] });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Nobody has approved/);
  const writer = flow('check-approval', { env: APPROVAL_ENV, replies: [['api --paginate', [[review('helper', 'APPROVED')]]], ['api repos/{owner}/{repo}/collaborators/helper', { permission: 'write' }]] });
  assert.equal(writer.status, 1);
  const noToken = flow('check-approval', { env: { ...APPROVAL_ENV, GH_TOKEN: '' } });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /GitHub App/);
});

test('an unknown command says how to use it', () => {
  const { status, stderr } = flow('nope');
  assert.equal(status, 1);
  assert.match(stderr, /Usage/);
});

test('the draft and its zip carry the name and folder from the plugin, not from any other plugin', () => {
  const version = nextPatch(currentVersion());
  const { status, calls, stderr } = flow('draft-release', { env: releaseBranchChecks(version), replies: [['api -X POST repos/{owner}/{repo}/releases/generate-notes', { body: '## Changes' }], ['release list', []]] });
  assert.equal(status, 0, stderr);
  const [create] = callsTo(calls, 'release', 'create');
  assert.equal(argAfter(create, '--title'), `Fixture Plugin ${version}`);
  assert.ok(create.some((arg) => arg.endsWith('com.example.fixture.ulanziPlugin.zip')));
  assert.match(argAfter(create, '--notes'), /Download `com\.example\.fixture\.ulanziPlugin\.zip`/);
  assert.match(argAfter(create, '--notes'), new RegExp(`blob/v${version}/README\\.md#setup`));
});

test('a repository without its pipeline file is told what is missing, before anything runs', () => {
  rmSync(join(work, '.github', 'pipeline.json'));
  const { status, stderr, calls } = flow('next', { env: { BRANCH: 'develop' } });
  assert.equal(status, 1);
  assert.match(stderr, /cannot use the pipeline yet/);
  assert.equal(calls.length, 0);
});

test('a pipeline file with a part missing names that part', () => {
  const file = join(work, '.github', 'pipeline.json');
  const { notes, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...rest, notes: { ...notes, about: '' }, pluginFolder: '../outside' }));
  const { status, stderr } = flow('next', { env: { BRANCH: 'develop' } });
  assert.equal(status, 1);
  assert.match(stderr, /pluginFolder must be/);
  assert.match(stderr, /notes\.about must be text/);
});
