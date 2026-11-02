// What the workflows run to move a change along the branch flow. The rules are in lib/flow.mjs.
// It uses Node's own modules only, and its jobs skip npm, because it runs next to AUTOMATION_TOKEN.
// It runs from the plugin's folder and comes from the pipeline, so a pull request cannot change what checks it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVELOP, MAIN, bumpBranch, bumpPullRequest, compareVersions, draftNotes, flowProblem, mainPullRequest, mergedBranches,
  notesStillToWrite, planDevelop, refreshNotes, releaseBranch, releasePullRequest, syncPullRequest, versionOfReleaseBranch, versionTags, workPullRequest,
} from './lib/flow.mjs';
import { manifestVersion, readPlugin, setVersion, versionMismatches } from './lib/plugin.mjs';

const LATEST = 'latest';
const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

const workDir = process.cwd();
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args));
const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const publishingIsOn = () => process.env.PUBLISHING_ENABLED === 'true';

let plugin;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function env(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

/**
 * A pull request opened with the workflow's own token leaves CI waiting for someone to click
 * "Approve workflows to run", so these steps use a token of the maintainer's.
 */
function requireAutomationToken() {
  if (!process.env.GH_TOKEN) fail('The AUTOMATION_TOKEN secret is missing or expired. "Setting up a plugin" in the README of ulanzi-plugin-pipeline says how to set it.');
}

const tagsOnRepo = () => versionTags(lines(git('tag', '--list', 'v*')));
const remoteBranches = (pattern) => lines(git('ls-remote', '--heads', 'origin', pattern)).map((line) => line.split('\t')[1].replace('refs/heads/', ''));
const deleteRemoteBranch = (branch) => gh('api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`);
const commitsAhead = (base, head) => ghJson('api', `repos/{owner}/{repo}/compare/${base}...${head}`).ahead_by;
const openPullRequests = () => ghJson('pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName');

function createPullRequest(base, head, { title, body }) {
  const url = gh('pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body);
  console.log(url);
  return url;
}

function mergeByItself(pullRequest) {
  try {
    gh('pr', 'merge', pullRequest, '--auto', '--merge');
  } catch {
    console.log('::warning::Auto-merge could not be turned on, so this pull request needs a merge by hand.');
  }
}

/** Runs on each push to a work branch. */
function openPullRequest() {
  requireAutomationToken();
  const branch = env('BRANCH');
  const subjects = lines(git('log', '--reverse', '--format=%s', `origin/${DEVELOP}..HEAD`));
  if (!subjects.length) return console.log(`${branch} has nothing that ${DEVELOP} does not.`);

  const [latest] = ghJson('pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state');
  if (latest?.state === 'OPEN') return console.log(`Pull request #${latest.number} is already open.`);
  // A person closed it on purpose, and more commits on the branch do not change that.
  if (latest?.state === 'CLOSED') return console.log(`Pull request #${latest.number} was closed, so it stays closed. Reopen it by hand if that changes.`);

  const template = readFileSync(join(workDir, '.github', 'pull_request_template.md'), 'utf8');
  return createPullRequest(DEVELOP, branch, workPullRequest({ branch, subjects, template }));
}

/**
 * A merge into main publishes, so what would stop the publishing has to stop the merge: found afterwards,
 * main has moved and the release is still a draft. Without the token this is a fork, already refused.
 */
function draftProblem() {
  const version = versionOfReleaseBranch(env('PR_HEAD'));
  if (env('PR_BASE') !== MAIN || !version || !process.env.GH_TOKEN) return null;
  const tag = `v${version}`;
  if (!findDraft(tag)) return `There is no draft for ${tag} yet. Wait for the Delivery run on ${env('PR_HEAD')}, then run this check again.`;
  const { body, targetCommitish } = ghJson('release', 'view', tag, '--json', 'body,targetCommitish');
  if (notesStillToWrite(body)) return `Write the top of the notes of the draft ${tag} for customers, then run this check again, or change a box.`;
  if (targetCommitish !== env('PR_HEAD_SHA')) return `The draft ${tag} holds ${targetCommitish}, not the end of this branch. Wait for the Delivery run, then run this check again.`;
  return null;
}

/** The check called Branch flow. Fork pull requests run it too, with no secret and a read-only token. */
function checkPullRequest() {
  const problem = flowProblem({
    base: env('PR_BASE'),
    head: env('PR_HEAD'),
    sameRepo: process.env.PR_HEAD_REPO === process.env.GITHUB_REPOSITORY,
    version: manifestVersion(workDir, plugin),
    body: process.env.PR_BODY,
  }) ?? draftProblem();
  if (problem) fail(problem);
  console.log('This pull request follows the branch flow.');
}

function closeOtherBumps(open, wanted) {
  for (const branch of remoteBranches('refs/heads/bump/v*')) {
    if (branch === wanted) continue;
    const pullRequest = open.find(({ headRefName }) => headRefName === branch);
    if (pullRequest) gh('pr', 'close', String(pullRequest.number), '--delete-branch', '--comment', 'Another version is needed now.');
    else deleteRemoteBranch(branch);
  }
}

function openBumpPullRequest(version, open) {
  const branch = bumpBranch(version);
  if (open.some(({ headRefName }) => headRefName === branch)) return console.log(`The pull request for ${branch} is already open.`);

  git('switch', '-C', branch);
  setVersion(workDir, plugin, version);
  git('-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-a', '-m', `Raise the version to ${version}`);
  // Only this automation writes to bump/ branches, and one may be left over from a run that stopped here.
  git('push', '--force', 'origin', `HEAD:refs/heads/${branch}`);
  createPullRequest(DEVELOP, branch, bumpPullRequest(version));
  mergeByItself(branch);
  return undefined;
}

function closeOldReleasePullRequests(open, branch) {
  for (const { number, headRefName, baseRefName } of open) {
    if (headRefName !== DEVELOP || baseRefName === branch || !versionOfReleaseBranch(baseRefName)) continue;
    gh('pr', 'close', String(number), '--comment', `${DEVELOP} moved on to \`${branch}\`.`);
    // With something merged it holds a draft and maybe a pull request to main, which can still go ahead.
    if (commitsAhead(MAIN, baseRefName) === 0) deleteRemoteBranch(baseRefName);
  }
}

function openReleasePullRequest(version, open, branches) {
  const branch = releaseBranch(version);
  closeOldReleasePullRequests(open, branch);
  if (!remoteBranches(`refs/heads/${branch}`).length) {
    gh('api', '-X', 'POST', 'repos/{owner}/{repo}/git/refs', '-f', `ref=refs/heads/${branch}`, '-f', `sha=${git('rev-parse', `origin/${MAIN}`)}`);
  }
  if (open.some(({ headRefName, baseRefName }) => headRefName === DEVELOP && baseRefName === branch)) {
    return console.log(`The pull request to ${branch} is already open, and it now holds this merge too.`);
  }
  if (commitsAhead(branch, DEVELOP) === 0) return console.log(`${branch} already has everything in ${DEVELOP}.`);
  return createPullRequest(branch, DEVELOP, releasePullRequest({ plugin, version, branches }));
}

/** Runs on each push to develop. */
function afterDevelop() {
  requireAutomationToken();
  const tags = tagsOnRepo();
  // Only what main does not have yet: something that came straight to main needs no release for itself.
  const branches = mergedBranches(lines(git('log', '--merges', '--format=%s', `origin/${MAIN}..HEAD`)), env('GITHUB_REPOSITORY').split('/')[0]);
  const plan = planDevelop({ version: manifestVersion(workDir, plugin), tags, branches });
  const open = openPullRequests();

  closeOtherBumps(open, plan.bump ? bumpBranch(plan.bump) : null);
  if (plan.idle) return console.log('Nothing has merged since the last release.');
  if (plan.bump) return openBumpPullRequest(plan.bump, open);
  return openReleasePullRequest(plan.release, open, branches);
}

/** Runs first on each merge into a release branch. */
function checkRelease() {
  const branch = env('BRANCH');
  const version = versionOfReleaseBranch(branch);
  if (!version) fail(`${branch} does not look like release/vX.Y.Z`);
  const mismatches = versionMismatches(workDir, plugin, version);
  if (mismatches.length) fail(`${branch} does not match: ${mismatches.join(', ')}`);
  if (tagsOnRepo().includes(version)) fail(`v${version} was already released, so it needs a new version.`);
  console.log(`${branch} and every version in the repository agree.`);
}

const findDraft = (tag) => ghJson('release', 'list', '--limit', '100', '--json', 'tagName,isDraft').find((release) => release.tagName === tag && release.isDraft);

/**
 * Runs once everything on a release branch has passed. The git tag is only born when the draft is
 * published, so validating again updates a draft and never moves a tag.
 */
function draftRelease() {
  requireAutomationToken();
  const version = versionOfReleaseBranch(env('BRANCH'));
  const repository = env('GITHUB_REPOSITORY');
  const commit = env('GITHUB_SHA');
  const tag = `v${version}`;
  const previous = tagsOnRepo().at(-1);
  const { body: changes } = ghJson(
    'api', '-X', 'POST', 'repos/{owner}/{repo}/releases/generate-notes',
    '-f', `tag_name=${tag}`, '-f', `target_commitish=${commit}`, ...(previous ? ['-f', `previous_tag_name=v${previous}`] : []),
  );
  const notes = draftNotes({ plugin, repository, version, changes, measure: readFileSync(join(workDir, 'measure', 'measure.txt'), 'utf8') });
  const title = `${plugin.name} ${version}`;
  const assets = [join('dist', `${plugin.pluginFolder}.zip`), join('dist', 'SHA256SUMS.txt')];

  if (findDraft(tag)) {
    const { body } = ghJson('release', 'view', tag, '--json', 'body');
    gh('release', 'edit', tag, '--target', commit, '--title', title, '--notes', refreshNotes(body, notes));
    gh('release', 'upload', tag, ...assets, '--clobber');
  } else {
    gh('release', 'create', tag, ...assets, '--draft', '--target', commit, '--title', title, '--notes', notes);
  }
  console.log(`Draft ${tag} holds ${commit}.`);
}

/** Runs after the draft. A repeat clears the device box, because that test was of older code. */
function openMainPullRequest() {
  requireAutomationToken();
  const branch = env('BRANCH');
  const pullRequest = mainPullRequest({
    plugin,
    version: versionOfReleaseBranch(branch),
    repository: env('GITHUB_REPOSITORY'),
    commit: env('GITHUB_SHA'),
    measure: readFileSync(join(workDir, 'measure', 'measure.txt'), 'utf8'),
    publishing: publishingIsOn(),
  });
  const [existing] = ghJson('pr', 'list', '--head', branch, '--base', MAIN, '--state', 'open', '--json', 'number');
  if (existing) {
    gh('pr', 'edit', String(existing.number), '--title', pullRequest.title, '--body', pullRequest.body);
    console.log(`Pull request #${existing.number} updated.`);
    return;
  }
  createPullRequest(MAIN, branch, pullRequest);
}

/** Runs on each push to main, which only a release branch can reach. */
function publish() {
  requireAutomationToken();
  const version = manifestVersion(workDir, plugin);
  const tag = `v${version}`;
  const tags = tagsOnRepo();
  if (tags.includes(version)) {
    console.log(`${tag} is already out, so there is nothing to publish.`);
    // It may have been published by hand, which leaves this part undone.
    finishRelease(version);
    return undefined;
  }
  // Until the maintainer decides, the draft stays a draft, and this is not a failure.
  if (!publishingIsOn()) return console.log(`::notice::Publishing is off, so ${tag} stays a draft. Set the repository variable PUBLISHING_ENABLED to true once the maintainer approves publishing.`);
  // The Community Store orders by publish date, so this would show an older version as the current one.
  if (tags.length && compareVersions(version, tags.at(-1)) < 0) fail(`v${tags.at(-1)} is already out, and ${tag} is older, so it stays a draft.`);
  if (!findDraft(tag)) fail(`There is no draft for ${tag}.`);

  const { body, targetCommitish } = ghJson('release', 'view', tag, '--json', 'body,targetCommitish');
  if (notesStillToWrite(body)) fail(`The top of the notes of the draft ${tag} still has to be written for customers. Write it, then run this job again.`);
  // What goes out is the zip that was validated, so main must be exactly the code it was built from.
  if (git('rev-parse', `${targetCommitish}^{tree}`) !== git('rev-parse', 'HEAD^{tree}')) {
    fail(`${MAIN} is not the code the draft ${tag} was validated on (${targetCommitish}), so it stays a draft.`);
  }
  gh('release', 'edit', tag, '--draft=false', '--latest');
  console.log(`${tag} is published.`);
  finishRelease(version);
  return undefined;
}

/** The release is out by now, so neither of these may fail the job. */
function finishRelease(version) {
  const branch = releaseBranch(version);
  try {
    if (remoteBranches(`refs/heads/${branch}`).length) deleteRemoteBranch(branch);
  } catch {
    console.log(`::warning::${branch} could not be deleted.`);
  }
  try {
    moveLatestBranch();
  } catch {
    console.log(`::warning::The ${LATEST} branch could not follow v${version}.`);
  }
}

/**
 * Runs on each push to main. A release leaves main with nothing develop lacks, so a difference means
 * something came straight to main, and work branches would miss it.
 */
function syncDevelop() {
  requireAutomationToken();
  if (!git('diff', '--name-only', `origin/${DEVELOP}...HEAD`)) return console.log(`${DEVELOP} has everything in ${MAIN}.`);
  const [open] = ghJson('pr', 'list', '--head', MAIN, '--base', DEVELOP, '--state', 'open', '--json', 'number');
  if (open) return console.log(`Pull request #${open.number} is already bringing ${MAIN} back.`);
  mergeByItself(createPullRequest(DEVELOP, MAIN, syncPullRequest()));
  return undefined;
}

/** The maintainer keeps a branch at the latest release. Without force, this only ever moves it forward. */
function moveLatestBranch() {
  if (!remoteBranches(`refs/heads/${LATEST}`).length) return;
  gh('api', '-X', 'PATCH', `repos/{owner}/{repo}/git/refs/heads/${LATEST}`, '-f', `sha=${git('rev-parse', 'HEAD')}`);
}

/** What the Delivery workflow runs on each push, except to a release branch: the branch says what comes next. */
function next() {
  const branch = env('BRANCH');
  if (branch === DEVELOP) return afterDevelop();
  if (branch !== MAIN) return openPullRequest();
  // A draft that has to wait is no reason to leave develop behind, so this comes first.
  try {
    syncDevelop();
  } catch {
    console.log(`::warning::${MAIN} could not be brought back into ${DEVELOP}.`);
  }
  return publish();
}

const COMMANDS = {
  next,
  'open-pull-request': openPullRequest,
  'check-pull-request': checkPullRequest,
  'after-develop': afterDevelop,
  'check-release': checkRelease,
  'draft-release': draftRelease,
  'open-main-pull-request': openMainPullRequest,
  publish,
  'sync-develop': syncDevelop,
};

const command = COMMANDS[process.argv[2]];
if (!command) fail(`Usage: node scripts/flow.mjs ${Object.keys(COMMANDS).join(' | ')}`);
try {
  plugin = readPlugin(workDir);
} catch (error) {
  fail(`This repository cannot use the pipeline yet. ${error.message}`);
}
command();
