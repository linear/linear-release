import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCommitContextsBetweenShas, resolveCommitRef, verifyAncestorReachable } from "./git";
import {
  assertBaseRefIsAncestor,
  assertBaseRefAllowed,
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

function release(name: string, commitSha: string): Release {
  return {
    id: `release-${name}`,
    name,
    commitSha,
    createdAt: new Date().toISOString(),
  };
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

  it("rejects --base-ref when a reachable release baseline already exists", () => {
    expect(() => assertBaseRefAllowed([release("1.0.0", repo.commits.api1)], repo.commits.head, deps)).toThrow(
      "already has a reachable release baseline",
    );
  });

  it("allows --base-ref when previous release baselines are unreachable", () => {
    expect(assertBaseRefAllowed([release("legacy", repo.commits.stale)], repo.commits.head, deps)).toBe("unreachable");
  });

  it("allows --base-ref when no previous release baseline exists", () => {
    expect(assertBaseRefAllowed([], repo.commits.head, deps)).toBe("none");
  });

  it("resolves git refs to commit SHAs", () => {
    expect(resolveCommitRef("api-start", repo.cwd)).toBe(repo.commits.api1);
    expect(resolveCommitRef("main~1", repo.cwd)).toBe(repo.commits.web);
  });

  it("uses --base-ref as an exclusive scan base with include paths", () => {
    const commits = getCommitContextsBetweenShas(repo.commits.api1, repo.commits.head, {
      includePaths: ["apps/api/**"],
      cwd: repo.cwd,
    });

    expect(commits.map((c) => c.sha)).toEqual([repo.commits.api2]);
  });

  it("allows the root commit as an exclusive scan base", () => {
    const commits = getCommitContextsBetweenShas(repo.commits.root, repo.commits.head, {
      cwd: repo.cwd,
    });

    expect(commits.map((c) => c.sha)).toEqual([repo.commits.api2, repo.commits.web, repo.commits.api1]);
  });

  it("treats --base-ref equal to HEAD as an empty range", () => {
    const commits = getCommitContextsBetweenShas(repo.commits.head, repo.commits.head, {
      includePaths: ["apps/api/**"],
      inspectSingleCommit: false,
      cwd: repo.cwd,
    });

    expect(commits).toEqual([]);
  });

  it("still creates a release for an accepted --base-ref scan with zero matching commits", () => {
    const commits = getCommitContextsBetweenShas(repo.commits.api1, repo.commits.head, {
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

  it("fails clearly for refs that do not resolve to a commit", () => {
    expect(() => resolveCommitRef("missing-ref", repo.cwd)).toThrow('Could not resolve "missing-ref"');
  });

  it("fails clearly when --base-ref resolves outside the current branch history", () => {
    expect(() => assertBaseRefIsAncestor("stale", repo.commits.stale, repo.commits.head, deps)).toThrow(
      "is not an ancestor of HEAD",
    );
  });
});
