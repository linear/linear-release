import { verbose } from "./log";
import { CommitContext } from "./types";

const MAX_KEY_LENGTH = 7;

/**
 * Linear's API types `pullRequestReferences[].number` as a GraphQL `Int`
 * (signed 32-bit). A `#NNN` token whose value exceeds this cannot be a real
 * GitHub PR number and would cause the entire release sync to be rejected,
 * so we filter such tokens out at extraction time.
 */
const MAX_PR_NUMBER = 2_147_483_647;

/**
 * Regex for matching issue identifiers with proper word boundaries.
 * Matches the same patterns as Linear's issue identifier detection.
 *
 * - `(?:^|\b|(?<=_))` - start boundary (includes underscore as word boundary)
 * - `(\w{1,7})` - team key (1-7 word characters)
 * - `-` - literal hyphen
 * - `([0-9]{1,9})` - issue number (1-9 digits)
 * - `(?:$|\b|(?=_))` - end boundary (includes underscore as word boundary)
 * - `(?!\.\d)` - negative lookahead to exclude version suffixes like "1.57.0"
 */
const ISSUE_IDENTIFIER_REGEX = new RegExp(
  `(?:^|\\b|(?<=_))((\\w{1,${MAX_KEY_LENGTH}})-([0-9]{1,9}))(?:$|\\b|(?=_))(?!\\.\\d)`,
  "gi",
);

const LINEAR_ISSUE_URL_REGEX = /https?:\/\/linear\.app\/[\w-]+\/issue\/(\w{1,7}-[0-9]{1,9})(?:\/[\w-]*)*/gi;

/**
 * `git merge --squash` followed by `git commit` writes a body containing this
 * header and then dumps the full message of every commit pulled in via the
 * squash — including upstream history merged into the feature branch via
 * `git merge`. Issue / PR references inside that dump describe branch history,
 * not the change being squashed, so they must not feed release association.
 *
 * We excise *only* the dump itself: any real subject the developer prepended
 * and any footer they appended (e.g. `Closes LIN-X`, `Co-authored-by: …`) are
 * preserved. The dump is bounded by recognizable structural lines (`commit
 * <sha>`, `Author:`, `Date:`, `Merge:`, blank lines, and indented body
 * content); the first non-indented, non-empty line that doesn't match those
 * patterns marks the start of user-authored footer content.
 */
const SQUASH_BLOCK_MARKER = /^Squashed commit of the following:/i;
const SQUASH_COMMIT_HEADER = /^commit [0-9a-f]{7,40}\b/i;
const SQUASH_METADATA_HEADER = /^(?:Author|AuthorDate|Commit|CommitDate|Date|Merge):\s/i;

function stripSquashBlock(message: string): string {
  const lines = message.split(/\r?\n/);
  const markerIdx = lines.findIndex((l) => SQUASH_BLOCK_MARKER.test(l));
  if (markerIdx === -1) return message;

  let i = markerIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    if (/^[ \t]/.test(line)) continue;
    if (SQUASH_COMMIT_HEADER.test(line)) continue;
    if (SQUASH_METADATA_HEADER.test(line)) continue;
    break;
  }

  const before = lines.slice(0, markerIdx).join("\n").trimEnd();
  const after = lines.slice(i).join("\n").trim();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

function normalizeLinearUrls(text: string): string {
  return text.replace(LINEAR_ISSUE_URL_REGEX, "$1");
}

/** Magic words that indicate a commit is closing/fixing an issue. Matches Linear's detection. */
const CLOSING_WORDS = [
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
];

/** Magic phrases that indicate a commit contributes to an issue. Matches Linear's detection. */
const CONTRIBUTING_PHRASES = [
  "ref",
  "refs",
  "references",
  "part of",
  "related to",
  "relates to",
  "contributes to",
  "towards",
  "toward",
];

/**
 * Core issue ID pattern without word boundaries — used inside the magic word
 * composite regex where surrounding context already provides boundaries.
 */
const ISSUE_ID_CORE = `\\w{1,${MAX_KEY_LENGTH}}-[0-9]{1,9}(?!\\.\\d)`;

/**
 * Build a regex that matches magic words followed by one or more issue identifiers.
 * Pattern per line, matching Linear's detection:
 *   \b(magic_words)[\s:]+(ISSUE_ID(([,\s]|\band\b|&)+ISSUE_ID)*)
 */
const MAGIC_WORD_REGEX = new RegExp(
  `\\b(${[...CLOSING_WORDS, ...CONTRIBUTING_PHRASES].join("|")})[\\s:]+(${ISSUE_ID_CORE}(?:(?:[\\s,]|\\band\\b|&)+${ISSUE_ID_CORE})*)`,
  "gi",
);

type IdentifierMatch = {
  identifier: string;
  rawIdentifier: string;
};

function parseMatch(match: RegExpExecArray): IdentifierMatch | undefined {
  const [, rawIdentifier, teamKey, numberString] = match;
  // Reject leading zeros (e.g., LIN-0004)
  if (!rawIdentifier || !teamKey || !numberString || Number(numberString).toString().length !== numberString.length) {
    return;
  }
  return {
    rawIdentifier,
    identifier: `${teamKey.toUpperCase()}-${Number(numberString)}`,
  };
}

function matchAllIdentifiers(text: string): IdentifierMatch[] {
  const regex = new RegExp(ISSUE_IDENTIFIER_REGEX.source, "gi");
  const results: IdentifierMatch[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const parsed = parseMatch(match);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

/**
 * Extract issue identifiers from text only when preceded by a magic word.
 * Processes text line-by-line, matching Linear's detection behavior.
 */
function matchMagicWordIdentifiers(text: string): IdentifierMatch[] {
  const results: IdentifierMatch[] = [];
  const lines = text.split(/\r?\n/);

  for (let line of lines) {
    line = normalizeLinearUrls(line);
    const regex = new RegExp(MAGIC_WORD_REGEX.source, "gi");
    let match;
    while ((match = regex.exec(line)) !== null) {
      // match[2] contains the captured issue keys portion (one or more IDs)
      const issueKeysPortion = match[2];
      if (issueKeysPortion) {
        const identifiers = matchAllIdentifiers(issueKeysPortion);
        results.push(...identifiers);
      }
    }
  }

  return results;
}

export type ExtractedIdentifier = {
  identifier: string;
  source: "branch_name" | "commit_message";
};

export type ExtractionOptions = {
  /**
   * Regex applied to each line of the commit message. The first capture group
   * must wrap the issue-ID portion, and is fed to the standard identifier
   * matcher (which also accepts ID chains like `LIN-1, LIN-2` and rejects
   * leading-zero IDs). Anchor with `^` to match once per line. The `g` flag
   * is forced and `y` is dropped internally. Example: `^\[(.+?)\]`.
   */
  commitPrefixPattern?: RegExp;
};

/**
 * Match a user-supplied prefix regex line-by-line, finding all occurrences on
 * each line. The regex's first capture group is fed to the standard identifier
 * matcher (uppercase normalization + leading-zero rejection + multi-ID list
 * grammar). The caller is expected to anchor with `^` if they want a
 * prefix-only match; an anchored pattern naturally still matches at most once
 * per line. Squashed sub-commit dumps are already removed by `stripSquashBlock`
 * before this runs.
 */
function matchCommitPrefixIdentifiers(text: string, pattern: RegExp): IdentifierMatch[] {
  // Force `g` (and drop `y`) so `matchAll` iterates every occurrence per line.
  const flags = pattern.flags.replace(/[gy]/g, "") + "g";
  const regex = new RegExp(pattern.source, flags);

  const results: IdentifierMatch[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(regex)) {
      if (!match[1]) continue;
      results.push(...matchAllIdentifiers(match[1]));
    }
  }
  return results;
}

export function extractLinearIssueIdentifiersForCommit(
  commit: CommitContext,
  options: ExtractionOptions = {},
): ExtractedIdentifier[] {
  if (!commit) {
    return [];
  }

  // Odd depth = the commit is undoing previous work (a revert), so we must not
  // count its identifiers as "added". Even depth = revert-of-revert (re-add).
  const { depth: branchDepth, inner: strippedBranch } = parseRevertBranch(commit.branchName ?? "");
  if (branchDepth % 2 === 1) {
    verbose(`Skipping revert branch "${commit.branchName}" (depth ${branchDepth}) for commit ${commit.sha}`);
    return [];
  }
  const { depth: messageDepth } = parseRevertMessage(commit.message ?? "");
  if (messageDepth % 2 === 1) {
    verbose(`Skipping revert message (depth ${messageDepth}) for commit ${commit.sha}`);
    return [];
  }

  const found = new Map<string, ExtractedIdentifier>();

  if (strippedBranch.length > 0) {
    for (const match of matchAllIdentifiers(strippedBranch)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, { identifier: match.identifier, source: "branch_name" });
      }
    }
  }

  // Strip any squashed sub-commit dump first so references that came from
  // already-merged branch history don't get re-attributed to this commit.
  const message = stripSquashBlock(commit.message ?? "");
  if (message.length > 0) {
    for (const match of matchMagicWordIdentifiers(message)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, { identifier: match.identifier, source: "commit_message" });
      }
    }
    if (options.commitPrefixPattern) {
      for (const match of matchCommitPrefixIdentifiers(message, options.commitPrefixPattern)) {
        if (!found.has(match.identifier)) {
          found.set(match.identifier, { identifier: match.identifier, source: "commit_message" });
        }
      }
    }
  }

  return Array.from(found.values());
}

export function extractPullRequestNumbersForCommit(commit: CommitContext): number[] {
  if (!commit) {
    return [];
  }

  const rawMessage = commit.message ?? "";

  // Skip reverts - they reference the original PR, not a new one
  if (/^Revert "/i.test(rawMessage)) {
    verbose(`Skipping revert commit ${commit.sha} with message: "${rawMessage}"`);
    return [];
  }

  // Revert merge commits reference the original PR number, not a new one.
  // Even depth (revert-of-revert) falls through to normal extraction.
  if (getRevertBranchDepth(commit.branchName) % 2 === 1) {
    verbose(`Skipping revert merge commit ${commit.sha}`);
    return [];
  }

  // Drop nested squash sub-commit dumps before scanning so `(#NNN)` references
  // from already-shipped commits pulled in via `git merge` don't get attributed
  // to this commit's release.
  const message = stripSquashBlock(rawMessage);

  const prNumbers: number[] = [];
  const pushIfValid = (raw: string, source: string): void => {
    const number = Number.parseInt(raw, 10);
    if (number > MAX_PR_NUMBER) {
      verbose(
        `Ignoring #${raw} in commit ${commit.sha} (${source}): exceeds max PR number ${MAX_PR_NUMBER}, likely not a GitHub PR reference`,
      );
      return;
    }
    verbose(`Found PR number ${number} in commit ${commit.sha} (${source}): "${message}"`);
    prNumbers.push(number);
  };

  // GitHub squash: "Title (#123)" - must be at end of title (first line)
  const title = message.split(/\r?\n/)[0] ?? "";
  const squashMatch = title.match(/\(#(\d+)\)$/);
  if (squashMatch) {
    pushIfValid(squashMatch[1]!, "squash format");
  }

  // GitHub merge: "Merge pull request #123 from ..." - must be at start
  const mergeMatch = message.match(/^Merge pull request #(\d+)/i);
  if (mergeMatch) {
    pushIfValid(mergeMatch[1]!, "merge format");
  }

  // Fallback for non-canonical merge titles (e.g. a direct push that put the PR
  // number somewhere other than the trailing parens). Restrict to the title line
  // — scanning the body would re-pick up cross-references like "builds on #85"
  // and stale references inside squashed-in sub-commit history.
  if (prNumbers.length === 0) {
    for (const match of title.matchAll(/#(\d+)/g)) {
      pushIfValid(match[1]!, "title scan");
    }
  }

  return [...new Set(prNumbers)];
}

function parseRevertBranch(branchName: string): {
  depth: number;
  inner: string;
} {
  // Full refs can have org/ prefixes (e.g. "org/revert-571-..."), strip to the revert pattern.
  // Non-greedy so we stop at the first revert-N- match, not the last (preserves nested depth).
  let name = branchName.replace(/^.*?\/(?=revert-\d+-)/i, "");
  let depth = 0;
  while (/^revert-\d+-/i.test(name)) {
    name = name.replace(/^revert-\d+-/i, "");
    depth++;
  }
  return { depth, inner: name };
}

/**
 * Strip revert-N- prefixes from a branch name and count nesting depth.
 * e.g. "revert-572-revert-571-romain/bac-39" → { depth: 2, inner: "romain/bac-39" }
 */
export function getRevertBranchDepth(branchName: string | null | undefined): number {
  if (!branchName) return 0;
  return parseRevertBranch(branchName).depth;
}

function parseRevertMessage(message: string): { depth: number; inner: string } {
  let text = message;
  let depth = 0;
  while (/^Revert "/i.test(text)) {
    const match = text.match(/^Revert "(.+)"(.*)$/s);
    if (!match) break;
    text = match[1]!;
    depth++;
  }
  return { depth, inner: text };
}

/**
 * Unwrap Revert "..." layers from a commit message and count nesting depth.
 * e.g. 'Revert "Revert "DRIVE-320: Fix""' → { depth: 2, inner: "DRIVE-320: Fix" }
 */
export function getRevertMessageDepth(message: string | null | undefined): number {
  if (!message) return 0;
  return parseRevertMessage(message).depth;
}

/** Extract identifiers being reverted. Returns [] if not an odd-depth revert. */
export function extractRevertedIssueIdentifiersForCommit(
  commit: CommitContext,
  options: ExtractionOptions = {},
): ExtractedIdentifier[] {
  if (!commit) return [];

  const { depth: branchDepth, inner: originalBranch } = parseRevertBranch(commit.branchName ?? "");
  const { depth: messageDepth, inner: innerMessage } = parseRevertMessage(commit.message ?? "");

  // At least one of branch/message must have odd depth (i.e., be a revert) to extract
  if (branchDepth % 2 === 0 && messageDepth % 2 === 0) return [];

  const found = new Map<string, ExtractedIdentifier>();

  if (branchDepth % 2 === 1) {
    for (const match of matchAllIdentifiers(originalBranch)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, { identifier: match.identifier, source: "branch_name" });
      }
    }
  }

  // Mirror the add path's gating on the inner message to avoid false positives
  // from generic word-number tokens (e.g. "Bump v1-2 to v1-3").
  if (messageDepth % 2 === 1) {
    const innerStripped = stripSquashBlock(innerMessage);
    for (const match of matchMagicWordIdentifiers(innerStripped)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, { identifier: match.identifier, source: "commit_message" });
      }
    }
    if (options.commitPrefixPattern) {
      for (const match of matchCommitPrefixIdentifiers(innerStripped, options.commitPrefixPattern)) {
        if (!found.has(match.identifier)) {
          found.set(match.identifier, { identifier: match.identifier, source: "commit_message" });
        }
      }
    }
  }

  return Array.from(found.values());
}
