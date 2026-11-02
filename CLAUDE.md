# ulanzi-plugin-pipeline

The shared CI and release pipeline of the Ulanzi plugins: reusable workflows, the branch flow engine and the repository setup. The README explains it. Use the `ulanzi-plugin` skill for anything about the SDK, host or store.

## Commands

`npm test`, on Node 20.12.2 (`.nvmrc`). There are no dependencies, and there should stay none: this code runs next to a token that can publish.

## Things that are easy to break

- Moving `v1` reaches every plugin at once, on every branch, with no pull request of theirs. Confirm with the maintainer before moving it, try the change on a plugin branch first, and only ever move it forward.
- This repository must stay public: public plugins cannot call workflows from a private one.
- A job added to `gate.yml` must also go in the `needs` of `passed`, or it stops blocking merges. A test checks this.
- Jobs that hold `AUTOMATION_TOKEN` must not run npm, so nothing from a dependency runs next to it. A test checks this.
- A called workflow can only keep or lower the permissions of its caller, so a new permission here also needs a change in each plugin's caller.
- Environment secrets only reach a called workflow when the caller says `secrets: inherit`. This was seen on a real run: passed by name, the secret was empty with no error, which is why the integrations job fails on an empty one.
- `github.*` is always the plugin's. `job.workflow_repository` and `job.workflow_sha` are how a job finds this repository, and `.pipeline` must not be there when `check:secrets` runs, because it scans every file git would commit.
- `pipeline.json` comes from the pull request, so it is read as data and never run. `flow.mjs` passes it to `gh` with no shell.
- A required check that never reports blocks every merge, so read the names off a real pull request before changing `CHECKS` in `setup-repo.mjs`. The maintainer runs that script: this session's permission controls refuse settings changes.
- `flow.mjs` and `lib/flow.mjs` came from Clima Pro, and their tests are the record of why each rule exists. Change a rule only together with its test.
- Text that a release or pull request says about one plugin belongs in that plugin's `pipeline.json`. A copied sentence here once told System Monitor's users they needed a WeatherAPI.com key.

## What has not been verified

The flow is tested with a real git and canned `gh` replies, so what GitHub itself does is only seen on a real run. On 2026-11-02 these ran for real, called across repositories: `Next step` opening a pull request, with the token through `secrets: inherit` on Clima Pro and by name on System Monitor, and the whole Gate on all three plugins.

Nothing past that has run yet: the `bump/` pull request, the release path (`build`, `smoke`, `integrations`, `measure`, `draft`), publishing, and `Passed` on a push or the weekly run, when some jobs are skipped on purpose. An environment secret through `secrets: inherit` was seen only within this repository, with a throwaway secret. `flow.mjs` itself has never published a release on GitHub.
