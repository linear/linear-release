import { describe, expect, it } from "vitest";
import { extractLinearIssueIdentifiersForCommit, extractPullRequestNumbersForCommit } from "./extractors";
import { CommitContext } from "./types";

describe("extractLinearIssueIdentifiersForCommit", () => {
  it("extracts identifiers from branch name", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/ENG-123-awesome-change",
      message: "Some message",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result).toEqual(["ENG-123"]);
  });

  it("extracts identifiers from commit message with magic words", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/no-key-here",
      message: "Fixes PLAT-42 and ENG-7 in one go",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result.sort()).toEqual(["ENG-7", "PLAT-42"].sort());
  });

  it("deduplicates identifiers across branch and message (case-insensitive)", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/eng-123-awesome-change",
      message: "Fixed ENG-123, see ENG-123",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result).toEqual(["ENG-123"]);
  });

  it("returns empty array when no identifiers are present", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "chore/update-deps",
      message: "update dependencies",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result).toEqual([]);
  });

  it("matches team keys with 1-7 alphanumeric characters", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/A-1-single-char",
      message: "Fixes ABCDEFG-999 and X1Y2Z3A-100",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result.sort()).toEqual(["A-1", "ABCDEFG-999", "X1Y2Z3A-100"].sort());
  });

  it("does not extract identifiers from commit message without magic words", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/no-key-here",
      message: "See LIN-123 for details",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result).toEqual([]);
  });

  it("does not match team keys longer than 7 characters", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/ABCDEFGH-123-too-long",
      message: "Some message",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(result).toEqual([]);
  });
});

describe("version suffix handling ", () => {
  // Version strings should NOT match
  it.each([
    ["release/ios-1.57.1", []],
    ["release/ios-1.57.0", []],
    ["ruby/setup-ruby-1.269.0", []],
    ["dependabot/swift/dd-sdk-ios-2.9.0", []],
    ["bump-terraform-1.13", []],
    ["release/ver-1.57.01", []],
  ])("branch %s should yield %j", (branch, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: branch,
      message: null,
    });
    expect(result).toEqual(expected);
  });

  // Legitimate identifiers should match
  it.each([
    ["john/ios-1641-introduce-a-proper-blockview", ["IOS-1641"]],
    ["jane/lin-47025-fix-branch-name-matching", ["LIN-47025"]],
    ["john/fix-lin-56696", ["LIN-56696"]],
    ["jane/asks/all/LIN-56081", ["LIN-56081"]],
    ["john/ios-1633-use-shimmer-animation", ["IOS-1633"]],
    ["jane/INF-530", ["INF-530"]],
  ])("branch %s should yield %j", (branch, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: branch,
      message: null,
    });
    expect(result).toEqual(expected);
  });
});

describe("leading zero rejection ", () => {
  it("rejects LIN-0004 style identifiers", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "feature/LIN-0004-test",
      message: null,
    });
    expect(result).toEqual([]);
  });
});

describe("underscore handling ", () => {
  // Underscores act as word boundaries
  it.each([
    ["story/LIN-123_LIN-321_hello_world", ["LIN-123", "LIN-321"]],
    ["username/lin-123_branch_name", ["LIN-123"]],
  ])("branch %s should yield %j", (branch, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: branch,
      message: null,
    });
    expect(result).toEqual(expected);
  });
});

describe("multiple identifiers ", () => {
  it.each([
    ["Fixes LIN-123 and LIN-321", ["LIN-123", "LIN-321"]],
    ["Closes LIN-123, LIN-321", ["LIN-123", "LIN-321"]],
  ])("message %s should yield %j", (message, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message,
    });
    expect(result.sort()).toEqual(expected.sort());
  });
});

describe("commit message magic word behavior", () => {
  it("extracts with closing keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("extracts with contributing phrase", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Related to LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("does not extract without magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See LIN-123 for details",
    });
    expect(result).toEqual([]);
  });

  it("extracts multiple keys after keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes LIN-123, LIN-456 and ENG-789",
    });
    expect(result.sort()).toEqual(["ENG-789", "LIN-123", "LIN-456"]);
  });

  it("extracts magic word in title line", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fix LIN-123: something",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("does not extract key in title without keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "LIN-123: Fix something",
    });
    expect(result).toEqual([]);
  });

  it.each([
    "close",
    "closes",
    "closed",
    "closing",
    "fix",
    "fixes",
    "fixed",
    "fixing",
    "resolve",
    "resolves",
    "resolved",
    "resolving",
    "complete",
    "completes",
    "completed",
    "completing",
  ])("closing keyword '%s' extracts issue", (keyword) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: `${keyword} LIN-100`,
    });
    expect(result).toEqual(["LIN-100"]);
  });

  it.each(["ref", "refs", "references", "part of", "related to", "relates to", "contributes to", "towards", "toward"])(
    "contributing phrase '%s' extracts issue",
    (phrase) => {
      const result = extractLinearIssueIdentifiersForCommit({
        sha: "abc",
        branchName: null,
        message: `${phrase} LIN-200`,
      });
      expect(result).toEqual(["LIN-200"]);
    },
  );

  it("supports keyword with colon separator", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Closes: LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("only extracts keys preceded by magic word on same line", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See LIN-111, fixes LIN-222",
    });
    expect(result).toEqual(["LIN-222"]);
  });

  it("does not extract from the original bug scenario", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Title\nSeparate issue to follow up on that here LIN-60064",
    });
    expect(result).toEqual([]);
  });

  it("branch provides keys independently of message magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "feature/LIN-100-something",
      message: "See LIN-200 for details",
    });
    expect(result).toEqual(["LIN-100"]);
  });

  it("is case insensitive for magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "fIXES LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("extracts with multi-word phrase 'Part of'", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Part of LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("extracts with multi-word phrase 'Related to'", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Related to LIN-456",
    });
    expect(result).toEqual(["LIN-456"]);
  });

  it("extracts issue from Linear URL with slug after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123/fix-auth",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("extracts issue from Linear URL without slug after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("does not extract Linear URL without magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See https://linear.app/myorg/issue/LIN-123/fix",
    });
    expect(result).toEqual([]);
  });

  it("extracts mixed Linear URLs and raw IDs after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123/slug, ENG-456 and LIN-789",
    });
    expect(result.sort()).toEqual(["ENG-456", "LIN-123", "LIN-789"]);
  });

  it("extracts issue from http Linear URL after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes http://linear.app/myorg/issue/LIN-123",
    });
    expect(result).toEqual(["LIN-123"]);
  });

  it("extracts issue from Linear URL with trailing slash", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/my-org/issue/LIN-213/",
    });
    expect(result).toEqual(["LIN-213"]);
  });

  it("extracts issue from Linear URL with contributing phrase", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Part of https://linear.app/myorg/issue/LIN-213/some-slug",
    });
    expect(result).toEqual(["LIN-213"]);
  });
});

describe("revert branch handling", () => {
  it("blocks extraction from merge commit with revert branch name", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/bac-39",
      message: "Merge pull request #572 from org/revert-571-romain/bac-39",
    });
    expect(result).toEqual([]);
  });

  it("blocks extraction when revert branch has multiple identifiers", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/drive-320-and-drive-321",
      message: null,
    });
    expect(result).toEqual([]);
  });

  it("blocks PR number extraction from revert branch", () => {
    const result = extractPullRequestNumbersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/bac-39",
      message: "Merge pull request #572 from org/revert-571-romain/bac-39",
    });
    expect(result).toEqual([]);
  });
});

describe("extractPullRequestNumbersForCommit", () => {
  // Messages that should extract PR numbers
  it.each([
    ["For issue #111, fix (#123)", [123], "squash merge skips fallback"],
    ["Fix #124 with better handling", [124], "hash in middle of title"],
    ["Merge pull request #431 from org/branch", [431], "GitHub merge format"],
    ["Merge pull request #42 from owner/branch\n\nDescription", [42], "merge with multiline description"],
    ["Fix bug\n\nRelated to (#999)", [999], "PR in commit body"],
  ])("message %j should yield %j (%s)", (message, expected) => {
    const result = extractPullRequestNumbersForCommit({ sha: "abc", message });
    expect(result).toEqual(expected);
  });

  // Messages that should NOT extract PR numbers
  it.each([
    ["Some fix", "no PR reference"],
    [null, "null message"],
    [undefined, "undefined message"],
    ['Revert "Fix bug (#123)"', "revert commit"],
    ['Revert "Merge pull request #456 from owner/branch"', "revert of merge"],
  ])("message %j should yield [] (%s)", (message, _description) => {
    const result = extractPullRequestNumbersForCommit({ sha: "abc", message });
    expect(result).toEqual([]);
  });
});
