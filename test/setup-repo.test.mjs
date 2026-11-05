// Runs scripts/setup-repo.mjs itself, against canned gh replies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_GH = pathToFileURL(join(root, 'test', 'support', 'fake-gh.mjs')).href;
const REPOSITORY = 'Weslley08/example';
const POLICIES = `api repos/${REPOSITORY}/environments/release-validation/deployment-branch-policies`;
const NO_RULES = ['api graphql', { data: { repository: { id: 'R1', branchProtectionRules: { nodes: [] } } } }];
const DEVELOP_REFS = `api repos/${REPOSITORY}/git/matching-refs/heads/develop`;
const MAIN_REF = `api repos/${REPOSITORY}/git/ref/heads/main`;
const SHA = 'a'.repeat(40);
const HAS_DEVELOP = [DEVELOP_REFS, [{ ref: 'refs/heads/develop', object: { sha: 'b'.repeat(40) } }]];
const HAS_MAIN = [MAIN_REF, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } }];

let dir;
let log;

function setupRepo(args = [REPOSITORY, '--environment', 'release-validation'], replies = [NO_RULES, [POLICIES, { branch_policies: [] }]]) {
  const result = spawnSync(process.execPath, ['--import', FAKE_GH, join(root, 'scripts', 'setup-repo.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_GH_LOG: log, FAKE_GH_REPLIES: JSON.stringify([...replies, HAS_DEVELOP]) },
  });
  return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
}

const callsTo = (calls, ...start) => calls.filter((args) => start.every((word, i) => args[i] === word));
const requiredIn = (body) => body.required_status_checks.contexts;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ulanzi-pipeline-setup-'));
  log = join(dir, 'gh.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('each branch of the flow requires the check that stands for the Gate, and CodeQL', () => {
  const { status, calls, stderr } = setupRepo();
  assert.equal(status, 0, stderr);

  const protections = callsTo(calls, 'api', '-X', 'PUT').filter((args) => args[3].endsWith('/protection'));
  assert.deepEqual(protections.map((args) => args[3].split('/').at(-2)), ['develop', 'main']);
  for (const args of protections) {
    const body = args.at(-1);
    assert.deepEqual(requiredIn(body), ['gate / Passed', 'CodeQL']);
    assert.equal(body.required_status_checks.strict, false, 'develop never holds the merge commits of main');
    assert.equal(body.enforce_admins, true);
    assert.equal(body.allow_deletions, false);
  }

  const [, rule] = callsTo(calls, 'api', 'graphql').map((args) => args.at(-1));
  assert.match(rule.query, /createBranchProtectionRule/);
  const { input } = rule.variables;
  assert.equal(input.pattern, 'release/v*');
  assert.equal(input.repositoryId, 'R1');
  assert.equal(input.allowsDeletions, true, 'publishing deletes the release branch');
  assert.equal(input.requiresStrictStatusChecks, false);
  assert.deepEqual(input.requiredStatusCheckContexts, requiredIn(protections[0].at(-1)), 'every branch of the flow requires the same checks');

  const [merging] = callsTo(calls, 'api', '-X', 'PATCH').map((args) => args.at(-1));
  assert.deepEqual(merging, { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, allow_auto_merge: true });
  const [policy] = callsTo(calls, 'api', '-X', 'POST').filter((args) => args[3].endsWith('deployment-branch-policies'));
  assert.deepEqual(policy.at(-1), { name: 'release/v*', type: 'branch' });
});

test('the security settings no file can apply are turned on', () => {
  const { calls } = setupRepo();
  const scanning = callsTo(calls, 'api', '-X', 'PATCH').map((args) => args.at(-1)).find((body) => body.security_and_analysis);
  assert.equal(scanning.security_and_analysis.secret_scanning_push_protection.status, 'enabled');
  const puts = callsTo(calls, 'api', '-X', 'PUT').map((args) => args[3]);
  for (const setting of ['vulnerability-alerts', 'automated-security-fixes', 'private-vulnerability-reporting']) {
    assert.ok(puts.includes(`repos/${REPOSITORY}/${setting}`), setting);
  }
});

test('the required name is the job in the workflow, as a repository that follows the template reports it', () => {
  const gate = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');
  assert.match(gate, /^ {2}passed:\r?\n {4}name: Passed\r?$/m);
  assert.match(readFileSync(join(root, 'templates', 'gate.yml'), 'utf8'), /^ {2}gate:\r?$/m);
  assert.match(readFileSync(join(root, 'scripts', 'setup-repo.mjs'), 'utf8'), /'gate \/ Passed'/);
});

test('a plugin that keeps no secret gets no environment', () => {
  const { status, calls } = setupRepo([REPOSITORY], [NO_RULES]);
  assert.equal(status, 0);
  assert.equal(calls.filter((args) => args.join(' ').includes('/environments/')).length, 0);
});

test('running it again updates the rule and adds no second policy', () => {
  const { status, calls } = setupRepo(undefined, [
    ['api graphql', { data: { repository: { id: 'R1', branchProtectionRules: { nodes: [{ id: 'P1', pattern: 'release/v*' }] } } } }],
    [POLICIES, { branch_policies: [{ name: 'release/v*' }] }],
  ]);
  assert.equal(status, 0);
  const [, rule] = callsTo(calls, 'api', 'graphql').map((args) => args.at(-1));
  assert.match(rule.query, /updateBranchProtectionRule/);
  assert.equal(rule.variables.input.branchProtectionRuleId, 'P1');
  assert.equal(callsTo(calls, 'api', '-X', 'POST').length, 0);
});

const ANALYSES = `repos/${REPOSITORY}/code-scanning/analyses`;
const GATE = '.github/workflows/gate.yml:analyze';
const OLD = '.github/workflows/codeql.yml:analyze';
const ANALYSES_ON_DEVELOP = [
  { id: 4, category: GATE, deletable: true },
  { id: 3, category: GATE, deletable: false },
  { id: 2, category: OLD, deletable: true },
  { id: 1, category: OLD, deletable: false },
];
const ANALYSIS_REPLIES = [
  NO_RULES,
  [`api ${ANALYSES}?ref=refs/heads/develop`, ANALYSES_ON_DEVELOP],
  [`api ${ANALYSES}?ref=refs/heads/main`, []],
  [`api -X DELETE ${ANALYSES}/2?confirm_delete=true`, { confirm_delete_url: `https://api.github.com/${ANALYSES}/1?confirm_delete=true` }],
  [`api -X DELETE https://api.github.com/${ANALYSES}/1?confirm_delete=true`, { confirm_delete_url: null }],
];

test('the whole set of analyses under an old workflow name is removed, and the current ones stay', () => {
  const { status, stdout, calls, stderr } = setupRepo([REPOSITORY], ANALYSIS_REPLIES);
  assert.equal(status, 0, stderr);
  assert.deepEqual(callsTo(calls, 'api', '-X', 'DELETE').map((args) => args[3]), [`${ANALYSES}/2?confirm_delete=true`, `https://api.github.com/${ANALYSES}/1?confirm_delete=true`]);
  assert.match(stdout, /Done: remove the CodeQL analyses named \.github\/workflows\/codeql\.yml:analyze from develop/);
});

test('with only the current analyses, or none readable, nothing is removed', () => {
  const current = setupRepo([REPOSITORY], [NO_RULES, [`api ${ANALYSES}?ref=refs/heads/develop`, ANALYSES_ON_DEVELOP.slice(0, 2)], [`api ${ANALYSES}?ref=refs/heads/main`, { fail: true }]]);
  assert.equal(current.status, 0);
  assert.equal(callsTo(current.calls, 'api', '-X', 'DELETE').length, 0);
});

test('the name kept for CodeQL matches the workflow, so the current analyses are never removed', () => {
  assert.match(readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8'), /^ {2}analyze:\r?$/m);
  assert.match(readFileSync(join(root, 'scripts', 'setup-repo.mjs'), 'utf8'), new RegExp(`CODEQL_CATEGORY = '${GATE.replaceAll('.', '\\.')}'`));
});

test('a dry run changes nothing and says what it would do', () => {
  const { status, stdout, calls } = setupRepo([REPOSITORY, '--environment', 'release-validation', '--dry-run'], ANALYSIS_REPLIES);
  assert.equal(status, 0);
  assert.deepEqual(calls.filter((args) => args[1] === '-X' && args[2] !== 'GET'), []);
  assert.equal(callsTo(calls, 'api', 'graphql').length, 1, 'only the read that finds the existing rule');
  assert.match(stdout, /Would: protect develop/);
  assert.match(stdout, /Would: protect release\/v\*/);
  assert.match(stdout, /Would: remove the CodeQL analyses named \.github\/workflows\/codeql\.yml:analyze from develop/);
});

test('without a repository it says how to use it, and changes nothing', () => {
  const { status, stderr, calls } = setupRepo([]);
  assert.equal(status, 1);
  assert.match(stderr, /Usage/);
  assert.equal(calls.length, 0);
});

test('creates missing develop from the exact main SHA before applying settings or branch protection', () => {
  const { status, calls, stderr, stdout } = setupRepo([REPOSITORY], [
    [DEVELOP_REFS, []], HAS_MAIN, NO_RULES,
  ]);
  assert.equal(status, 0, stderr);
  const creations = callsTo(calls, 'api', '-X', 'POST').filter((args) => args[3] === `repos/${REPOSITORY}/git/refs`);
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0].at(-1), { ref: 'refs/heads/develop', sha: SHA });
  const createIndex = calls.findIndex((args) => args === creations[0]);
  const firstSettingsIndex = calls.findIndex((args) => args[1] === '-X' && args[2] === 'PATCH');
  assert.ok(createIndex < firstSettingsIndex, 'branch must be created before applying any repository settings');
  assert.match(stdout, /Done: create develop from main at aaaaaaa/);
});

test('does not move, recreate, or overwrite an existing develop branch', () => {
  const { status, calls, stdout } = setupRepo([REPOSITORY], [NO_RULES]);
  assert.equal(status, 0);
  assert.equal(callsTo(calls, 'api', '-X', 'POST').filter((args) => args[3].endsWith('/git/refs')).length, 0);
  assert.ok(!calls.some((args) => args.join(' ').includes('/git/ref/heads/main')));
  assert.match(stdout, /Already: develop branch exists/);
});

test('missing develop dry-run reports branch creation but makes no writes', () => {
  const { status, calls, stdout, stderr } = setupRepo([REPOSITORY, '--bootstrap-only', '--dry-run'], [
    [DEVELOP_REFS, []], HAS_MAIN,
  ]);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Would: create develop from main at aaaaaaa/);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ['api', `repos/${REPOSITORY}/git/matching-refs/heads/develop`],
    ['api', `repos/${REPOSITORY}/git/ref/heads/main`],
  ].map((args) => args.slice(0, 3)));
  assert.equal(calls.some((args) => args[1] === '-X'), false);
});

test('bootstrap-only creates develop without protecting branches or touching repository settings', () => {
  const { status, calls, stderr } = setupRepo([REPOSITORY, '--bootstrap-only'], [
    [DEVELOP_REFS, []], HAS_MAIN,
  ]);
  assert.equal(status, 0, stderr);
  assert.equal(calls.filter((args) => args[1] === '-X').length, 1);
  assert.equal(callsTo(calls, 'api', '-X', 'POST')[0][3], `repos/${REPOSITORY}/git/refs`);
  assert.equal(calls.some((args) => args.join(' ').includes('/protection')), false);
});

test('existing develop bootstrap-only is a no-op', () => {
  const { status, calls, stdout } = setupRepo([REPOSITORY, '--bootstrap-only']);
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  assert.match(stdout, /Already: develop branch exists/);
});

test('branch creation refuses invalid main ref and stops before any settings changes', () => {
  const { status, calls } = setupRepo([REPOSITORY], [
    [DEVELOP_REFS, []], [MAIN_REF, { ref: 'refs/heads/main', object: { sha: '' } }], NO_RULES,
  ]);
  assert.notEqual(status, 0);
  assert.equal(calls.some((args) => args[1] === '-X'), false);
});

test('branch API errors do not get mistaken for a missing branch', () => {
  const { status, calls } = setupRepo([REPOSITORY], [[DEVELOP_REFS, { fail: true }], HAS_MAIN, NO_RULES]);
  assert.notEqual(status, 0);
  assert.equal(calls.some((args) => args[1] === '-X'), false);
});
