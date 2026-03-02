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

    it("adds identifier when last action is re-add", () => {
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("adds identifier when only add commits are present", () => {
      const result = scanCommits(commits.slice(0, 2), null);
      expect(ids(result.issueReferences)).toEqual(["BAC-39"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("reverts identifier when add is followed by revert", () => {
      const result = scanCommits(commits.slice(0, 4), null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["BAC-39"]);
    });
  });

  describe("squash revert with magic word in message", () => {
    it("reverts identifier extracted from unwrapped message via magic word", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "Fixes DRIVE-320: memory leak in background location service" },
        { sha: "r1", message: 'Revert "Fixes DRIVE-320: memory leak in background location service"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["DRIVE-320"]);
    });

    it("ignores version-like tokens (v1-2) without magic word", () => {
      const commits: CommitContext[] = [
        { sha: "a1", message: "Bump v1-2 to v1-3" },
        { sha: "r1", message: 'Revert "Bump v1-2 to v1-3"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });
  });

  describe("last-write-wins edge cases", () => {
    it("separates different issues into added and reverted lists", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100", message: "Fixes ENG-100" },
        { sha: "r1", branchName: "revert-1-user/eng-200", message: 'Revert "ENG-200: something"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-200"]);
    });

    it("reverts when same issue is added then reverted", () => {
      const commits: CommitContext[] = [
        { sha: "a1", branchName: "user/eng-100" },
        { sha: "r1", branchName: "revert-1-user/eng-100", message: 'Revert "ENG-100: fix"' },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual([]);
      expect(ids(result.revertedIssueReferences)).toEqual(["ENG-100"]);
    });

    it("adds when same issue is reverted then re-added", () => {
      const commits: CommitContext[] = [
        { sha: "r1", branchName: "revert-1-user/eng-100", message: 'Revert "ENG-100: fix"' },
        { sha: "a1", branchName: "user/eng-100" },
      ];
      const result = scanCommits(commits, null);
      expect(ids(result.issueReferences)).toEqual(["ENG-100"]);
      expect(ids(result.revertedIssueReferences)).toEqual([]);
    });

    it("reverts despite magic word in message when branch signals revert", () => {
      // The branch name (revert-1-...) signals this is a revert, even though
      // the message body contains "Fixes ENG-100" which would normally add it.
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

    it("reverts via message-only revert even when previously added from branch", () => {
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
