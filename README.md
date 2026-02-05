<p align="center">
  <a href="https://linear.app" target="_blank" rel="noopener noreferrer">
    <img width="64" src="https://raw.githubusercontent.com/linear/linear/master/docs/logo.svg" alt="Linear logo">
  </a>
</p>
<h1 align="center">
  Linear Release
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

> [!NOTE]
> This project is currently in beta and requires enrollment to use. If you're interested in trying it out or need assistance, please contact [Linear support](https://linear.app/contact) or your account manager. APIs and commands may change in future releases.

## Overview

Linear Release is a CLI tool that integrates your CI/CD pipeline with [Linear's release management](https://linear.app/docs/releases). It automatically:

- Scans commits for Linear issue identifiers (e.g., `ENG-123`)
- Detects pull request references in commit messages
- Creates and updates releases in Linear
- Tracks deployment stages (staging, production, etc.)

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

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Required for commit history

      - name: Download Linear Release CLI
        run: |
          curl -L https://github.com/linear/linear-release/releases/latest/download/linear-release-linux-x64 -o linear-release
          chmod +x linear-release

      - name: Sync release
        env:
          LINEAR_ACCESS_KEY: ${{ secrets.LINEAR_ACCESS_KEY }}
        run: ./linear-release sync
```

## Commands

### `sync`

Creates a release or adds issues to the current release. This is the default command.

```bash
# Name and version default to the short commit hash (e.g., "a1b2c3d")
linear-release sync

# Specify custom name and version
linear-release sync --name="v1.2.0" --version="1.2.0"
```

### `complete`

Marks a release as complete. Only applicable to scheduled pipelines, as continuous pipelines create releases in the completed stage automatically.

```bash
# Completes the most recent started release
linear-release complete

# Completes the release with the specified version
linear-release complete --version="1.2.0"
```

### `update`

Updates a release's deployment stage. Only applicable to scheduled pipelines, as continuous pipelines create releases in the completed stage automatically.

```bash
# Updates the latest started release (or planned if no started release exists)
linear-release update --stage="in review"

# Updates the release with the specified version
linear-release update --stage="in review" --version="1.2.0"
```

## Configuration

### Environment Variables

| Variable            | Required | Description                     |
| ------------------- | -------- | ------------------------------- |
| `LINEAR_ACCESS_KEY` | Yes      | Pipeline access key from Linear |

### CLI Options

| Option            | Commands                     | Description                                                                                                                                              |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`          | `sync`                       | Custom release name. Defaults to short commit hash.                                                                                                      |
| `--version`       | `sync`, `complete`, `update` | Release version identifier. For `sync`, defaults to short commit hash. For `complete` and `update`, if omitted, targets the most recent started release. |
| `--stage`         | `update`                     | Target deployment stage (required for `update`)                                                                                                          |
| `--include-paths` | `sync`                       | Filter commits by changed file paths                                                                                                                     |

### Path Filtering

Use `--include-paths` to only include commits that modify specific files. This is useful for monorepos.

```bash
# Only include commits affecting the mobile app
linear-release sync --include-paths="apps/mobile/**"

# Multiple patterns
linear-release sync --include-paths="apps/mobile/**,packages/shared/**"
```

Patterns use [Git pathspec](https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-pathspec) glob syntax. Paths are relative to the repository root.

Path patterns can also be configured in your pipeline settings in Linear. If both are set, the CLI `--include-paths` option takes precedence.

## How It Works

1. **Fetches the latest release** from your Linear pipeline to determine the commit range
2. **Scans commits** between the last release and the current commit
3. **Extracts issue identifiers** from branch names and commit messages (e.g., `feat/ENG-123-add-feature`)
4. **Detects pull request numbers** from commit messages (e.g., `Merge pull request #42`)
5. **Syncs to Linear** creating or updating the release with linked issues

## License

Licensed under the [MIT License](./LICENSE).
