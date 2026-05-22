import { readFileSync } from "node:fs";
import { LinearClient, LinearClientOptions } from "@linear/sdk";
import {
  assertGitAvailable,
  ensureCommitAvailable,
  getCommitContextsBetweenShas,
  getCurrentGitInfo,
  getRepoInfo,
  resolveCommitRef,
  verifyAncestorReachable,
} from "./git";
import { assertBaseRefIsAncestor, ScanBase, selectAutomaticScanBase, shouldCreateReleaseForScan } from "./scan-base";
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
import {
  getCLIWarnings,
  parseCLIArgs,
  ReleaseContentSource,
  ReleaseDocumentSpec,
  ReleaseLink,
  ReleaseNoteSpec,
} from "./args";
import { error, info, setJsonMode, setLogLevel, setStderr, verbose, warn } from "./log";
import { pluralize } from "./util";
import { buildUserAgent } from "./user-agent";
import { withRetry } from "./retry";
import { getCliVersion } from "./version";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(getCliVersion());
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Linear Release CLI v${getCliVersion()}

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
  --include-subjects=<regex> Filter commits whose subject (first line) matches the regex
  --link <URL|Label=URL>       Add a link to the targeted release (repeatable)
  --document <Title=content> Attach a document to the release (repeatable, Title required)
  --document-file <[Title=]path> Attach a document from a file (title inferred from basename if omitted; "-" for stdin requires Title=-; repeatable)
  --release-notes <content>  Set the release notes covering this release (last-wins)
  --release-notes-file <path> Set release notes from a file ("-" for stdin; last-wins)
  --base-ref=<ref>           Override sync scan base (exclusive; scans <ref>..HEAD)
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
  linear-release sync --include-subjects="[A-Z]{2,}-[0-9]+"
  linear-release sync --link "https://ci.example.com/run/123"
  linear-release sync --link "Pipeline=https://ci.example.com/run/123"
  linear-release sync --document-file "Changelog=./CHANGELOG.md"
  linear-release sync --document-file ./CHANGELOG.md
  linear-release sync --release-notes-file ./release-notes.md
  linear-release sync --base-ref=<last-released-ref> --include-paths="apps/web/**"
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
  baseRef,
  includePaths,
  includeSubjects,
  links,
  documents: documentSpecs,
  releaseNotes: releaseNotesSpec,
  jsonOutput,
  timeoutSeconds,
  logLevel,
} = parsedArgs;
const cliWarnings = getCLIWarnings(parsedArgs);

type ReleaseDocument = { title: string; content: string };
type ReleaseNotes = { content: string; title?: string };

let stdinContent: string | undefined;
function readStdinOnce(flag: string): string {
  if (stdinContent === undefined) {
    stdinContent = readFileSync(0, "utf8");
  } else {
    throw new Error(
      `${flag} cannot consume stdin: another flag already read from stdin. Use "-" with at most one --document-file or --release-notes-file.`,
    );
  }
  return stdinContent;
}

function resolveContent(source: ReleaseContentSource, flag: string): string {
  if (source.kind === "inline") {
    return source.content;
  }
  if (source.path === "-") {
    return readStdinOnce(flag);
  }
  try {
    return readFileSync(source.path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${flag} file "${source.path}": ${message}`);
  }
}

function resolveDocuments(specs: ReleaseDocumentSpec[]): ReleaseDocument[] {
  const flag = "--document-file";
  return specs.map((spec) => ({ title: spec.title, content: resolveContent(spec.source, flag) }));
}

function resolveReleaseNotes(spec: ReleaseNoteSpec | undefined): ReleaseNotes | undefined {
  if (!spec) return undefined;
  return { content: resolveContent(spec.source, "--release-notes-file") };
}

let documents: ReleaseDocument[];
let releaseNotes: ReleaseNotes | undefined;
try {
  documents = resolveDocuments(documentSpecs);
  releaseNotes = resolveReleaseNotes(releaseNotesSpec);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  error(`${message} (run linear-release --help for usage)`);
  process.exit(1);
}
setLogLevel(logLevel);
if (jsonOutput) {
  setStderr(true);
  setJsonMode(true);
}

function formatVersion(release: { version?: string } | null | undefined): string {
  return release?.version ? `version: ${release.version}` : "no version set";
}

function formatLinkForLog(link: ReleaseLink): string {
  if (link.label) {
    return link.label;
  }

  try {
    const { hostname } = new URL(link.url);
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "unlabeled";
  }
}

function formatLinkSummary(linksToFormat: ReleaseLink[]): string {
  return linksToFormat.length > 0 ? `, links [${linksToFormat.map(formatLinkForLog).join(", ")}]` : "";
}

function formatDocumentsSummary(docs: ReleaseDocument[]): string {
  return docs.length > 0 ? `, documents [${docs.map((d) => d.title).join(", ")}]` : "";
}

function formatReleaseNotesSummary(notes: ReleaseNotes | undefined): string {
  return notes ? `, release notes (${notes.content.length} chars)` : "";
}

const logEnvironmentSummary = () => {
  info(`linear-release v${getCliVersion()}`);
  if (releaseName) {
    info(`Using custom release name: ${releaseName}`);
  }
  if (releaseVersion) {
    info(`Using custom release version: ${releaseVersion}`);
  }
  for (const warningMessage of cliWarnings) {
    warn(warningMessage);
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

  const currentCommit = await getCurrentGitInfo();

  if (!currentCommit.commit) {
    throw new Error("Could not get current commit");
  }

  const recentReleases = await getRecentReleases();
  const scanBase = getScanBase(recentReleases, currentCommit.commit);
  let latestSha = scanBase.sha;
  let inspectingOnlyCurrentCommit = false;

  if (scanBase.kind === "base-ref") {
    assertBaseRefIsAncestor(scanBase.ref, latestSha, currentCommit.commit, { verifyAncestorReachable });
    const includePathSummary = effectiveIncludePaths?.length
      ? ` with include paths: ${effectiveIncludePaths.join(", ")}`
      : "";
    info(`Scanning ${latestSha.slice(0, 7)}..${currentCommit.commit.slice(0, 7)}${includePathSummary}`);
  } else {
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
  }

  const commits = getCommitContextsBetweenShas(latestSha, currentCommit.commit, {
    includePaths: effectiveIncludePaths,
    inspectSingleCommit: scanBase.kind !== "base-ref",
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
    const commitNoun = effectiveIncludePaths?.length ? "matching commit" : "commit";
    if (scanBase.kind === "base-ref") {
      info(`Found ${commits.length} ${pluralize(commits.length, commitNoun)} in requested range`);
    } else if (latestSha === currentCommit.commit) {
      info(
        `Inspected current commit ${currentCommit.commit.slice(0, 7)}; found ${commits.length} ${pluralize(commits.length, commitNoun)}`,
      );
    } else {
      info(
        `Found ${commits.length} ${pluralize(commits.length, commitNoun)} between ${latestSha.slice(0, 7)} and ${currentCommit.commit.slice(0, 7)}`,
      );
    }
  }

  if (commits.length === 0) {
    const reason = effectiveIncludePaths?.length
      ? `No matching commits found for include paths: ${effectiveIncludePaths.join(", ")}`
      : scanBase.kind === "base-ref"
        ? "No commits found in the requested range"
        : "No commits found in the computed range";
    if (!shouldCreateReleaseForScan(commits.length, scanBase)) {
      info(`${reason}. Skipping release creation.`);
      return null;
    }
    info(`${reason}. Syncing release anyway because --base-ref was provided to establish the baseline.`);
  }

  // git log returns newest-first; scanCommits needs chronological (oldest-first) for last-write-wins
  commits.reverse();

  const { issueReferences, revertedIssueReferences, prNumbers, debugSink } = scanCommits(commits, {
    includePaths: effectiveIncludePaths,
    includeSubjects,
  });

  verbose(`Debug sink: ${JSON.stringify(debugSink, null, 2)}`);

  if (revertedIssueReferences.length > 0) {
    info(`Reverted issue keys: ${revertedIssueReferences.map((f) => f.identifier).join(", ")}`);
  }

  const repoInfo = getRepoInfo();

  const release = await syncRelease(
    issueReferences,
    revertedIssueReferences,
    prNumbers,
    repoInfo,
    debugSink,
    links,
    documents,
    releaseNotes,
  );
  const issueIds = issueReferences.map((f) => f.identifier);
  const parts: string[] = [];
  if (issueIds.length > 0) parts.push(`issues [${issueIds.join(", ")}]`);
  if (prNumbers.length > 0) parts.push(`pull requests [${prNumbers.map((n) => `#${n}`).join(", ")}]`);
  const scanned = parts.length > 0 ? parts.join(", ") : "no new issues or pull requests";
  info(
    `Synced to release ${release.name} (${formatVersion(release)}): ${scanned}${formatLinkSummary(links)}${formatDocumentsSummary(documents)}${formatReleaseNotesSummary(releaseNotes)}`,
  );
  if (scanBase.kind === "base-ref") {
    info(`Stored release baseline: ${(release.commitSha ?? currentCommit.commit).slice(0, 7)}`);
  }

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
    commitSha: commitSha ?? undefined,
    links,
    documents,
    releaseNotes,
  });
  if (result.success) {
    info(
      `Completed release ${result.release?.name ?? "(unknown)"} (${formatVersion(result.release)})${formatLinkSummary(links)}${formatDocumentsSummary(documents)}${formatReleaseNotesSummary(releaseNotes)}`,
    );
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
      links,
      documents,
      releaseNotes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to update release: ${message}`);
  }

  if (result.success) {
    info(
      `Updated release ${result.release?.name ?? "(unknown)"} (${formatVersion(result.release)}) to stage ${result.release?.stageName}${formatLinkSummary(links)}${formatDocumentsSummary(documents)}${formatReleaseNotesSummary(releaseNotes)}`,
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

function getScanBase(candidates: Release[], currentSha: string): ScanBase {
  if (baseRef) {
    let resolvedSha: string;
    try {
      resolvedSha = resolveCommitRef(baseRef);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid --base-ref: ${detail}`);
    }
    info(`Using --base-ref ${baseRef} (${resolvedSha.slice(0, 7)}); skipping automatic baseline selection`);
    return { kind: "base-ref", sha: resolvedSha, ref: baseRef };
  }

  const scanBase = selectAutomaticScanBase(candidates, currentSha, { verifyAncestorReachable });
  if (scanBase.kind !== "first-sync") {
    return scanBase;
  }

  if (scanBase.candidatesConsidered === 0) {
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
      `No recent release is an ancestor of ${currentSha} (${scanBase.candidatesConsidered} ${pluralize(
        scanBase.candidatesConsidered,
        "candidate",
      )} considered); falling back to the first-sync scan boundary`,
    );
  }
  // For a merge HEAD the issue keys live on HEAD^2's branch, not on HEAD
  // itself, so HEAD-only would miss them. Non-merge HEAD carries its own key.
  if (scanBase.sha !== currentSha) {
    verbose(`Merge HEAD: using HEAD^1 (${scanBase.sha}) as the scan boundary`);
  } else {
    verbose("Inspecting current commit only");
  }
  return scanBase;
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
  releaseLinks: ReleaseLink[],
  releaseDocuments: ReleaseDocument[],
  releaseNotesValue: ReleaseNotes | undefined,
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
        links: releaseLinks.length > 0 ? releaseLinks : undefined,
        documents: releaseDocuments.length > 0 ? releaseDocuments : undefined,
        releaseNotes: releaseNotesValue,
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
  name?: string;
  version?: string;
  commitSha?: string;
  links: ReleaseLink[];
  documents: ReleaseDocument[];
  releaseNotes?: ReleaseNotes;
}): Promise<{
  success: boolean;
  release: { id: string; name: string; version?: string; url?: string } | null;
}> {
  const {
    name,
    version,
    commitSha,
    links: releaseLinks,
    documents: releaseDocuments,
    releaseNotes: notesValue,
  } = options;

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
        links: releaseLinks.length > 0 ? releaseLinks : undefined,
        documents: releaseDocuments.length > 0 ? releaseDocuments : undefined,
        releaseNotes: notesValue,
      },
    },
  );

  return response.data.releaseCompleteByAccessKey;
}

async function updateReleaseByPipeline(options: {
  stage?: string;
  version?: string;
  name?: string;
  links: ReleaseLink[];
  documents: ReleaseDocument[];
  releaseNotes?: ReleaseNotes;
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
  const { stage, version, name, links: releaseLinks, documents: releaseDocuments, releaseNotes: notesValue } = options;
  const response = await apiRequest<AccessKeyUpdateByPipelineResponse>(
    `
    mutation releaseUpdateByPipelineByAccessKey($input: ReleaseUpdateByPipelineInputBase!) {
      releaseUpdateByPipelineByAccessKey(input: $input) {
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
    {
      input: {
        stage,
        version,
        name,
        links: releaseLinks.length > 0 ? releaseLinks : undefined,
        documents: releaseDocuments.length > 0 ? releaseDocuments : undefined,
        releaseNotes: notesValue,
      },
    },
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
