import { LinearClient, LinearClientOptions } from "@linear/sdk";
import { commitExists, getCommitContextsBetweenShas, getCurrentGitInfo, getRepoInfo } from "./git";
import { extractLinearIssueIdentifiersForCommit, extractPullRequestNumbersForCommit } from "./extractors";
import {
  Release,
  AccessKeyLatestReleaseResponse,
  AccessKeyPipelineSettingsResponse,
  AccessKeySyncReleaseResponse,
  AccessKeyCompleteReleaseResponse,
  AccessKeyUpdateByPipelineResponse,
  CommitContext,
  DebugSink,
  IssueSource,
  PullRequestSource,
  RepoInfo,
} from "./types";
import { parseCLIArgs } from "./args";
import { log, setStderr } from "./log";
import { pluralize } from "./util";
import { buildUserAgent } from "./user-agent";

declare const CLI_VERSION: string;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(CLI_VERSION);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Linear Release CLI v${CLI_VERSION}

Integrate CI/CD pipelines with Linear releases.

Usage: linear-release <command> [options]

Commands:
  sync      Create or update a release by scanning commits (default)
  complete  Mark the current release as complete
  update    Update the deployment stage of a release

Options:
  --name=<name>              Custom release name (sync only)
  --release-version=<version>  Release version identifier
  --stage=<stage>            Deployment stage (required for update)
  --include-paths=<paths>    Filter commits by file paths (comma-separated globs)
  --json                     Output result as JSON
  -v, --version              Show version number
  -h, --help                 Show this help message

Environment:
  LINEAR_ACCESS_KEY          Pipeline access key (required)

Examples:
  linear-release sync
  linear-release sync --name="Release 1.2.0" --release-version="1.2.0"
  linear-release complete
  linear-release update --stage=production
  linear-release sync --include-paths="apps/web/**,packages/**"
`);
  process.exit(0);
}

const accessKey: string = process.env.LINEAR_ACCESS_KEY || "";

if (!accessKey) {
  console.error("Error: LINEAR_ACCESS_KEY environment variable must be set");
  process.exit(1);
}

let parsedArgs: ReturnType<typeof parseCLIArgs>;
try {
  parsedArgs = parseCLIArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  console.error("Run linear-release --help for usage information.");
  process.exit(1);
}
const { command, releaseName, releaseVersion, stageName, includePaths, jsonOutput } = parsedArgs;
if (jsonOutput) {
  setStderr(true);
}

const logEnvironmentSummary = () => {
  log("Using access key authentication");

  if (releaseName) {
    log(`Using custom release name: ${releaseName}`);
  }
  if (releaseVersion) {
    log(`Using custom release version: ${releaseVersion}`);
  }

  log(`Running in ${process.env.NODE_ENV === "development" ? "development" : "production"} mode`);
};

const getDevApiUrl = () => {
  return "http://localhost:8090/graphql";
};

const options: LinearClientOptions = {
  ...{ apiKey: accessKey },
  ...(process.env.NODE_ENV === "development"
    ? {
        apiUrl: getDevApiUrl(),
      }
    : {}),
};

const linearClient = new LinearClient(options);
linearClient.client.setHeader("User-Agent", buildUserAgent());

function scanCommits(
  commits: CommitContext[],
  includePaths: string[] | null,
): {
  issueIdentifiers: string[];
  prNumbers: number[];
  debugSink: DebugSink;
} {
  const seen = new Set<string>();
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

      seen.add(key);
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

      seen.add(key);
      log(`Detected issue key ${key} from commit message "${commit.message ?? ""}"`);
    }

    // Extract PR numbers from commit message
    const prNumbers = extractPullRequestNumbersForCommit(commit);
    for (const prNumber of prNumbers) {
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
    issueIdentifiers: Array.from(seen),
    prNumbers: Array.from(prNumbersSet),
    debugSink,
  };
}

async function syncCommand(): Promise<{
  release: { id: string; name: string; version?: string; url?: string };
} | null> {
  logEnvironmentSummary();

  // Fetch pipeline settings from API
  const pipelineSettings = await getPipelineSettings();

  // CLI --include-paths takes precedence over API includePathPatterns
  let effectiveIncludePaths: string[] | null;
  if (includePaths && includePaths.length > 0) {
    effectiveIncludePaths = includePaths;
    log(`Using CLI --include-paths: ${JSON.stringify(effectiveIncludePaths)}`);
    if (pipelineSettings.includePathPatterns.length > 0) {
      log(
        `Note: Pipeline has includePathPatterns configured ${JSON.stringify(
          pipelineSettings.includePathPatterns,
        )}, but CLI --include-paths takes precedence`,
      );
    }
  } else if (pipelineSettings.includePathPatterns.length > 0) {
    effectiveIncludePaths = pipelineSettings.includePathPatterns;
    log(`Using pipeline includePathPatterns: ${JSON.stringify(effectiveIncludePaths)}`);
  } else {
    effectiveIncludePaths = null;
  }

  const currentCommit = await getCurrentGitInfo();

  if (!currentCommit.commit) {
    throw new Error("Could not get current commit");
  }

  let latestSha = await getLatestSha();
  let inspectingOnlyCurrentCommit = false;

  if (!commitExists(latestSha)) {
    log(
      `Could not find sha ${latestSha} in the git history (it may be on a different branch or the repository history was not fully fetched)`,
    );
    inspectingOnlyCurrentCommit = true;
    latestSha = currentCommit.commit;
  }

  const commits = getCommitContextsBetweenShas(latestSha, currentCommit.commit, {
    includePaths: effectiveIncludePaths,
  });

  if (inspectingOnlyCurrentCommit) {
    if (commits.length === 0) {
      if (effectiveIncludePaths?.length) {
        log(`Current commit (${currentCommit.commit}) does not match the path filter`);
      } else {
        log(`Current commit (${currentCommit.commit}) could not be inspected`);
      }
    } else {
      log(`Inspecting current commit (${currentCommit.commit})`);
    }
  } else {
    log(
      `Found ${commits.length} ${pluralize(commits.length, "commit")} between ${latestSha} and ${currentCommit.commit}`,
    );
  }

  if (commits.length === 0) {
    const reason = effectiveIncludePaths?.length
      ? `matching ${JSON.stringify(effectiveIncludePaths)}`
      : "in the computed range";
    log(`No commits found ${reason}. Skipping release creation.`);
    return null;
  }

  const { issueIdentifiers, prNumbers, debugSink } = scanCommits(commits, effectiveIncludePaths);

  log(`Debug sink: ${JSON.stringify(debugSink, null, 2)}`);

  if (issueIdentifiers.length === 0) {
    log("No issue keys found");
  } else {
    log(`Retrieved issue keys: ${issueIdentifiers.join(", ")}`);
  }

  const repoInfo = getRepoInfo();

  const release = await syncRelease(issueIdentifiers, prNumbers, repoInfo, debugSink);
  log(
    `Issues [${issueIdentifiers.join(", ")}] and pull requests [${prNumbers.join(
      ", ",
    )}] have been added to release ${release.name}`,
  );

  log("Finished");

  return { release: { id: release.id, name: release.name, version: release.version, url: release.url } };
}

async function completeCommand(): Promise<{
  release: { id: string; name: string; version?: string; url?: string };
} | null> {
  logEnvironmentSummary();

  const currentCommit = await getCurrentGitInfo();
  const commitSha = currentCommit.commit;

  const result = await completeRelease({
    version: releaseVersion,
    commitSha,
  });
  if (result.success) {
    log(`Completed release ${result.release?.name ?? "(unknown)"}`);
  } else {
    throw new Error("Failed to complete release");
  }

  log("Finished");

  return result.release
    ? {
        release: {
          id: result.release.id,
          name: result.release.name,
          version: result.release.version,
          url: result.release.url,
        },
      }
    : null;
}

async function updateCommand(): Promise<{
  release: { id: string; name: string; version?: string; url?: string };
} | null> {
  logEnvironmentSummary();

  if (!stageName) {
    throw new Error("--stage=<stage-name> is required for the update command");
  }

  let result;
  try {
    result = await updateReleaseByPipeline({
      stage: stageName,
      version: releaseVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to update release: ${message}`);
  }

  if (result.success) {
    log(`Updated release "${result.release?.name}" to stage "${result.release?.stageName}"`);
  } else {
    throw new Error("Failed to update release");
  }

  log("Finished");

  return result.release
    ? {
        release: {
          id: result.release.id,
          name: result.release.name,
          version: result.release.version,
          url: result.release.url,
        },
      }
    : null;
}

async function getLatestRelease(): Promise<Release | null> {
  const response = (await linearClient.client.rawRequest(
    `
    query latestReleaseByAccessKey {
      latestReleaseByAccessKey {
        id
        name
        createdAt
        commitSha
      }
    }
  `,
  )) as AccessKeyLatestReleaseResponse;

  return response.data.latestReleaseByAccessKey;
}

async function getLatestSha(): Promise<string> {
  const latestRelease = await getLatestRelease();
  const latestSha = latestRelease?.commitSha;
  if (latestSha) {
    return latestSha;
  }

  // If we can't find a release or the latest release has no commit SHA, we will only inspect the current commit
  if (!latestRelease) {
    log("Could not find latest release, assuming it's the first release, will only inspect the current commit");
  } else if (!latestRelease.commitSha) {
    log("Latest release has no commit SHA, will only inspect the current commit");
  }
  const currentSha = await getCurrentGitInfo().commit;
  if (!currentSha) {
    throw new Error("Could not get current commit");
  }
  return currentSha;
}

async function getPipelineSettings(): Promise<{ includePathPatterns: string[] }> {
  const response = (await linearClient.client.rawRequest(
    `
    query pipelineSettingsByAccessKey {
      releasePipelineByAccessKey {
        includePathPatterns
      }
    }
  `,
  )) as AccessKeyPipelineSettingsResponse;

  return {
    includePathPatterns: response.data.releasePipelineByAccessKey.includePathPatterns ?? [],
  };
}

async function syncRelease(
  issueIdentifiers: string[],
  prNumbers: number[],
  repoInfo: RepoInfo | null,
  debugSink: DebugSink,
): Promise<Release> {
  const currentSha = await getCurrentGitInfo().commit;
  if (!currentSha) {
    throw new Error("Could not get current commit");
  }

  if (prNumbers.length > 0 && !repoInfo) {
    throw new Error("Repository info is required to sync a release with pull request references");
  }

  const { owner, name } = repoInfo ?? {};

  const response = (await linearClient.client.rawRequest(
    `
    mutation syncReleaseByAccessKey($input: ReleaseSyncInputBase!) {
      releaseSyncByAccessKey(input: $input) {
        success
        release {
          id
          name
          url
          version
          commitSha
          createdAt
        }
      }
    }
    `,
    {
      input: {
        name: releaseName,
        version: releaseVersion,
        commitSha: currentSha,
        issueIdentifiers,
        pullRequestReferences: prNumbers.map((number) => ({
          repositoryOwner: owner,
          repositoryName: name,
          number,
        })),
        debugSink,
      },
    },
  )) as AccessKeySyncReleaseResponse;

  if (!response.data?.releaseSyncByAccessKey?.release) {
    throw new Error("Failed to sync release");
  }

  return response.data.releaseSyncByAccessKey.release;
}

async function completeRelease(options: {
  version?: string | null;
  commitSha?: string | null;
}): Promise<{ success: boolean; release: { id: string; name: string; version?: string; url?: string } | null }> {
  const { version, commitSha } = options;

  const response = (await linearClient.client.rawRequest(
    `
    mutation releaseCompleteByAccessKey($input: ReleaseCompleteInputBase!) {
      releaseCompleteByAccessKey(input: $input) {
        success
        release {
          id
          name
          version
          url
        }
      }
    }
    `,
    {
      input: {
        version,
        commitSha,
      },
    },
  )) as AccessKeyCompleteReleaseResponse;

  return response.data.releaseCompleteByAccessKey;
}

async function updateReleaseByPipeline(options: { stage?: string; version?: string | null }): Promise<{
  success: boolean;
  release: { id: string; name: string; version?: string; url?: string; stageName: string } | null;
}> {
  const { stage, version } = options;
  const versionInput = version ? `, version: "${version}"` : "";
  const stageInput = stage ? `, stage: "${stage}"` : "";

  const inputParts = [versionInput, stageInput]
    .filter(Boolean)
    .map((s) => s.slice(2))
    .join(", ");
  const response = (await linearClient.client.rawRequest(
    `
    mutation {
      releaseUpdateByPipelineByAccessKey(input: { ${inputParts} }) {
        success
        release {
          id
          name
          version
          url
          stage {
            name
          }
        }
      }
    }
    `,
  )) as AccessKeyUpdateByPipelineResponse;

  const result = response.data.releaseUpdateByPipelineByAccessKey;
  return {
    success: result.success,
    release: result.release
      ? {
          id: result.release.id,
          name: result.release.name,
          version: result.release.version,
          url: result.release.url,
          stageName: result.release.stage?.name ?? "(unknown)",
        }
      : null,
  };
}

async function main() {
  let result: { release: { id: string; name: string; version?: string; url?: string } } | null = null;

  switch (command) {
    case "sync":
      result = await syncCommand();
      break;
    case "complete":
      result = await completeCommand();
      break;
    case "update":
      result = await updateCommand();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Available commands: sync, complete, update");
      process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result ?? { release: null }));
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
