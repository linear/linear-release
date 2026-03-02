import { extractLinearIssueIdentifiersForCommit, extractPullRequestNumbersForCommit } from "./extractors";
import { log } from "./log";
import { CommitContext, DebugSink, IssueReference, IssueSource, PullRequestSource } from "./types";

export function scanCommits(
  commits: CommitContext[],
  includePaths: string[] | null,
): {
  issueReferences: IssueReference[];
  prNumbers: number[];
  debugSink: DebugSink;
} {
  const seen = new Map<string, IssueReference>();
  const prNumbersSet = new Set<number>();
  const debugSink: DebugSink = {
    inspectedShas: [],
    issues: {},
    pullRequests: [],
    includePaths,
  };

  for (const commit of commits) {
    debugSink.inspectedShas.push(commit.sha);

    const fromBranch = extractLinearIssueIdentifiersForCommit({
      sha: commit.sha,
      branchName: commit.branchName,
      message: null,
    });

    for (const key of fromBranch) {
      if (!debugSink.issues[key]) {
        debugSink.issues[key] = [];
      }

      const source: IssueSource = {
        sha: commit.sha,
        source: "branch_name",
        value: commit.branchName ?? "",
      };
      debugSink.issues[key].push(source);

      if (seen.has(key)) {
        continue;
      }

      seen.set(key, { identifier: key, commitSha: commit.sha });
      log(`Detected issue key ${key} from branch name "${commit.branchName ?? ""}"`);
    }

    const fromMessage = extractLinearIssueIdentifiersForCommit({
      sha: commit.sha,
      branchName: null,
      message: commit.message,
    });

    for (const key of fromMessage) {
      if (!debugSink.issues[key]) {
        debugSink.issues[key] = [];
      }

      const source: IssueSource = {
        sha: commit.sha,
        source: "commit_message",
        value: commit.message ?? "",
      };
      debugSink.issues[key].push(source);

      if (seen.has(key)) {
        continue;
      }

      seen.set(key, { identifier: key, commitSha: commit.sha });
      log(`Detected issue key ${key} from commit message "${commit.message ?? ""}"`);
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

  return {
    issueReferences: Array.from(seen.values()),
    prNumbers: Array.from(prNumbersSet),
    debugSink,
  };
}
