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
    "implement",
    "implements",
    "implemented",
    "implementing",
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

describe("squash sub-commit blocks", () => {
  // `git merge --squash` followed by `git commit` writes a body that begins
  // with a "Squashed commit of the following:" header and dumps every commit
  // pulled in via the squash, including upstream commits merged into the
  // feature branch. Those references describe branch history, not the change
  // landing here, so they must not be re-attributed to this release.

  it("ignores PR refs inside a squash sub-commit dump (no real title)", () => {
    const message = `Squashed commit of the following:

commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

    Older shipped PR title (#85)

    Fixes LIN-50`;
    expect(extractPullRequestNumbersForCommit({ sha: "abc", message })).toEqual([]);
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual([]);
  });

  it("ignores PR refs inside a squash dump but keeps a real title prepended", () => {
    const message = `New dashboard widget (#100)

Squashed commit of the following:

commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

    Older shipped PR title (#85)

    Fixes LIN-50

commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

    Bug fix for graph render

    Fixes LIN-100`;
    // Title's PR # is the legitimate one; body's #85 must not leak.
    expect(extractPullRequestNumbersForCommit({ sha: "abc", message })).toEqual([100]);
    // LIN-100 is in a sub-commit body — also nested history. With the squash
    // dump stripped, neither LIN-50 (already shipped) nor LIN-100 (whose
    // attribution belongs to a different commit) are re-extracted from here.
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual([]);
  });

  it("keeps magic-word refs from the PR description body above the squash dump", () => {
    const message = `New dashboard widget (#100)

Closes LIN-100

Squashed commit of the following:

commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

    Fixes LIN-50`;
    expect(extractPullRequestNumbersForCommit({ sha: "abc", message })).toEqual([100]);
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual(["LIN-100"]);
  });

  it("does not extract PR # from body cross-reference like 'builds on #85'", () => {
    const message = `Add settings page (#100)

This builds on #85 and #87. Closes LIN-200.`;
    expect(extractPullRequestNumbersForCommit({ sha: "abc", message })).toEqual([100]);
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual(["LIN-200"]);
  });

  it("preserves a user-authored footer appended after the squash dump", () => {
    // Default `git merge --squash` puts the dump at the top, so any footer
    // (e.g., trailers like `Closes LIN-X`, `Co-authored-by: ...`) typically
    // ends up below the dump after the developer edits the message.
    const message = `Squashed commit of the following:

commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Author: Dev <dev@example.com>
Date:   Wed May 6 16:45:34 2026 +0000

    Edge cases

commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Author: Dev <dev@example.com>
Date:   Wed May 6 16:45:34 2026 +0000

    Implement search filter

Closes LIN-200`;
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual(["LIN-200"]);
  });

  it("preserves both a prepended title and an appended footer around the dump", () => {
    const message = `Search filter (#100)

Squashed commit of the following:

commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

    Older shipped PR title (#85)

    Fixes LIN-50

Closes LIN-200`;
    expect(extractPullRequestNumbersForCommit({ sha: "abc", message })).toEqual([100]);
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message })).sort()).toEqual(["LIN-200"]);
  });

  it("handles the marker without recognizable commit blocks below", () => {
    const message = `Squashed commit of the following:

Closes LIN-200`;
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual(["LIN-200"]);
  });

  it("does not strip squash blocks from revert add-extraction (revert path is already blocked)", () => {
    // A revert message that wraps a squash dump shouldn't add anything.
    const message = `Revert "Squashed commit of the following:

    Fixes LIN-50"`;
    expect(ids(extractLinearIssueIdentifiersForCommit({ sha: "abc", message }))).toEqual([]);
  });
});

describe("extractPullRequestNumbersForCommit", () => {
  // Messages that should extract PR numbers
  it.each([
    ["For issue #111, fix (#123)", [123], "squash merge skips fallback"],
    ["Fix #124 with better handling", [124], "hash in middle of title"],
    ["Merge pull request #431 from org/branch", [431], "GitHub merge format"],
    ["Merge pull request #42 from owner/branch\n\nDescription", [42], "merge with multiline description"],
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

  // Numbers above the GraphQL Int (32-bit) bound cannot be GitHub PR numbers
  // and must be filtered so they don't poison the release sync mutation.
  it.each([
    [
      "FLEX-2816: fix something\n\nTwo issues from cursor[bot] review #4211934690.",
      [],
      "title has no PR number and body scan is no longer attempted",
    ],
    [
      "Fix something (#51876)\n\nTwo issues from cursor[bot] review #4211934690.",
      [51876],
      "squash match keeps valid PR; body cross-references are ignored",
    ],
    ["Fix bug\n\nRelated to (#4211934690)", [], "body fallback removed: cross-reference in body is ignored"],
    ["Fix bug\n\nSee #123 and sentry #9999999999", [], "body fallback removed: numbers in body don't leak"],
    ["Title (#4211934690)", [], "squash format with oversized number is dropped"],
    ["Merge pull request #4211934690 from x/y", [], "merge format with oversized number is dropped"],
    [`Title (#${2_147_483_647})`, [2_147_483_647], "Int32 max is allowed"],
    [`Title (#${2_147_483_648})`, [], "one above Int32 max is dropped"],
  ])("message %j should yield %j (%s)", (message, expected) => {
    const result = extractPullRequestNumbersForCommit({ sha: "abc", message });
    expect(result).toEqual(expected);
  });
});
