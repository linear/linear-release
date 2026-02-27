import {
  extractLinearIssueIdentifiersForCommit,
  extractPullRequestNumbersForCommit,
  extractRevertedIssueIdentifiersForCommit,
} from "./extractors";
import { log } from "./log";
import { CommitContext, DebugSink, IssueReference, PullRequestSource } from "./types";

/**
 * Scan commits and produce added/reverted issue references using last-write-wins.
 * Expects commits in chronological order (oldest first). The caller must reverse
 * git log output before passing it here.
 */
export function scanCommits(
  commits: CommitContext[],
  includePaths: string[] | null,
): {
  issueReferences: IssueReference[];
  revertedIssueReferences: IssueReference[];
  prNumbers: number[];
  debugSink: DebugSink;
} {
  const lastAction = new Map<string, "added" | "reverted">();
  const addedRefs = new Map<string, IssueReference>();
  const revertedRefs = new Map<string, IssueReference>();

  const prNumbersSet = new Set<number>();
  const debugSink: DebugSink = {
    inspectedShas: [],
    issues: {},
    revertedIssues: {},
    pullRequests: [],
    includePaths,
  };

  for (const commit of commits) {
    debugSink.inspectedShas.push(commit.sha);

    for (const { identifier, source } of extractRevertedIssueIdentifiersForCommit(commit)) {
      if (!debugSink.revertedIssues[identifier]) {
        debugSink.revertedIssues[identifier] = [];
      }
      debugSink.revertedIssues[identifier].push({
        sha: commit.sha,
        source,
        value: source === "branch_name" ? (commit.branchName ?? "") : (commit.message ?? ""),
      });

      lastAction.set(identifier, "reverted");
      revertedRefs.set(identifier, { identifier, commitSha: commit.sha });
      log(`Detected reverted issue key ${identifier} from commit ${commit.sha}`);
    }

    for (const { identifier, source } of extractLinearIssueIdentifiersForCommit(commit)) {
      if (!debugSink.issues[identifier]) {
        debugSink.issues[identifier] = [];
      }
      debugSink.issues[identifier].push({
        sha: commit.sha,
        source,
        value: source === "branch_name" ? (commit.branchName ?? "") : (commit.message ?? ""),
      });

      lastAction.set(identifier, "added");
      addedRefs.set(identifier, { identifier, commitSha: commit.sha });
      log(
        `Detected issue key ${identifier} from ${source === "branch_name" ? `branch "${commit.branchName}"` : `message "${commit.message}"`}`,
      );
    }

    for (const prNumber of extractPullRequestNumbersForCommit(commit)) {
      if (!prNumbersSet.has(prNumber)) {
        prNumbersSet.add(prNumber);
        const prSource: PullRequestSource = {
          sha: commit.sha,
          number: prNumber,
          value: commit.message ?? "",
        };
        debugSink.pullRequests.push(prSource);
        log(`Found pull request number ${prNumber} in commit ${commit.sha}`);
      }
    }
  }

  const issueReferences: IssueReference[] = [];
  const revertedIssueReferences: IssueReference[] = [];
  for (const [identifier, action] of lastAction) {
    if (action === "added") {
      issueReferences.push(addedRefs.get(identifier)!);
    } else {
      revertedIssueReferences.push(revertedRefs.get(identifier)!);
    }
  }

  return {
    issueReferences,
    revertedIssueReferences,
    prNumbers: Array.from(prNumbersSet),
    debugSink,
  };
}
