---
name: linear-release-setup
description: Generate CI/CD configuration for Linear Release. Use when setting up
  release tracking, configuring CI pipelines for Linear, or integrating deployments
  with Linear releases. Supports GitHub Actions, GitLab CI, CircleCI, and other platforms.
---

# Linear Release Setup

## Interactive Workflow

### Step 1: Preflight

Before generating config, confirm:

1. **Pipeline exists in Linear** — the user must have created a release pipeline in Linear first (Settings → Releases). Each pipeline has its own access key.
2. **Detect CI platform** — look for `.github/workflows/*.yml` (GitHub Actions), `.gitlab-ci.yml` (GitLab CI), `.circleci/config.yml` (CircleCI), or other CI config.
3. **Detect default branch** — check `git symbolic-ref refs/remotes/origin/HEAD` or the CI config. Don't assume `main`.

### Step 2: Map pipelines, then ask

Start by listing every build the user ships independently — each becomes its own Linear pipeline. Pipeline-vs-stage confusion is the single most common setup mistake, so whenever a split isn't obvious, apply the test in "Stages vs Pipelines" below.

Ask, in order:

1. **CI platform** — if not auto-detected.

2. **What do you ship, and to whom?** Prompt explicitly about common split candidates: production vs. beta or TestFlight, nightly or dogfood builds, staging, per-platform builds (iOS, Android, web), per-service in a monorepo. For each candidate, apply the test: _can these hold different commits at the same time?_ Yes → separate pipelines. No (same immutable build moving through gates) → one pipeline with stages.

3. **For each pipeline: continuous or scheduled?**
   - **Continuous** — every deploy completes a release. Typical for nightlies, dogfood, and web apps that ship on merge.
   - **Scheduled** — releases collect changes over time and move through stages before shipping. Typical for versioned mobile and on-prem.

4. **For each scheduled pipeline, ask explicitly:**
   - **Branch model** — just `main`, or `main` + release branches (`release/*`)?
   - **Version source** — calendar (`2026.05`), semver (`1.2.0`), or commit SHA? Derived from branch name, CI variable, file, or git tag?
   - **Stages** — what phases does a release move through before completion (e.g. "code freeze", "in qa")? Stages are gates on one build, not separate pipelines.
   - **Automation** — all manual via `workflow_dispatch`, or automated (e.g. cutting a release branch auto-promotes it)?

5. **Monorepo paths** — if multiple pipelines share one repo, note which paths belong to each and wire up path filters in Linear pipeline settings or via `--include-paths`.

### Step 3: Generate the CI configuration

For each pipeline, pick the matching example template, adapt it (branch patterns, stage names, paths, version format), and add it to an existing workflow or create a new one. Multiple pipelines mean multiple workflows or jobs, each calling the CLI with its own access key — one secret per pipeline (e.g. `LINEAR_ACCESS_KEY_IOS`, `LINEAR_ACCESS_KEY_WEB`).

| Platform       | Pipeline Type | Example                                                                                                               |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions | Continuous    | [`github-actions-continuous/`](https://github.com/linear/linear-release/blob/main/examples/github-actions-continuous) |
| GitHub Actions | Scheduled     | [`github-actions-scheduled/`](https://github.com/linear/linear-release/blob/main/examples/github-actions-scheduled)   |
| GitLab CI      | Continuous    | [`gitlab-ci-continuous/`](https://github.com/linear/linear-release/blob/main/examples/gitlab-ci-continuous)           |
| GitLab CI      | Scheduled     | [`gitlab-ci-scheduled/`](https://github.com/linear/linear-release/blob/main/examples/gitlab-ci-scheduled)             |
| CircleCI       | Continuous    | [`circleci-continuous/`](https://github.com/linear/linear-release/blob/main/examples/circleci-continuous)             |
| CircleCI       | Scheduled     | [`circleci-scheduled/`](https://github.com/linear/linear-release/blob/main/examples/circleci-scheduled)               |

For GitHub Actions, prefer the official action (`linear/linear-release-action@v0`). For other platforms, download the CLI binary and refer to the [README](https://github.com/linear/linear-release#commands) for the full command reference:

```bash
curl -sL https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
chmod +x linear-release
```

Each scheduled example includes a **monorepo** note in the header explaining how to split workflows for path filtering per platform.

### Step 4: Remind about secrets

Tell the user to add the `LINEAR_ACCESS_KEY` secret to their CI environment:

- **GitHub Actions**: Repository Settings → Secrets and variables → Actions → New repository secret
- **GitLab CI**: Settings → CI/CD → Variables
- **CircleCI**: Project Settings → Environment Variables

The access key is created in Linear from the pipeline's settings page. Each pipeline has its own access key.

## Key Concepts

### Pipelines

A release pipeline is one independent stream of releases, with its own version history, current release, and access key. This is not a CI pipeline; a Linear pipeline is the unit Linear uses to track releases, and your CI config calls the CLI to update it.

Different products, environments, or distribution channels that ship independently are different pipelines. A team with an App Store build and a separate nightly internal build has two pipelines — different artifacts, different audiences, even from the same codebase.

### Pipeline Types

**Continuous**: Every deploy creates a completed release. One `sync` call on push.

**Scheduled**: An ongoing release collects changes, then moves through stages before completion. Three commands:

- `sync` — adds issues from new commits to the current release
- `update --stage=<stage>` — moves the release to a stage (e.g. "code freeze")
- `complete` — marks the release as shipped

The typical scheduled flow uses **release branches**: `main` collects changes, a `release/*` branch is cut for stabilization, and branch creation auto-promotes to a stage. Version is derived from the branch name (e.g. `release/1.2.0` → `1.2.0`). On `main`, `sync` runs without `--release-version` so issues land on the current started release. On release branches, `sync` runs with `--release-version` to target the specific release.

### Stages vs Pipelines

A **pipeline** is one stream of releases. A **stage** is one phase inside a release on that pipeline. Confusing the two is the single most common setup mistake — work through the test below before writing any config.

**The test:** can two things be in-flight at the same time, holding different commits?

- **Yes** → separate pipelines. TestFlight running on `HEAD` while production ships 1.2 from a release branch. Web staging auto-deploying from `main` while prod lags behind. A hotfix landing in one stream but not the other.
- **No, it's the same build moving through gates** → one pipeline with stages. A release is cut at 1.2, goes through code freeze, QA, and RC soak, then ships. The build never changes; only the phase does.

Stages are process gates: "code freeze", "in qa", "in review", "rc soak". They only exist on scheduled pipelines.

**Ambiguous cases — apply the test:**

- **Beta / TestFlight.** TestFlight soak before GA on the _same build_ → stage on the production pipeline. A separate nightly or dogfood channel shipping _distinct builds_ → its own pipeline.
- **Staging.** Staging that auto-deploys from `main` (or runs hotfixes prod doesn't have) → separate pipeline. Staging that holds the exact same build as prod, just earlier in the promotion path → stage.
- **Per-service monorepo.** Each service that ships independently → its own pipeline, scoped by path filters. Unambiguous; services are never stages.

Stages can also be **frozen** in Linear. A frozen stage makes `sync` (without `--release-version`) skip that release and land commits on the next one — a safety net for code freezes. This is a process tool, not a way to squeeze two pipelines into one.

### Commands

| Command    | Purpose                            | Key flags                                        |
| ---------- | ---------------------------------- | ------------------------------------------------ |
| `sync`     | Create/update release from commits | `--name`, `--release-version`, `--include-paths` |
| `update`   | Move release to a stage            | `--stage` (required), `--release-version`        |
| `complete` | Mark release as complete           | `--release-version`                              |

### GitHub Action Inputs

When using `linear/linear-release-action@v0`, inputs map to CLI flags as follows:

| CLI flag             | Action input                         |
| -------------------- | ------------------------------------ |
| (command positional) | `command`                            |
| `--name`             | `name`                               |
| `--release-version`  | `version` (alias: `release_version`) |
| `--stage`            | `stage`                              |
| `--include-paths`    | `include_paths`                      |

### Path Filtering (Monorepos)

Path filters can be configured in Linear's pipeline settings or via the CLI's `--include-paths` flag (CLI takes precedence if both are set). If the user has already configured paths in Linear, the CLI flag is optional.

For **monorepos with release branches**, CI platforms often can't path-filter differently per branch. The solution is two workflow/job definitions: `main` with path filtering, release branches without. Each scheduled example includes platform-specific instructions.

### Requirements

- **Full git history**: `fetch-depth: 0` or equivalent — shallow clones miss commits between releases.
- **`LINEAR_ACCESS_KEY`**: Per-pipeline access key from Linear, stored as a CI secret.

### Checklist

- [ ] Full clone / `fetch-depth: 0`
- [ ] `LINEAR_ACCESS_KEY` set as a secret (one per pipeline)
- [ ] Correct binary platform (`linux-x64`, `darwin-arm64`, or `darwin-x64`)
- [ ] Triggers on the correct branches (`main` for continuous; `main` + `release/*` for scheduled)
- [ ] Monorepo: path filters set (in Linear config or via `--include-paths`), and separate workflows if using release branches
