import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  approvalProblem, compareVersions, draftNotes, flowProblem, mainPullRequest, mergedBranches, nextVersion, notesStillToWrite,
  planDevelop, refreshNotes, releasePullRequest, versionOfReleaseBranch, versionTags, workPullRequest,
} from '../scripts/lib/flow.mjs';
import { manifestVersion, readPlugin, setVersion, versionMismatches } from '../scripts/lib/plugin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(root, 'test', 'fixtures', 'plugin');
const plugin = readPlugin(FIXTURE);
const PLUGIN_FOLDER = plugin.pluginFolder;
const VERSION_FILES = ['package.json', 'package-lock.json', `${PLUGIN_FOLDER}/package.json`, `${PLUGIN_FOLDER}/package-lock.json`, `${PLUGIN_FOLDER}/manifest.json`];

test('versions compare as numbers, not as text', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
});

test('only real version tags count, lowest first', () => {
  assert.deepEqual(versionTags(['v1.10.0', 'v1.9.0', 'v.1.4.0', 'nightly', 'v2.0', 'v1.2.3-rc.1']), ['1.9.0', '1.10.0']);
});

test('the merged branch comes from what GitHub writes, for this repository and for forks', () => {
  assert.deepEqual(mergedBranches([
    'Merge pull request #6 from Weslley08/feat/choose-exact-place',
    'Merge pull request #7 from someone-else/fix/typo',
    "Merge branch 'main' into feat/x",
    'Show official Defesa Civil alerts',
  ]), ['feat/choose-exact-place', 'fix/typo']);
});

test('bringing main back is not new work, but a fork whose branch is called main is', () => {
  assert.deepEqual(mergedBranches([
    'Merge pull request #10 from Weslley08/main',
    'Merge pull request #11 from someone-else/main',
  ], 'Weslley08'), ['main']);
  assert.deepEqual(planDevelop({ version: '1.4.0', tags: ['1.4.0'], branches: mergedBranches(['Merge pull request #10 from Weslley08/main'], 'Weslley08') }), { idle: true });
});

test('a feature raises the second number and anything else the third', () => {
  assert.equal(nextVersion('1.4.2', ['fix/a', 'feat/b']), '1.5.0');
  assert.equal(nextVersion('1.4.2', ['feature/b']), '1.5.0');
  assert.equal(nextVersion('1.4.2', ['fix/a', 'chore/b', 'bump/v1.4.3']), '1.4.3');
  assert.equal(nextVersion('1.4.2', ['featured/not-really']), '1.4.3');
});

test('develop asks for a new version when its own is already released', () => {
  assert.deepEqual(planDevelop({ version: '1.4.0', tags: ['1.3.0', '1.4.0'], branches: ['fix/a'] }), { bump: '1.4.1' });
  assert.deepEqual(planDevelop({ version: '1.4.0', tags: ['1.4.0'], branches: ['feat/a'] }), { bump: '1.5.0' });
});

test('develop goes to a release once its version is free', () => {
  assert.deepEqual(planDevelop({ version: '1.4.1', tags: ['1.4.0'], branches: ['fix/a', 'bump/v1.4.1'] }), { release: '1.4.1' });
  assert.deepEqual(planDevelop({ version: '1.5.0', tags: ['1.4.0'], branches: ['feat/a', 'bump/v1.5.0'] }), { release: '1.5.0' });
});

test('a feature merged after a patch was planned moves the release to a new version', () => {
  assert.deepEqual(planDevelop({ version: '1.4.1', tags: ['1.4.0'], branches: ['fix/a', 'bump/v1.4.1', 'feat/b'] }), { bump: '1.5.0' });
});

test('a version raised by hand is kept, even a big jump', () => {
  assert.deepEqual(planDevelop({ version: '2.0.0', tags: ['1.4.0'], branches: ['feat/a'] }), { release: '2.0.0' });
});

test('nothing merged since the last release asks for nothing, so running this again is safe', () => {
  assert.deepEqual(planDevelop({ version: '1.4.0', tags: ['1.4.0'], branches: [] }), { idle: true });
});

test('with no tag yet, the version in the code is the release', () => {
  assert.deepEqual(planDevelop({ version: '0.1.0', tags: [], branches: [] }), { release: '0.1.0' });
});

test('develop takes work branches and forks, but nothing back from a release', () => {
  const pr = { base: 'develop', version: '1.4.1', body: '' };
  for (const head of ['feat/x', 'fix/y', 'bump/v1.4.1', 'dependabot/npm_and_yarn/ws-8', 'main']) {
    assert.equal(flowProblem({ ...pr, head, sameRepo: true }), null, head);
  }
  assert.equal(flowProblem({ ...pr, head: 'patch-1', sameRepo: false }), null);
  assert.equal(flowProblem({ ...pr, head: 'release/v1.4.1', sameRepo: false }), null, 'a fork can name its branch anything');
  assert.match(flowProblem({ ...pr, head: 'release/v1.4.1', sameRepo: true }), /Nothing flows back/);
});

test('a release branch takes only develop from this repository, at its own version', () => {
  const pr = { base: 'release/v1.4.1', body: '' };
  assert.equal(flowProblem({ ...pr, head: 'develop', sameRepo: true, version: '1.4.1' }), null);
  assert.match(flowProblem({ ...pr, head: 'feat/x', sameRepo: true, version: '1.4.1' }), /must come from develop/);
  assert.match(flowProblem({ ...pr, head: 'develop', sameRepo: false, version: '1.4.1' }), /must come from develop/);
  assert.match(flowProblem({ ...pr, head: 'develop', sameRepo: true, version: '1.5.0' }), /says version 1\.5\.0/);
});

test('main takes only a release branch, and says what to do about anything else', () => {
  const pr = { base: 'main', version: '1.4.1' };
  assert.equal(flowProblem({ ...pr, head: 'release/v1.4.1', sameRepo: true }), null);
  assert.match(flowProblem({ ...pr, head: 'develop', sameRepo: true }), /Change the base of this one to develop/);
  assert.match(flowProblem({ ...pr, head: 'dependabot/npm_and_yarn/ws-8', sameRepo: true }), /Change the base of this one to develop/);
  assert.match(flowProblem({ ...pr, head: 'release/v1.4.1', sameRepo: false }), /must come from a release/);
  assert.match(flowProblem({ ...pr, head: 'release/v1.4.0', sameRepo: true }), /says version 1\.4\.1/);
});

const REVIEW = { user: 'maint', state: 'APPROVED', commit: 'abc' };
const approval = (reviews, extra = {}) => approvalProblem({ author: 'bot', headSha: 'abc', reviews, permissionOf: (user) => (user === 'maint' ? 'admin' : 'write'), ...extra });

test('main waits for the maintainer, because merging there publishes', () => {
  assert.equal(approval([REVIEW]), null);
  assert.match(approval([]), /Nobody has approved/);
  assert.match(approval([{ ...REVIEW, state: 'COMMENTED' }]), /Nobody has approved/);
  assert.match(approval([{ ...REVIEW, user: 'someone' }]), /Nobody has approved/, 'write access is not enough');
  assert.match(approval([REVIEW], { author: 'maint' }), /Nobody has approved/, 'the one who opened it cannot approve it');
});

test('an approval counts for the last commit only, and a later review of the same person replaces it', () => {
  assert.match(approval([{ ...REVIEW, commit: 'older' }]), /earlier commit no longer counts/);
  assert.equal(approval([{ ...REVIEW, commit: 'older' }, REVIEW]), null);
  assert.equal(approval([REVIEW, { ...REVIEW, state: 'COMMENTED' }]), null, 'a comment decides nothing');
  assert.match(approval([REVIEW, { ...REVIEW, state: 'DISMISSED' }]), /Nobody has approved/);
  assert.match(approval([REVIEW, { ...REVIEW, state: 'CHANGES_REQUESTED' }]), /asked for changes/);
  assert.match(approval([REVIEW, { user: 'other', state: 'CHANGES_REQUESTED', commit: 'abc' }]), /other asked for changes/);
});

test('the pull request to main says the approval is what allows the merge, with no boxes left to tick', () => {
  const { body } = mainPullRequest({ plugin, version: '1.4.1', repository: 'a/b', commit: 'abc', measure: 'Memory 60 MB\n', publishing: true });
  assert.doesNotMatch(body, /\[ \]/);
  assert.match(body, /maintainer's approval is what allows the merge/);
  assert.match(body, /takes back the approval/);
  assert.match(body, /Memory 60 MB/);
});

test('branches with other names are not release branches', () => {
  assert.equal(versionOfReleaseBranch('release/v1.4.1'), '1.4.1');
  for (const branch of ['release/1.4.1', 'release/v1.4', 'release/v1.4.1-rc', 'xrelease/v1.4.1']) assert.equal(versionOfReleaseBranch(branch), null, branch);
});

test('an opened pull request is named after the first commit and keeps the template', () => {
  const template = readFileSync(join(FIXTURE, '.github', 'pull_request_template.md'), 'utf8');
  const { title, body } = workPullRequest({ branch: 'feat/x', subjects: ['Add x', 'Fix x'], template });
  assert.equal(title, 'Add x');
  assert.match(body, /- Add x\n- Fix x/);
  assert.match(body, /## How I tested it/);
  assert.doesNotMatch(body, /A sentence or two/);
});

test('the release pull request leaves out the version bumps', () => {
  const { title, body } = releasePullRequest({ plugin, version: '1.4.1', branches: ['fix/a', 'bump/v1.4.1'] });
  assert.equal(title, 'Release v1.4.1');
  assert.match(body, /`fix\/a`/);
  assert.doesNotMatch(body, /`bump\//);
});

const DRAFT = { plugin, repository: 'a/b', version: '1.4.1', changes: '* Add x by @me in https://example.com/1\n', measure: 'Node v20.12.2, 6 keys\nMemory with keys drawn      68.8 MB (heap 14.1 MB)\nCPU idle                    0.10% of one core\n' };

test('draft notes say the manual check is not done, and end with the numbers as a plain list', () => {
  const notes = draftNotes(DRAFT);
  assert.match(notes, /has not been completed/);
  assert.match(notes, /blob\/v1\.4\.1\/docs\/VERIFY\.md/);
  assert.match(notes, /not the \*\*Source code\*\* archives/);
  assert.match(notes, /^- Memory with keys drawn: 68\.8 MB \(heap 14\.1 MB\)$/m);
  assert.match(notes, /^- CPU idle: 0\.10% of one core$/m);
  assert.ok(notes.indexOf('- CPU idle') > notes.indexOf('## Technical details'));
});

test('the store shows the whole text, so draft notes draw no table or HTML and keep the required credit', () => {
  const notes = draftNotes(DRAFT);
  assert.doesNotMatch(notes, /^\|/m);
  assert.doesNotMatch(notes, /<[a-z!]/i);
  assert.doesNotMatch(notes, /```/);
  assert.match(notes, /## Credits\n\nData by the fixture service, as its terms require\./);
});

test('notes generated by CI count as still to write, down to either of their marks', () => {
  const notes = draftNotes(DRAFT);
  assert.equal(notesStillToWrite(notes), true);
  assert.equal(notesStillToWrite(notes.replace(/^WRITE THIS FOR CUSTOMERS\..*$/m, 'Better alerts.')), true, 'the list under it is still there');
  assert.equal(notesStillToWrite(notes.slice(notes.indexOf('## Installing by hand'))), false);
});

test('validating again keeps the text a person wrote, and brings new technical details', () => {
  const written = `Better alerts.\n\n- Faster\n\n${draftNotes({ ...DRAFT, measure: 'CPU idle  9.99% of one core\n' }).slice(draftNotes(DRAFT).indexOf('## Installing by hand'))}\n\nRan on my D200: all fine.`;
  const refreshed = refreshNotes(written, draftNotes(DRAFT));
  assert.match(refreshed, /^Better alerts\./);
  assert.match(refreshed, /## Installing by hand/);
  assert.match(refreshed, /- CPU idle: 0\.10% of one core/);
  assert.doesNotMatch(refreshed, /9\.99%/);
  assert.doesNotMatch(refreshed, /Ran on my D200/, 'that test was of older code');
  assert.match(refreshed, /has not been completed/);
  assert.equal(notesStillToWrite(refreshed), false);
});

test('validating again before anyone wrote the notes just brings them up to date', () => {
  const fresh = draftNotes(DRAFT);
  assert.equal(refreshNotes(draftNotes({ ...DRAFT, changes: '* Old' }), fresh), fresh);
});

test('notes with the technical details removed by hand get them back', () => {
  const refreshed = refreshNotes('Better alerts.', draftNotes(DRAFT));
  assert.match(refreshed, /^Better alerts\.\n\n## Technical details/);
  assert.match(refreshed, /- CPU idle/);
});

function versionFilesCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'ulanzi-pipeline-version-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test('raising the version changes every copy of it and nothing else', () => {
  const dir = versionFilesCopy();
  try {
    const before = manifestVersion(FIXTURE, plugin);
    setVersion(dir, plugin, '9.8.7');
    assert.equal(manifestVersion(dir, plugin), '9.8.7');
    assert.deepEqual(versionMismatches(dir, plugin, '9.8.7'), []);
    for (const file of VERSION_FILES) {
      const changed = readFileSync(join(dir, file), 'utf8').split('\n');
      const original = readFileSync(join(FIXTURE, file), 'utf8').split('\n');
      assert.equal(changed.length, original.length, file);
      const different = changed.filter((line, i) => line !== original[i]);
      assert.equal(different.length, file.endsWith('package-lock.json') ? 2 : 1, file);
      for (const line of different) assert.ok(line.includes('9.8.7'), `${file}: ${line}`);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages[''].version, '9.8.7');
    assert.deepEqual(versionMismatches(FIXTURE, plugin, before), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with another version is named', () => {
  const dir = versionFilesCopy();
  try {
    setVersion(dir, plugin, '9.8.7');
    assert.deepEqual(versionMismatches(dir, plugin, '9.8.7'), []);
    assert.equal(versionMismatches(dir, plugin, '1.0.0').length, VERSION_FILES.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
