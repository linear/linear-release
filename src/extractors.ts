import { log } from "./log";
import { CommitContext } from "./types";

const MAX_KEY_LENGTH = 7;

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

export function extractLinearIssueIdentifiersForCommit(commit: CommitContext): string[] {
  if (!commit) {
    return [];
  }

  const sources = [commit.branchName ?? "", commit.message ?? ""].filter((value) => value.length > 0);

  if (sources.length === 0) {
    return [];
  }

  const found = new Map<string, string>();

  for (const source of sources) {
    const matches = matchAllIdentifiers(source);
    for (const match of matches) {
      if (!found.has(match.identifier)) {
        found.set(match.identifier, match.rawIdentifier);
      }
    }
  }

  return Array.from(found.keys());
}

export function extractPullRequestNumbersForCommit(commit: CommitContext): number[] {
  if (!commit) {
    return [];
  }

  const message = commit.message ?? "";

  // Skip reverts - they reference the original PR, not a new one
  if (/^Revert "/i.test(message)) {
    log(`Skipping revert commit ${commit.sha} with message: "${message}"`);
    return [];
  }

  const prNumbers: number[] = [];

  // GitHub squash: "Title (#123)" - must be at end of title (first line)
  const title = message.split(/\r?\n/)[0] ?? "";
  const squashMatch = title.match(/\(#(\d+)\)$/);
  if (squashMatch) {
    log(`Found PR number ${squashMatch[1]} in commit ${commit.sha} using squash format: "${message}"`);
    prNumbers.push(Number.parseInt(squashMatch[1]!, 10));
  }

  // GitHub merge: "Merge pull request #123 from ..." - must be at start
  const mergeMatch = message.match(/^Merge pull request #(\d+)/i);
  if (mergeMatch) {
    log(`Found PR number ${mergeMatch[1]} in commit ${commit.sha} using merge format: "${message}"`);
    prNumbers.push(Number.parseInt(mergeMatch[1]!, 10));
  }

  // Only use fallback if no matches from squash/merge formats
  if (prNumbers.length === 0) {
    const messageMatches = message.matchAll(/#(\d+)/g);
    for (const match of messageMatches) {
      log(`Found PR number ${match[1]} in commit ${commit.sha} by extracting from message: "${message}"`);
      prNumbers.push(Number.parseInt(match[1]!, 10));
    }
  }

  return [...new Set(prNumbers)];
}
