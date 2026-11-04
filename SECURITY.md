# Security

## Reporting a problem

Use [GitHub's private report](https://github.com/Weslley08/ulanzi-plugin-pipeline/security/advisories/new), not a public issue.

## Why this matters more than one repository

Every plugin runs this code with a token of its GitHub App, which can push branches, open pull requests and publish releases. Published releases reach users through the Community Store with no further review. So anyone who can move `v1` here can reach all of those at once.

## How the risk is limited

- `v1` only moves forward, by a person, and nothing can force-push or delete it. See "Changing the pipeline" in the [README](README.md).
- The App's key reaches four jobs only, and none of them runs anything from npm. The key is read by the one step that makes the token, which lasts an hour and reaches one repository. A test keeps it that way.
- The scripts next to the token come from this repository at the same commit as the workflow, not from the pull request being checked, so a pull request cannot change what checks it.
- `.github/pipeline.json` in a plugin is read as data and never run.
- This repository has no dependencies, and every action is pinned to a commit or digest.
- A fork or a Dependabot pull request gets no secret and a read-only token. The workflows use `pull_request`, never `pull_request_target`.

## How it is checked

Each pull request and a weekly scan run CodeQL, and Dependabot proposes updates to the pinned actions. These tools only find problems that are already known. Passing them does not prove the pipeline has no vulnerabilities.
