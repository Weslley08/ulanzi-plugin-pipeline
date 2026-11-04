// The rules of the branch flow, apart from git and gh so that they can be tested:
// a work branch -> develop -> release/vX.Y.Z -> main. See "The branch flow" in README.md.

export const DEVELOP = 'develop';
export const MAIN = 'main';

/** Pushing a branch with one of these prefixes opens its pull request. Keep in step with templates/delivery.yml. */
export const WORK_PREFIXES = ['feature', 'feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci', 'build', 'perf'];
const NEW_FEATURE_PREFIXES = new Set(['feature', 'feat']);

const VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_BRANCH = /^release\/v(\d+\.\d+\.\d+)$/;
// What GitHub writes when a pull request merges, from this repository or from a fork.
const MERGE_SUBJECT = /^Merge pull request #\d+ from ([^/\s]+)\/(\S+)$/;
// Customers read the body of a release: the Community Store's app shows all of it as "What changed".
// Publishing refuses a draft that still has either line, so a person has to write that part.
const NOTES_START = 'WRITE THIS FOR CUSTOMERS.';
const NOTES_END = 'END OF WHAT TO REPLACE';
const TECHNICAL_DETAILS = '## Technical details';

export const releaseBranch = (version) => `release/v${version}`;
export const bumpBranch = (version) => `bump/v${version}`;
export const versionOfReleaseBranch = (branch) => RELEASE_BRANCH.exec(branch)?.[1] ?? null;
export const isVersion = (text) => VERSION.test(text);

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Keeps real version tags, lowest first, without the v. A mistyped v.1.4.0 is not a version. */
export const versionTags = (tags) => tags
  .filter((tag) => tag.startsWith('v') && isVersion(tag.slice(1)))
  .map((tag) => tag.slice(1))
  .sort(compareVersions);

/** Bringing main back into develop is not new work, but a fork's own branch called main is. */
export function mergedBranches(subjects, owner) {
  return subjects.flatMap((subject) => {
    const [, from, branch] = MERGE_SUBJECT.exec(subject) ?? [];
    return branch && !(from === owner && branch === MAIN) ? [branch] : [];
  });
}

/** A new feature raises the second number and anything else the third. A bigger jump is made by hand. */
export function nextVersion(last, branches) {
  const [major, minor, patch] = last.split('.').map(Number);
  const hasFeature = branches.some((branch) => NEW_FEATURE_PREFIXES.has(branch.split('/')[0]));
  return hasFeature ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/**
 * What a push to develop leads to. A version that already has a tag cannot be released again, and one
 * below what the merged branches call for would hide a new feature in a patch.
 * @returns {{idle: true} | {bump: string} | {release: string}}
 */
export function planDevelop({ version, tags, branches }) {
  const last = tags.at(-1);
  if (!last) return { release: version };
  if (!branches.length && tags.includes(version)) return { idle: true };
  const wanted = nextVersion(last, branches);
  return compareVersions(version, wanted) >= 0 ? { release: version } : { bump: wanted };
}

/** @returns {string | null} why this pull request may not merge */
export function flowProblem({ base, head, sameRepo, version }) {
  const headRelease = sameRepo ? versionOfReleaseBranch(head) : null;
  if (base === DEVELOP) {
    return headRelease ? `Nothing flows back from ${head}: a release branch only holds what came from ${DEVELOP}.` : null;
  }
  const baseRelease = versionOfReleaseBranch(base);
  if (baseRelease) {
    if (!sameRepo || head !== DEVELOP) return `A pull request to ${base} must come from ${DEVELOP}.`;
    return version === baseRelease ? null : `${DEVELOP} says version ${version}, so it cannot go to ${base}.`;
  }
  if (base === MAIN) {
    if (!headRelease) return `A pull request to ${MAIN} must come from a release/vX.Y.Z branch. Change the base of this one to ${DEVELOP}.`;
    return version === headRelease ? null : `${head} says version ${version}.`;
  }
  return null;
}

/**
 * Merging into main publishes, and CI cannot see the device. What stands in for that is an approval from the
 * maintainer, given after running docs/VERIFY.md. It counts only for the last commit, from an admin who did not
 * open the pull request: a pull request opened with the maintainer's own token cannot be approved by them.
 * @param {{ author: string, headSha: string, reviews: {user: string, state: string, commit: string}[], permissionOf: (user: string) => string }} pr
 * @returns {string | null} why the maintainer has not approved yet
 */
export function approvalProblem({ author, headSha, reviews, permissionOf }) {
  // A later review replaces an earlier one by the same person. A plain comment decides nothing.
  const verdicts = new Map();
  for (const { user, state, commit } of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) verdicts.set(user, { state, commit });
  }
  const asked = [...verdicts].find(([, { state }]) => state === 'CHANGES_REQUESTED');
  if (asked) return `${asked[0]} asked for changes. They have to approve, or dismiss the review, before this can merge.`;

  const approved = [...verdicts].filter(([, { state }]) => state === 'APPROVED');
  const current = approved.filter(([user, { commit }]) => commit === headSha && user !== author && permissionOf(user) === 'admin');
  if (current.length) return null;
  const stale = approved.some(([user, { commit }]) => commit !== headSha && user !== author && permissionOf(user) === 'admin');
  const next = stale ? 'An approval of an earlier commit no longer counts, because the release changed after it.' : 'Nobody has approved it yet.';
  return `Merging publishes the release. ${next} The maintainer has to run docs/VERIFY.md on a device with the zip from the draft, then approve this pull request. The one who opened it cannot approve it, and the GitHub App opens it, so the maintainer can.`;
}

/** The first commit says what the branch is for, and the template keeps its checklists. */
export function workPullRequest({ branch, subjects, template }) {
  const commits = subjects.map((subject) => `- ${subject}`).join('\n');
  return {
    title: subjects[0] ?? branch,
    body: template.replace(/<!--[\s\S]*?-->/, commits),
  };
}

export function bumpPullRequest(version) {
  return {
    title: `Raise the version to ${version}`,
    body: `What was merged into \`${DEVELOP}\` needs a new version. This merges by itself once the checks pass, and then the pull request for \`${releaseBranch(version)}\` opens.\n\nFor a bigger number, close this and run \`npm run bump -- X.Y.Z\` in a branch.`,
  };
}

export function syncPullRequest() {
  return {
    title: `Bring ${MAIN} back into ${DEVELOP}`,
    body: `Something reached \`${MAIN}\` that \`${DEVELOP}\` does not have, so work branches would miss it. This merges by itself once the checks pass, and asks for no new version. If the files conflict, it needs a merge by hand.`,
  };
}

export function releasePullRequest({ plugin, version, branches }) {
  const list = branches.filter((branch) => !branch.startsWith('bump/')).map((branch) => `- \`${branch}\``).join('\n') || '- Nothing since the last release';
  const steps = [...plugin.validation.steps, `If all of that passes, a draft release is created with the zip and the numbers, and a pull request to \`${MAIN}\` opens`]
    .map((step, i) => `${i + 1}. ${step}`)
    .join('\n');
  return {
    title: `Release v${version}`,
    body: `Merging this is the approval to validate v${version}. GitHub does not let a person approve a pull request in their own name, so the merge is the approval.\n\n## What happens next\n\n${steps}\n\nMore merges into \`${DEVELOP}\` join this pull request.\n\n## What goes in\n\n${list}`,
  };
}

export function mainPullRequest({ plugin, version, repository, commit, measure, publishing }) {
  const draft = `**${plugin.name} ${version}** from [Releases](https://github.com/${repository}/releases)`;
  const opening = publishing
    ? `Merging this publishes the draft ${draft} as the final release.`
    : `Publishing is off in this repository, so merging this leaves the draft ${draft} as a draft until the maintainer sets the \`PUBLISHING_ENABLED\` repository variable to \`true\`.`;
  const done = plugin.validation.done.map((line) => `- ${line}`).join('\n');
  const byHand = publishing ? ' Do not publish the draft by hand: the merge does it.' : '';
  return {
    title: `Publish v${version}`,
    body: `${opening} ${plugin.merging}\n\n## Done automatically on ${commit}\n\n${done}\n\n\`\`\`\n${measure.trim()}\n\`\`\`\n\n## Before merging\n\nCI cannot see the device, and customers read the notes. Write the notes first, because the check reads the draft when the description changes or someone reviews.${byHand} A new merge into this branch validates again, replaces the zip and the technical details, keeps the text you wrote above them, and takes back the approval.

The maintainer's approval is what allows the merge. Give it after running docs/VERIFY.md on a real device with the zip from this draft, putting the result under "Technical details" in its notes, and after replacing the top of the draft's notes with what changes for customers.`,
  };
}

export const notesStillToWrite = (body) => body.includes(NOTES_START) || body.includes(NOTES_END);

export function draftNotes({ plugin, repository, version, changes, measure }) {
  const blob = `https://github.com/${repository}/blob/v${version}`;
  const fill = (text) => text.replaceAll('{blob}', blob).replaceAll('{zip}', `${plugin.pluginFolder}.zip`);
  const measured = measure.trim().split('\n').map((line) => `- ${line.trim().replace(/\s{2,}/g, ': ')}`).join('\n');
  return `${NOTES_START} Replace everything down to the "${NOTES_END}" line, or publishing refuses this draft. The Community Store's app shows all these notes as "What changed", with no tables or HTML, and its site shows only the first three lines, up to 240 characters, with a heading counting as a line. So open with one sentence and two short bullets on what changes for the user, with no heading above them, then the same in Portuguese.

Merged since the last release:

${changes.trim()}

${NOTES_END}

## Installing by hand

${fill(plugin.notes.install)}

## ${plugin.notes.aboutHeading}

${fill(plugin.notes.about)}

${TECHNICAL_DETAILS}

[The manual checklist](${blob}/docs/VERIFY.md) has not been completed. ${fill(plugin.notes.checks)}

\`npm run measure\` on a GitHub Windows runner, against ${plugin.notes.measuredAgainst}:

${measured}`;
}

/** Validating again brings new technical details, and must not lose the text a person already wrote. */
export function refreshNotes(existing, fresh) {
  if (notesStillToWrite(existing)) return fresh;
  return `${existing.split(TECHNICAL_DETAILS)[0].trimEnd()}\n\n${fresh.slice(fresh.indexOf(TECHNICAL_DETAILS))}`;
}
