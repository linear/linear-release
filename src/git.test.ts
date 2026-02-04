import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPathspecArgs,
  extractBranchName,
  extractBranchNameFromMergeMessage,
  getCommitContext,
  getCommitContextsBetweenShas,
  getRepoInfo,
  isMergeCommit,
  normalizePathspec,
} from "./git";

describe("normalizePathspec", () => {
  it("should strip leading ./", () => {
    expect(normalizePathspec("./android/**")).toBe("android/**");
  });

  it("should strip leading /", () => {
    expect(normalizePathspec("/src/**")).toBe("src/**");
  });

  it("should strip multiple leading slashes", () => {
    expect(normalizePathspec("///src/**")).toBe("src/**");
    expect(normalizePathspec("/./src/**")).toBe("src/**");
  });

  it("should trim whitespace", () => {
    expect(normalizePathspec("  android/**  ")).toBe("android/**");
  });

  it("should handle empty strings", () => {
    expect(normalizePathspec("")).toBe("");
  });
});

describe("buildPathspecArgs", () => {
  it("should return empty string for null", () => {
    expect(buildPathspecArgs(null)).toBe("");
  });

  it("should return empty string for empty array", () => {
    expect(buildPathspecArgs([])).toBe("");
  });

  it("should build pathspec for single pattern", () => {
    expect(buildPathspecArgs(["android/**"])).toBe('-- ":(top,glob)android/**"');
  });

  it("should build pathspec for multiple patterns", () => {
    expect(buildPathspecArgs(["android/**", "shared/**"])).toBe('-- ":(top,glob)android/**" ":(top,glob)shared/**"');
  });

  it("should filter out empty patterns", () => {
    expect(buildPathspecArgs(["android/**", "", "  "])).toBe('-- ":(top,glob)android/**"');
  });

  it("should normalize patterns", () => {
    expect(buildPathspecArgs(["./android/**", "  ios/**  "])).toBe('-- ":(top,glob)android/**" ":(top,glob)ios/**"');
  });
});

describe("extractBranchName", () => {
  it("should return null for empty or undefined input", () => {
    expect(extractBranchName(undefined)).toBeNull();
    expect(extractBranchName("")).toBeNull();
    expect(extractBranchName("   ")).toBeNull();
  });

  it("should extract a simple branch name", () => {
    expect(extractBranchName("feature/ENG-123-add-button")).toBe("feature/ENG-123-add-button");
  });

  it("should prefer feature branches over common branches", () => {
    expect(extractBranchName("main, feature/ENG-123-fix")).toBe("feature/ENG-123-fix");
    expect(extractBranchName("feature/ENG-123-fix, main")).toBe("feature/ENG-123-fix");
    expect(extractBranchName("master, develop, feature/PLAT-456")).toBe("feature/PLAT-456");
  });

  it("should handle all common branch names (case-insensitive)", () => {
    const commonBranches = ["main", "master", "develop", "dev", "staging", "production", "prod"];

    for (const common of commonBranches) {
      expect(extractBranchName(`${common}, feature/ABC-1`)).toBe("feature/ABC-1");
      expect(extractBranchName(`${common.toUpperCase()}, feature/ABC-1`)).toBe("feature/ABC-1");
    }
  });

  it("should fall back to common branch if no feature branches exist", () => {
    expect(extractBranchName("main")).toBe("main");
    expect(extractBranchName("main, master")).toBe("master"); // longer name preferred
  });

  it("should pick the longest branch name when multiple candidates exist", () => {
    expect(extractBranchName("feat/X, feature/ENG-123-longer-name")).toBe("feature/ENG-123-longer-name");
  });

  it("should handle HEAD -> prefix", () => {
    expect(extractBranchName("HEAD -> feature/ENG-123")).toBe("feature/ENG-123");
    expect(extractBranchName("HEAD -> main, feature/ENG-123")).toBe("feature/ENG-123");
  });

  it("should filter out tags", () => {
    expect(extractBranchName("tag: v1.0.0, feature/ENG-123")).toBe("feature/ENG-123");
    expect(extractBranchName("TAG: v1.0.0, main")).toBe("main");
  });

  it("should filter out origin/HEAD", () => {
    expect(extractBranchName("origin/HEAD, feature/ENG-123")).toBe("feature/ENG-123");
  });

  it("should normalize remote branch prefixes", () => {
    expect(extractBranchName("remotes/origin/feature/ENG-123")).toBe("feature/ENG-123");
    expect(extractBranchName("remotes/upstream/feature/ABC-1, remotes/origin/main")).toBe("feature/ABC-1");
  });

  it("should return null when only tags are present", () => {
    expect(extractBranchName("tag: v1.0.0")).toBeNull();
    expect(extractBranchName("tag: v1.0.0, tag: latest")).toBeNull();
  });
});

describe("getRepoInfo", () => {
  // Skip: reads from actual git remote, will pass once in linear-release repo
  it.skip("should return the repo info", () => {
    const result = getRepoInfo();
    expect(result).toBeDefined();
    expect(result?.owner).toBe("linear");
    expect(result?.name).toBe("linear-release");
  });
});

describe("extractBranchNameFromMergeMessage", () => {
  describe("GitHub format", () => {
    it("should extract branch name from standard GitHub merge message", () => {
      const message = "Merge pull request #431 from RideShareAppOrg/romain/bac-26";
      expect(extractBranchNameFromMergeMessage(message)).toBe("romain/bac-26");
    });

    it("should extract branch name and ignore trailing text", () => {
      const message = "Merge pull request #42 from owner/feature/ENG-123-fix-bug Some description";
      expect(extractBranchNameFromMergeMessage(message)).toBe("feature/ENG-123-fix-bug");
    });

    it("should handle case insensitivity", () => {
      const message = "MERGE PULL REQUEST #100 from owner/branch-name";
      expect(extractBranchNameFromMergeMessage(message)).toBe("branch-name");
    });
  });

  describe("edge cases", () => {
    it("should return null for non-merge messages", () => {
      expect(extractBranchNameFromMergeMessage("Some regular commit")).toBeNull();
      expect(extractBranchNameFromMergeMessage("Fix bug (#123)")).toBeNull();
    });

    it("should return null for null or undefined input", () => {
      expect(extractBranchNameFromMergeMessage(null)).toBeNull();
      expect(extractBranchNameFromMergeMessage(undefined)).toBeNull();
    });
  });
});

type TempRepo = {
  cwd: string;
  commits: {
    first: string;
    second: string;
    third: string;
  };
};

type TempRepoWithMerge = {
  cwd: string;
  commits: {
    base: string;
    featureBranch: string;
    mergeCommit: string;
  };
};

function runGit(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
}

/**
 * Build a deterministic git repo for integration tests.
 *
 * Commit history (oldest -> newest):
 * 1) src/alpha.txt
 * 2) .github/workflows/ci.yml
 * 3) src/beta.txt
 *
 * This lets tests assert includePaths behavior without depending on
 * the state of the working repository.
 */
function createTempRepo(): TempRepo {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-"));
  runGit("init", cwd);
  runGit('config user.email "test@example.com"', cwd);
  runGit('config user.name "Test User"', cwd);

  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "alpha.txt"), "alpha");
  runGit("add .", cwd);
  runGit('commit -m "feat: add src file  with  extra  spaces"', cwd);
  const first = runGit("rev-parse HEAD", cwd);

  mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
  writeFileSync(join(cwd, ".github", "workflows", "ci.yml"), "name: ci");
  runGit("add .", cwd);
  runGit('commit -m "chore: add workflow"', cwd);
  const second = runGit("rev-parse HEAD", cwd);

  writeFileSync(join(cwd, "src", "beta.txt"), "beta");
  runGit("add .", cwd);
  runGit('commit -m "feat: add beta"', cwd);
  const third = runGit("rev-parse HEAD", cwd);

  return { cwd, commits: { first, second, third } };
}

/**
 * Build a deterministic git repo with a merge commit for integration tests.
 *
 * Structure:
 * 1) base commit on main (modifies root file)
 * 2) feature branch created, commits to src/feature.txt
 * 3) merge commit combining main and feature branch
 *
 * This tests that merge commits are included even when path filtering would exclude them.
 */
function createTempRepoWithMerge(): TempRepoWithMerge {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-merge-test-"));
  runGit("init", cwd);
  runGit('config user.email "test@example.com"', cwd);
  runGit('config user.name "Test User"', cwd);

  // Create initial commit on main
  writeFileSync(join(cwd, "README.md"), "initial");
  runGit("add .", cwd);
  runGit('commit -m "Initial commit"', cwd);
  // Ensure branch is named "main" regardless of git's default branch config
  runGit("branch -M main", cwd);
  const base = runGit("rev-parse HEAD", cwd);

  // Create feature branch with commit that modifies src/
  runGit("checkout -b feature/ENG-123-add-feature", cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "feature.txt"), "feature code");
  runGit("add .", cwd);
  runGit('commit -m "Add feature code"', cwd);
  const featureBranch = runGit("rev-parse HEAD", cwd);

  // Merge feature branch into main (creates a merge commit)
  runGit("checkout main", cwd);
  runGit(
    'merge --no-ff feature/ENG-123-add-feature -m "Merge pull request #42 from owner/feature/ENG-123-add-feature"',
    cwd,
  );
  const mergeCommit = runGit("rev-parse HEAD", cwd);

  return { cwd, commits: { base, featureBranch, mergeCommit } };
}

describe("getCommitContextsBetweenShas", () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = createTempRepo();
  });

  afterAll(() => {
    rmSync(repo.cwd, { recursive: true, force: true });
  });

  it("should return empty array for invalid SHA patterns", () => {
    expect(
      getCommitContextsBetweenShas("invalid", repo.commits.third, {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
    expect(
      getCommitContextsBetweenShas(repo.commits.first, "invalid", {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
    expect(
      getCommitContextsBetweenShas("not-a-sha", "also-invalid", {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
  });

  it("should return commits between two valid SHAs", () => {
    const result = getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.sha).toBe(repo.commits.third);
    expect(result[1]?.sha).toBe(repo.commits.second);
  });

  it("should return single commit when fromSha equals toSha", () => {
    const result = getCommitContextsBetweenShas(repo.commits.first, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sha).toBe(repo.commits.first);
  });

  it("should normalize commit message whitespace", () => {
    const result = getCommitContextsBetweenShas(repo.commits.first, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(1);
    // The first commit has "feat: add src file  with  extra  spaces" - multiple spaces should be normalized
    expect(result[0]?.message).not.toMatch(/\s{2,}/);
    expect(result[0]?.message).toBe("feat: add src file with extra spaces");
  });

  it("should return empty array when no commits in range", () => {
    // third..first is empty because first is an ancestor of third
    const result = getCommitContextsBetweenShas(repo.commits.third, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toEqual([]);
  });

  it("should filter commits by includePaths patterns", () => {
    const withSrcFilter = getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: ["src/**"],
      cwd: repo.cwd,
    });
    expect(withSrcFilter).toHaveLength(1);
    expect(withSrcFilter[0]?.sha).toBe(repo.commits.third);

    const withGithubFilter = getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: [".github/**"],
      cwd: repo.cwd,
    });
    expect(withGithubFilter).toHaveLength(1);
    expect(withGithubFilter[0]?.sha).toBe(repo.commits.second);
  });

  it("should resolve paths relative to repo root even when process.cwd() is a subdirectory", () => {
    // Simulates running the CLI from a subdirectory (e.g., mobile-ios/ci_scripts)
    // while using paths relative to the repo root (e.g., src/**)
    const originalCwd = process.cwd();
    try {
      process.chdir(join(repo.cwd, "src"));

      // Without the fix, this would fail because git would look for "src/**" relative to
      // the subdirectory (i.e., src/src/**) which doesn't exist
      const result = getCommitContextsBetweenShas(
        repo.commits.first,
        repo.commits.third,
        { includePaths: ["src/**"] }, // no cwd passed — uses process.cwd()
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.sha).toBe(repo.commits.third);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should not resolve paths relative to cwd", () => {
    // Companion test to the above: verifies that paths are resolved from repo root, not cwd.
    // From within src/, looking for "*.txt" would match src/alpha.txt and src/beta.txt
    // if paths were relative to cwd. With :(top), it looks for <repo>/*.txt which doesn't exist.
    const originalCwd = process.cwd();
    try {
      process.chdir(join(repo.cwd, "src"));

      const result = getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
        includePaths: ["*.txt"],
      });

      expect(result).toHaveLength(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("merge commit handling", () => {
  let mergeRepo: TempRepoWithMerge;

  beforeAll(() => {
    mergeRepo = createTempRepoWithMerge();
  });

  afterAll(() => {
    rmSync(mergeRepo.cwd, { recursive: true, force: true });
  });

  describe("isMergeCommit", () => {
    it("should return true for a merge commit", () => {
      expect(isMergeCommit(mergeRepo.commits.mergeCommit, mergeRepo.cwd)).toBe(true);
    });

    it("should return false for a regular commit", () => {
      expect(isMergeCommit(mergeRepo.commits.featureBranch, mergeRepo.cwd)).toBe(false);
      expect(isMergeCommit(mergeRepo.commits.base, mergeRepo.cwd)).toBe(false);
    });

    it("should return false for invalid SHA", () => {
      expect(isMergeCommit("invalid-sha", mergeRepo.cwd)).toBe(false);
    });
  });

  describe("getCommitContext", () => {
    it("should return commit context for a valid SHA", () => {
      const context = getCommitContext(mergeRepo.commits.mergeCommit, mergeRepo.cwd);
      expect(context).not.toBeNull();
      expect(context?.sha).toBe(mergeRepo.commits.mergeCommit);
      expect(context?.message).toContain("Merge pull request #42");
    });

    it("should extract branch name from merge commit message when decorations are empty", () => {
      // Delete the feature branch so decorations won't include it
      runGit("branch -d feature/ENG-123-add-feature", mergeRepo.cwd);

      const context = getCommitContext(mergeRepo.commits.mergeCommit, mergeRepo.cwd);
      expect(context?.branchName).toBe("feature/ENG-123-add-feature");
    });

    it("should return null for invalid SHA", () => {
      expect(getCommitContext("invalid-sha", mergeRepo.cwd)).toBeNull();
    });
  });

  describe("getCommitContextsBetweenShas with merge commits", () => {
    it("should include merge commit when path filtering would exclude it", () => {
      // Without the fix, path filtering for "src/**" would only return the feature branch commit
      // because merge commits don't have direct file changes.
      // With the fix, the merge commit should be included for metadata extraction.
      const result = getCommitContextsBetweenShas(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, {
        includePaths: ["src/**"],
        cwd: mergeRepo.cwd,
      });

      // Should include both: the merge commit (for metadata) and the feature commit (for file changes)
      expect(result.length).toBeGreaterThanOrEqual(2);

      // The merge commit should be first (unshifted)
      const mergeCommitResult = result.find((c) => c.sha === mergeRepo.commits.mergeCommit);
      expect(mergeCommitResult).toBeDefined();
      expect(mergeCommitResult?.message).toContain("Merge pull request #42");
      expect(mergeCommitResult?.branchName).toBe("feature/ENG-123-add-feature");

      // The feature branch commit should also be included
      const featureCommitResult = result.find((c) => c.sha === mergeRepo.commits.featureBranch);
      expect(featureCommitResult).toBeDefined();
    });

    it("should not duplicate merge commit if it was already included", () => {
      // Without path filtering, the merge commit is already included
      const result = getCommitContextsBetweenShas(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, {
        cwd: mergeRepo.cwd,
      });

      // Count occurrences of merge commit
      const mergeCommitCount = result.filter((c) => c.sha === mergeRepo.commits.mergeCommit).length;
      expect(mergeCommitCount).toBe(1);
    });
  });
});
