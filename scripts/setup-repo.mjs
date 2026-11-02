// Applies the settings a plugin repository needs for the branch flow, with the maintainer's own gh login.
// Safe to run again, and --dry-run shows the changes without making them:
//   node scripts/setup-repo.mjs Weslley08/ulanzi-deck-clima-pro --environment release-validation --dry-run
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const RELEASE_PATTERN = 'release/v*';
const CODEQL_CATEGORY = '.github/workflows/gate.yml:analyze';

// One job stands for all of the Gate, so the pipeline can change its jobs without touching this setting in each
// repository. A required check that never reports blocks every merge, so these are names seen on a real pull request.
// CodeQL reports even where its base was never analyzed: it did on the first pull request to develop.
const CHECKS = ['gate / Passed', 'CodeQL'];

const { values: options, positionals: [repository] } = parseArgs({
  options: { environment: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  allowPositionals: true,
});
const dryRun = options['dry-run'];
const environment = options.environment;

if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
  console.error('Usage: node scripts/setup-repo.mjs OWNER/REPOSITORY [--environment NAME] [--dry-run]');
  process.exit(1);
}

function gh(args, body) {
  const input = body === undefined ? undefined : JSON.stringify(body);
  return execFileSync('gh', [...args, ...(input ? ['--input', '-'] : [])], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
}

/** Anything that changes the repository goes through here. */
function change(description, args, body) {
  if (dryRun) {
    console.log(`Would: ${description}\n  gh ${args.join(' ')}${body ? `\n  ${JSON.stringify(body)}` : ''}`);
    return;
  }
  gh(args, body);
  console.log(`Done: ${description}`);
}

// Not strict: main holds merge commits that develop never gets, so "up to date with the base" could never be true.
const protection = (contexts) => ({
  required_status_checks: { strict: false, contexts },
  enforce_admins: true,
  required_pull_request_reviews: { required_approving_review_count: 0 },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
});

function findReleaseRule() {
  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { id branchProtectionRules(first: 50) { nodes { id pattern } } }
  }`;
  const [owner, name] = repository.split('/');
  const { data } = JSON.parse(gh(['api', 'graphql'], { query, variables: { owner, name } }));
  return { repositoryId: data.repository.id, rule: data.repository.branchProtectionRules.nodes.find(({ pattern }) => pattern === RELEASE_PATTERN) };
}

/** The REST API takes no wildcards, so a rule for every release branch has to go through GraphQL. */
function protectReleaseBranches() {
  const { repositoryId, rule } = findReleaseRule();
  const settings = {
    requiresApprovingReviews: true,
    requiredApprovingReviewCount: 0,
    requiresStatusChecks: true,
    requiresStrictStatusChecks: false,
    requiredStatusCheckContexts: CHECKS,
    isAdminEnforced: true,
    allowsForcePushes: false,
    // Publishing deletes the release branch.
    allowsDeletions: true,
  };
  const mutation = rule
    ? { query: 'mutation($input: UpdateBranchProtectionRuleInput!) { updateBranchProtectionRule(input: $input) { clientMutationId } }', variables: { input: { branchProtectionRuleId: rule.id, pattern: RELEASE_PATTERN, ...settings } } }
    : { query: 'mutation($input: CreateBranchProtectionRuleInput!) { createBranchProtectionRule(input: $input) { clientMutationId } }', variables: { input: { repositoryId, pattern: RELEASE_PATTERN, ...settings } } };
  change(`protect ${RELEASE_PATTERN}`, ['api', 'graphql'], mutation);
}

function environmentHasPolicy() {
  try {
    const { branch_policies: policies } = JSON.parse(gh(['api', `repos/${repository}/environments/${environment}/deployment-branch-policies`]));
    return policies.some(({ name }) => name === RELEASE_PATTERN);
  } catch {
    return false;
  }
}

function analysesOn(branch) {
  try {
    return JSON.parse(gh(['api', `repos/${repository}/code-scanning/analyses?ref=refs/heads/${branch}&per_page=100`]));
  } catch {
    return [];
  }
}

/**
 * CodeQL names its analyses after the workflow file. With an old name still on a branch, each pull request to it
 * says "1 configuration not found": the check goes neutral, so new alerts neither show as new nor block the merge.
 * Only the newest analysis of a set can be deleted, and each deletion names the next one.
 */
function removeOldCodeqlAnalyses(branch) {
  const old = analysesOn(branch).filter(({ category, deletable }) => deletable && !category.startsWith(CODEQL_CATEGORY));
  for (const { id, category } of old) {
    const description = `remove the CodeQL analyses named ${category} from ${branch}`;
    if (dryRun) {
      console.log(`Would: ${description}`);
      continue;
    }
    let url = `repos/${repository}/code-scanning/analyses/${id}?confirm_delete=true`;
    while (url) url = JSON.parse(gh(['api', '-X', 'DELETE', url])).confirm_delete_url;
    console.log(`Done: ${description}`);
  }
}

change('allow merge commits only, and turn on auto-merge', ['api', '-X', 'PATCH', `repos/${repository}`], {
  allow_merge_commit: true,
  allow_squash_merge: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
});
change('turn on secret scanning with push protection', ['api', '-X', 'PATCH', `repos/${repository}`], {
  security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
});
change('turn on Dependabot alerts', ['api', '-X', 'PUT', `repos/${repository}/vulnerability-alerts`]);
change('turn on Dependabot security fixes', ['api', '-X', 'PUT', `repos/${repository}/automated-security-fixes`]);
change('turn on private vulnerability reporting', ['api', '-X', 'PUT', `repos/${repository}/private-vulnerability-reporting`]);
if (environment) {
  change(`create the ${environment} environment`, ['api', '-X', 'PUT', `repos/${repository}/environments/${environment}`], {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  if (!environmentHasPolicy()) {
    change(`give that environment to ${RELEASE_PATTERN} only`, ['api', '-X', 'POST', `repos/${repository}/environments/${environment}/deployment-branch-policies`], { name: RELEASE_PATTERN, type: 'branch' });
  }
}
for (const branch of ['develop', 'main']) {
  change(`protect ${branch}`, ['api', '-X', 'PUT', `repos/${repository}/branches/${branch}/protection`], protection(CHECKS));
  removeOldCodeqlAnalyses(branch);
}
protectReleaseBranches();
