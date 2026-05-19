import { describe, expect, it } from "vitest";
import { scanCommits } from "./scan";
import { CommitContext } from "./types";

function ids(refs: { identifier: string }[]): string[] {
  return refs.map((r) => r.identifier).sort();
}

describe("scanCommits", () => {
  describe("add → revert → re-add chain", () => {
    // Oldest first, as scanCommits expects
    const commits: CommitContext[] = [
      { sha: "a1", message: "Add TEST variable to .env.example" },
      {
        sha: "a2",
        branchName: "romain/bac-39",
        message: "Merge pull request #571 from org/romain/bac-39 Add TEST variable",
      },
      { sha: "r1", message: 'Revert "Add TEST variable to .env.example"' },
      {
        sha: "r2",
        branchName: "revert-571-romain/bac-39",
        message: 'Merge pull request #572 from org/revert-571-romain/bac-39 Revert "Add TEST variable"',
      },
      {
        sha: "ra1",
        message: 'Revert "Revert "Add TEST variable to .env.example""',
      },
      {
        sha: "ra2",
        branchName: "revert-572-revert-571-romain/bac-39",
        message: "Merge pull request #573 from org/revert-572-revert-571-romain/bac-39 Custom name",
      },
    ];

    it("adds identifier when last action is re-add", () => {
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("adds identifier when only add commits are present", () => {
      const result = scanCommits(commits.slice(0, 2), null, null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("reverts identifier when add is followed by revert", () => {
      const result = scanCommits(commits.slice(0, 4), null, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["BAC-39"]);
    });
  });

  describe("squash revert with magic word in message", () => {
    it("reverts identifier extracted from unwrapped message via magic word", () => {
      const commits: CommitContext[] = [
        {
          sha: "a1",
          message: "Fixes DRIVE-320: memory leak in background location service",
        },
        {
          sha: "r1",
          message: 'Revert "Fixes DRIVE-320: memory leak in background location service"',
        },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["DRIVE-320"]);
    });

    it("ignores version-like tokens (v1-2) without magic word", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "Bump v1-2 to v1-3" },
        { sha: "r1", message: 'Revert "Bump v1-2 to v1-3"' },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });
  });

  describe("last-write-wins edge cases", () => {
    it("separates different issues into added and reverted lists", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100", message: "Fixes ENG-100" },
        {
          sha: "r1",
          branchName: "revert-1-user/eng-200",
          message: 'Revert "ENG-200: something"',
        },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-200"]);
    });

    it("reverts when same issue is added then reverted", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100" },
        {
          sha: "r1",
          branchName: "revert-1-user/eng-100",
          message: 'Revert "ENG-100: fix"',
        },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("adds when same issue is reverted then re-added", () => {
      const commits: CommitContext[] = [
        {
          sha: "r1",
          branchName: "revert-1-user/eng-100",
          message: 'Revert "ENG-100: fix"',
        },
        { sha: "a1", branchName: "user/eng-100" },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("body magic word adds the new issue when branch signals revert", () => {
      // GitHub's auto-revert form: branch is `revert-<N>-<original>` and the
      // revert author's body note `Fixes ENG-200` claims a new issue is closed
      // by reverting. The branch inner names the reverted work (ENG-100); the
      // body names the added work (ENG-200).
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100" },
        {
          sha: "r1",
          branchName: "revert-1-user/eng-100",
          message: "Merge pull request #2\n\nFixes ENG-200",
        },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-200"]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("reverts via message-only revert even when previously added from branch", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100", message: "Fixes ENG-100" },
        { sha: "r1", message: 'Revert "Fixes ENG-100"' },
      ];
      const result = scanCommits(commits, null, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });
  });

  describe("--include-subjects filter", () => {
    it("includes only commits whose subject matches the regex", () => {
      const commits: CommitContext[] = [
        { sha: "c1", message: "feat: add login. Fixes ENG-100" },
        { sha: "c2", message: "chore: bump deps. Fixes ENG-200" },
        { sha: "c3", message: "fix: handle null. Fixes ENG-300" },
      ];
      const result = scanCommits(commits, null, "^(feat|fix):");
      expect(ids(result.issueReferences)).toEqual(["ENG-100", "ENG-300"]);
      expect(result.debugSink.inspectedShas).toEqual(["c1", "c3"]);
    });

    it("matches against the subject (first line) only, ignoring body", () => {
      const commits: CommitContext[] = [{ sha: "c1", message: "chore: tidy\n\nfeat: ENG-100 add login (in body)" }];
      const result = scanCommits(commits, null, "^feat:");
      expect(ids(result.issueReferences)).toEqual([]);
      expect(result.debugSink.inspectedShas).toEqual([]);
    });

    it("supports unanchored substring patterns", () => {
      const commits: CommitContext[] = [
        { sha: "c1", message: "Squash: feat. Fixes ENG-100" },
        { sha: "c2", message: "chore: bump" },
      ];
      const result = scanCommits(commits, null, "feat");
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
    });

    it("skips commits with no message when a regex is set", () => {
      const commits: CommitContext[] = [
        { sha: "c1", branchName: "user/eng-100", message: null },
        { sha: "c2", branchName: "user/eng-200", message: "feat: add login" },
      ];
      const result = scanCommits(commits, null, "^feat:");
      expect(ids(result.issueReferences)).toEqual(["ENG-200"]);
      expect(result.debugSink.inspectedShas).toEqual(["c2"]);
    });

    it("records the pattern on the debug sink", () => {
      const result = scanCommits([{ sha: "c1", message: "feat: x" }], null, "^feat:");
      expect(result.debugSink.includeSubjects).toBe("^feat:");
    });

    it("leaves includeSubjects null when filter is disabled", () => {
      const result = scanCommits([{ sha: "c1", message: "anything" }], null, null);
      expect(result.debugSink.includeSubjects).toBeNull();
    });

    it("matches the inner subject of a revert so revert detection is not bypassed", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "fix: login bug. Fixes ENG-100" },
        { sha: "r1", message: 'Revert "fix: login bug. Fixes ENG-100"' },
      ];
      const result = scanCommits(commits, null, "^(feat|fix):");
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("matches the inner subject through nested revert wrappers", () => {
      const commits: CommitContext[] = [
        {
          sha: "ra1",
          message: 'Revert "Revert "fix: login bug. Fixes ENG-100""',
        },
      ];
      const result = scanCommits(commits, null, "^(feat|fix):");
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
    });

    it("still skips commits whose inner subject does not match", () => {
      const commits: CommitContext[] = [{ sha: "r1", message: 'Revert "chore: bump deps. Fixes ENG-200"' }];
      const result = scanCommits(commits, null, "^(feat|fix):");
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });
  });
});
