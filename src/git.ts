import { execSync } from "node:child_process";
import type { CommitContext, GitInfo, RepoInfo } from "./types";
import { log } from "./log";

/** Strips leading "./" or "/" so paths are clean for git pathspec. */
export function normalizePathspec(pattern: string): string {
  return pattern.replace(/^(\.\/|\/)+/, "").trim();
}

/**
 * Builds git pathspec arguments from include patterns.
 *
 * Uses `:(top,glob)` pathspec prefix:
 * - `top`: paths are relative to repo root, not the current working directory
 * - `glob`: enables `**` for recursive matching (e.g., "src/**")
 *
 * @see https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-aiddefpathspec
 */
export function buildPathspecArgs(includePaths: string[] | null): string {
  if (!includePaths || includePaths.length === 0) {
    return "";
  }
  const patterns = includePaths
    .map((p) => normalizePathspec(p))
    .filter((p) => p.length > 0)
    .map((p) => `":(top,glob)${p}"`);
  if (patterns.length === 0) {
    return "";
  }
  return `-- ${patterns.join(" ")}`;
}

export function getCurrentGitInfo(cwd: string = process.cwd()): GitInfo {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    })
      .trim()
      .replace(/^HEAD$/, "detached");

    const commit = execSync("git rev-parse HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    const message = execSync("git log -1 --pretty=%B", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    })
      .trim()
      .replace(/\s+/g, " ");

    return { branch, commit, message };
  } catch {
    return { branch: null, commit: null, message: null };
  }
}

/**
 * Extracts the most relevant branch name from git decoration refs.
 * Prefers feature branches over common branches (main, master, develop, etc.)
 * and picks the longest name when multiple candidates exist.
 */
export function extractBranchName(rawDecorations: string | undefined): string | null {
  if (!rawDecorations || rawDecorations.trim().length === 0) {
    return null;
  }

  const refs = rawDecorations.split(",").map((ref) => ref.trim());

  const branches = refs
    .map((ref) => ref.replace(/^HEAD ->\s*/, ""))
    .filter((ref) => ref.length > 0 && !ref.toLowerCase().startsWith("tag:") && !ref.startsWith("origin/HEAD"));

  if (branches.length === 0) {
    return null;
  }

  const common = new Set(["main", "master", "develop", "dev", "staging", "production", "prod"]);

  const normalizedBranches = branches.map((b) => b.replace(/^remotes\/[^/]+\//, ""));

  const candidates = normalizedBranches.filter((b) => !common.has(b.toLowerCase()));

  const preferred = candidates.length > 0 ? candidates : normalizedBranches;

  return preferred.sort((a, b) => b.length - a.length)[0]!;
}

export function commitExists(sha: string, cwd: string = process.cwd()): boolean {
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (error) {
    // Only log unexpected errors, not "commit not found" which is expected
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Not a valid object")) {
      log(`commitExists: Unexpected error checking ${sha}: ${message}`);
    }
    return false;
  }
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Returns true if the commit has more than one parent (i.e., is a merge commit).
 */
export function isMergeCommit(sha: string, cwd: string = process.cwd()): boolean {
  if (!SHA_PATTERN.test(sha)) {
    log(`isMergeCommit: Invalid SHA format "${sha}"`);
    return false;
  }

  try {
    // %P returns space-separated parent hashes
    // Regular commits have 1 parent (no space), merge commits have 2+ (contains space)
    const parentHashes = execSync(`git log -1 --format=%P ${sha}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    return parentHashes.includes(" ");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`isMergeCommit: Failed to check ${sha}: ${message}`);
    return false;
  }
}

/**
 * Extracts the branch name from a GitHub merge commit message.
 * Matches: "Merge pull request #X from owner/branch-name"
 */
export function extractBranchNameFromMergeMessage(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  const match = message.match(/Merge pull request #\d+ from [^/]+\/(\S+)/i);
  return match?.[1] ?? null;
}

/**
 * Parses a commit chunk (from git log --format=%H%x1f%B%x1f%D) into a CommitContext.
 * Prefers branch name from merge message over decorations for issue tracking.
 */
function parseCommitChunk(chunk: string): CommitContext {
  const [sha, rawMessage, rawDecorations] = chunk.split("\x1f");
  const message = (rawMessage ?? "").trim().replace(/\s+/g, " ");
  const branchName = extractBranchNameFromMergeMessage(message) ?? extractBranchName(rawDecorations);

  return { sha: sha.trim(), branchName, message };
}

/**
 * Returns the commit context for a single commit without path filtering.
 */
export function getCommitContext(sha: string, cwd: string = process.cwd()): CommitContext | null {
  if (!SHA_PATTERN.test(sha)) {
    log(`getCommitContext: Invalid SHA format "${sha}"`);
    return null;
  }

  try {
    const output = execSync(`git log -1 --format=%H%x1f%B%x1f%D%x1e ${sha}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

    const chunk = output.split("\x1e")[0];
    if (!chunk || chunk.trim().length === 0) {
      log(`getCommitContext: Empty output for ${sha}`);
      return null;
    }

    return parseCommitChunk(chunk);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`getCommitContext: Failed to get context for ${sha}: ${message}`);
    return null;
  }
}

/**
 * Ensures a commit is available in the local repository.
 * For shallow clones, progressively fetches more history until the commit is found.
 * Throws if the commit cannot be made available (e.g., not on the current branch).
 */
function ensureCommitAvailable(sha: string, cwd: string): void {
  if (commitExists(sha, cwd)) {
    return;
  }

  const strategies = [
    {
      command: "git fetch --deepen=200 origin",
      label: "Deepening by 200 commits",
    },
    {
      command: "git fetch --deepen=500 origin",
      label: "Deepening by 500 commits",
    },
    { command: "git fetch --unshallow origin", label: "Fetching full history" },
  ];

  log(`Commit ${sha} not in local history (likely shallow clone)`);

  for (const { command, label } of strategies) {
    log(label);
    try {
      execSync(command, { cwd, stdio: "pipe" });
      if (commitExists(sha, cwd)) {
        log(`Found commit ${sha}`);
        return;
      }
    } catch {
      // Strategy failed, try next
    }
  }

  const currentBranch = getCurrentGitInfo(cwd).branch ?? "unknown";
  throw new Error(
    `Commit ${sha} not reachable from branch "${currentBranch}" even after fetching full history. ` +
      `Ensure the commit exists on branch "${currentBranch}".`,
  );
}

/**
 * Returns commits between two SHAs, optionally filtered by file paths.
 *
 * @param fromSha - Starting commit SHA (exclusive)
 * @param toSha - Ending commit SHA (inclusive)
 * @param options.includePaths - Glob patterns to filter commits by file paths (relative to repo root)
 * @param options.cwd - Working directory for git commands (defaults to process.cwd())
 */
export function getCommitContextsBetweenShas(
  fromSha: string,
  toSha: string,
  options: { includePaths?: string[] | null; cwd?: string } = {},
): CommitContext[] {
  const { includePaths = null, cwd = process.cwd() } = options;

  if (!SHA_PATTERN.test(fromSha)) {
    log(`getCommitContextsBetweenShas: Invalid fromSha format "${fromSha}"`);
    return [];
  }
  if (!SHA_PATTERN.test(toSha)) {
    log(`getCommitContextsBetweenShas: Invalid toSha format "${toSha}"`);
    return [];
  }

  // Ensure the base commit is available (handles shallow clones)
  ensureCommitAvailable(fromSha, cwd);

  const pathspecArgs = buildPathspecArgs(includePaths);

  // If fromSha and toSha are the same, get that single commit only
  const logCommand =
    fromSha === toSha
      ? `git log -1 --format=%H%x1f%B%x1f%D%x1e ${toSha} ${pathspecArgs}`
      : `git log --format=%H%x1f%B%x1f%D%x1e ${fromSha}..${toSha} ${pathspecArgs}`;

  const output = execSync(logCommand, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const commits = output
    .split("\x1e")
    .filter((chunk) => chunk.trim().length > 0)
    .map(parseCommitChunk);

  /**
   * Path filtering can exclude a merge commit at toSha. This is because merge commits have no direct file changes.
   * We still want to include it for metadata extraction, like PR numbers and branch names.
   */
  const toShaWasExcluded = includePaths?.length && !commits.some((c) => c.sha === toSha);

  if (toShaWasExcluded && isMergeCommit(toSha, cwd)) {
    const mergeCommit = getCommitContext(toSha, cwd);
    if (mergeCommit) {
      commits.unshift(mergeCommit);
    }
  }

  if (commits.length === 0) {
    log(
      `getCommitContextsBetweenShas: No commits found between ${fromSha}..${toSha}` +
        (includePaths?.length ? ` with paths: ${includePaths.join(", ")}` : ""),
    );
  }

  return commits;
}

export function getRepoInfo(remote: string = "origin", cwd: string = process.cwd()): RepoInfo | null {
  try {
    const url = execSync(`git remote get-url ${remote}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    // Handle HTTPS URLs: https://github.com/owner/repo.git or https://github.com/owner/repo
    const httpsMatch = url.match(
      /^https?:\/\/(?:[^@]+@)?(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/]+?)(?:\.git)?$/,
    );
    if (httpsMatch) {
      return {
        owner: httpsMatch[1] || null,
        name: httpsMatch[2]?.replace(/\.git$/, "") || null,
      };
    }

    // Handle SSH URLs: git@github.com:owner/repo.git or git@github.com:owner/repo
    const sshMatch = url.match(/^git@(?:github\.com|gitlab\.com|bitbucket\.org):([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        owner: sshMatch[1] || null,
        name: sshMatch[2]?.replace(/\.git$/, "") || null,
      };
    }

    return null;
  } catch (error) {
    console.error(`Error getting repo info: ${error}`);
    return null;
  }
}

export function getPullRequestNumbers(commits: CommitContext[]): number[] {
  const prNumbers = new Set<number>();

  for (const commit of commits) {
    if (!commit.message) {
      continue;
    }

    const matches = commit.message.matchAll(/\(#(\d+)\)/g);
    for (const match of matches) {
      const prNumber = Number.parseInt(match[1]!, 10);
      if (!Number.isNaN(prNumber)) {
        log(`Found pull request number ${prNumber} in commit ${commit.sha}`);
        prNumbers.add(prNumber);
      }
    }
  }

  return Array.from(prNumbers);
}
