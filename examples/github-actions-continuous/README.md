# GitHub Actions — Continuous Pipeline

Every deployment creates a completed release automatically.

## When to use

Use this when your team ships continuously — every push to main is a deploy, and each deploy should be tracked as its own release in Linear.

## How it works

On every push to `main`, the workflow runs `sync` via the official [Linear Release Action](https://github.com/linear/linear-release-action). This creates a new release from the commits since the last release and immediately marks it as complete.

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` as a repository secret (Settings → Secrets and variables → Actions → New repository secret).
3. Copy [`linear-release.yml`](linear-release.yml) into `.github/workflows/`.

## Customization

- **Branch name**: Change `main` in the `branches` filter if your default branch is different.
- **Monorepo path filters**: Add the `include_paths` input to scope the release to specific directories.
