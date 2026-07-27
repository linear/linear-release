import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getCommitContextsBetweenShas, resolveCommitRef, verifyAncestorReachable } from "./git";
import * as log from "./log";
import {
  assertBaseRefIsAncestor,
  BROAD_SCAN_COMMIT_THRESHOLD,
  getBroadScanWarning,
  type ScanBase,
  selectAutomaticScanBase,
  shouldCreateReleaseForScan,
} from "./scan-base";
import type { Release } from "./types";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), content);
  runGit(["add", "."], cwd);
  runGit(["commit", "-m", message], cwd);
  return runGit(["rev-parse", "HEAD"], cwd);
}

function createMigrationRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-scan-base-"));
  runGit(["init", "-q", "-b", "main"], cwd);
  runGit(["config", "user.email", "test@example.com"], cwd);
  runGit(["config", "user.name", "Test User"], cwd);

  const root = commit(cwd, "README.md", "root", "root");
  const api1 = commit(cwd, "apps/api/a.txt", "api 1", "LIN-100 api one");
  runGit(["tag", "api-start"], cwd);
  const web = commit(cwd, "apps/web/a.txt", "web", "LIN-200 web");
  const api2 = commit(cwd, "apps/api/b.txt", "api 2", "LIN-300 api two");
  const head = runGit(["rev-parse", "HEAD"], cwd);

  runGit(["checkout", "-q", "-b", "stale", root], cwd);
  const stale = commit(cwd, "legacy/service.txt", "legacy", "legacy release");
  runGit(["checkout", "-q", "main"], cwd);

  return { cwd, commits: { root, api1, web, api2, head, stale } };
}

function createGitFlowHotfixRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-gitflow-hotfix-"));
  runGit(["init", "-q", "-b", "develop"], cwd);
  runGit(["config", "user.email", "test@example.com"], cwd);
  runGit(["config", "user.name", "Test User"], cwd);

  commit(cwd, "app.txt", "base", "base before release/3.34.0");
  runGit(["checkout", "-q", "-b", "release/3.34.0"], cwd);
  const previousRelease = commit(cwd, "release.txt", "3.34.0", "release v3.34.0");
  runGit(["tag", "v3.34.0"], cwd);

  runGit(["checkout", "-q", "develop"], cwd);
  commit(cwd, "foo/1.txt", "FOO-1", "[FOO-1] feature on develop");
  commit(cwd, "foo/2.txt", "FOO-2", "[FOO-2] feature on develop");
  commit(cwd, "foo/3.txt", "FOO-3", "[FOO-3] feature on develop");
  commit(cwd, "foo/4.txt", "FOO-4", "[FOO-4] feature on develop");
  runGit(["merge", "-q", "--no-ff", "release/3.34.0", "-m", "Merge release/3.34.0 back into develop"], cwd);
  const forkPoint = runGit(["rev-parse", "HEAD"], cwd);

  runGit(["checkout", "-q", "-b", "release/3.34.1"], cwd);
  const head = commit(cwd, "hotfix.txt", "fix", "[HOT-1] hotfix commit");
  runGit(["tag", "v3.34.1"], cwd);

  return { cwd, commits: { previousRelease, forkPoint, head } };
}

function createMergeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-scan-base-merge-"));
  runGit(["init", "-q", "-b", "main"], cwd);
  runGit(["config", "user.email", "test@example.com"], cwd);
  runGit(["config", "user.name", "Test User"], cwd);

  const root = commit(cwd, "README.md", "root", "root");
  runGit(["checkout", "-q", "-b", "stale", root], cwd);
  const stale = commit(cwd, "stale.txt", "stale", "stale release");
  runGit(["checkout", "-q", "-b", "feature", root], cwd);
  commit(cwd, "feature.txt", "feature", "feature commit");
  runGit(["checkout", "-q", "main"], cwd);
  const firstParent = commit(cwd, "main.txt", "main", "main commit");
  runGit(["merge", "-q", "--no-ff", "feature", "-m", "merge feature"], cwd);
  const mergeCommit = runGit(["rev-parse", "HEAD"], cwd);

  return { cwd, commits: { stale, firstParent, mergeCommit } };
}

describe("scan base selection", () => {
  let repo: ReturnType<typeof createMigrationRepo>;
  const deps = {
    verifyAncestorReachable: (sha: string, headSha: string) => verifyAncestorReachable(sha, headSha, repo.cwd),
  };

  beforeAll(() => {
    repo = createMigrationRepo();
  });

  afterAll(() => {
    rmSync(repo.cwd, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves git refs to commit SHAs", () => {
    expect(resolveCommitRef("api-start", repo.cwd)).toBe(repo.commits.api1);
    expect(resolveCommitRef("main~1", repo.cwd)).toBe(repo.commits.web);
  });

  it("uses --base-ref as an exclusive scan base with include paths", async () => {
    const commits = await getCommitContextsBetweenShas(repo.commits.api1, repo.commits.head, {
      includePaths: ["apps/api/**"],
      cwd: repo.cwd,
    });

    expect(commits.map((c) => c.sha)).toEqual([repo.commits.api2]);
  });

  it("allows the root commit as an exclusive scan base", async () => {
    const commits = await getCommitContextsBetweenShas(repo.commits.root, repo.commits.head, {
      cwd: repo.cwd,
    });

    expect(commits.map((c) => c.sha)).toEqual([repo.commits.api2, repo.commits.web, repo.commits.api1]);
  });

  it("treats --base-ref equal to HEAD as an empty range", async () => {
    const commits = await getCommitContextsBetweenShas(repo.commits.head, repo.commits.head, {
      includePaths: ["apps/api/**"],
      inspectSingleCommit: false,
      cwd: repo.cwd,
    });

    expect(commits).toEqual([]);
  });

  it("still creates a release for an accepted --base-ref scan with zero matching commits", async () => {
    const commits = await getCommitContextsBetweenShas(repo.commits.api1, repo.commits.head, {
      includePaths: ["does-not-match/**"],
      cwd: repo.cwd,
    });
    const scanBase: ScanBase = { kind: "base-ref", sha: repo.commits.api1, ref: "api-start" };

    expect(commits).toEqual([]);
    expect(shouldCreateReleaseForScan(commits.length, scanBase)).toBe(true);
  });

  it("keeps normal automatic scans from creating releases with zero commits", () => {
    const scanBase = selectAutomaticScanBase([], repo.commits.head, deps, repo.cwd);
    expect(shouldCreateReleaseForScan(0, scanBase)).toBe(false);
  });

  it("scans only a merge commit when release candidates cannot be used", () => {
    const mergeRepo = createMergeRepo();
    const mergeDeps = {
      verifyAncestorReachable: (sha: string, headSha: string) => verifyAncestorReachable(sha, headSha, mergeRepo.cwd),
    };

    try {
      const scanBase = selectAutomaticScanBase(
        [
          {
            id: "stale-release",
            name: "stale release",
            createdAt: new Date().toISOString(),
            commitSha: mergeRepo.commits.stale,
          },
        ],
        mergeRepo.commits.mergeCommit,
        mergeDeps,
        mergeRepo.cwd,
      );

      expect(scanBase).toEqual({
        kind: "first-sync",
        sha: mergeRepo.commits.mergeCommit,
        candidatesConsidered: 1,
      });
      expect(scanBase.sha).not.toBe(mergeRepo.commits.firstParent);
    } finally {
      rmSync(mergeRepo.cwd, { recursive: true, force: true });
    }
  });

  it("uses the first-sync boundary when there are no release candidates", () => {
    const mergeRepo = createMergeRepo();
    const mergeDeps = {
      verifyAncestorReachable: (sha: string, headSha: string) => verifyAncestorReachable(sha, headSha, mergeRepo.cwd),
    };

    try {
      expect(selectAutomaticScanBase([], mergeRepo.commits.mergeCommit, mergeDeps, mergeRepo.cwd)).toEqual({
        kind: "first-sync",
        sha: mergeRepo.commits.firstParent,
        candidatesConsidered: 0,
      });
    } finally {
      rmSync(mergeRepo.cwd, { recursive: true, force: true });
    }
  });

  it("warns when every SHA-bearing candidate is rejected", () => {
    const warn = vi.spyOn(log, "warn");

    selectAutomaticScanBase(
      [
        {
          id: "stale-release",
          name: "stale release",
          createdAt: new Date().toISOString(),
          commitSha: repo.commits.stale,
        },
      ],
      repo.commits.head,
      deps,
      repo.cwd,
    );

    expect(warn).toHaveBeenCalledWith(
      "None of the last 1 synced releases' commit SHAs exist in this repository's history. Syncing only the current commit until a scan base can be established. If this pipeline receives syncs from multiple repositories, use one pipeline per repository; otherwise pass --base-ref to pin the scan range.",
    );
  });

  it("warns when candidates do not carry commit SHAs", () => {
    const warn = vi.spyOn(log, "warn");

    selectAutomaticScanBase(
      [
        {
          id: "manual-release",
          name: "manual release",
          createdAt: new Date().toISOString(),
        },
      ],
      repo.commits.head,
      deps,
      repo.cwd,
    );

    expect(warn).toHaveBeenCalledWith(
      "None of the last 1 releases carry a commit SHA (they were likely created manually). Syncing only the current commit until a scan base can be established. If this pipeline receives syncs from multiple repositories, use one pipeline per repository; otherwise pass --base-ref to pin the scan range.",
    );
  });

  it("warns when GraphQL candidates have null commit SHAs", () => {
    const warn = vi.spyOn(log, "warn");
    const manualRelease = {
      id: "manual-release",
      name: "manual release",
      createdAt: new Date().toISOString(),
      commitSha: null,
    } as unknown as Release;

    selectAutomaticScanBase([manualRelease], repo.commits.head, deps, repo.cwd);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("they were likely created manually"));
  });

  it("does not warn on a genuine first sync", () => {
    const warn = vi.spyOn(log, "warn");

    selectAutomaticScanBase([], repo.commits.head, deps, repo.cwd);

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when it finds a reachable release anchor", () => {
    const warn = vi.spyOn(log, "warn");

    selectAutomaticScanBase(
      [
        {
          id: "reachable-release",
          name: "reachable release",
          createdAt: new Date().toISOString(),
          commitSha: repo.commits.api1,
        },
      ],
      repo.commits.head,
      deps,
      repo.cwd,
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns only when scans exceed the broad-scan threshold", () => {
    const scanBase: ScanBase = { kind: "release", sha: repo.commits.api1 };
    const baseRefScanBase: ScanBase = { kind: "base-ref", sha: repo.commits.api1, ref: "release-start" };

    expect(getBroadScanWarning(BROAD_SCAN_COMMIT_THRESHOLD, scanBase)).toBeUndefined();
    expect(getBroadScanWarning(BROAD_SCAN_COMMIT_THRESHOLD + 1, scanBase)).toContain("Scanning 101 commits");
    expect(getBroadScanWarning(BROAD_SCAN_COMMIT_THRESHOLD + 1, baseRefScanBase)).toContain(
      "linked to the target release. This range was explicitly requested.",
    );
    expect(getBroadScanWarning(BROAD_SCAN_COMMIT_THRESHOLD + 1, baseRefScanBase)).not.toContain("Pass --version");
  });

  it("fails clearly for refs that do not resolve to a commit", () => {
    expect(() => resolveCommitRef("missing-ref", repo.cwd)).toThrow('Could not resolve "missing-ref"');
  });

  it("fetches a tag from origin when it is missing from a shallow clone", () => {
    const remote = mkdtempSync(join(tmpdir(), "linear-release-shallow-remote-"));
    runGit(["init", "-q", "-b", "main"], remote);
    runGit(["config", "user.email", "test@example.com"], remote);
    runGit(["config", "user.name", "Test User"], remote);
    const tagged = commit(remote, "old.txt", "old", "tagged commit");
    runGit(["tag", "v9.9.9"], remote);
    commit(remote, "new1.txt", "new1", "after tag 1");
    commit(remote, "new2.txt", "new2", "after tag 2");

    const shallow = mkdtempSync(join(tmpdir(), "linear-release-shallow-clone-"));
    runGit(["clone", "-q", "--depth", "1", "--single-branch", `file://${remote}`, shallow], tmpdir());

    try {
      expect(() =>
        execFileSync("git", ["rev-parse", "--verify", "v9.9.9^{commit}"], {
          cwd: shallow,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).toThrow();

      expect(resolveCommitRef("v9.9.9", shallow)).toBe(tagged);
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it("fails clearly when --base-ref resolves outside the current branch history", () => {
    expect(() => assertBaseRefIsAncestor("stale", repo.commits.stale, repo.commits.head, deps)).toThrow(
      "is not an ancestor of HEAD",
    );
  });

  it("supports GitFlow hotfix releases by letting --base-ref use the integration fork point", async () => {
    const gitFlowRepo = createGitFlowHotfixRepo();
    const gitFlowDeps = {
      verifyAncestorReachable: (sha: string, headSha: string) => verifyAncestorReachable(sha, headSha, gitFlowRepo.cwd),
    };

    try {
      const automaticBase = selectAutomaticScanBase(
        [
          {
            id: "previous",
            name: "v3.34.0",
            createdAt: new Date().toISOString(),
            commitSha: gitFlowRepo.commits.previousRelease,
          },
        ],
        gitFlowRepo.commits.head,
        gitFlowDeps,
        gitFlowRepo.cwd,
      );

      expect(automaticBase).toEqual({ kind: "release", sha: gitFlowRepo.commits.previousRelease });
      expect(
        (
          await getCommitContextsBetweenShas(automaticBase.sha, gitFlowRepo.commits.head, {
            cwd: gitFlowRepo.cwd,
          })
        ).map((c) => c.message?.split("\n")[0]),
      ).toEqual([
        "[HOT-1] hotfix commit",
        "Merge release/3.34.0 back into develop",
        "[FOO-4] feature on develop",
        "[FOO-3] feature on develop",
        "[FOO-2] feature on develop",
        "[FOO-1] feature on develop",
      ]);

      const baseRef = runGit(["merge-base", "develop", "HEAD"], gitFlowRepo.cwd);
      expect(baseRef).toBe(gitFlowRepo.commits.forkPoint);
      expect(() =>
        assertBaseRefIsAncestor("$(git merge-base develop HEAD)", baseRef, gitFlowRepo.commits.head, gitFlowDeps),
      ).not.toThrow();
      expect(
        (
          await getCommitContextsBetweenShas(baseRef, gitFlowRepo.commits.head, {
            inspectSingleCommit: false,
            cwd: gitFlowRepo.cwd,
          })
        ).map((c) => c.message?.split("\n")[0]),
      ).toEqual(["[HOT-1] hotfix commit"]);
    } finally {
      rmSync(gitFlowRepo.cwd, { recursive: true, force: true });
    }
  });
});
