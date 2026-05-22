<p align="center">
  <a href="https://linear.app" target="_blank" rel="noopener noreferrer">
    <img width="64" src="https://raw.githubusercontent.com/linear/linear/master/docs/logo.svg" alt="Linear logo">
  </a>
</p>
<h1 align="center">
  @linear/release
</h1>
<h3 align="center">
  Automate release tracking in your CI/CD pipeline
</h3>
<p align="center">
  Connect your deployments to Linear releases.<br/>
  Automatically link issues to releases.
</p>
<p align="center">
  <a href="https://github.com/linear/linear-release/actions/workflows/test.yml"><img src="https://github.com/linear/linear-release/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/linear/linear-release/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Linear Release is released under the MIT license."></a>
</p>

## Overview

Linear Release is a CLI tool that integrates your CI/CD pipeline with [Linear's release management](https://linear.app/docs/releases). After integrating into your CI, it automatically:

- Scans commits for Linear issue identifiers (e.g., `ENG-123`)
- Detects pull request references in commit messages
- Creates and updates releases in Linear
- Tracks stages for scheduled releases
- Detects changes in the right directories in monorepos with path filtering

## Pipeline Types

Linear Release supports two pipeline styles, created and configured in Linear:

**Continuous**: Every deployment creates a completed release. Use `sync` after each deploy — the release is created in completed stage.

**Scheduled**: An ongoing release collects changes over time, then moves through stages (e.g. "code freeze", "qa") before completion. Useful for release trains. Use `sync` to add issues, `update` to move between stages, and `complete` to finalize (move to released stage).

## Installation

Download the pre-built binary for your platform from the [releases page](https://github.com/linear/linear-release/releases).

```bash
# Linux (x64)
curl -L https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release

# macOS (Apple Silicon)
curl -L https://github.com/linear/linear-release/releases/latest/download/linear-release-darwin-arm64 -o linear-release

# macOS (Intel)
curl -L https://github.com/linear/linear-release/releases/latest/download/linear-release-darwin-x64 -o linear-release

chmod +x linear-release
```

## Quick Start

### GitHub Actions

Use the official [Linear Release Action](https://github.com/marketplace/actions/linear-release) for the simplest setup:

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: linear/linear-release-action@v0
    with:
      access_key: ${{ secrets.LINEAR_ACCESS_KEY }}
```

### Other CI platforms

Download the CLI binary and run it directly:

```yaml
# Download
curl -L https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
chmod +x linear-release

# Run
LINEAR_ACCESS_KEY=<your-key> ./linear-release sync
```

### AI-assisted setup

Use the Linear Release setup skill to generate CI configuration tailored to your project. It supports GitHub Actions, GitLab CI, CircleCI, and other platforms, and walks you through continuous vs. scheduled pipelines, monorepo path filtering, and more.

Copy the [SKILL.md](./skills/linear-release-setup/SKILL.md) into your project, or install it with [skills.sh](https://skills.sh):

```bash
npx skills add linear/linear-release
```

Once installed, run it from your AI agent with `/linear-release-setup` (or just ask the agent to set up Linear Release — it will pick up the skill automatically).

## Commands

### `sync`

Creates a release or adds issues to the current release. This is the default command.

```bash
# Name and version default to the short commit hash (e.g., "a1b2c3d")
linear-release sync

# Specify custom name and version
linear-release sync --name="Release 1.2.0" --release-version="1.2.0"
```

### `complete`

Marks a release as complete. Only applicable to scheduled pipelines, as continuous pipelines create releases in the completed stage automatically.

```bash
# Completes the most recent started release
linear-release complete

# Completes the release with the specified version
linear-release complete --release-version="1.2.0"

# Sets a custom name when completing the release
linear-release complete --name="Release 1.2.0"
```

### `update`

Updates a release's deployment stage. Only applicable to scheduled pipelines, as continuous pipelines create releases in the completed stage automatically.

```bash
# Updates the latest started release (or planned if no started release exists)
linear-release update --stage="in review"

# Updates the release with the specified version
linear-release update --stage="in review" --release-version="1.2.0"

# Sets a custom name when updating the release
linear-release update --stage="in review" --name="Release 1.2.0"
```

## Configuration

### Environment Variables

| Variable            | Required | Description                     |
| ------------------- | -------- | ------------------------------- |
| `LINEAR_ACCESS_KEY` | Yes      | Pipeline access key from Linear |

### CLI Options

| Option                 | Commands                     | Description                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`               | `sync`, `complete`, `update` | Custom release name. For `sync`, the value is applied to the targeted release — both newly created releases and existing ones get the provided name. For `complete` and `update`, sets the name on the targeted release.                                             |
| `--release-version`    | `sync`, `complete`, `update` | Release version identifier. For `sync`, defaults to short commit hash. For `complete` and `update`, selects an existing release with that version (errors if none exists); does not change a release's version. If omitted, targets the most recent started release. |
| `--stage`              | `update`                     | Target deployment stage (required for `update`)                                                                                                                                                                                                                      |
| `--include-paths`      | `sync`                       | Filter commits by changed file paths                                                                                                                                                                                                                                 |
| `--include-subjects`   | `sync`                       | Filter commits whose subject (first line) matches a regex                                                                                                                                                                                                            |
| `--link`               | `sync`, `complete`, `update` | Add a link to the targeted release. Use `--link "https://example.com"` or `--link "Label=https://example.com"`; repeat the flag to add multiple links.                                                                                                               |
| `--document`           | `sync`, `complete`, `update` | Attach a document. `--document "Title=...markdown..."`; repeat for multiple docs. Existing documents with the same title on the release are updated.                                                                                                                 |
| `--document-file`      | `sync`, `complete`, `update` | Same as `--document` but reads the body from a file: `--document-file "Title=path/to/file.md"`. Use `-` to read from stdin.                                                                                                                                          |
| `--release-notes`      | `sync`, `complete`, `update` | Set the release notes for this release. Inline markdown. If combined with `--release-notes-file`, the last flag wins.                                                                                                                                                |
| `--release-notes-file` | `sync`, `complete`, `update` | Same as `--release-notes` but reads from a file. Use `-` for stdin.                                                                                                                                                                                                  |
| `--base-ref`           | `sync`                       | Override the scan base. Exclusive: scans `<base-ref>..HEAD`.                                                                                                                                                                                                         |
| `--json`               | `sync`, `complete`, `update` | Output result as JSON on stdout. Logs are emitted as JSON Lines (one object per line) on stderr.                                                                                                                                                                     |
| `--quiet`              | `sync`, `complete`, `update` | Suppress info-level output. Warnings and errors are still printed.                                                                                                                                                                                                   |
| `--verbose`            | `sync`, `complete`, `update` | Print detailed progress including debug diagnostics                                                                                                                                                                                                                  |
| `--timeout`            | `sync`, `complete`, `update` | Max duration in seconds before aborting (default: 60)                                                                                                                                                                                                                |

### Command Targeting

| Command    | With `--release-version`                                                                                   | Without `--release-version`                                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`     | Targets matching version, labels an unversioned started release, or creates a new release for that version | Continuous pipelines create a release with short SHA name/version. Scheduled pipelines use the currently started release, or move the latest planned release to started automatically if no started release can be found. |
| `update`   | Updates that exact release version                                                                         | Updates latest started release, or latest planned release if no started release exists                                                                                                                                    |
| `complete` | Completes that exact release version                                                                       | Completes latest started release                                                                                                                                                                                          |

For scheduled pipelines, prefer always passing `--release-version` in CI, especially when releases overlap. Only `sync` sets the version on a release — `complete` and `update` strictly look up by version. If your CI has no natural labeling moment (e.g. tag-driven releases), run `sync --release-version=X` immediately before `complete --release-version=X` at release time.

### JSON Output

Use `--json` to get structured output for scripting.

```bash
linear-release sync --json
# => {"release":{"id":"...","name":"Release 1.2.0","version":"1.2.0","url":"https://linear.app/..."}}
```

When no release is created (e.g. no commits found), `--json` outputs `{"release":null}`.

### Log Levels

By default, the CLI prints key results like the number of commits scanned and issues linked. Use log level flags to control verbosity:

| Flag        | Output                                                               |
| ----------- | -------------------------------------------------------------------- |
| `--quiet`   | Warnings and errors only — ideal for silent CI jobs                  |
| _(default)_ | Key results (issues found, release created, etc)                     |
| `--verbose` | Detailed progress (config, shallow-clone fetches, debug diagnostics) |

Only one log level flag can be used at a time.

### Path Filtering

Use `--include-paths` to only include commits that modify specific files. This is useful for monorepos where you make changes to different apps/services that have their own respective pipelines.

```bash
# Only include commits affecting the mobile app
linear-release sync --include-paths="apps/mobile/**"

# Multiple patterns
linear-release sync --include-paths="apps/mobile/**,packages/shared/**"
```

Patterns use [Git pathspec](https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-pathspec) glob syntax. Paths are relative to the repository root.

Path patterns can also be configured in your pipeline settings in Linear. If both are set, the CLI `--include-paths` option takes precedence.

### Subject Filtering

Use `--include-subjects` to only scan commits whose subject (first line) matches a regular expression. Useful when the default commit range pulls in noise — direct pushes without issue links, bot commits, or merge commits you don't want appearing in releases.

```bash
# Only commits that mention a Linear issue identifier in the subject
linear-release sync --include-subjects="[A-Z]{2,}-[0-9]+"

# Conventional Commits — keep user-impacting changes, drop chore/docs/test/ci
linear-release sync --include-subjects="^(feat|fix|perf):"
```

The regex is matched against the commit subject only (everything before the first newline) — body lines such as squash dumps or co-author trailers are ignored. Use the regex's own `|` alternation to combine multiple patterns; remember to escape regex metacharacters in shell strings.

`--include-subjects` composes with `--include-paths`: a commit must pass both filters to be scanned.

### Release Links

`--link` attaches external URLs to the release — a GitHub release page, a CI run, a deployment dashboard.

```bash
# Bare URL — Linear derives the label ("GitHub" here)
linear-release sync --link "https://github.com/acme/app/releases/tag/v1.2.0"

# Multiple labeled links
linear-release sync \
  --link "CI run=https://ci.example.com/run/123" \
  --link "Deploy dashboard=https://deploys.example.com/v1.2.0"

# Works on complete and update too
linear-release complete --release-version="1.2.0" \
  --link "https://github.com/acme/app/releases/tag/v1.2.0"
```

Each value is either an absolute URL or `Label=URL`. Both `--link "Label=..."` and `--link="Label=..."` are accepted. `http(s)` is the typical scheme; the server rejects unsafe ones like `javascript:` or `data:`.

### Documents and release notes

Attach release notes and supporting documents to a release. Each release has at most one set of release notes (last `--release-notes` / `--release-notes-file` wins). Documents are repeatable and keyed by title — re-syncing with the same title updates content in place.

```bash
# Release notes from a generated changelog
linear-release sync --release-notes-file ./CHANGELOG.md

# Plus extra documents (deploy log, runbook, etc.)
linear-release sync \
  --release-notes-file ./CHANGELOG.md \
  --document-file "Deploy log=./deploy.log" \
  --document-file "Runbook=./runbook.md"

# Stdin works on both flags — useful when piping from another command
git log v1.0.0..HEAD --format="- %s" | linear-release sync --release-notes-file -

# Inline (single-line content only — see "Multi-line content" below)
linear-release sync --document "Deploy log=Deployed to production at $(date -u +%FT%TZ)"
```

> **Multi-line content**: use `--document-file` / `--release-notes-file`. Inline `\n` inside `"…"` is passed verbatim by the shell — same gotcha as `gh release create --notes`, `git commit -m`, and `helm --set`. For inline multi-line, use a real newline in the quotes or [`$'…\n…'`](https://www.gnu.org/software/bash/manual/html_node/ANSI_002dC-Quoting.html).

## How It Works

1. **Fetches the latest release** from your Linear pipeline to determine the commit range
2. **Scans commits** between the commit from the last release and the current commit
3. **Extracts issue identifiers** from branch names and commit messages (e.g., `feat/ENG-123-add-feature`)
4. **Detects pull/merge request numbers** from commit messages — GitHub `Title (#42)` / `Merge pull request #42`, and GitLab `See merge request <group>/<project>!42` trailers (emitted whenever a merge commit is created)
5. **Syncs data to Linear** that adds issues and provided links to a newly created completed release (continuous pipelines) or the currently in-progress release (scheduled pipelines). PR/MR numbers are sent alongside the repository info, and Linear resolves them back to any issues linked to those PRs/MRs — so issues attached only via a PR/MR (not mentioned in a commit message or branch name) are still picked up.

> [!NOTE]
> **First sync**: when no prior release exists for the pipeline, only the current commit is scanned (there's no previous SHA to bound the range from).

### Overriding the Scan Base

Use `--base-ref` to explicitly choose the exclusive lower bound for `sync`'s commit scan. This is useful when the automatically selected release baseline is not the range you want for a custom branching workflow, first-time onboarding, or migration.

```bash
linear-release sync --base-ref=<last-released-ref> --include-paths="apps/api/**"
```

The base ref is exclusive: linear-release scans `<base-ref>..HEAD`, matching Git range syntax, and still applies any configured path filters. Pass the last commit, tag, or ref that should be treated as already released, not the first commit you want included.

When `--base-ref` is provided, it overrides automatic base selection for that run. After sync, current `HEAD` is stored as the future release baseline. Choosing an older or newer base can reattach or skip commits, so use this only when you intentionally want to own the scan range.

## Troubleshooting

- **Unexpected release was updated/completed**: pass `--release-version` explicitly so the command does not target the latest started/planned release.
- **No release created by `sync`**: without `--base-ref`, if no commits match the computed range (or path filters), `sync` returns `{"release":null}`.
- **Need to backfill the first release, migrate rewritten history, or override the inferred range**: run `sync` with `--base-ref=<ref>` to set an explicit scan base.
- **Stage update fails**: `--stage` matches first by exact name, then case-insensitively with dashes and underscores treated as spaces. If multiple stages normalize to the same value, pass the exact stage name to disambiguate.
- **`sync --release-version` fails because the matching release is archived**: restore the archived release in Linear before re-syncing.
- **Operation timed out**: the CLI aborts after 60 seconds by default. For large repositories or slow networks, increase the limit with `--timeout=120`.
- **`git` not on PATH**: the CLI shells out to `git`. Install it in your CI image (e.g. `apt-get install -y git` on Debian/Ubuntu).
- **No `.git` directory found**: the CLI must run inside a full clone. On GitLab CI, set `GIT_STRATEGY: clone` (not `none` or `empty`) and `GIT_DEPTH: 0` on the linear-release job.
- **GitLab MR numbers are not linked**: linear-release reads the `See merge request <group>/<project>!N` trailer that GitLab adds to merge commits. Projects configured with `merge_method: fast-forward` produce no merge commit and no trailer, so the MR number cannot be recovered from the message. To still link the change to its Linear issue, include the identifier in the branch name (e.g. `username/eng-123-add-feature`) or in the commit message with a magic word (e.g. `Fixes ENG-123`).
- **Binary fails to start with "not found" or loader errors**: the prebuilt binary is glibc-linked and will not run on Alpine/musl images. Switch to a Debian/Ubuntu base (`debian:bookworm-slim`, `ubuntu:24.04`).

## License

Licensed under the [MIT License](./LICENSE).
