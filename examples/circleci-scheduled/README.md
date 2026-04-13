# CircleCI — Scheduled Pipeline

Releases follow a branch cut model where changes collect over time and move through stages before shipping.

## When to use

Use this when your team cuts release branches for stabilization. Main collects changes into the current release, release branches sync with an explicit version and auto-promote on creation.

## How it works

- **Push to `main`**: Syncs issues to the current started release (no explicit version).
- **Push to `release/*`**: Derives the version from `CIRCLE_BRANCH` and syncs with that version. Detects branch creation by checking for previous pipelines via the CircleCI API, and auto-promotes to "code freeze" on first push.
- **API trigger**: Runs `update` or `complete` with pipeline parameters for later stage transitions and final completion.

### Triggering manual actions

Use the CircleCI API to trigger stage transitions:

```bash
curl -X POST https://circleci.com/api/v2/project/gh/ORG/REPO/pipeline \
  -H "Circle-Token: $CIRCLE_TOKEN" -H "Content-Type: application/json" \
  -d '{"parameters": {"run-release-action": true, "action": "update", "stage": "qa", "release_version": "1.2.0"}}'
```

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` and `CIRCLE_TOKEN` as environment variables in CircleCI (Project Settings → Environment Variables).
3. Copy the contents of [`config.yml`](config.yml) into your `.circleci/config.yml` (or merge with your existing config).

## Customization

- **Branch patterns**: Change `release/` to match your release branch convention.
- **Stage names**: Replace `code freeze` with whatever your first stage is called.
- **Version derivation**: The example strips `release/` from the branch name. Adjust if your branch naming differs.
- **Monorepo path filters**: Add the `include_paths` input to scope the release to specific directories.

## Monorepo note

CircleCI doesn't support path filtering natively. Use the `path-filtering` orb or split into separate workflows and use the API to conditionally trigger.
