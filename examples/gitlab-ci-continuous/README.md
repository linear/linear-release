# GitLab CI — Continuous Pipeline

Every deployment creates a completed release automatically.

## When to use

Use this when your team ships continuously — every push to the default branch is a deploy, and each deploy should be tracked as its own release in Linear.

## How it works

On every push to the default branch, the job downloads the Linear Release CLI and runs `sync`. This creates a new release from the commits since the last release and immediately marks it as complete.

## Setup

1. Create a release pipeline in Linear (Settings → Releases) and grab the access key.
2. Add `LINEAR_ACCESS_KEY` as a CI/CD variable in GitLab (Settings → CI/CD → Variables).
3. Copy the contents of [`.gitlab-ci.yml`](.gitlab-ci.yml) into your `.gitlab-ci.yml` (or merge with your existing config).

## Customization

- **Branch rules**: Change `$CI_DEFAULT_BRANCH` if you need to target a different branch.
- **Monorepo path filters**: Add `--include-paths` to the `sync` command to scope the release to specific directories.
