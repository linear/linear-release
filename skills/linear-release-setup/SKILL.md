---
name: linear-release-setup
description: Generate CI/CD configuration for Linear Release. Use when setting up
  release tracking, configuring CI pipelines for Linear, or integrating deployments
  with Linear releases. Supports GitHub Actions, GitLab CI, CircleCI, and other platforms.
---

# Linear Release Setup

[Linear Release](https://github.com/linear/linear-release) is a CLI tool that integrates CI/CD pipelines with [Linear's release management](https://linear.app/docs/releases). It scans commits for issue identifiers, creates/updates releases, and tracks deployment stages.

This skill generates CI/CD configuration files for Linear Release based on the user's project setup.

## Interactive Workflow

Follow these steps when the user asks to set up Linear Release:

### Step 1: Detect existing CI setup

Look for existing CI configuration files:

- `.github/workflows/*.yml` — GitHub Actions
- `.gitlab-ci.yml` — GitLab CI
- `.circleci/config.yml` — CircleCI
- `Jenkinsfile`, `bitbucket-pipelines.yml`, etc. — other platforms

### Step 2: Ask the user

Gather the following information (skip questions you can infer from the codebase):

1. **CI platform** — if not auto-detected, ask which platform they use
2. **Pipeline type** — continuous (every merge creates a completed release) or scheduled (releases go through stages like staging → production)
3. **Monorepo?** — if the repo has multiple apps/services, ask which paths to track (e.g. `apps/web/**`)
4. **Deployment stages** — for scheduled pipelines, ask what stages they use (e.g. staging, production)
5. **Release naming** — whether they want custom names/versions (e.g. `v1.2.0`) or the default (short commit SHA)

### Step 3: Generate the CI configuration

Use the patterns in this skill to generate the appropriate configuration. Add the config to an existing workflow file or create a new one, depending on the user's preference.

### Step 4: Remind about secrets

Tell the user to add the `LINEAR_ACCESS_KEY` secret to their CI environment:

- **GitHub Actions**: Repository Settings → Secrets and variables → Actions → New repository secret
- **GitLab CI**: Settings → CI/CD → Variables
- **CircleCI**: Project Settings → Environment Variables

The access key is created in Linear under Settings → Releases → Pipelines.

## Key Concepts

### Pipeline Types

**Continuous pipelines**: Every merge to the main branch creates a completed release. Use a single `sync` command — releases are created in the completed stage automatically.

**Scheduled pipelines**: Releases go through deployment stages (e.g. staging → production). Use multiple commands:

- `sync` — creates a release or adds issues to the current release
- `update --stage=<stage>` — moves the release to a deployment stage
- `complete` — marks the release as done

### Commands Reference

| Command    | Purpose                            | Key flags                                        |
| ---------- | ---------------------------------- | ------------------------------------------------ |
| `sync`     | Create/update release from commits | `--name`, `--release-version`, `--include-paths` |
| `update`   | Move release to a deployment stage | `--stage` (required), `--release-version`        |
| `complete` | Mark release as complete           | `--release-version`                              |

All commands support `--json` for structured output.

### Requirements

- **Full git history**: The checkout step must use `fetch-depth: 0` (or equivalent full clone) so Linear Release can scan commits between releases.
- **`LINEAR_ACCESS_KEY`**: Pipeline access key from Linear, stored as a CI secret.

### Path Filtering (Monorepos)

Use `--include-paths` to only include commits touching specific paths:

```bash
linear-release sync --include-paths="apps/mobile/**"
linear-release sync --include-paths="apps/mobile/**,packages/shared/**"
```

Patterns use Git pathspec glob syntax, relative to the repository root.

## GitHub Actions Patterns

### Using the Official Action

The simplest setup for GitHub Actions uses `linear/linear-release-action@v0`.

#### Continuous Pipeline

```yaml
name: Linear Release
on:
  push:
    branches: [main]

jobs:
  linear-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: linear/linear-release-action@v0
        with:
          access_key: ${{ secrets.LINEAR_ACCESS_KEY }}
```

#### Scheduled Pipeline

```yaml
name: Linear Release
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      action:
        description: "Release action"
        required: true
        type: choice
        options:
          - sync
          - update
          - complete
      stage:
        description: "Deployment stage (for update)"
        required: false
        type: string
      release_version:
        description: "Release version (optional)"
        required: false
        type: string

jobs:
  linear-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      # On push: sync issues to the current release
      - uses: linear/linear-release-action@v0
        if: github.event_name == 'push'
        with:
          access_key: ${{ secrets.LINEAR_ACCESS_KEY }}

      # Manual: run the specified action
      - uses: linear/linear-release-action@v0
        if: github.event_name == 'workflow_dispatch'
        with:
          access_key: ${{ secrets.LINEAR_ACCESS_KEY }}
          action: ${{ inputs.action }}
          stage: ${{ inputs.stage }}
          release_version: ${{ inputs.release_version }}
```

#### With Path Filtering (Monorepo)

```yaml
- uses: linear/linear-release-action@v0
  with:
    access_key: ${{ secrets.LINEAR_ACCESS_KEY }}
    include_paths: "apps/web/**,packages/shared/**"
```

### Using the CLI Binary Directly

For advanced use cases or when you need more control:

```yaml
name: Linear Release
on:
  push:
    branches: [main]

jobs:
  linear-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Download Linear Release
        run: |
          curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
          chmod +x linear-release

      - name: Sync release
        run: ./linear-release sync
        env:
          LINEAR_ACCESS_KEY: ${{ secrets.LINEAR_ACCESS_KEY }}
```

## GitLab CI Patterns

### Setup

All GitLab CI patterns use this base setup to download the binary:

```yaml
.linear-release-setup: &linear-release-setup
  before_script:
    - curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
    - chmod +x linear-release
```

### Continuous Pipeline

```yaml
.linear-release-setup: &linear-release-setup
  before_script:
    - curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
    - chmod +x linear-release

linear-release-sync:
  <<: *linear-release-setup
  stage: deploy
  script:
    - ./linear-release sync
  variables:
    LINEAR_ACCESS_KEY: $LINEAR_ACCESS_KEY
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

### Scheduled Pipeline

```yaml
.linear-release-setup: &linear-release-setup
  before_script:
    - curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
    - chmod +x linear-release

# Runs on every merge to add issues to the current release
linear-release-sync:
  <<: *linear-release-setup
  stage: deploy
  script:
    - ./linear-release sync
  variables:
    LINEAR_ACCESS_KEY: $LINEAR_ACCESS_KEY
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH

# Trigger manually to move the release to a deployment stage
linear-release-update:
  <<: *linear-release-setup
  stage: deploy
  script:
    - ./linear-release update --stage="$STAGE"
  variables:
    LINEAR_ACCESS_KEY: $LINEAR_ACCESS_KEY
    STAGE: ""
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual

# Trigger manually to complete the release
linear-release-complete:
  <<: *linear-release-setup
  stage: deploy
  script:
    - ./linear-release complete
  variables:
    LINEAR_ACCESS_KEY: $LINEAR_ACCESS_KEY
    GIT_DEPTH: 0
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
```

### With Path Filtering (Monorepo)

Add `--include-paths` to the `sync` script in any of the patterns above:

```yaml
script:
  - ./linear-release sync --include-paths="apps/web/**,packages/shared/**"
```

## CircleCI Patterns

### Continuous Pipeline

```yaml
version: 2.1

jobs:
  linear-release-sync:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - run:
          name: Download Linear Release
          command: |
            curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
            chmod +x linear-release
      - run:
          name: Sync release
          command: ./linear-release sync

workflows:
  release:
    jobs:
      - linear-release-sync:
          filters:
            branches:
              only: main
```

The `LINEAR_ACCESS_KEY` environment variable must be set in CircleCI project settings.

### Scheduled Pipeline

```yaml
version: 2.1

jobs:
  linear-release-sync:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - run:
          name: Download Linear Release
          command: |
            curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
            chmod +x linear-release
      - run:
          name: Sync release
          command: ./linear-release sync

  linear-release-update:
    docker:
      - image: cimg/base:current
    parameters:
      stage:
        type: string
    steps:
      - checkout
      - run:
          name: Download Linear Release
          command: |
            curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
            chmod +x linear-release
      - run:
          name: Update release stage
          command: ./linear-release update --stage="<< parameters.stage >>"

  linear-release-complete:
    docker:
      - image: cimg/base:current
    steps:
      - checkout
      - run:
          name: Download Linear Release
          command: |
            curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
            chmod +x linear-release
      - run:
          name: Complete release
          command: ./linear-release complete

workflows:
  # Sync on every push to main
  release-sync:
    jobs:
      - linear-release-sync:
          filters:
            branches:
              only: main

  # Trigger stage updates and completion via CircleCI API
  release-update:
    jobs:
      - linear-release-update:
          stage: staging
      - hold-production:
          type: approval
          requires:
            - linear-release-update
      - linear-release-update:
          stage: production
          requires:
            - hold-production
      - hold-complete:
          type: approval
          requires:
            - linear-release-update
      - linear-release-complete:
          requires:
            - hold-complete
```

## General CI Pattern

For any CI platform not listed above, use this generic bash pattern:

```bash
# 1. Ensure full git history is available (no shallow clones)
# 2. Download the binary for your platform (linux-x64, darwin-arm64, or darwin-x64)
curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
chmod +x linear-release

# 3. Set the access key
export LINEAR_ACCESS_KEY="<your-key>"

# 4. Run the appropriate command
./linear-release sync                              # Continuous: on every merge
./linear-release sync --name="v1.2.0"              # With custom name
./linear-release update --stage="staging"           # Scheduled: move to stage
./linear-release complete                           # Scheduled: finalize release
./linear-release sync --include-paths="apps/web/**" # Monorepo: filter by path
```

### Checklist

- [ ] Full clone / `fetch-depth: 0` — shallow clones will miss commits between releases
- [ ] `LINEAR_ACCESS_KEY` set as a secret environment variable
- [ ] Correct binary for the runner platform (`linux-x64`, `darwin-arm64`, or `darwin-x64`)
- [ ] Runs on merges to the main/default branch
