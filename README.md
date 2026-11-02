# Ulanzi plugin pipeline

The one CI and release pipeline of the Ulanzi Studio plugins. Each plugin keeps two short workflow files that say when it runs and what differs, and the jobs live here, so a fix here reaches all of them.

| Plugin | Uses it from |
| :- | :- |
| [Clima Pro](https://github.com/Weslley08/ulanzi-deck-clima-pro) | `develop` |
| [System Monitor Pro](https://github.com/Weslley08/ulanzi-deck-system-monitor-pro) | `develop` |
| [Soundpad Controller](https://github.com/Weslley08/ulanzi-deck-soundpad-pro) | `feature/soundpad-controller` |

**This repository has to stay public.** GitHub lets a public repository call reusable workflows only from another public repository, and the plugins are public by policy. Nothing here is secret: it holds no key, and the plugins read their secrets from their own settings.

## The branch flow

```
feature/*, fix/*, chore/*...  ->  develop  ->  release/vX.Y.Z  ->  main
```

A person merges at each arrow, and the rest happens by itself:

- **Gate** decides whether a change may merge: the branch rules, workflow lint, tests, coverage, the zip, known vulnerabilities, CodeQL and dependency review. It also runs each week.
- **Delivery** moves the change along: it opens the pull requests, raises the version, builds and validates a release, creates the draft and publishes it.

Each plugin's `CONTRIBUTING.md` explains the steps from a contributor's side. The rules themselves are in [`scripts/lib/flow.mjs`](scripts/lib/flow.mjs).

## What a plugin provides

The pipeline runs these npm scripts in the plugin, so that anyone can run the same thing on their own machine, including from a fork:

| Script | Used for |
| :- | :- |
| `setup` | Installing dependencies from the lockfiles |
| `typecheck`, `test`, `test:coverage` | Tests |
| `package`, `verify:package` | Building the zip into `dist/`, and proving it starts |
| `audit`, `check:sdk`, `check:secrets` | Security |
| `check:licenses` | Optional: it runs if the plugin has it |
| `measure` | The CPU and memory numbers that go in the release |

It also reads `.nvmrc`, `docs/VERIFY.md`, `.github/pull_request_template.md`, and `.github/pipeline.json`, which holds what the pull requests and release notes say about this plugin. A file that is wrong or missing fails with a message naming what to fix.

### `.github/pipeline.json`

[`templates/pipeline.json`](templates/pipeline.json) is a starting point. Everything in it is text, and `{zip}` and `{blob}` are filled in: the zip's name, and the GitHub address of this version's files.

| Field | What it says |
| :- | :- |
| `name` | The name in release titles |
| `pluginFolder` | The folder with `manifest.json`, ending in `.ulanziPlugin` |
| `merging` | The sentence after "Merging this publishes..." in the pull request to `main` |
| `validation.steps` | What happens after merging into a release branch, in that pull request |
| `validation.done` | What was already done, in the pull request to `main` |
| `notes.install` | "Installing by hand" in the release notes |
| `notes.aboutHeading`, `notes.about` | The next section of the notes: required credits and what the plugin does not claim |
| `notes.checks` | What the automated checks really covered. Only write what ran |
| `notes.measuredAgainst` | What `npm run measure` ran against |

### What a plugin can change

In its `gate.yml`:

| Input | Default | What it does |
| :- | :- | :- |
| `test-os` | Windows, macOS and Linux | JSON list of the systems the tests run on |
| `codeql-config` | none | CodeQL configuration, for the paths it should leave out |

In its `delivery.yml`:

| Input | Default | What it does |
| :- | :- | :- |
| `smoke-os` | Windows and macOS | JSON list of the systems the zip must start on |
| `integrations-scripts` | none, which skips the job | npm scripts to run before the draft, separated by spaces |
| `integrations-os` | Linux | The system those scripts run on |
| `integrations-environment` | none | The environment that holds their secret |
| `integrations-secret` | none | The name of that secret, which they read as an environment variable. Without it the job fails, because live tests skip without a key and look like a pass |
| `publishing` | `true` | Anything else leaves the draft alone when a release merges into `main`. New plugins start with `${{ vars.PUBLISHING_ENABLED }}`, so publishing stays off until the maintainer sets that variable |

Both also pass the `AUTOMATION_TOKEN` secret.

## Setting up a plugin

1. Copy [`templates/gate.yml`](templates/gate.yml) and [`templates/delivery.yml`](templates/delivery.yml) to its `.github/workflows/`, and [`templates/pipeline.json`](templates/pipeline.json) to its `.github/`, then fill them in.
2. Open a pull request, and wait for its checks to report. A required check that never reports blocks every merge, so this comes before the next step.
3. Apply the settings with your own login. This protects `develop`, `main` and `release/v*`, allows merge commits only, turns on auto-merge and the security settings. Add `--dry-run` first to see the changes, and `--environment NAME` if the plugin has a secret for `integrations-secret`.

   ```
   node scripts/setup-repo.mjs OWNER/REPOSITORY
   ```

4. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for that repository only, with read and write on **Contents** and **Pull requests**, and set it with `gh secret set AUTOMATION_TOKEN --repo OWNER/REPOSITORY`. Do the same when it expires. A pull request opened with the workflow's own token leaves the Gate waiting for a click on "Approve workflows to run", which is why this is needed.

Each repository requires only two checks: `gate / Passed` and `CodeQL`. `Passed` is one job that waits for all of the Gate, so the jobs can change here without touching the settings of each plugin. When it is red, it is only the summary: open the job it names, because that one says what it needs.

## Changing the pipeline

Plugins call `@v1`, which is a branch. It reaches every plugin the moment it moves, on every branch of theirs, with no pull request and no new plugin version. That is the point of this repository, and also its risk, so:

1. Open a pull request to `main`. `npm test` is the same flow, with a real git and canned `gh` replies.
2. **Try it for real:** on a branch of a plugin, point `gate.yml` and `delivery.yml` at your branch instead of `@v1`. What GitHub itself does only shows on a real run.
3. Merge into `main`, and move `v1` forward:

   ```
   git push origin main:v1
   ```

   Without force, this only ever moves it forward, so what each plugin ran can always be found.

A change that needs something new from the plugins gets a new `v2` branch, and `v1` keeps working until they have all moved.

Plugins call `@v1` and not a pinned commit on purpose: a pinned commit would need a pull request in each plugin for each change here, and that pull request would raise the plugin's version and open a release.

## What stays in each plugin

The scripts behind the npm scripts above stay in the plugin, because a fork has to be able to run them without this repository, and most of them know things about that plugin. That leaves some identical copies across plugins: `bump-version.mjs`, `check-sdk.mjs`, `package.mjs`, `scan-secrets.mjs`, `lib/version.mjs` and `lib/zip.mjs`.
