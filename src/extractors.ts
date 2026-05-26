import { verbose } from "./log";
import { CommitContext } from "./types";

const MAX_KEY_LENGTH = 7;

/**
 * Linear's API types `pullRequestReferences[].number` as a GraphQL `Int`
 * (signed 32-bit). A token whose value exceeds this cannot be a real PR/MR
 * number and would cause the entire release sync to be rejected, so we filter
 * such tokens out at extraction time.
 */
const MAX_PR_NUMBER = 2_147_483_647;

const GITHUB_SQUASH_RE = /\(#(\d+)\)$/;
const GITHUB_MERGE_RE = /^Merge pull request #(\d+)/i;
const GITHUB_TITLE_SCAN_RE = /#(\d+)/g;
const GITLAB_MR_TRAILER_RE = /^See merge request [\w./-]+!(\d+)\b/gim;

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
 * Patterns for common manual subject-line conventions that aren't gated by a
 * magic word. Each regex is anchored to the start of the subject and must
 * capture team key in group 1 and issue number in group 2.
 *
 * Add more entries here as new conventions appear in the wild.
 */
const COMMON_SUBJECT_PATTERNS: RegExp[] = [
  // `[ENG-123] My change`
  new RegExp(`^\\s*\\[(\\w{1,${MAX_KEY_LENGTH}})-([0-9]{1,9})\\]`, "i"),
  // `(ENG-123) My change`
  new RegExp(`^\\s*\\((\\w{1,${MAX_KEY_LENGTH}})-([0-9]{1,9})\\)`, "i"),
  // `ENG-123 My change` or `ENG-123: My change` (colon is allowed before the
  // whitespace; `ENG-123:foo` without the space stays unmatched to keep the
  // delimiter unambiguous).
  new RegExp(`^\\s*(\\w{1,${MAX_KEY_LENGTH}})-([0-9]{1,9})(?=:?\\s)`, "i"),
];

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
 * Extract identifiers from common, manually-written subject-line conventions
 * (e.g. `[ENG-123] My change`). These don't require a magic word — the
 * convention itself signals intent.
 */
function matchCommonSubjectPatterns(message: string): IdentifierMatch[] {
  const subject = getCommitSubject(message);
  const results: IdentifierMatch[] = [];
  for (const pattern of COMMON_SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (!match) continue;
    const [, teamKey, numberString] = match;
    if (!teamKey || !numberString) continue;
    if (Number(numberString).toString().length !== numberString.length) continue;
    results.push({
      rawIdentifier: `${teamKey}-${numberString}`,
      identifier: `${teamKey.toUpperCase()}-${Number(numberString)}`,
    });
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

export function extractLinearIssueIdentifiersForCommit(commit: CommitContext): ExtractedIdentifier[] {
  if (!commit) {
    return [];
  }

  // Odd depth = revert; even depth = non-revert or revert-of-revert (re-add).
  const { depth: branchDepth, inner: strippedBranch } = parseRevertBranch(commit.branchName ?? "");
  const { depth: messageDepth, afterTitle } = parseRevertMessage(commit.message ?? "");

  const found = new Map<string, ExtractedIdentifier>();

  // Odd-depth revert branches name what was *reverted* (e.g. `revert-456-eng-100-fix`),
  // not what the revert itself adds — so the branch contributes no added identifiers.
  // The body scan below still runs, since `Fixes ENG-N` in the revert message body
  // is the revert author's own note about what they're closing.
  if (branchDepth % 2 === 0 && strippedBranch.length > 0) {
    for (const match of matchAllIdentifiers(strippedBranch)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, {
          identifier: match.identifier,
          source: "branch_name",
        });
      }
    }
  } else if (branchDepth % 2 === 1) {
    verbose(
      `Skipping branch-name extraction for revert branch "${commit.branchName}" (depth ${branchDepth}) on ${commit.sha}`,
    );
  }

  // In a revert, the inner subject's identifiers are reverted, not added — but
  // the revert author's body (e.g. `Fixes LIN-N`) describes what the revert
  // itself closes, so scan that. Strip squash dumps first to avoid attributing
  // already-shipped references to this commit.
  const scanTarget = messageDepth % 2 === 1 ? afterTitle : (commit.message ?? "");
  const message = stripSquashBlock(scanTarget);
  if (message.length > 0) {
    for (const match of [...matchCommonSubjectPatterns(message), ...matchMagicWordIdentifiers(message)]) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, {
          identifier: match.identifier,
          source: "commit_message",
        });
      }
    }
  }

  return Array.from(found.values());
}

type PrMatch = { number: number; source: string };

/**
 * Extract pull/merge request numbers referenced by a single commit's message.
 *
 * Recognized formats:
 * - GitHub squash: `Title (#N)` on the title line
 * - GitHub merge: `Merge pull request #N from ...` at the start of the message
 * - GitLab: a `See merge request <group>/<project>!N` trailer (emitted by the
 *   default merge commit template whenever a merge commit is created — i.e.
 *   merge_method = merge or rebase_merge, squash on or off)
 *
 * Not captured (we cannot recover the number from the message alone):
 * - GitLab merge_method = ff (no merge commit, no trailer; the source commit
 *   lands verbatim on the target branch)
 * - Projects with custom merge commit templates that strip these formats
 * - Direct pushes whose commit message follows none of the above conventions
 */
export function extractPullRequestNumbersForCommit(commit: CommitContext): number[] {
  if (!commit) return [];

  const rawMessage = commit.message ?? "";

  // Reverts reference the original PR, not a new one.
  if (/^Revert "/i.test(rawMessage)) {
    verbose(`Skipping revert commit ${commit.sha} with message: "${rawMessage}"`);
    return [];
  }
  if (getRevertBranchDepth(commit.branchName) % 2 === 1) {
    verbose(`Skipping revert merge commit ${commit.sha}`);
    return [];
  }

  // Drop nested squash sub-commit dumps before scanning so `(#NNN)` references
  // from already-shipped commits pulled in via `git merge` don't get attributed
  // to this commit's release.
  const message = stripSquashBlock(rawMessage);

  const valid: number[] = [];
  for (const { number, source } of [...extractGithubPrNumbers(message), ...extractGitlabMrNumbers(message)]) {
    if (number > MAX_PR_NUMBER) {
      verbose(
        `Ignoring #${number} in commit ${commit.sha} (${source}): exceeds max PR number ${MAX_PR_NUMBER}, not a valid reference`,
      );
      continue;
    }
    verbose(`Found PR number ${number} in commit ${commit.sha} (${source}): "${message}"`);
    valid.push(number);
  }
  return [...new Set(valid)];
}

function extractGithubPrNumbers(message: string): PrMatch[] {
  const matches: PrMatch[] = [];
  const title = message.split(/\r?\n/)[0] ?? "";

  const squash = title.match(GITHUB_SQUASH_RE);
  if (squash)
    matches.push({
      number: Number.parseInt(squash[1]!, 10),
      source: "github squash",
    });

  const merge = message.match(GITHUB_MERGE_RE);
  if (merge)
    matches.push({
      number: Number.parseInt(merge[1]!, 10),
      source: "github merge",
    });

  // Fallback for non-canonical merge titles (e.g. a direct push that put the PR
  // number somewhere other than the trailing parens). Restrict to the title —
  // scanning the body would re-pick up cross-references like "builds on #85"
  // and stale references inside squashed-in sub-commit history.
  if (matches.length === 0) {
    for (const m of title.matchAll(GITHUB_TITLE_SCAN_RE)) {
      matches.push({
        number: Number.parseInt(m[1]!, 10),
        source: "github title scan",
      });
    }
  }

  return matches;
}

function extractGitlabMrNumbers(message: string): PrMatch[] {
  // Line-anchored so we don't pick up `!N` references elsewhere in the body.
  return [...message.matchAll(GITLAB_MR_TRAILER_RE)].map((m) => ({
    number: Number.parseInt(m[1]!, 10),
    source: "gitlab merge request trailer",
  }));
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

export function getCommitSubject(message: string | null | undefined): string {
  if (!message) return "";
  const newlineIdx = message.search(/\r?\n/);
  return newlineIdx === -1 ? message : message.slice(0, newlineIdx);
}

/**
 * Returns the subject with any `Revert "..."` wrapping stripped. For a
 * non-revert commit this is just the subject; for a revert it's the subject of
 * the commit being reverted. Callers that want to match against what the
 * change is *about* (not the revert mechanics) should use this.
 */
export function getEffectiveSubject(message: string | null | undefined): string {
  if (!message) return "";
  return parseRevertMessage(message).inner;
}

/**
 * Unwrap `Revert "..."` layers on the subject line only. Scanning the whole
 * message would let a stray `"` in the body extend the capture past the real
 * subject. `afterTitle` is everything outside the unwrapped subject (trailing
 * content on the subject line plus the body), so callers can scan it for the
 * revert author's own references.
 */
function parseRevertMessage(message: string): {
  depth: number;
  inner: string;
  afterTitle: string;
} {
  const newlineIdx = message.search(/\r?\n/);
  const subject = newlineIdx === -1 ? message : message.slice(0, newlineIdx);
  const body = newlineIdx === -1 ? "" : message.slice(newlineIdx);

  let text = subject;
  let depth = 0;
  let outerAfter = "";
  while (/^Revert "/i.test(text)) {
    const match = text.match(/^Revert "(.+)"(.*)$/);
    if (!match) break;
    if (depth === 0) outerAfter = match[2]!;
    text = match[1]!;
    depth++;
  }
  return { depth, inner: text, afterTitle: outerAfter + body };
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
export function extractRevertedIssueIdentifiersForCommit(commit: CommitContext): ExtractedIdentifier[] {
  if (!commit) return [];

  const { depth: branchDepth, inner: originalBranch } = parseRevertBranch(commit.branchName ?? "");
  const { depth: messageDepth, inner: innerMessage } = parseRevertMessage(commit.message ?? "");

  // At least one of branch/message must have odd depth (i.e., be a revert) to extract
  if (branchDepth % 2 === 0 && messageDepth % 2 === 0) return [];

  const found = new Map<string, ExtractedIdentifier>();

  if (branchDepth % 2 === 1) {
    for (const match of matchAllIdentifiers(originalBranch)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, {
          identifier: match.identifier,
          source: "branch_name",
        });
      }
    }
  }

  // Use magic-word gating on the inner message, same as the add path, to avoid
  // false positives from generic word-number tokens (e.g. "Bump v1-2 to v1-3").
  if (messageDepth % 2 === 1) {
    const innerStripped = stripSquashBlock(innerMessage);
    for (const match of matchMagicWordIdentifiers(innerStripped)) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, {
          identifier: match.identifier,
          source: "commit_message",
        });
      }
    }
  }

  return Array.from(found.values());
}
