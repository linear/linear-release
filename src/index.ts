import { LinearClient, LinearClientOptions } from "@linear/sdk";
import {
  assertGitAvailable,
  commitExists,
  ensureCommitAvailable,
  getCommitContextsBetweenShas,
  getCurrentGitInfo,
  getRepoInfo,
  isAncestor,
  resolveFirstSyncBoundary,
} from "./git";
import { findBaseSha } from "./base-sha";
import { scanCommits } from "./scan";
import {
  Release,
  AccessKeyPipelineSettingsResponse,
  AccessKeyRecentReleasesResponse,
  AccessKeySyncReleaseResponse,
  AccessKeyCompleteReleaseResponse,
  AccessKeyUpdateByPipelineResponse,
  DebugSink,
  IssueReference,
  RepoInfo,
} from "./types";
import { getCLIWarnings, parseCLIArgs } from "./args";
import { error, info, setJsonMode, setLogLevel, setStderr, verbose, warn } from "./log";
import { pluralize } from "./util";
import { buildUserAgent } from "./user-agent";
import { withRetry } from "./retry";

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
  --name=<name>              Custom release name
  --release-version=<version>  Release version identifier
  --stage=<stage>            Deployment stage (required for update)
  --include-paths=<paths>    Filter commits by file paths (comma-separated globs)
  --commit-prefix-pattern=<regex>  Detect issue IDs via a regex prefix (e.g. ^\\[(.+?)\\] for [LIN-123])
  --timeout=<seconds>        Abort if the operation exceeds this duration (default: 60)
  --json                     Output result as JSON (logs emitted as JSON Lines on stderr)
  --quiet                    Suppress info-level output (warnings and errors still printed)
  --verbose                  Print detailed progress including debug diagnostics
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
  linear-release sync --commit-prefix-pattern='^\\[(.+?)\\]'
`);
  process.exit(0);
}

const accessKey: string = process.env.LINEAR_ACCESS_KEY || "";

if (!accessKey) {
  error("LINEAR_ACCESS_KEY environment variable must be set");
  process.exit(1);
}

let parsedArgs: ReturnType<typeof parseCLIArgs>;
try {
  parsedArgs = parseCLIArgs(process.argv.slice(2));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  error(`${message} (run linear-release --help for usage)`);
  process.exit(1);
}
const {
  command,
  releaseName,
  releaseVersion,
  stageName,
  includePaths,
  jsonOutput,
  timeoutSeconds,
  logLevel,
  commitPrefixPattern,
} = parsedArgs;
const cliWarnings = getCLIWarnings(parsedArgs);
setLogLevel(logLevel);
if (jsonOutput) {
  setStderr(true);
  setJsonMode(true);
}

function formatVersion(release: { version?: string } | null | undefined): string {
  return release?.version ? `version: ${release.version}` : "no version set";
}

const logEnvironmentSummary = () => {
  info(`linear-release v${CLI_VERSION}`);
  if (releaseName) {
    info(`Using custom release name: ${releaseName}`);
  }
  if (releaseVersion) {
    info(`Using custom release version: ${releaseVersion}`);
  }
  for (const w of cliWarnings) {
    warn(w);
  }
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

async function apiRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return withRetry(() => linearClient.client.rawRequest(query, variables)) as Promise<T>;
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
    verbose(`Using CLI --include-paths: ${JSON.stringify(effectiveIncludePaths)}`);
    if (pipelineSettings.includePathPatterns.length > 0) {
      verbose(
        `Note: Pipeline has includePathPatterns configured ${JSON.stringify(
          pipelineSettings.includePathPatterns,
        )}, but CLI --include-paths takes precedence`,
      );
    }
  } else if (pipelineSettings.includePathPatterns.length > 0) {
    effectiveIncludePaths = pipelineSettings.includePathPatterns;
    verbose(`Using pipeline includePathPatterns: ${JSON.stringify(effectiveIncludePaths)}`);
  } else {
    effectiveIncludePaths = null;
  }

  if (commitPrefixPattern) {
    verbose(`Using CLI --commit-prefix-pattern: ${commitPrefixPattern}`);
  }

  const currentCommit = await getCurrentGitInfo();

  if (!currentCommit.commit) {
    throw new Error("Could not get current commit");
  }

  let latestSha = await getLatestSha();
  let inspectingOnlyCurrentCommit = false;

  try {
    ensureCommitAvailable(latestSha);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `Could not make sha ${latestSha} available in local git history; falling back to current commit only. ${message}`,
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
        verbose(`Current commit (${currentCommit.commit}) does not match the path filter`);
      } else {
        verbose(`Current commit (${currentCommit.commit}) could not be inspected`);
      }
    } else {
      verbose(`Inspecting current commit (${currentCommit.commit})`);
    }
  } else {
    info(
      `Found ${commits.length} ${pluralize(commits.length, "commit")} between ${latestSha.slice(0, 7)} and ${currentCommit.commit.slice(0, 7)}`,
    );
  }

  if (commits.length === 0) {
    const reason = effectiveIncludePaths?.length
      ? `matching ${JSON.stringify(effectiveIncludePaths)}`
      : "in the computed range";
    info(`No commits found ${reason}. Skipping release creation.`);
    return null;
  }

  // git log returns newest-first; scanCommits needs chronological (oldest-first) for last-write-wins
  commits.reverse();

  const { issueReferences, revertedIssueReferences, prNumbers, debugSink } = scanCommits(
    commits,
    effectiveIncludePaths,
    { commitPrefixPattern },
  );

  verbose(`Debug sink: ${JSON.stringify(debugSink, null, 2)}`);

  if (revertedIssueReferences.length > 0) {
    info(`Reverted issue keys: ${revertedIssueReferences.map((f) => f.identifier).join(", ")}`);
  }

  const repoInfo = getRepoInfo();

  const release = await syncRelease(issueReferences, revertedIssueReferences, prNumbers, repoInfo, debugSink);
  const issueIds = issueReferences.map((f) => f.identifier);
  const parts: string[] = [];
  if (issueIds.length > 0) parts.push(`issues [${issueIds.join(", ")}]`);
  if (prNumbers.length > 0) parts.push(`pull requests [${prNumbers.map((n) => `#${n}`).join(", ")}]`);
  const attached = parts.length > 0 ? parts.join(", ") : "no new issues or pull requests";
  info(`Synced to release ${release.name} (${formatVersion(release)}): ${attached}`);

  return {
    release: {
      id: release.id,
      name: release.name,
      version: release.version,
      url: release.url,
    },
  };
}

async function completeCommand(): Promise<{
  release: { id: string; name: string; version?: string; url?: string };
} | null> {
  logEnvironmentSummary();

  const currentCommit = await getCurrentGitInfo();
  const commitSha = currentCommit.commit;

  const result = await completeRelease({
    name: releaseName,
    version: releaseVersion,
    commitSha,
  });
  if (result.success) {
    info(`Completed release ${result.release?.name ?? "(unknown)"} (${formatVersion(result.release)})`);
  } else {
    throw new Error("Failed to complete release");
  }

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
      name: releaseName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to update release: ${message}`);
  }

  if (result.success) {
    info(
      `Updated release ${result.release?.name ?? "(unknown)"} (${formatVersion(result.release)}) to stage ${result.release?.stageName}`,
    );
  } else {
    throw new Error("Failed to update release");
  }

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

async function getRecentReleases(): Promise<Release[]> {
  // Pin the limit explicitly rather than relying on the server default — the
  // walk's correctness depends on the right ancestor being in this page, so
  // the cap is a meaningful contract, not an implementation detail.
  const response = await apiRequest<AccessKeyRecentReleasesResponse>(
    `
    query recentReleasesByAccessKey($limit: Int) {
      recentReleasesByAccessKey(limit: $limit) {
        id
        name
        createdAt
        commitSha
      }
    }
  `,
    { limit: 20 },
  );

  return response.data.recentReleasesByAccessKey;
}

async function getLatestSha(): Promise<string> {
  const currentSha = getCurrentGitInfo().commit;
  if (!currentSha) {
    throw new Error("Could not get current commit");
  }

  const candidates = await getRecentReleases();
  const result = findBaseSha(candidates, currentSha, { isAncestor, commitExists, ensureCommitAvailable });
  if (result.kind === "found") {
    return result.sha;
  }

  if (candidates.length === 0) {
    verbose("No recent releases found; assuming first sync");
  } else {
    // The candidate list came back non-empty but no entry is reachable from
    // HEAD. This usually means orphaned/stale commitShas, but can also mean
    // the actual previous release is older than the recent-releases page —
    // in which case we'll silently under-cover. Surface it at warn level so
    // it's visible in CI logs.
    // Don't promise "current commit only" here — the actual fallback is
    // resolveFirstSyncBoundary, which uses HEAD^1 when HEAD is a merge commit.
    // The follow-up verbose lines below print the boundary that was chosen.
    warn(
      `No recent release is an ancestor of ${currentSha} (${candidates.length} candidate${
        candidates.length === 1 ? "" : "s"
      } considered); falling back to the first-sync scan boundary`,
    );
  }
  // For a merge HEAD the issue keys live on HEAD^2's branch, not on HEAD
  // itself, so HEAD-only would miss them. Non-merge HEAD carries its own key.
  const boundary = resolveFirstSyncBoundary(currentSha);
  if (boundary !== currentSha) {
    verbose(`Merge HEAD: using HEAD^1 (${boundary}) as the scan boundary`);
  } else {
    verbose("Inspecting current commit only");
  }
  return boundary;
}

async function getPipelineSettings(): Promise<{
  includePathPatterns: string[];
}> {
  const response = await apiRequest<AccessKeyPipelineSettingsResponse>(
    `
    query pipelineSettingsByAccessKey {
      releasePipelineByAccessKey {
        includePathPatterns
      }
    }
  `,
  );

  return {
    includePathPatterns: response.data.releasePipelineByAccessKey.includePathPatterns ?? [],
  };
}

async function syncRelease(
  issueReferences: IssueReference[],
  revertedIssueReferences: IssueReference[],
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

  const response = await apiRequest<AccessKeySyncReleaseResponse>(
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
        issueReferences,
        revertedIssueReferences: revertedIssueReferences.length > 0 ? revertedIssueReferences : undefined,
        pullRequestReferences: prNumbers.map((number) => ({
          repositoryOwner: owner,
          repositoryName: name,
          number,
        })),
        repository: repoInfo
          ? {
              owner: repoInfo.owner,
              name: repoInfo.name,
              provider: repoInfo.provider,
              url: repoInfo.url,
            }
          : undefined,
        debugSink,
      },
    },
  );

  if (!response.data?.releaseSyncByAccessKey?.release) {
    throw new Error("Failed to sync release");
  }

  return response.data.releaseSyncByAccessKey.release;
}

async function completeRelease(options: {
  name?: string | null;
  version?: string | null;
  commitSha?: string | null;
}): Promise<{
  success: boolean;
  release: { id: string; name: string; version?: string; url?: string } | null;
}> {
  const { name, version, commitSha } = options;

  const response = await apiRequest<AccessKeyCompleteReleaseResponse>(
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
        name,
        version,
        commitSha,
      },
    },
  );

  return response.data.releaseCompleteByAccessKey;
}

async function updateReleaseByPipeline(options: {
  stage?: string;
  version?: string | null;
  name?: string | null;
}): Promise<{
  success: boolean;
  release: {
    id: string;
    name: string;
    version?: string;
    url?: string;
    stageName: string;
  } | null;
}> {
  const { stage, version, name } = options;
  const versionInput = version ? `, version: "${version}"` : "";
  const stageInput = stage ? `, stage: "${stage}"` : "";
  const nameInput = name ? `, name: "${name}"` : "";

  const inputParts = [versionInput, stageInput, nameInput]
    .filter(Boolean)
    .map((s) => s.slice(2))
    .join(", ");
  const response = await apiRequest<AccessKeyUpdateByPipelineResponse>(
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
  );

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
  assertGitAvailable();

  let result: {
    release: { id: string; name: string; version?: string; url?: string };
  } | null = null;

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
      error(`Unknown command "${command}" (available: sync, complete, update)`);
      process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result ?? { release: null }));
  }
}

const timeoutMs = timeoutSeconds * 1000;
const timeout = setTimeout(() => {
  error(
    `Error: Operation timed out after ${timeoutSeconds}s. This may indicate a large repository or slow network. Use --timeout=<seconds> to increase the limit.`,
  );
  process.exit(1);
}, timeoutMs);
timeout.unref();

main()
  .catch((e) => {
    error(`Error: ${e.message}`);
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(timeout);
  });
