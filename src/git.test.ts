import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError } from "./provider";
import {
  assertGitAvailable,
  buildPathspecArgs,
  ensureCommitAvailable,
  extractBranchName,
  extractBranchNameFromMergeMessage,
  getCommitContext,
  getCommitContextsBetweenShas,
  countCommitsInRange,
  getCurrentGitInfo,
  getCommitParents,
  getRemoteUrl,
  isAncestor,
  normalizePathspec,
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

  it("should preserve negation while normalizing the path", () => {
    expect(normalizePathspec(" !./mobile/** ")).toBe("!mobile/**");
    expect(normalizePathspec("!/desktop/**")).toBe("!desktop/**");
  });

  it("should trim whitespace between the negation and the path", () => {
    expect(normalizePathspec("! mobile/**")).toBe("!mobile/**");
    expect(normalizePathspec("! ./desktop/**")).toBe("!desktop/**");
  });

  it("should handle empty strings", () => {
    expect(normalizePathspec("")).toBe("");
  });
});

describe("buildPathspecArgs", () => {
  it("should return an empty array for null", () => {
    expect(buildPathspecArgs(null)).toEqual([]);
  });

  it("should return an empty array for an empty array", () => {
    expect(buildPathspecArgs([])).toEqual([]);
  });

  it("should build pathspec for single pattern", () => {
    expect(buildPathspecArgs(["android/**"])).toEqual(["--", ":(top,glob)android/**"]);
  });

  it("should build pathspec for multiple patterns", () => {
    expect(buildPathspecArgs(["android/**", "shared/**"])).toEqual([
      "--",
      ":(top,glob)android/**",
      ":(top,glob)shared/**",
    ]);
  });

  it("should filter out empty patterns", () => {
    expect(buildPathspecArgs(["android/**", "", "  "])).toEqual(["--", ":(top,glob)android/**"]);
  });

  it("should normalize patterns", () => {
    expect(buildPathspecArgs(["./android/**", "  ios/**  "])).toEqual([
      "--",
      ":(top,glob)android/**",
      ":(top,glob)ios/**",
    ]);
  });

  it("should build exclude pathspecs for negated patterns", () => {
    expect(buildPathspecArgs(["**", "!./mobile/**", " !/desktop/** "])).toEqual([
      "--",
      ":(top,glob)**",
      ":(top,glob,exclude)mobile/**",
      ":(top,glob,exclude)desktop/**",
    ]);
  });

  it("should reject a negation without a path", () => {
    expect(() => buildPathspecArgs(["!"])).toThrow(ConfigurationError);
    expect(() => buildPathspecArgs(["! "])).toThrow("a negation must include a path");
    expect(() => buildPathspecArgs(["src/**", "!"])).toThrow(ConfigurationError);
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

describe("getRemoteUrl", () => {
  it("should return the origin remote URL", () => {
    expect(getRemoteUrl()).toMatch(/github\.com[:/]linear\/linear-release/);
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

type TempRepoStaleBranchDecoration = {
  cwd: string;
  commits: {
    base: string;
    downMerge: string; // Interior merge commit a stale branch was cut from; subject is not a parseable merge message
    tip: string;
  };
};

type TempRepoFastForwardFeature = {
  cwd: string;
  commits: {
    base: string;
    feature: string; // Fast-forwarded regular commit whose issue key lives only in the branch name
    tip: string;
  };
};

function runGit(command: string, cwd: string): string {
  return execSync(`git ${command}`, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
}

function buildFastImportMessage(index: number, messageBytes: number): string {
  const header = `Merge pull request #${40000 + index} from owner/feature/PLAT-${10000 + index}-sync-pipeline\n\nPLAT-${10000 + index}: update service ${index}\n\n`;
  const filler = "* chore(deps): bump internal packages and regenerate lockfile entries for the release train\n";
  return (header + filler.repeat(Math.ceil((messageBytes - header.length) / filler.length))).slice(0, messageBytes);
}

function createFastImportRepo(
  commitCount: number,
  messageBytes: number,
): {
  cwd: string;
  anchor: string;
  commits: string[];
  head: string;
} {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-fast-import-"));
  runGit("init", cwd);
  const records: string[] = [];
  const appendCommit = (mark: number, message: string, from?: number) => {
    records.push(
      `commit refs/heads/main\nmark :${mark}\ncommitter Repro Bot <repro@example.com> ${1753000000 + mark * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${from ? `from :${from}\n` : ""}\n`,
    );
  };

  appendCommit(1, "chore: release anchor v20260506\n");
  for (let index = 1; index <= commitCount; index++) {
    appendCommit(index + 1, buildFastImportMessage(index, messageBytes), index);
  }
  execSync("git fast-import", {
    cwd,
    input: records.join(""),
    stdio: ["pipe", "ignore", "pipe"],
  });

  const [anchor, ...commits] = runGit("rev-list --reverse main", cwd).split("\n");
  return { cwd, anchor: anchor!, commits, head: commits[commits.length - 1]! };
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
 *    AFTER app-b/ appears on main — a stale branch never rebased. The merge
 *    differs from its first parent for app-b/ only because app-b/ advanced on
 *    main while the branch was open, so `--full-history` keeps it under an app-b
 *    pathspec even though the branch delivered nothing to app-b/.
 *  - feat/XYZ-2-impl is rooted at the stale merge and genuinely edits app-b/.
 *    Its key lives only on the merge subject, so dropping the merge would lose
 *    the key entirely even though the merge did deliver app-b/ changes.
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

/**
 * A stale branch cut from an interior down-merge commit and never committed onto,
 * so its ref only decorates that merge. The merge subject is not a parseable merge
 * message, leaving the decoration as the sole — wrong — branch-name source.
 */
function createTempRepoStaleBranchDecoration(): TempRepoStaleBranchDecoration {
  const { cwd, base } = initTempRepo({
    prefix: "linear-release-stale-decoration-",
    dirs: ["src"],
    seedFile: { path: "src/a.txt", content: "a" },
  });

  runGit(`checkout -b trunk ${base}`, cwd);
  writeFileSync(join(cwd, "src", "b.txt"), "b");
  runGit("add .", cwd);
  runGit('commit -m "trunk work"', cwd);

  runGit("checkout main", cwd);
  writeFileSync(join(cwd, "src", "c.txt"), "c");
  runGit("add .", cwd);
  runGit('commit -m "release work"', cwd);
  runGit('merge --no-ff trunk -m "Down merge trunk into release (#501)"', cwd);
  const downMerge = runGit("rev-parse HEAD", cwd);

  runGit(`branch ZED-7 ${downMerge}`, cwd);

  writeFileSync(join(cwd, "src", "d.txt"), "d");
  runGit("add .", cwd);
  runGit('commit -m "[ARC-3]: fix worker lookup for restricted roles (#502)"', cwd);
  const tip = runGit("rev-parse HEAD", cwd);

  return { cwd, commits: { base, downMerge, tip } };
}

/**
 * A GitLab fast-forward merge: the feature branch's commit lands verbatim on main
 * with the issue key only in the branch name, and a later commit leaves it
 * interior. The kept branch ref is the sole source of the key — it must survive.
 */
function createTempRepoFastForwardFeature(): TempRepoFastForwardFeature {
  const { cwd, base } = initTempRepo({
    prefix: "linear-release-ff-feature-",
    dirs: ["src"],
    seedFile: { path: "src/a.txt", content: "a" },
  });

  runGit(`checkout -b user/REL-9-feature ${base}`, cwd);
  writeFileSync(join(cwd, "src", "b.txt"), "b");
  runGit("add .", cwd);
  runGit('commit -m "Add feature"', cwd);
  const feature = runGit("rev-parse HEAD", cwd);

  runGit("checkout main", cwd);
  runGit("merge --ff-only user/REL-9-feature", cwd);
  writeFileSync(join(cwd, "src", "c.txt"), "c");
  runGit("add .", cwd);
  runGit('commit -m "chore: follow-up"', cwd);
  const tip = runGit("rev-parse HEAD", cwd);

  return { cwd, commits: { base, feature, tip } };
}

describe("getCommitContextsBetweenShas", () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = createTempRepo();
  });

  it("should auto-fetch deeper history for shallow clones", async () => {
    const shallowRepo = createShallowCloneRepo();

    try {
      expect(runGit("rev-parse --is-shallow-repository", shallowRepo.cwd)).toBe("true");

      ensureCommitAvailable(shallowRepo.commits.first, shallowRepo.cwd);

      const result = await getCommitContextsBetweenShas(shallowRepo.commits.first, shallowRepo.commits.third, {
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

  it("should return empty array for invalid SHA patterns", async () => {
    expect(
      await getCommitContextsBetweenShas("invalid", repo.commits.third, {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
    expect(
      await getCommitContextsBetweenShas(repo.commits.first, "invalid", {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
    expect(
      await getCommitContextsBetweenShas("not-a-sha", "also-invalid", {
        cwd: repo.cwd,
      }),
    ).toEqual([]);
  });

  it("should return commits between two valid SHAs", async () => {
    const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.sha).toBe(repo.commits.third);
    expect(result[1]?.sha).toBe(repo.commits.second);
  });

  it("should return single commit when fromSha equals toSha", async () => {
    const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sha).toBe(repo.commits.first);
  });

  it("should collapse horizontal whitespace but preserve newlines", async () => {
    const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toHaveLength(1);
    // Multiple spaces in the subject should be collapsed
    expect(result[0]?.message).toBe("feat: add src file with extra spaces");
  });

  it("should preserve newlines so extractors can distinguish title from body", async () => {
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

      const result = await getCommitContextsBetweenShas(sha, sha, { cwd });
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

  it("should return empty array when no commits in range", async () => {
    // third..first is empty because first is an ancestor of third
    const result = await getCommitContextsBetweenShas(repo.commits.third, repo.commits.first, {
      cwd: repo.cwd,
    });
    expect(result).toEqual([]);
  });

  it("should filter commits by includePaths patterns", async () => {
    const withSrcFilter = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: ["src/**"],
      cwd: repo.cwd,
    });
    expect(withSrcFilter).toHaveLength(1);
    expect(withSrcFilter[0]?.sha).toBe(repo.commits.third);

    const withGithubFilter = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: [".github/**"],
      cwd: repo.cwd,
    });
    expect(withGithubFilter).toHaveLength(1);
    expect(withGithubFilter[0]?.sha).toBe(repo.commits.second);
  });

  it("should exclude commits matching negated path patterns", async () => {
    const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: ["**", "!.github/**"],
      cwd: repo.cwd,
    });

    expect(result.map((commit) => commit.sha)).toEqual([repo.commits.third]);
  });

  it("should support exclusion-only path patterns", async () => {
    const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
      includePaths: ["!.github/**"],
      cwd: repo.cwd,
    });

    expect(result.map((commit) => commit.sha)).toEqual([repo.commits.third]);
  });

  it("should reject a negation without a path instead of scanning unfiltered", async () => {
    await expect(
      getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
        includePaths: ["!"],
        cwd: repo.cwd,
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it("should resolve paths relative to repo root even when process.cwd() is a subdirectory", async () => {
    // Simulates running the CLI from a subdirectory (e.g., mobile-ios/ci_scripts)
    // while using paths relative to the repo root (e.g., src/**)
    const originalCwd = process.cwd();
    try {
      process.chdir(join(repo.cwd, "src"));

      // The `:(top,...)` magic prefix in buildPathspecArgs anchors the glob
      // at the repo root regardless of cwd; without it git would resolve
      // "src/**" against the subdirectory (i.e., src/src/**).
      const result = await getCommitContextsBetweenShas(
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

  it("should not resolve paths relative to cwd", async () => {
    // Companion test to the above: verifies that paths are resolved from repo root, not cwd.
    // From within src/, looking for "*.txt" would match src/alpha.txt and src/beta.txt
    // if paths were relative to cwd. With :(top), it looks for <repo>/*.txt which doesn't exist.
    const originalCwd = process.cwd();
    try {
      process.chdir(join(repo.cwd, "src"));

      const result = await getCommitContextsBetweenShas(repo.commits.first, repo.commits.third, {
        includePaths: ["*.txt"],
      });

      expect(result).toHaveLength(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should parse large commit messages incrementally with intact fields", async () => {
    const fastImportRepo = createFastImportRepo(3, 1024 * 1024);
    try {
      const result = await getCommitContextsBetweenShas(fastImportRepo.anchor, fastImportRepo.head, {
        cwd: fastImportRepo.cwd,
      });

      expect(result).toHaveLength(3);
      for (let resultIndex = 0; resultIndex < result.length; resultIndex++) {
        const commitIndex = 3 - resultIndex;
        const expectedSha = fastImportRepo.commits[commitIndex - 1]!;
        const expectedParent = commitIndex === 1 ? fastImportRepo.anchor : fastImportRepo.commits[commitIndex - 2]!;
        expect(result[resultIndex]).toEqual({
          sha: expectedSha,
          branchName: `feature/PLAT-${10000 + commitIndex}-sync-pipeline`,
          message: buildFastImportMessage(commitIndex, 1024 * 1024).trim(),
          parents: [expectedParent],
        });
      }
    } finally {
      rmSync(fastImportRepo.cwd, { recursive: true, force: true });
    }
  });

  it("should stream git log output larger than 256 MiB", async () => {
    const fastImportRepo = createFastImportRepo(270, 1024 * 1024);
    try {
      const result = await getCommitContextsBetweenShas(fastImportRepo.anchor, fastImportRepo.head, {
        cwd: fastImportRepo.cwd,
      });

      expect(result).toHaveLength(270);
      expect(result[0]?.sha).toBe(fastImportRepo.head);
      expect(result[result.length - 1]?.sha).toBe(fastImportRepo.commits[0]);
    } finally {
      rmSync(fastImportRepo.cwd, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("getCurrentGitInfo", () => {
  it("should preserve branch and commit for a large HEAD message", () => {
    const repo = initTempRepo({
      prefix: "linear-release-large-head-",
      dirs: ["src"],
      seedFile: { path: "src/file.txt", content: "content" },
    });
    try {
      execSync("git commit --amend -F -", {
        cwd: repo.cwd,
        input: "Large HEAD\n\n" + "x".repeat(2 * 1024 * 1024),
        stdio: ["pipe", "ignore", "pipe"],
      });

      const info = getCurrentGitInfo(repo.cwd);
      expect(info.branch).not.toBeNull();
      expect(info.commit).not.toBeNull();
    } finally {
      rmSync(repo.cwd, { recursive: true, force: true });
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
    it("should return commit context for a valid SHA", async () => {
      const context = await getCommitContext(mergeRepo.commits.mergeCommit, mergeRepo.cwd);
      expect(context).not.toBeNull();
      expect(context?.sha).toBe(mergeRepo.commits.mergeCommit);
      expect(context?.message).toContain("Merge pull request #42");
    });

    it("should extract branch name from merge commit message when decorations are empty", async () => {
      // Delete the feature branch so decorations won't include it
      runGit("branch -d feature/ENG-123-add-feature", mergeRepo.cwd);

      const context = await getCommitContext(mergeRepo.commits.mergeCommit, mergeRepo.cwd);
      expect(context?.branchName).toBe("feature/ENG-123-add-feature");
    });

    it("should return null for invalid SHA", async () => {
      expect(await getCommitContext("invalid-sha", mergeRepo.cwd)).toBeNull();
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
    it("should include merge commit when path filtering would exclude it", async () => {
      // The merge node itself adds no file changes, so default simplification
      // would drop it; `--full-history` keeps it for metadata (PR number,
      // branch name) extraction.
      const result = await getCommitContextsBetweenShas(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, {
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

    it("should not duplicate merge commit if it was already included", async () => {
      // Without path filtering, the merge commit is already included
      const result = await getCommitContextsBetweenShas(mergeRepo.commits.base, mergeRepo.commits.mergeCommit, {
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

    it("should return in-path merges and drop out-of-path merges across a multi-merge range", async () => {
      // `--full-history` keeps merges whose contribution arrived via a non-
      // first parent. Their tree equals one parent's, so default simplification
      // would drop them — and with them the issue keys in their branch names.
      const result = await getCommitContextsBetweenShas(multiRepo.commits.base, multiRepo.commits.headMerge, {
        includePaths: ["frontend/**", "backend/**"],
        cwd: multiRepo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(multiRepo.commits.merge100)).toBe(true);
      expect(shas.has(multiRepo.commits.merge200)).toBe(true);
      // merge300 only touched infra/, so under the frontend/backend pathspec it
      // changed nothing relative to its parents and `--full-history` drops it
      // natively — LIN-300 never reaches a frontend release.
      expect(shas.has(multiRepo.commits.merge300)).toBe(false);
      expect(shas.has(multiRepo.commits.headMerge)).toBe(true);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toEqual(
        expect.arrayContaining(["feature/LIN-100-add-foo", "feature/LIN-200-fix-bar", "rel/2026-05-06"]),
      );
      expect(branchNames).not.toContain("feature/LIN-300-infra");
    });

    it("should return HEAD merge commit when fromSha === toSha and HEAD is a merge", async () => {
      const result = await getCommitContextsBetweenShas(multiRepo.commits.headMerge, multiRepo.commits.headMerge, {
        includePaths: ["frontend/**", "backend/**"],
        cwd: multiRepo.cwd,
      });

      const headResult = result.find((c) => c.sha === multiRepo.commits.headMerge);
      expect(headResult).toBeDefined();
      expect(headResult?.branchName).toBe("rel/2026-05-06");
    });

    it("should not drift to an unrelated ancestor when fromSha === toSha and HEAD is outside includePaths", async () => {
      // `git log -1 <sha> -- <paths>` walks back from <sha> until something
      // matches the pathspec — `--no-walk` makes it return only <sha>, or
      // nothing if <sha> doesn't match.
      const result = await getCommitContextsBetweenShas(multiRepo.commits.merge300, multiRepo.commits.merge300, {
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

    it("should surface feature merges from inside the rel branch when scanning the resolved first-sync boundary", async () => {
      // Mirrors the customer's first-sync flow: resolveFirstSyncBoundary picks
      // HEAD^1 because HEAD is a merge, then getCommitContextsBetweenShas runs
      // over that range.
      const boundary = resolveFirstSyncBoundary(relRepo.commits.headMerge, relRepo.cwd);
      expect(boundary).not.toBe(relRepo.commits.headMerge);

      const result = await getCommitContextsBetweenShas(boundary, relRepo.commits.headMerge, {
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

    it("drops a stale-branch merge that delivered no change to the filtered paths", async () => {
      // feat/ABC-1-stale edited app-a/ only but merged after app-b/ landed, so
      // `--full-history` keeps its merge under the app-b pathspec. The merge
      // delivered nothing to app-b/, so its subject key must not be attributed.
      const result = await getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-b/**"],
        cwd: repo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(repo.commits.staleMerge)).toBe(false);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).not.toContain("feat/ABC-1-stale");
    });

    it("retains a merge whose key lives only on the subject when it delivered the filtered paths", async () => {
      // feat/XYZ-2-impl genuinely edited app-b/ and carries its key only on the
      // merge subject, so dropping the merge would lose the key entirely.
      const result = await getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-b/**"],
        cwd: repo.cwd,
      });

      const shas = new Set(result.map((c) => c.sha));
      expect(shas.has(repo.commits.subjectMerge)).toBe(true);

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toContain("feat/XYZ-2-impl");
    });

    it("applies merge retention under an exclusion-only filter", async () => {
      // With `!app-a/**` the stale merge delivered only excluded paths, so it
      // must be dropped, while the merge that delivered app-b/ is retained.
      const result = await getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["!app-a/**"],
        cwd: repo.cwd,
      });

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).not.toContain("feat/ABC-1-stale");
      expect(branchNames).toContain("feat/XYZ-2-impl");
    });

    it("still attributes a stale merge to the surface it actually touched", async () => {
      // The same stale merge DID deliver app-a/ changes, so under an app-a filter
      // its subject key is correctly retained — the fix discards leaks, not work.
      // And the app-b-only merge must not leak into the app-a surface.
      const result = await getCommitContextsBetweenShas(repo.commits.base, repo.commits.subjectMerge, {
        includePaths: ["app-a/**"],
        cwd: repo.cwd,
      });

      const branchNames = result.map((c) => c.branchName).filter((b): b is string => !!b);
      expect(branchNames).toContain("feat/ABC-1-stale");
      expect(branchNames).not.toContain("feat/XYZ-2-impl");
    });
  });

  describe("getCommitContextsBetweenShas with branch refs decorating interior commits", () => {
    let stale: TempRepoStaleBranchDecoration;
    let ff: TempRepoFastForwardFeature;

    beforeAll(() => {
      stale = createTempRepoStaleBranchDecoration();
      ff = createTempRepoFastForwardFeature();
    });

    afterAll(() => {
      rmSync(stale.cwd, { recursive: true, force: true });
      rmSync(ff.cwd, { recursive: true, force: true });
    });

    it("ignores a stale ref decorating an interior merge commit", async () => {
      const result = await getCommitContextsBetweenShas(stale.commits.base, stale.commits.tip, { cwd: stale.cwd });

      const interior = result.find((c) => c.sha === stale.commits.downMerge);
      expect(interior).toBeDefined();
      expect(interior?.branchName).toBeNull();
    });

    it("keeps a fast-forwarded feature branch decorating an interior regular commit", async () => {
      // The key lives only in the branch name (GitLab fast-forward / direct push),
      // so dropping interior decorations here would silently lose the issue.
      const result = await getCommitContextsBetweenShas(ff.commits.base, ff.commits.tip, { cwd: ff.cwd });

      const interior = result.find((c) => c.sha === ff.commits.feature);
      expect(interior?.branchName).toBe("user/REL-9-feature");
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

describe("countCommitsInRange", () => {
  it("counts commits exclusive of the from SHA", () => {
    const repo = initTempRepo({
      prefix: "linear-release-count-",
      dirs: ["src"],
      seedFile: { path: "src/file.txt", content: "one" },
    });
    try {
      writeFileSync(join(repo.cwd, "src", "file.txt"), "two");
      runGit('commit -am "second"', repo.cwd);
      writeFileSync(join(repo.cwd, "src", "file.txt"), "three");
      runGit('commit -am "third"', repo.cwd);
      const head = runGit("rev-parse HEAD", repo.cwd);

      expect(countCommitsInRange(repo.base, head, repo.cwd)).toBe(2);
      expect(countCommitsInRange(head, head, repo.cwd)).toBe(0);
    } finally {
      rmSync(repo.cwd, { recursive: true, force: true });
    }
  });

  it("returns null when the range cannot be resolved", () => {
    const repo = initTempRepo({
      prefix: "linear-release-count-invalid-",
      dirs: ["src"],
      seedFile: { path: "src/file.txt", content: "one" },
    });
    try {
      expect(countCommitsInRange("0".repeat(40), repo.base, repo.cwd)).toBeNull();
    } finally {
      rmSync(repo.cwd, { recursive: true, force: true });
    }
  });
});
