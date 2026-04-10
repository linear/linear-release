# CircleCI — Continuous Pipeline

Every deployment creates a completed release automatically.

## When to use

Use this when your team ships continuously — every push to main is a deploy, and each deploy should be tracked as its own release in Linear.

## How it works

On every push to `main`, the workflow downloads the Linear Release CLI and runs `sync`. This creates a new release from the commits since the last release and immediately marks it as complete.

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` as an environment variable in CircleCI (Project Settings → Environment Variables).
3. Copy the contents of [`config.yml`](config.yml) into your `.circleci/config.yml` (or merge with your existing config).

## Customization

- **Branch name**: Change `main` in the branch filter if your default branch is different.
- **Monorepo path filters**: Add `--include-paths` to the `sync` command to scope the release to specific directories.
