import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBaseSha, type FindBaseShaDeps } from "./base-sha";
import { commitExists, ensureCommitAvailable, getCommitContextsBetweenShas, isAncestor } from "./git";
import type { Release } from "./types";

function runGit(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  runGit("add .", cwd);
  runGit(`commit -qm "${message}"`, cwd);
  return runGit("rev-parse HEAD", cwd);
}

function release(name: string, commitSha: string | undefined, daysAgoCreated: number): Release {
  return {
    id: `id-${name}`,
    name,
    commitSha,
    createdAt: new Date(Date.now() - daysAgoCreated * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Topology shared by most scenarios:
 *
 *   main:  root ─ m1 ─ m2 ─ m3 ─ mainHead         (HEAD when CI is on main)
 *                 │
 *                 └─ h1 ─ h2                       (hotfix side branch)
 *                                  └─ hotfixHead   (HEAD when CI is on hotfix)
 *
 * - mainPrev  = the "1.71.0" sha on main (m3 here, one before mainHead).
 * - hotfixSha = h2, the "1.70.1" release sha on the hotfix branch.
 * - mainHead  = main's tip, used as HEAD for "CI on main" scenarios.
 * - hotfixHead = an extra commit on top of h2, used as HEAD for "CI on hotfix" scenarios.
 *
 * Side branches are kept alive (named refs) so the SHAs stay reachable in this
 * test repo regardless of GC; the walk doesn't care about branch names, only
 * ancestry from the HEAD it's given.
 */
function buildRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "base-sha-"));
  runGit("init -q -b main", cwd);
  runGit('config user.email "t@t"', cwd);
  runGit('config user.name "t"', cwd);

  commit(cwd, "f", "0", "root");
  const m1 = commit(cwd, "f", "1", "m1");

  // Branch off m1 for the hotfix
  runGit(`checkout -q -b hotfix ${m1}`, cwd);
  commit(cwd, "f", "h1", "h1");
  const hotfixSha = commit(cwd, "f", "h2", "h2 (1.70.1 release)");
  const hotfixHead = commit(cwd, "f", "h3", "h3 (hotfix HEAD)");

  // Back to main
  runGit("checkout -q main", cwd);
  commit(cwd, "f", "2", "m2");
  const mainPrev = commit(cwd, "f", "3", "m3 (1.71.0 release)");
  const mainHead = commit(cwd, "f", "4", "m4 (1.72.0 HEAD)");

  return { cwd, hotfixSha, hotfixHead, mainPrev, mainHead };
}

describe("findBaseSha", () => {
  let repo: ReturnType<typeof buildRepo>;
  let deps: FindBaseShaDeps;

  beforeAll(() => {
    repo = buildRepo();
    deps = {
      isAncestor: (sha, head) => isAncestor(sha, head, repo.cwd),
      commitExists: (sha) => commitExists(sha, repo.cwd),
      ensureCommitAvailable: (sha) => ensureCommitAvailable(sha, repo.cwd),
    };
  });

  afterAll(() => {
    if (repo) rmSync(repo.cwd, { recursive: true, force: true });
  });

  it("scenario A — healthy single train: picks the only candidate", () => {
    const candidates = [release("1.71.0", repo.mainPrev, 5)];
    expect(findBaseSha(candidates, repo.mainHead, deps)).toEqual({ kind: "found", sha: repo.mainPrev });
  });

  it("scenario B — concurrent trains, hotfix listed first: skips hotfix, picks main", () => {
    // The hotfix candidate sorts ahead of the main-train candidate, but its
    // commitSha sits on a side branch — not reachable from HEAD. Using it as
    // the base would scan a range covering everything the main train already
    // shipped between the fork point and HEAD. Walk past it to the main
    // release whose SHA is reachable.
    const candidates = [release("1.70.1", repo.hotfixSha, 3), release("1.71.0", repo.mainPrev, 10)];
    expect(findBaseSha(candidates, repo.mainHead, deps)).toEqual({ kind: "found", sha: repo.mainPrev });
  });

  it("scenario C — CI on the hotfix branch, main listed first: skips main, picks hotfix", () => {
    // Mirror of scenario B: HEAD is on the hotfix branch and the main-train
    // candidate sorts first. The main SHA isn't reachable from the hotfix
    // HEAD, so the walk continues to the hotfix's own previous release.
    const candidates = [release("1.71.0", repo.mainPrev, 3), release("1.70.1", repo.hotfixSha, 10)];
    expect(findBaseSha(candidates, repo.hotfixHead, deps)).toEqual({ kind: "found", sha: repo.hotfixSha });
  });

  it("scenario D — newly created release with null commitSha: skipped, walks to previous release", () => {
    // A release just created via the API has no commitSha until the first CI
    // sync writes one. Treating null as "no prior release" would under-cover
    // everything that landed since the actual previous release; the walk
    // skips the null entry and lands on the previous real release.
    const candidates = [release("1.72.0", undefined, 1), release("1.71.0", repo.mainPrev, 10)];
    expect(findBaseSha(candidates, repo.mainHead, deps)).toEqual({ kind: "found", sha: repo.mainPrev });
  });

  it("scenario E — all candidates non-ancestors: returns fallback", () => {
    // Every candidate's commitSha lives on a history disjoint from HEAD —
    // shape produced by force-pushes that orphan old release SHAs, manual
    // edits, or stale rows the API hasn't pruned. The walk exhausts the list
    // and returns fallback so the caller can decide how to scan.
    const candidates = [release("1.70.1", repo.hotfixSha, 3), release("hotfix-tip", repo.hotfixHead, 1)];
    expect(findBaseSha(candidates, repo.mainHead, deps)).toEqual({ kind: "fallback" });
  });

  it("scenario F — empty list (first-ever sync): returns fallback", () => {
    expect(findBaseSha([], repo.mainHead, deps)).toEqual({ kind: "fallback" });
  });
});

/**
 * Pairs scenario B's base selection with the actual `git log` range
 * computation: instead of asserting only on the picked SHA, feed it into
 * `getCommitContextsBetweenShas` and check the resulting commit list. Makes
 * concrete why ancestor checking matters — a naive "use the first candidate"
 * pick produces a range that includes commits the main train already shipped,
 * while the walk's pick collapses the range to just the new bump.
 */
describe("end-to-end: concurrent trains", () => {
  let repo: ReturnType<typeof buildRepo>;
  let deps: FindBaseShaDeps;
  let candidates: Release[];

  beforeAll(() => {
    repo = buildRepo();
    deps = {
      isAncestor: (sha, head) => isAncestor(sha, head, repo.cwd),
      commitExists: (sha) => commitExists(sha, repo.cwd),
      ensureCommitAvailable: (sha) => ensureCommitAvailable(sha, repo.cwd),
    };
    // Hotfix sorts ahead of the main-train release in the candidate list.
    candidates = [release("1.70.1", repo.hotfixSha, 3), release("1.71.0", repo.mainPrev, 10)];
  });

  afterAll(() => {
    if (repo) rmSync(repo.cwd, { recursive: true, force: true });
  });

  it("naive 'use first candidate' base scans commits already shipped via the main train", () => {
    const naiveBase = candidates[0]!.commitSha!;
    const range = getCommitContextsBetweenShas(naiveBase, repo.mainHead, { cwd: repo.cwd });
    const messages = range.map((c) => c.message?.split("\n")[0]).filter(Boolean);

    // m2 and m3 belong to 1.71.0; only m4 is the 1.72.0 bump. Using the
    // hotfix SHA as base scans all three — exactly the re-attachment shape
    // we want to avoid.
    expect(messages).toEqual(["m4 (1.72.0 HEAD)", "m3 (1.71.0 release)", "m2"]);
  });

  it("findBaseSha picks the main release; range collapses to just the new bump", () => {
    const result = findBaseSha(candidates, repo.mainHead, deps);
    expect(result).toEqual({ kind: "found", sha: repo.mainPrev });
    if (result.kind !== "found") return;

    const range = getCommitContextsBetweenShas(result.sha, repo.mainHead, { cwd: repo.cwd });
    const messages = range.map((c) => c.message?.split("\n")[0]).filter(Boolean);

    expect(messages).toEqual(["m4 (1.72.0 HEAD)"]);
  });
});
