import { describe, expect, it } from "vitest";
import {
  ExtractedIdentifier,
  extractLinearIssueIdentifiersForCommit,
  extractPullRequestNumbersForCommit,
  extractRevertedIssueIdentifiersForCommit,
  getRevertBranchDepth,
  getRevertMessageDepth,
} from "./extractors";
import { CommitContext } from "./types";

function ids(result: ExtractedIdentifier[]): string[] {
  return result.map((r) => r.identifier);
}

describe("extractLinearIssueIdentifiersForCommit", () => {
  it("extracts identifiers from branch name", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/ENG-123-awesome-change",
      message: "Some message",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result)).toEqual(["ENG-123"]);
  });

  it("extracts identifiers from commit message with magic words", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/no-key-here",
      message: "Fixes PLAT-42 and ENG-7 in one go",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result).sort()).toEqual(["ENG-7", "PLAT-42"].sort());
  });

  it("deduplicates identifiers across branch and message (case-insensitive)", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/eng-123-awesome-change",
      message: "Fixed ENG-123, see ENG-123",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result)).toEqual(["ENG-123"]);
  });

  it("returns empty array when no identifiers are present", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "chore/update-deps",
      message: "update dependencies",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result)).toEqual([]);
  });

  it("matches team keys with 1-7 alphanumeric characters", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/A-1-single-char",
      message: "Fixes ABCDEFG-999 and X1Y2Z3A-100",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result).sort()).toEqual(["A-1", "ABCDEFG-999", "X1Y2Z3A-100"].sort());
  });

  it("does not extract identifiers from commit message without magic words", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/no-key-here",
      message: "See LIN-123 for details",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result)).toEqual([]);
  });

  it("does not match team keys longer than 7 characters", () => {
    const commit: CommitContext = {
      sha: "abc123",
      branchName: "feature/ABCDEFGH-123-too-long",
      message: "Some message",
    };

    const result = extractLinearIssueIdentifiersForCommit(commit);

    expect(ids(result)).toEqual([]);
  });
});

describe("version suffix handling", () => {
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
    expect(ids(result)).toEqual(expected);
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
    expect(ids(result)).toEqual(expected);
  });
});

describe("leading zero rejection", () => {
  it("rejects LIN-0004 style identifiers", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "feature/LIN-0004-test",
      message: null,
    });
    expect(ids(result)).toEqual([]);
  });
});

describe("underscore handling", () => {
  it.each([
    ["story/LIN-123_LIN-321_hello_world", ["LIN-123", "LIN-321"]],
    ["username/lin-123_branch_name", ["LIN-123"]],
  ])("branch %s should yield %j", (branch, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: branch,
      message: null,
    });
    expect(ids(result)).toEqual(expected);
  });
});

describe("multiple identifiers", () => {
  it.each([
    ["Fixes LIN-123 and LIN-321", ["LIN-123", "LIN-321"]],
    ["Closes LIN-123, LIN-321", ["LIN-123", "LIN-321"]],
  ])("message %s should yield %j", (message, expected) => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message,
    });
    expect(ids(result).sort()).toEqual(expected.sort());
  });
});

describe("commit message magic word behavior", () => {
  it("extracts with closing keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("extracts with contributing phrase", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Related to LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("does not extract without magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See LIN-123 for details",
    });
    expect(ids(result)).toEqual([]);
  });

  it("extracts multiple keys after keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes LIN-123, LIN-456 and ENG-789",
    });
    expect(ids(result).sort()).toEqual(["ENG-789", "LIN-123", "LIN-456"]);
  });

  it("extracts magic word in title line", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fix LIN-123: something",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("does not extract key in title without keyword", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "LIN-123: Fix something",
    });
    expect(ids(result)).toEqual([]);
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
    expect(ids(result)).toEqual(["LIN-100"]);
  });

  it.each(["ref", "refs", "references", "part of", "related to", "relates to", "contributes to", "towards", "toward"])(
    "contributing phrase '%s' extracts issue",
    (phrase) => {
      const result = extractLinearIssueIdentifiersForCommit({
        sha: "abc",
        branchName: null,
        message: `${phrase} LIN-200`,
      });
      expect(ids(result)).toEqual(["LIN-200"]);
    },
  );

  it("supports keyword with colon separator", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Closes: LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("only extracts keys preceded by magic word on same line", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See LIN-111, fixes LIN-222",
    });
    expect(ids(result)).toEqual(["LIN-222"]);
  });

  it("does not extract from the original bug scenario", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Title\nSeparate issue to follow up on that here LIN-60064",
    });
    expect(ids(result)).toEqual([]);
  });

  it("branch provides keys independently of message magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "feature/LIN-100-something",
      message: "See LIN-200 for details",
    });
    expect(ids(result)).toEqual(["LIN-100"]);
  });

  it("is case insensitive for magic words", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "fIXES LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("extracts with multi-word phrase 'Part of'", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Part of LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("extracts with multi-word phrase 'Related to'", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Related to LIN-456",
    });
    expect(ids(result)).toEqual(["LIN-456"]);
  });

  it("extracts issue from Linear URL with slug after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123/fix-auth",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("extracts issue from Linear URL without slug after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("does not extract Linear URL without magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "See https://linear.app/myorg/issue/LIN-123/fix",
    });
    expect(ids(result)).toEqual([]);
  });

  it("extracts mixed Linear URLs and raw IDs after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/myorg/issue/LIN-123/slug, ENG-456 and LIN-789",
    });
    expect(ids(result).sort()).toEqual(["ENG-456", "LIN-123", "LIN-789"]);
  });

  it("extracts issue from http Linear URL after magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes http://linear.app/myorg/issue/LIN-123",
    });
    expect(ids(result)).toEqual(["LIN-123"]);
  });

  it("extracts issue from Linear URL with trailing slash", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Fixes https://linear.app/my-org/issue/LIN-213/",
    });
    expect(ids(result)).toEqual(["LIN-213"]);
  });

  it("extracts issue from Linear URL with contributing phrase", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: "Part of https://linear.app/myorg/issue/LIN-213/some-slug",
    });
    expect(ids(result)).toEqual(["LIN-213"]);
  });
});

describe("revert branch handling", () => {
  it("blocks extraction from merge commit with revert branch name", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/bac-39",
      message: "Merge pull request #572 from org/revert-571-romain/bac-39",
    });
    expect(ids(result)).toEqual([]);
  });

  it("blocks extraction when revert branch has multiple identifiers", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/drive-320-and-drive-321",
      message: null,
    });
    expect(ids(result)).toEqual([]);
  });

  it("blocks PR number extraction from revert branch", () => {
    const result = extractPullRequestNumbersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/bac-39",
      message: "Merge pull request #572 from org/revert-571-romain/bac-39",
    });
    expect(result).toEqual([]);
  });

  it("blocks add-extraction from message-only revert with magic word", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: 'Revert "Fixes ENG-100"',
    });
    expect(ids(result)).toEqual([]);
  });

  it("reverted extractor picks up message-only revert with magic word", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      branchName: null,
      message: 'Revert "Fixes ENG-100"',
    });
    expect(ids(result)).toEqual(["ENG-100"]);
  });

  it("allows extraction from revert-of-revert branch (even depth)", () => {
    const result = extractLinearIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-572-revert-571-romain/bac-39",
      message: null,
    });
    expect(ids(result)).toEqual(["BAC-39"]);
  });
});

describe("extractRevertedIssueIdentifiersForCommit", () => {
  it("extracts identifier from unwrapped revert message with magic word", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      message: 'Revert "Fixes DRIVE-320: memory leak in background location service"',
    });
    expect(ids(result)).toEqual(["DRIVE-320"]);
  });

  it("ignores identifier in unwrapped message without magic word", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      message: 'Revert "DRIVE-320: Fix memory leak in background location service"',
    });
    expect(ids(result)).toEqual([]);
  });

  it("ignores non-issue tokens in unwrapped message", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      message: 'Revert "Bump v1-2 to v1-3"',
    });
    expect(ids(result)).toEqual([]);
  });

  it("extracts identifier from revert branch name", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-571-romain/bac-39",
      message: 'Revert "Add TEST variable to .env.example"',
    });
    expect(ids(result)).toEqual(["BAC-39"]);
  });

  it("extracts from both message and branch, deduplicates", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "revert-566-romain/drive-320",
      message: 'Revert "Fixes DRIVE-320: memory leak"',
    });
    expect(ids(result)).toEqual(["DRIVE-320"]);
  });

  it("extracts multiple identifiers from unwrapped message", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      message: 'Revert "Fixes DRIVE-320 and DRIVE-321"',
    });
    expect(ids(result).sort()).toEqual(["DRIVE-320", "DRIVE-321"]);
  });

  it("returns empty for non-revert commit", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      branchName: "romain/drive-320",
      message: "DRIVE-320: Fix memory leak",
    });
    expect(ids(result)).toEqual([]);
  });

  it("returns empty when revert message has no identifiers", () => {
    const result = extractRevertedIssueIdentifiersForCommit({
      sha: "abc",
      message: 'Revert "Fix bug"',
    });
    expect(ids(result)).toEqual([]);
  });

  it("returns empty for null/undefined inputs", () => {
    expect(ids(extractRevertedIssueIdentifiersForCommit({ sha: "abc", message: null }))).toEqual([]);
    expect(ids(extractRevertedIssueIdentifiersForCommit({ sha: "abc" }))).toEqual([]);
  });
});

describe("revert chain: add → revert → re-add", () => {
  const mergeAdd: CommitContext = {
    sha: "c7f3c4b1",
    branchName: "romain/bac-39",
    message: "Merge pull request #571 from org/romain/bac-39 Add TEST variable",
  };
  const innerAdd: CommitContext = {
    sha: "439fe0e5",
    message: "Add TEST variable to .env.example",
  };
  const mergeRevert: CommitContext = {
    sha: "69c6d923",
    branchName: "revert-571-romain/bac-39",
    message: 'Merge pull request #572 from org/revert-571-romain/bac-39 Revert "Add TEST variable"',
  };
  const innerRevert: CommitContext = {
    sha: "986e4383",
    message: 'Revert "Add TEST variable to .env.example"',
  };
  const mergeReAdd: CommitContext = {
    sha: "cc13b9c5",
    branchName: "revert-572-revert-571-romain/bac-39",
    message: "Merge pull request #573 from org/revert-572-revert-571-romain/bac-39 Custom name for the revert revert",
  };
  const innerReAdd: CommitContext = {
    sha: "9c83cecb",
    message: 'Revert "Revert "Add TEST variable to .env.example""',
  };
  const inlineAdd: CommitContext = { sha: "c041d48b", message: "More revert test" };
  const inlineRevert: CommitContext = { sha: "fa20f72f", message: 'Revert "More revert test"' };
  const inlineReapply: CommitContext = { sha: "1086658b", message: 'Reapply "More revert test"' };
  const inlineMerge: CommitContext = {
    sha: "f685bbbc",
    branchName: "romain/test-revert",
    message: 'Merge pull request #575 from org/romain/test-revert Reapply "More revert test"',
  };

  describe("issue extraction (add path)", () => {
    it("merge add → extracts identifier from branch", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(mergeAdd))).toEqual(["BAC-39"]);
    });

    it("inner add → nothing (no magic word, no branch)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(innerAdd))).toEqual([]);
    });

    it("merge revert → blocked (odd-depth revert branch)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(mergeRevert))).toEqual([]);
    });

    it("inner revert → nothing (Revert message has no magic word)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(innerRevert))).toEqual([]);
    });

    it("merge re-add → identifier re-added (even depth = revert-of-revert)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(mergeReAdd))).toEqual(["BAC-39"]);
    });

    it("inner re-add → nothing (no magic word, no branch)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(innerReAdd))).toEqual([]);
    });

    it("inline revert/reapply → nothing (no identifiers)", () => {
      expect(ids(extractLinearIssueIdentifiersForCommit(inlineAdd))).toEqual([]);
      expect(ids(extractLinearIssueIdentifiersForCommit(inlineRevert))).toEqual([]);
      expect(ids(extractLinearIssueIdentifiersForCommit(inlineReapply))).toEqual([]);
      expect(ids(extractLinearIssueIdentifiersForCommit(inlineMerge))).toEqual([]);
    });
  });

  describe("issue extraction (revert path)", () => {
    it("merge add → not a revert", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(mergeAdd))).toEqual([]);
    });

    it("merge revert → extracts identifier from stripped branch", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(mergeRevert))).toEqual(["BAC-39"]);
    });

    it("inner revert → nothing (no identifier in unwrapped message)", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(innerRevert))).toEqual([]);
    });

    it("merge re-add → not a revert (even depth)", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(mergeReAdd))).toEqual([]);
    });

    it("inner re-add → not a revert (even depth)", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(innerReAdd))).toEqual([]);
    });

    it("inline revert/reapply → nothing (no identifiers)", () => {
      expect(ids(extractRevertedIssueIdentifiersForCommit(inlineRevert))).toEqual([]);
      expect(ids(extractRevertedIssueIdentifiersForCommit(inlineReapply))).toEqual([]);
    });
  });
});

describe("getRevertBranchDepth", () => {
  it.each([
    [null, 0],
    ["romain/bac-39", 0],
    ["revert-571-romain/bac-39", 1],
    ["revert-572-revert-571-romain/bac-39", 2],
    ["revert-574-revert-573-revert-572-romain/bac-39", 3],
    ["org/revert-572-revert-571-romain/bac-39", 2],
  ])("branch %j → depth %d", (branch, expected) => {
    expect(getRevertBranchDepth(branch)).toBe(expected);
  });
});

describe("getRevertMessageDepth", () => {
  it.each([
    [null, 0],
    ["Fix memory leak", 0],
    ['Revert "DRIVE-320: Fix"', 1],
    ['Revert "Revert "DRIVE-320: Fix""', 2],
    ['Revert "Revert "Revert "DRIVE-320: Fix"""', 3],
    ['Reapply "DRIVE-320: Fix"', 0],
  ])("message %j → depth %d", (message, expected) => {
    expect(getRevertMessageDepth(message)).toBe(expected);
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
