# GitHub Actions — Scheduled Pipeline

Releases follow a branch cut model where changes collect over time and move through stages before shipping.

## When to use

Use this when your team cuts release branches for stabilization. Main collects changes into the current release, a `release/*` branch is cut for stabilization, and branch creation auto-promotes to "code freeze".

## How it works

- **Push to `main`**: Syncs issues to the current started release (no explicit version).
- **Push to `release/*`**: Derives the version from the branch name and syncs with that version. On branch creation, auto-promotes the release to "code freeze".
- **Manual dispatch**: Runs `update` or `complete` with the specified stage and version, for later stage transitions and final completion.

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` as a repository secret (Settings → Secrets and variables → Actions → New repository secret).
3. Copy [`linear-release.yml`](linear-release.yml) into `.github/workflows/`.

## Customization

- **Branch patterns**: Change `release/**` to match your release branch convention.
- **Stage names**: Replace `code freeze` with whatever your first stage is called.
- **Version derivation**: The example strips `release/` from the branch name. Adjust if your branch naming differs.

## Monorepo note

GitHub Actions `paths` applies to all branches in a push trigger. To path-filter `main` without filtering release branches, split into two workflow files:

1. **File 1 (main)**: Add `paths: [...]` to the push trigger, keep only the main sync step.
2. **File 2 (release)**: Keep the release branch + `workflow_dispatch` logic as-is.

Add `include_paths` to the action in both files.
