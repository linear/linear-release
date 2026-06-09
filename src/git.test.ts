import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertGitAvailable,
  buildPathspecArgs,
  ensureCommitAvailable,
  extractBranchName,
  extractBranchNameFromMergeMessage,
  getCommitContext,
  getCommitContextsBetweenShas,
  getCommitParents,
  getRepoInfo,
  isAncestor,
  normalizePathspec,
  parseRepoUrl,
  resolveFirstSyncBoundary,
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
  it("should return the repo info", () => {
    const result = getRepoInfo();
    expect(result).toBeDefined();
    expect(result?.owner).toBe("linear");
    expect(result?.name).toBe("linear-release");
    expect(result?.provider).toBe("github");
    expect(result?.url).toBe("https://github.com/linear/linear-release");
  });
});

describe("parseRepoUrl", () => {
  describe("HTTPS URLs", () => {
    it("should parse github.com HTTPS URL", () => {
      const result = parseRepoUrl("https://github.com/linear/linear-app.git");
      expect(result).toEqual({
        owner: "linear",
        name: "linear-app",
        provider: "github",
        url: "https://github.com/linear/linear-app",
      });
    });

    it("should parse github.com HTTPS URL without .git suffix", () => {
      const result = parseRepoUrl("https://github.com/linear/linear-app");
      expect(result).toEqual({
        owner: "linear",
        name: "linear-app",
        provider: "github",
        url: "https://github.com/linear/linear-app",
      });
    });

    it("should parse gitlab.com HTTPS URL", () => {
      const result = parseRepoUrl("https://gitlab.com/myorg/myrepo.git");
      expect(result).toEqual({
        owner: "myorg",
        name: "myrepo",
        provider: "gitlab",
        url: "https://gitlab.com/myorg/myrepo",
      });
    });

    it("should parse GitHub Enterprise HTTPS URL", () => {
      const result = parseRepoUrl("https://github.mycompany.com/engineering/platform.git");
      expect(result).toEqual({
        owner: "engineering",
        name: "platform",
        provider: "github",
        url: "https://github.mycompany.com/engineering/platform",
      });
    });

    it("should parse self-hosted GitLab HTTPS URL", () => {
      const result = parseRepoUrl("https://gitlab.internal.io/team/service.git");
      expect(result).toEqual({
        owner: "team",
        name: "service",
        provider: "gitlab",
        url: "https://gitlab.internal.io/team/service",
      });
    });

    it("should parse gitlab.com HTTPS URL with nested groups", () => {
      const result = parseRepoUrl("https://gitlab.com/my-org/my-group/my-repo.git");
      expect(result).toEqual({
        owner: "my-org",
        name: "my-group/my-repo",
        provider: "gitlab",
        url: "https://gitlab.com/my-org/my-group/my-repo",
      });
    });

    it("should parse gitlab.com HTTPS URL with deeply nested groups", () => {
      const result = parseRepoUrl("https://gitlab.com/org/group/subgroup/repo.git");
      expect(result).toEqual({
        owner: "org",
        name: "group/subgroup/repo",
        provider: "gitlab",
        url: "https://gitlab.com/org/group/subgroup/repo",
      });
    });

    it("should parse self-hosted GitLab HTTPS URL with nested groups and no .git suffix", () => {
      const result = parseRepoUrl("https://gitlab.internal.io/team/platform/service");
      expect(result).toEqual({
        owner: "team",
        name: "platform/service",
        provider: "gitlab",
        url: "https://gitlab.internal.io/team/platform/service",
      });
    });

    it("should parse bitbucket.org HTTPS URL", () => {
      const result = parseRepoUrl("https://bitbucket.org/myorg/myrepo.git");
      expect(result).toEqual({
        owner: "myorg",
        name: "myrepo",
        provider: "bitbucket",
        url: "https://bitbucket.org/myorg/myrepo",
      });
    });

    it("should parse self-hosted Bitbucket HTTPS URL", () => {
      const result = parseRepoUrl("https://bitbucket.mycompany.com/team/service.git");
      expect(result).toEqual({
        owner: "team",
        name: "service",
        provider: "bitbucket",
        url: "https://bitbucket.mycompany.com/team/service",
      });
    });

    it("should parse HTTPS URL with credentials", () => {
      const result = parseRepoUrl("https://token@github.com/linear/linear-app.git");
      expect(result).toEqual({
        owner: "linear",
        name: "linear-app",
        provider: "github",
        url: "https://github.com/linear/linear-app",
      });
    });
  });

  describe("SSH URLs", () => {
    it("should parse github.com SSH URL", () => {
      const result = parseRepoUrl("git@github.com:linear/linear-app.git");
      expect(result).toEqual({
        owner: "linear",
        name: "linear-app",
        provider: "github",
        url: "https://github.com/linear/linear-app",
      });
    });

    it("should parse github.com SSH URL without .git suffix", () => {
      const result = parseRepoUrl("git@github.com:linear/linear-app");
      expect(result).toEqual({
        owner: "linear",
        name: "linear-app",
        provider: "github",
        url: "https://github.com/linear/linear-app",
      });
    });

    it("should parse gitlab.com SSH URL", () => {
      const result = parseRepoUrl("git@gitlab.com:myorg/myrepo.git");
      expect(result).toEqual({
        owner: "myorg",
        name: "myrepo",
        provider: "gitlab",
        url: "https://gitlab.com/myorg/myrepo",
      });
    });

    it("should parse GitHub Enterprise SSH URL", () => {
      const result = parseRepoUrl("git@github.mycompany.com:engineering/platform.git");
      expect(result).toEqual({
        owner: "engineering",
        name: "platform",
        provider: "github",
        url: "https://github.mycompany.com/engineering/platform",
      });
    });

    it("should parse self-hosted GitLab SSH URL", () => {
      const result = parseRepoUrl("git@gitlab.internal.io:team/service.git");
      expect(result).toEqual({
        owner: "team",
        name: "service",
        provider: "gitlab",
        url: "https://gitlab.internal.io/team/service",
      });
    });

    it("should parse gitlab.com SSH URL with nested groups", () => {
      const result = parseRepoUrl("git@gitlab.com:my-org/my-group/my-repo.git");
      expect(result).toEqual({
        owner: "my-org",
        name: "my-group/my-repo",
        provider: "gitlab",
        url: "https://gitlab.com/my-org/my-group/my-repo",
      });
    });

    it("should parse gitlab.com SSH URL with deeply nested groups", () => {
      const result = parseRepoUrl("git@gitlab.com:org/group/subgroup/repo.git");
      expect(result).toEqual({
        owner: "org",
        name: "group/subgroup/repo",
        provider: "gitlab",
        url: "https://gitlab.com/org/group/subgroup/repo",
      });
    });

    it("should parse bitbucket.org SSH URL", () => {
      const result = parseRepoUrl("git@bitbucket.org:myorg/myrepo.git");
      expect(result).toEqual({
        owner: "myorg",
        name: "myrepo",
        provider: "bitbucket",
        url: "https://bitbucket.org/myorg/myrepo",
      });
    });

    it("should parse self-hosted Bitbucket SSH URL", () => {
      const result = parseRepoUrl("git@bitbucket.mycompany.com:team/service.git");
      expect(result).toEqual({
        owner: "team",
        name: "service",
        provider: "bitbucket",
        url: "https://bitbucket.mycompany.com/team/service",
      });
    });
  });

  describe("GitHub Enterprise Cloud (*.ghe.com)", () => {
    it("should detect github provider for a *.ghe.com host", () => {
      const result = parseRepoUrl("https://acme.ghe.com/engineering/platform.git");
      expect(result).toEqual({
        owner: "engineering",
        name: "platform",
        provider: "github",
        url: "https://acme.ghe.com/engineering/platform",
      });
    });

    it("should detect github provider for multi-part subdomains under .ghe.com", () => {
      const result = parseRepoUrl("https://tenant-name.ghe.com/owner/repo.git");
      expect(result?.provider).toBe("github");
    });

    it("should not match the bare ghe.com host (no subdomain)", () => {
      const result = parseRepoUrl("https://ghe.com/owner/repo.git");
      expect(result?.provider).toBeNull();
    });

    it("should not match hosts that merely contain .ghe.com as a substring", () => {
      // Suffix match guards against attacker-controlled hosts that happen
      // to include "ghe.com" somewhere in the middle of the hostname.
      const result = parseRepoUrl("https://evil-ghe.com.attacker.com/owner/repo.git");
      expect(result?.provider).toBeNull();
    });
  });

  describe("unknown providers", () => {
    it("should return null provider for unknown hosts", () => {
      const result = parseRepoUrl("https://example.com/myorg/myrepo.git");
      expect(result).toEqual({
        owner: "myorg",
        name: "myrepo",
        provider: null,
        url: "https://example.com/myorg/myrepo",
      });
    });

    it("should return null for unrecognized URL formats", () => {
      expect(parseRepoUrl("not-a-url")).toBeNull();
      expect(parseRepoUrl("")).toBeNull();
    });
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

  describe("GitLab format", () => {
    it("should extract branch name from GitLab merge message with target", () => {
      const message = "Merge branch 'ax/ENG-123-add-button' into 'develop'";
      expect(extractBranchNameFromMergeMessage(message)).toBe("ax/ENG-123-add-button");
    });

    it("should extract branch name from GitLab merge message without target", () => {
      const message = "Merge branch 'feature/ENG-456-fix-auth'";
      expect(extractBranchNameFromMergeMessage(message)).toBe("feature/ENG-456-fix-auth");
    });

    it("should handle case insensitivity for GitLab format", () => {
      const message = "MERGE BRANCH 'feature/LIN-100'";
      expect(extractBranchNameFromMergeMessage(message)).toBe("feature/LIN-100");
    });
  });

  describe("Bitbucket format", () => {
    it("should extract branch name from standard Bitbucket merge message", () => {
      const message = "Merged in romain/LIN-123-fix-auth (pull request #42)";
      expect(extractBranchNameFromMergeMessage(message)).toBe("romain/LIN-123-fix-auth");
    });

    it("should extract branch name and ignore trailing PR title", () => {
      const message = "Merged in feature/ENG-123-add-button (pull request #7) Improve button spacing";
      expect(extractBranchNameFromMergeMessage(message)).toBe("feature/ENG-123-add-button");
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

type ShallowCloneRepo = TempRepo & {
  origin: string;
  source: string;
};

type TempRepoWithMerge = {
  cwd: string;
  commits: {
    base: string;
    featureBranch: string;
    mergeCommit: string;
  };
};

type TempRepoWithMultipleMerges = {
  cwd: string;
  commits: {
    base: string;
    merge100: string; // Merge of feature/LIN-100 (touches frontend/)
    merge200: string; // Merge of feature/LIN-200 (touches backend/)
    merge300: string; // Merge of feature/LIN-300 (touches infra/ — outside includePaths)
    headMerge: string; // Merge of release branch into main
  };
};

type TempRepoReleaseBranch = {
  cwd: string;
  commits: {
    base: string;
    headMerge: string; // The rel-branch → main merge (HEAD)
  };
};

type TempRepoStaleMerge = {
  cwd: string;
  commits: {
    base: string;
    staleMerge: string; // Merge of feat/ABC-1-stale — edited app-a/ only, merged after app-b/ landed
    subjectMerge: string; // Merge of feat/XYZ-2-impl — edited app-b/, key only on the merge subject (HEAD)
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
 * Initializes a tmpdir repo, configures user, creates the listed directories,
 * lands a seed commit, and renames the branch to `main`. Returns the cwd and
 * base SHA.
 */
function initTempRepo(opts: { prefix: string; dirs: string[]; seedFile: { path: string; content: string } }): {
  cwd: string;
  base: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), opts.prefix));
  runGit("init", cwd);
  runGit('config user.email "test@example.com"', cwd);
  runGit('config user.name "Test User"', cwd);
  for (const dir of opts.dirs) {
    mkdirSync(join(cwd, dir), { recursive: true });
  }
  writeFileSync(join(cwd, opts.seedFile.path), opts.seedFile.content);
  runGit("add .", cwd);
  runGit('commit -m "Initial"', cwd);
  runGit("branch -M main", cwd);
  return { cwd, base: runGit("rev-parse HEAD", cwd) };
}

/**
 * Cuts `branch` off `baseBranch`, lands one file change, merges back via
 * `--no-ff` with a GitHub-style PR-merge message, then deletes `branch` to
 * mirror a CI checkout (merged feature branches gone). Returns the merge SHA.
 */
function mergeFeatureBranch(opts: {
  cwd: string;
  baseBranch: string;
  branch: string;
  file: string;
  prNumber: number;
}): string {
  const { cwd, baseBranch, branch, file, prNumber } = opts;
  runGit(`checkout -b ${branch} ${baseBranch}`, cwd);
  writeFileSync(join(cwd, file), "x");
  runGit("add .", cwd);
  runGit(`commit -m "feature work on ${branch}"`, cwd);
  runGit(`checkout ${baseBranch}`, cwd);
  runGit(`merge --no-ff ${branch} -m "Merge pull request #${prNumber} from owner/${branch}"`, cwd);
  const sha = runGit("rev-parse HEAD", cwd);
  runGit(`branch -D ${branch}`, cwd);
  return sha;
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

function createShallowCloneRepo(): ShallowCloneRepo {
  const source = createTempRepo();
  const origin = mkdtempSync(join(tmpdir(), "linear-release-origin-"));
  runGit(`clone --bare ${source.cwd} ${origin}`, tmpdir());

  const cwd = mkdtempSync(join(tmpdir(), "linear-release-shallow-"));
  runGit(`clone --depth 1 file://${origin} ${cwd}`, tmpdir());

  return { cwd, origin, source: source.cwd, commits: source.commits };
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

/**
 * Three feature branches merged into main, then a release branch with one
 * commit merged back as HEAD. `merge300` touches `infra/` only.
 */
function createTempRepoWithMultipleMerges(): TempRepoWithMultipleMerges {
  const { cwd, base } = initTempRepo({
    prefix: "linear-release-multi-merge-",
    dirs: ["frontend", "backend", "infra"],
    seedFile: { path: "frontend/seed.txt", content: "seed" },
  });

  const merge100 = mergeFeatureBranch({
    cwd,
    baseBranch: "main",
    branch: "feature/LIN-100-add-foo",
    file: "frontend/foo.txt",
    prNumber: 100,
  });
  const merge200 = mergeFeatureBranch({
    cwd,
    baseBranch: "main",
    branch: "feature/LIN-200-fix-bar",
    file: "backend/bar.txt",
    prNumber: 200,
  });
  const merge300 = mergeFeatureBranch({
    cwd,
    baseBranch: "main",
    branch: "feature/LIN-300-infra",
    file: "infra/three.txt",
    prNumber: 300,
  });

  // rel branch needs at least one of its own commits, otherwise --no-ff is a
  // no-op when the branches are identical.
  runGit("checkout -b rel/2026-05-06 main", cwd);
  writeFileSync(join(cwd, "frontend", "release-notes.txt"), "notes");
  runGit("add .", cwd);
  runGit('commit -m "release notes"', cwd);
  runGit("checkout main", cwd);
  runGit('merge --no-ff rel/2026-05-06 -m "Merge pull request #324 from owner/rel/2026-05-06"', cwd);
  const headMerge = runGit("rev-parse HEAD", cwd);
  runGit("branch -D rel/2026-05-06", cwd);

  return { cwd, commits: { base, merge100, merge200, merge300, headMerge } };
}

/**
 * Release-branch workflow: features merged INTO `rel/2026-05-06`, then rel
 * merged into main as HEAD. `feature/LIN-300-mobile` touches `mobile-android/`
 * only.
 */
function createTempRepoReleaseBranch(): TempRepoReleaseBranch {
  const { cwd, base } = initTempRepo({
    prefix: "linear-release-rel-branch-",
    dirs: ["frontend-nuxt3", "backend", "mobile-android"],
    seedFile: { path: "frontend-nuxt3/seed.ts", content: "seed" },
  });

  runGit("checkout -b rel/2026-05-06 main", cwd);
  mergeFeatureBranch({
    cwd,
    baseBranch: "rel/2026-05-06",
    branch: "feature/LIN-100-foo",
    file: "frontend-nuxt3/foo.ts",
    prNumber: 100,
  });
  mergeFeatureBranch({
    cwd,
    baseBranch: "rel/2026-05-06",
    branch: "feature/LIN-200-bar",
    file: "backend/bar.ts",
    prNumber: 200,
  });
  mergeFeatureBranch({
    cwd,
    baseBranch: "rel/2026-05-06",
    branch: "feature/LIN-300-mobile",
    file: "mobile-android/m.kt",
    prNumber: 300,
  });

  runGit("checkout main", cwd);
  runGit('merge --no-ff rel/2026-05-06 -m "Merge pull request #324 from owner/rel/2026-05-06"', cwd);
  const headMerge = runGit("rev-parse HEAD", cwd);
  runGit("branch -D rel/2026-05-06", cwd);

  return { cwd, commits: { base, headMerge } };
}

/**
 * Two PR merges into main, each carrying its issue key only in the branch name
 * (no content commit carries a key):
 *  - feat/ABC-1-stale is rooted at `base`, edits app-a/ only, and is merged
 *    AFTER app-b/ appears on main — a stale branch never rebased. Its merge is
 *    not TREESAME to its first parent for app-b/ (which advanced on main while
 *    the branch was open), so `--full-history` keeps it under an app-b pathspec
 *    even though it delivered nothing to app-b/.
 *  - feat/XYZ-2-impl is rooted at the stale merge and genuinely edits app-b/.
 *    Its key lives only on the merge subject, so dropping the merge would lose
 *    it — the exact case #62 fixed.
 */
function createTempRepoStaleMerge(): TempRepoStaleMerge {
  const { cwd, base } = initTempRepo({
    prefix: "linear-release-stale-merge-",
    dirs: ["app-a", "app-b"],
    seedFile: { path: "app-a/file.txt", content: "a0" },
  });

  runGit(`checkout -b feat/ABC-1-stale ${base}`, cwd);
  writeFileSync(join(cwd, "app-a", "file.txt"), "a1");
  runGit("add .", cwd);
  runGit('commit -m "rework app-a internals"', cwd);

  runGit("checkout main", cwd);
  writeFileSync(join(cwd, "app-b", "file.txt"), "b0");
  runGit("add .", cwd);
  runGit('commit -m "add app-b on main"', cwd);

  runGit('merge --no-ff feat/ABC-1-stale -m "Merge pull request #1 from owner/feat/ABC-1-stale"', cwd);
  const staleMerge = runGit("rev-parse HEAD", cwd);
  runGit("branch -D feat/ABC-1-stale", cwd);

  runGit(`checkout -b feat/XYZ-2-impl ${staleMerge}`, cwd);
  writeFileSync(join(cwd, "app-b", "file.txt"), "b1");
  runGit("add .", cwd);
  runGit('commit -m "implement the thing"', cwd);

  runGit("checkout main", cwd);
  runGit('merge --no-ff feat/XYZ-2-impl -m "Merge pull request #2 from owner/feat/XYZ-2-impl"', cwd);
  const subjectMerge = runGit("rev-parse HEAD", cwd);
  runGit("branch -D feat/XYZ-2-impl", cwd);

  return { cwd, commits: { base, staleMerge, subjectMerge } };
}

describe("getCommitContextsBetweenShas", () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = createTempRepo();
  });

  it("should auto-fetch deeper history for shallow clones", () => {
    const shallowRepo = createShallowCloneRepo();

    try {
      expect(runGit("rev-parse --is-shallow-repository", shallowRepo.cwd)).toBe("true");

      ensureCommitAvailable(shallowRepo.commits.first, shallowRepo.cwd);

      const result = getCommitContextsBetweenShas(shallowRepo.commits.first, shallowRepo.commits.third, {
        cwd: shallowRepo.cwd,
      });

      expect(result.map((commit) => commit.sha)).toEqual([shallowRepo.commits.third, shallowRepo.commits.second]);
      expect(runGit("rev-parse --is-shallow-repository", shallowRepo.cwd)).toBe("false");
    } finally {
      rmSync(shallowRepo.cwd, { recursive: true, force: true });
      rmSync(shallowRepo.origin, { recursive: true, force: true });
      rmSync(shallowRepo.source, { recursive: true, force: true });
    }
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

  it("should collapse horizontal whitespace but preserve newlines", () => {
    const result = getCommitContextsBetweenShas(repo.commits.first, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(1);
    // Multiple spaces in the subject should be collapsed
    expect(result[0]?.message).toBe("feat: add src file with extra spaces");
  });

  it("should preserve newlines so extractors can distinguish title from body", () => {
    // Standalone tempdir so the multiline body is independent of the shared fixture.
    const cwd = mkdtempSync(join(tmpdir(), "linear-release-multiline-"));
    try {
      runGit("init", cwd);
      runGit('config user.email "test@example.com"', cwd);
      runGit('config user.name "Test User"', cwd);
      writeFileSync(join(cwd, "file.txt"), "x");
      runGit("add .", cwd);
      runGit('commit -m "Add feature (#100)" -m "Closes LIN-200" -m "Co-authored-by: Other <other@example.com>"', cwd);
      const sha = runGit("rev-parse HEAD", cwd);

      const result = getCommitContextsBetweenShas(sha, sha, { cwd });
      expect(result).toHaveLength(1);
      expect(result[0]?.message).toBe(
        "Add feature (#100)\n\nCloses LIN-200\n\nCo-authored-by: Other <other@example.com>",
      );
      // First line is the actual title (not the entire flattened body)
      expect(result[0]!.message!.split("\n")[0]).toBe("Add feature (#100)");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

      // The `:(top,...)` magic prefix in buildPathspecArgs anchors the glob
      // at the repo root regardless of cwd; without it git would resolve
      // "src/**" against the subdirectory (i.e., src/src/**).
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

  describe("getCommitParents", () => {
    it("returns 2 parents for a merge commit", () => {
      const parents = getCommitParents(mergeRepo.commits.mergeCommit, mergeRepo.cwd);
      expect(parents).toEqual([mergeRepo.commits.base, mergeRepo.commits.featureBranch]);
    });

    it("returns 1 parent for a regular commit", () => {
      expect(getCommitParents(mergeRepo.commits.featureBranch, mergeRepo.cwd)).toEqual([mergeRepo.commits.base]);
    });

    it("returns [] for the root commit", () => {
      expect(getCommitParents(mergeRepo.commits.base, mergeRepo.cwd)).toEqual([]);
    });

    it("returns [] for an unknown SHA", () => {
      expect(getCommitParents("0000000000000000000000000000000000000000", mergeRepo.cwd)).toEqual([]);
    });
  });

  describe("resolveFirstSyncBoundary", () => {
    it("expands to HEAD^1 when HEAD is a merge commit", () => {
      expect(resolveFirstSyncBoundary(mergeRepo.commits.mergeCommit, mergeRepo.cwd)).toBe(mergeRepo.commits.base);
    });

    it("returns the commit itself when HEAD is a regular commit", () => {
      expect(resolveFirstSyncBoundary(mergeRepo.commits.featureBranch, mergeRepo.cwd)).toBe(
        mergeRepo.commits.featureBranch,
      );
    });

    it("returns the commit itself when HEAD is the root commit", () => {
      expect(resolveFirstSyncBoundary(mergeRepo.commits.base, mergeRepo.cwd)).toBe(mergeRepo.commits.base);
    });
  });

  describe("isAncestor", () => {
    it("returns true when sha is an ancestor of headSha", () => {
      expect(isAncestor(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, mergeRepo.cwd)).toBe(true);
    });

    it("returns true for a sha equal to headSha", () => {
      expect(isAncestor(mergeRepo.commits.mergeCommit, mergeRepo.commits.mergeCommit, mergeRepo.cwd)).toBe(true);
    });

    it("returns false when sha is not on headSha's history", () => {
      // featureBranch is reachable from mergeCommit (parent #2), but mergeCommit
      // is not reachable from featureBranch — that's the asymmetric case the
      // walk relies on to skip side-branch candidates.
      expect(isAncestor(mergeRepo.commits.mergeCommit, mergeRepo.commits.featureBranch, mergeRepo.cwd)).toBe(false);
    });

    it("returns false for an unknown sha", () => {
      expect(isAncestor("0000000000000000000000000000000000000000", mergeRepo.commits.mergeCommit, mergeRepo.cwd)).toBe(
        false,
      );
    });
  });

  describe("getCommitContextsBetweenShas with merge commits", () => {
    it("should include merge commit when path filtering would exclude it", () => {
      // The merge node itself adds no file changes, so default simplification
      // would drop it; `--full-history` keeps it for metadata (PR number,
      // branch name) extraction.
      const result = getCommitContextsBetweenShas(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, {
        includePaths: ["src/**"],
        cwd: mergeRepo.cwd,
      });

      // Both the merge (for metadata) and the feature commit (for file changes).
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

  describe("getCommitContextsBetweenShas with multiple merges in range", () => {
    let multiRepo: TempRepoWithMultipleMerges;

    beforeAll(() => {
      multiRepo = createTempRepoWithMultipleMerges();
    });

    afterAll(() => {
      rmSync(multiRepo.cwd, { recursive: true, force: true });
    });

    it("should return in-path merges and drop out-of-path merges across a multi-merge range", () => {
      // `--full-history` keeps merges whose contribution arrived via a non-
      // first parent. Their tree equals one parent's, so default simplification
      // would drop them — and with them the issue keys in their branch names.
      const result = getCommitContextsBetweenShas(multiRepo.commits.base, multiRepo.commits.headMerge, {
        includePaths: ["frontend/**", "backend/**"],
        cwd: multiRepo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(multiRepo.commits.merge100)).toBe(true);
      expect(shas.has(multiRepo.commits.merge200)).toBe(true);
      // merge300 only touched infra/, so under the frontend/backend pathspec it
      // is TREESAME to its parents and `--full-history` drops it natively —
      // LIN-300 never reaches a frontend release.
      expect(shas.has(multiRepo.commits.merge300)).toBe(false);
      expect(shas.has(multiRepo.commits.headMerge)).toBe(true);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toEqual(
        expect.arrayContaining(["feature/LIN-100-add-foo", "feature/LIN-200-fix-bar", "rel/2026-05-06"]),
      );
      expect(branchNames).not.toContain("feature/LIN-300-infra");
    });

    it("should return HEAD merge commit when fromSha === toSha and HEAD is a merge", () => {
      const result = getCommitContextsBetweenShas(multiRepo.commits.headMerge, multiRepo.commits.headMerge, {
        includePaths: ["frontend/**", "backend/**"],
        cwd: multiRepo.cwd,
      });

      const headResult = result.find((c) => c.sha === multiRepo.commits.headMerge);
      expect(headResult).toBeDefined();
      expect(headResult?.branchName).toBe("rel/2026-05-06");
    });

    it("should not drift to an unrelated ancestor when fromSha === toSha and HEAD is outside includePaths", () => {
      // `git log -1 <sha> -- <paths>` walks back from <sha> until something
      // matches the pathspec — `--no-walk` makes it return only <sha>, or
      // nothing if <sha> doesn't match.
      const result = getCommitContextsBetweenShas(multiRepo.commits.merge300, multiRepo.commits.merge300, {
        includePaths: ["frontend/**"],
        cwd: multiRepo.cwd,
      });

      expect(result).toEqual([]);
    });
  });

  describe("getCommitContextsBetweenShas with release-branch workflow", () => {
    // First sync (no prior release SHA) on a merge HEAD: scanning HEAD alone
    // finds no keys because HEAD's branch is the rel branch, not any feature.
    // Caller passes HEAD^1 as the boundary so the rel branch's contents are in
    // range.
    let relRepo: TempRepoReleaseBranch;

    beforeAll(() => {
      relRepo = createTempRepoReleaseBranch();
    });

    afterAll(() => {
      rmSync(relRepo.cwd, { recursive: true, force: true });
    });

    it("should surface feature merges from inside the rel branch when scanning the resolved first-sync boundary", () => {
      // Mirrors the customer's first-sync flow: resolveFirstSyncBoundary picks
      // HEAD^1 because HEAD is a merge, then getCommitContextsBetweenShas runs
      // over that range.
      const boundary = resolveFirstSyncBoundary(relRepo.commits.headMerge, relRepo.cwd);
      expect(boundary).not.toBe(relRepo.commits.headMerge);

      const result = getCommitContextsBetweenShas(boundary, relRepo.commits.headMerge, {
        includePaths: ["frontend-nuxt3/**", "backend/**"],
        cwd: relRepo.cwd,
      });

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toEqual(
        expect.arrayContaining(["feature/LIN-100-foo", "feature/LIN-200-bar", "rel/2026-05-06"]),
      );
      // LIN-300 is mobile-only — outside the path filter — must not leak.
      expect(branchNames).not.toContain("feature/LIN-300-mobile");
    });
  });

  describe("getCommitContextsBetweenShas with stale-branch merges under a path filter", () => {
    let repo: TempRepoStaleMerge;

    beforeAll(() => {
      repo = createTempRepoStaleMerge();
    });

    afterAll(() => {
      rmSync(repo.cwd, { recursive: true, force: true });
    });

    it("drops a stale-branch merge that delivered no change to the filtered paths", () => {
      // feat/ABC-1-stale edited app-a/ only but merged after app-b/ landed, so
      // `--full-history` keeps its merge under the app-b pathspec. The merge
      // delivered nothing to app-b/, so its subject key must not be attributed.
      const result = getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-b/**"],
        cwd: repo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(repo.commits.staleMerge)).toBe(false);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).not.toContain("feat/ABC-1-stale");
    });

    it("retains a merge whose key lives only on the subject when it delivered the filtered paths (#62)", () => {
      // feat/XYZ-2-impl genuinely edited app-b/ and carries its key only on the
      // merge subject — dropping the merge would lose the key, the #62 bug.
      const result = getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-b/**"],
        cwd: repo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(repo.commits.subjectMerge)).toBe(true);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toContain("feat/XYZ-2-impl");
    });

    it("still attributes a stale merge to the surface it actually touched", () => {
      // The same stale merge DID deliver app-a/ changes, so under an app-a filter
      // its subject key is correctly retained — the fix discards leaks, not work.
      // And the app-b-only merge must not leak into the app-a surface.
      const result = getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-a/**"],
        cwd: repo.cwd,
      });

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toContain("feat/ABC-1-stale");
      expect(branchNames).not.toContain("feat/XYZ-2-impl");
    });
  });
});

describe("assertGitAvailable", () => {
  it("succeeds inside a git repository with git on PATH", () => {
    const repo = createTempRepo();
    try {
      expect(() => assertGitAvailable(repo.cwd)).not.toThrow();
    } finally {
      rmSync(repo.cwd, { recursive: true, force: true });
    }
  });

  it("throws when not inside a git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "linear-release-no-repo-"));
    try {
      expect(() => assertGitAvailable(cwd)).toThrow(/git repository/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("throws with a PATH hint when the git binary is missing", () => {
    const repo = createTempRepo();
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-linear-release-test-dir";
    try {
      expect(() => assertGitAvailable(repo.cwd)).toThrow(/git.*on PATH/);
    } finally {
      process.env.PATH = originalPath;
      rmSync(repo.cwd, { recursive: true, force: true });
    }
  });
});
