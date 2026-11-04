// What must stay true of the workflow files, read as text so that the pipeline itself needs no dependency.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORK_PREFIXES } from '../scripts/lib/flow.mjs';
import { configProblems } from '../scripts/lib/plugin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(root, '.github', 'workflows');
const workflow = (file) => readFileSync(join(WORKFLOWS, file), 'utf8');
const template = (file) => readFileSync(join(root, 'templates', file), 'utf8');
const SHARED = ['gate.yml', 'delivery.yml'];

/** The text of each job, by its id. */
function jobs(text) {
  const parts = text.slice(text.indexOf('\njobs:\n')).split(/^ {2}([a-z-]+):\r?$/m).slice(1);
  return Object.fromEntries(parts.flatMap((part, i) => (i % 2 ? [] : [[part, parts[i + 1]]])));
}

test('every work prefix opens a pull request, and only those', () => {
  const listed = [...template('delivery.yml').matchAll(/^\s+- ([a-z]+)\/\*\*$/gm)].map(([, prefix]) => prefix);
  assert.deepEqual(listed, WORK_PREFIXES);
});

test('the bump branches stay out of the workflow that opens pull requests, because the bump opens its own', () => {
  assert.equal(WORK_PREFIXES.includes('bump'), false);
});

test('a missing token reaches the step that names it, instead of stopping at checkout', () => {
  for (const file of readdirSync(WORKFLOWS)) {
    assert.doesNotMatch(workflow(file), /^\s+token: \$\{\{ steps\.app\.outputs\.token \}\}$/m, file);
  }
});

test('the pull request is read from the event, because base_ref and head_ref are empty on a review', () => {
  for (const file of SHARED) assert.doesNotMatch(workflow(file), /github\.(base_ref|head_ref)/, file);
});

test('Branch flow reads the draft, which takes write access to contents', () => {
  assert.match(jobs(workflow('gate.yml')).rules, /permission-contents: write/);
});

test('the dependency review is told its commits, because a review event has none of its own', () => {
  const { review } = jobs(workflow('gate.yml'));
  assert.match(review, /base-ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(review, /head-ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test('the shared workflows can only be called, and their callers name the same files', () => {
  for (const file of SHARED) {
    assert.doesNotMatch(workflow(file), /^ {2}(push|pull_request|pull_request_target|schedule|workflow_dispatch):/m, file);
    assert.match(workflow(file), /^ {2}workflow_call:/m, file);
    assert.match(template(file), new RegExp(`uses: Weslley08/ulanzi-plugin-pipeline/\\.github/workflows/${file.replace('.', '\\.')}@v1`), file);
  }
});

test('no job that holds the token runs anything from npm', () => {
  for (const file of SHARED) {
    for (const [id, text] of Object.entries(jobs(workflow(file)))) {
      if (!text.includes('steps.app.outputs.token')) continue;
      assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /\bnpm\b/, `${file}: ${id}`);
    }
  }
});

test('the App key is read by the step that makes the token and nowhere else', () => {
  for (const file of SHARED) {
    for (const [id, text] of Object.entries(jobs(workflow(file)))) {
      const reads = text.match(/^.*secrets\.APP_PRIVATE_KEY.*$/gm) ?? [];
      if (!reads.length) continue;
      assert.deepEqual(reads.map((line) => line.trim()), ['private-key: ${{ secrets.APP_PRIVATE_KEY }}'], `${file}: ${id}`);
      assert.match(text, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d/, `${file}: ${id}`);
      assert.match(text, /^ {4}env:\n(?: {6}#.*\n)? {6}APP_CLIENT_ID: \$\{\{ secrets\.APP_CLIENT_ID \}\}$/m, `${file}: ${id}`);
    }
  }
});

test('the token only reaches the steps that need it', () => {
  for (const file of SHARED) {
    const holders = Object.entries(jobs(workflow(file))).filter(([, text]) => text.includes('steps.app.outputs.token')).map(([id]) => id);
    assert.deepEqual(holders, file === 'gate.yml' ? ['rules', 'approval'] : ['next', 'draft'], file);
  }
});

test('the check that stands for the Gate waits for every other job', () => {
  const { passed, ...others } = jobs(workflow('gate.yml'));
  const [, needs] = /needs: \[([^\]]+)\]/.exec(passed);
  assert.deepEqual(needs.split(', ').sort(), Object.keys(others).sort());
  assert.match(passed, /if: \$\{\{ always\(\) \}\}/, 'without this it is skipped when a job fails, and a skipped required check lets the merge through');
});

test('the draft runs only after what validates it, and never on a branch where those were skipped', () => {
  const { draft, smoke, measure } = jobs(workflow('delivery.yml'));
  assert.match(draft, /needs: \[smoke, integrations, measure\]/);
  assert.match(draft, /needs\.smoke\.result == 'success'/);
  assert.match(draft, /needs\.measure\.result == 'success'/);
  assert.match(draft, /needs\.integrations\.result == 'skipped' && inputs\.integrations-scripts == ''/);
  for (const job of [smoke, measure]) assert.match(job, /needs: build/);
});

test('the scripts come from the same commit of the pipeline as the workflow that runs them', () => {
  for (const file of SHARED) {
    for (const [id, text] of Object.entries(jobs(workflow(file)))) {
      if (!text.includes('.pipeline/scripts/')) continue;
      assert.match(text, /repository: \$\{\{ job\.workflow_repository \}\}/, `${file}: ${id}`);
      assert.match(text, /ref: \$\{\{ job\.workflow_sha \}\}/, `${file}: ${id}`);
    }
  }
});

test('the pipeline is gone before the secret scan, which reads every file git would commit', () => {
  const { build } = jobs(workflow('delivery.yml'));
  assert.ok(build.indexOf('rm -rf .pipeline') < build.indexOf('npm run check:secrets'));
  assert.ok(build.indexOf('rm -rf .pipeline') > build.indexOf('flow.mjs check-release'));
});

test('every action is pinned to a commit or a digest', () => {
  for (const file of readdirSync(WORKFLOWS)) {
    for (const [, reference] of workflow(file).matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
      assert.match(reference, /@[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$/, `${file}: ${reference}`);
    }
  }
});

test('forks are not named in the workflows, so a fork of the pipeline works the same', () => {
  for (const file of SHARED) assert.doesNotMatch(workflow(file), /Weslley08/, file);
});

test('the starting pipeline file is complete', () => {
  assert.deepEqual(configProblems(JSON.parse(template('pipeline.json'))), []);
});
