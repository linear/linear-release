# Releasing

This document describes how to create a new release of `linear-release`.

## Prerequisites

- You must be on the `main` branch with a clean working tree, up to date with `origin/main`
- The [GitHub CLI](https://cli.github.com) (`gh`) must be installed and authenticated
- `pnpm` must be installed

## Creating a release

Run the release script with the target version:

```bash
pnpm release <version>
```

For example:

```bash
pnpm release 0.7.0
```

The version must follow `MAJOR.MINOR.PATCH` format (e.g., `0.7.0`, `1.0.0`).

## What happens

The release script (`scripts/release.sh`) and CI workflows handle the full process:

### 1. `pnpm release` (local)

The script runs preflight checks and then:

1. Validates that the version format is correct
2. Checks that `gh` is installed and authenticated
3. Verifies the working tree is clean, you're on `main`, and it's up to date with `origin/main`
4. Ensures the `v<version>` tag and `release/<version>` branch don't already exist
5. Creates a `release/<version>` branch
6. Bumps the version in `package.json`
7. Commits the change and pushes the branch
8. Opens a PR against `main` via `gh pr create`

### 2. PR review and merge

Review and merge the PR as usual. The PR only contains the `package.json` version bump.

### 3. Auto-tagging (CI)

When a PR from a `release/*` branch is merged into `main`, the **Auto-tag release** workflow (`.github/workflows/auto-tag-release.yml`) runs automatically:

1. Validates the version from the branch name matches `package.json`
2. Creates and pushes a `v<version>` tag on the merge commit
3. Triggers the release workflow

### 4. Build and publish (CI)

The **Release** workflow (`.github/workflows/release.yml`) is triggered by the new tag and:

1. Builds platform-specific executables (linux-x64, darwin-x64, darwin-arm64) using Bun
2. Code signs and notarizes the macOS binaries
3. Creates a GitHub Release with the built binaries attached
