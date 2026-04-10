# GitLab CI — Scheduled Pipeline

Releases follow a branch cut model where changes collect over time and move through stages before shipping.

## When to use

Use this when your team cuts release branches for stabilization. Main collects changes into the current release, release branches sync with an explicit version and auto-promote on creation.

## How it works

- **Push to default branch**: Syncs issues to the current started release (no explicit version).
- **Push to `release/*`**: Derives the version from the branch name and syncs with that version. Detects branch creation via `CI_COMMIT_BEFORE_SHA` being all zeros, and auto-promotes to "code freeze" on first push.
- **Manual jobs**: `linear-release-update` and `linear-release-complete` can be triggered manually from the GitLab UI for later stage transitions and final completion.

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` as a CI/CD variable in GitLab (Settings → CI/CD → Variables).
3. Copy the contents of [`.gitlab-ci.yml`](.gitlab-ci.yml) into your `.gitlab-ci.yml` (or merge with your existing config).

## Customization

- **Branch patterns**: Change `release/` to match your release branch convention.
- **Stage names**: Replace `code freeze` with whatever your first stage is called.
- **Version derivation**: The example strips `release/` from the branch name. Adjust if your branch naming differs.

## Monorepo note

Add a `changes` filter to the main job's rules only (not release branch jobs):

```yaml
rules:
  - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    changes:
      - "apps/mobile/**"
      - "packages/shared/**"
```

Also add `--include-paths` to all `sync` commands.
