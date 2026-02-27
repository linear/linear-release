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
      { sha: "ra1", message: 'Revert "Revert "Add TEST variable to .env.example""' },
      {
        sha: "ra2",
        branchName: "revert-572-revert-571-romain/bac-39",
        message: "Merge pull request #573 from org/revert-572-revert-571-romain/bac-39 Custom name",
      },
    ];

    it("full chain: last action is re-add, so identifier is in added list", () => {
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("add only: identifier is in added list", () => {
      const result = scanCommits(commits.slice(0, 2), null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("add + revert: identifier is in reverted list", () => {
      const result = scanCommits(commits.slice(0, 4), null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["BAC-39"]);
    });
  });

  describe("squash revert with magic word in message", () => {
    it("identifier extracted from unwrapped message via magic word, ends up reverted", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "Fixes DRIVE-320: memory leak in background location service" },
        { sha: "r1", message: 'Revert "Fixes DRIVE-320: memory leak in background location service"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["DRIVE-320"]);
    });

    it("identifier without magic word is ignored (no false positives)", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "Bump v1-2 to v1-3" },
        { sha: "r1", message: 'Revert "Bump v1-2 to v1-3"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });
  });

  describe("inline revert/reapply cycle without identifiers", () => {
    const commits: CommitContext[] = [
      { sha: "a1", message: "More revert test" },
      { sha: "r1", message: 'Revert "More revert test"' },
      { sha: "ra1", message: 'Reapply "More revert test"' },
      {
        sha: "m1",
        branchName: "romain/test-revert",
        message: 'Merge pull request #575 from org/romain/test-revert Reapply "More revert test"',
      },
    ];

    it("no identifiers found in either list", () => {
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });
  });

  describe("last-write-wins edge cases", () => {
    it("different issues go to their respective lists", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100", message: "Fixes ENG-100" },
        { sha: "r1", branchName: "revert-1-user/eng-200", message: 'Revert "ENG-200: something"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-200"]);
    });

    it("add then revert same issue: only in reverted", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100" },
        { sha: "r1", branchName: "revert-1-user/eng-100", message: 'Revert "ENG-100: fix"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("revert then add same issue: only in added", () => {
      const commits: CommitContext[] = [
        { sha: "r1", branchName: "revert-1-user/eng-100", message: 'Revert "ENG-100: fix"' },
        { sha: "a1", branchName: "user/eng-100" },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("revert merge commit with magic word in message does not add identifier", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100" },
        {
          sha: "r1",
          branchName: "revert-1-user/eng-100",
          message: "Merge pull request #2\n\nFixes ENG-100",
        },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("message-only revert with magic word is reverted, not added", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100", message: "Fixes ENG-100" },
        { sha: "r1", message: 'Revert "Fixes ENG-100"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });
  });
});
