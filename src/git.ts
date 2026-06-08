import { execFileSync, execSync } from "node:child_process";
import type { CommitContext, GitInfo, RepoInfo } from "./types";
import { error as logError, verbose, warn } from "./log";

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

/**
 * Verifies the runtime environment can satisfy the CLI's git requirements:
 *   1. The `git` binary is on PATH.
 *   2. The current working directory is inside a git repository.
 *
 * Call once at startup, before any other git operations, so cryptic
 * downstream failures (ENOENT, "not a git repository") become useful
 * diagnostics for CI users.
 */
export function assertGitAvailable(cwd: string = process.cwd()): void {
  try {
    execSync("git --version", {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error(
      "linear-release requires `git` on PATH, but `git --version` failed. Please make sure that git is installed and available.",
    );
  }

  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error("linear-release must run inside a git repository, but no `.git` directory was found.");
  }
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

/**
 * Implicit scan boundary for a first-time release sync (no prior release SHA).
 * Expands a merge HEAD to its first parent so the merged-in branch's commits
 * are in range — issue keys live there, not on the merge node itself.
 */
export function resolveFirstSyncBoundary(currentSha: string, cwd: string = process.cwd()): string {
  const parents = getCommitParents(currentSha, cwd);
  if (parents.length > 1 && parents[0]) {
    return parents[0];
  }
  return currentSha;
}

/**
 * Returns `sha`'s parent SHAs in order. Empty array if the commit has no
 * reachable parents — root commit, unknown SHA, or shallow clone where the
 * parents aren't in the local repo. Merges have 2+ entries.
 */
export function getCommitParents(sha: string, cwd: string = process.cwd()): string[] {
  try {
    const out = execSync(`git log -1 --format=%P ${sha}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out ? out.split(" ").filter((p) => /^[0-9a-f]{40}$/i.test(p)) : [];
  } catch {
    return [];
  }
}

export function commitExists(sha: string, cwd: string = process.cwd()): boolean {
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff `sha` is reachable by walking parents from `headSha`.
 *
 * Used to verify that a candidate base SHA is actually on HEAD's history before
 * we hand it to `git log <base>..<HEAD>` — a candidate from a side branch (e.g.
 * a hotfix release) will scan a wrong range otherwise.
 *
 * Caveat on shallow clones: `git merge-base --is-ancestor` exits 1 both when
 * `sha` is genuinely not an ancestor AND when the walk hits a shallow boundary
 * before reaching `sha`. Callers that need to disambiguate should use
 * `verifyAncestorReachable`, which deepens and retries on shallow cutoffs.
 */
export function isAncestor(sha: string, headSha: string, cwd: string = process.cwd()): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${sha} ${headSha}`, {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Returns true if the repository at `cwd` is a shallow clone, false otherwise. */
export function isShallowRepository(cwd: string = process.cwd()): boolean {
  try {
    const out = execSync("git rev-parse --is-shallow-repository", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

const DEEPEN_STRATEGIES = [
  { command: "git fetch --deepen=200 origin", label: "Deepening by 200 commits" },
  { command: "git fetch --deepen=500 origin", label: "Deepening by 500 commits" },
  { command: "git fetch --unshallow origin", label: "Fetching full history" },
];

function deepenUntil(cwd: string, check: () => boolean): boolean {
  for (const { command, label } of DEEPEN_STRATEGIES) {
    verbose(label);
    try {
      execSync(command, { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      verbose(`Strategy "${label}" failed: ${reason}`);
      continue;
    }
    if (check()) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `sha` is an ancestor of `headSha`, deepening a shallow clone
 * as needed to obtain a definitive answer.
 *
 * `isAncestor` alone isn't enough on shallow repos: `merge-base --is-ancestor`
 * exits 1 both for genuine non-ancestors and for walks that hit a shallow graft
 * before reaching `sha` — the two cases share an exit code. And `commitExists`
 * can return true for an object that was pulled in as a side-branch boundary
 * parent even when that commit isn't yet walkable from `headSha`. Disambiguate
 * by deepening and retrying.
 */
export function verifyAncestorReachable(sha: string, headSha: string, cwd: string = process.cwd()): boolean {
  if (sha === headSha) {
    return true;
  }

  const isReachable = () => commitExists(sha, cwd) && isAncestor(sha, headSha, cwd);

  if (isReachable()) {
    return true;
  }
  if (!isShallowRepository(cwd)) {
    // Deep repo: this negative is real, not a shallow cutoff.
    return false;
  }

  verbose(`Cannot confirm ${sha.slice(0, 7)} is an ancestor of ${headSha.slice(0, 7)} on shallow repo; deepening`);

  if (deepenUntil(cwd, isReachable)) {
    verbose(`Confirmed ${sha.slice(0, 7)} is an ancestor of ${headSha.slice(0, 7)}`);
    return true;
  }
  return false;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Resolves a git ref, tag, or SHA to a full commit SHA.
 *
 * Shallow or single-branch clones often lack the target locally:
 *   - SHA-like inputs: deepen history until the commit is reachable.
 *   - Tag or branch refs: `git fetch origin <ref>` populates FETCH_HEAD with
 *     the resolved commit for both kinds, without needing to know which.
 */
export function resolveCommitRef(ref: string, cwd: string = process.cwd()): string {
  const resolve = (target: string = ref) =>
    execFileSync("git", ["rev-parse", "--verify", `${target}^{commit}`], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

  try {
    return resolve();
  } catch {
    if (SHA_PATTERN.test(ref)) {
      ensureCommitAvailable(ref, cwd);
      return resolve();
    }
    try {
      verbose(`Ref "${ref}" not in local history; fetching from origin`);
      execFileSync("git", ["fetch", "origin", ref], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 30_000,
      });
      return resolve("FETCH_HEAD");
    } catch {
      throw new Error(`Could not resolve "${ref}" to a commit. Use a valid commit SHA, tag, or ref.`);
    }
  }
}

/**
 * Extracts the branch name from a merge commit message.
 * Supports:
 *   - GitHub: "Merge pull request #X from owner/branch-name"
 *   - GitLab: "Merge branch 'branch-name' into 'target'"
 *   - GitLab (no target): "Merge branch 'branch-name'"
 *   - Bitbucket: "Merged in branch-name (pull request #X)"
 */
export function extractBranchNameFromMergeMessage(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  // GitHub: "Merge pull request #123 from owner/branch-name"
  const githubMatch = message.match(/Merge pull request #\d+ from [^/]+\/(\S+)/i);
  if (githubMatch?.[1]) {
    return githubMatch[1];
  }
  // GitLab: "Merge branch 'branch-name' into 'target'" or "Merge branch 'branch-name'"
  const gitlabMatch = message.match(/Merge branch '([^']+)'/i);
  if (gitlabMatch?.[1]) {
    return gitlabMatch[1];
  }
  // Bitbucket: "Merged in feature/ENG-123-fix-auth (pull request #42)"
  const bitbucketMatch = message.match(/Merged in (\S+) \(pull request #\d+\)/i);
  return bitbucketMatch?.[1] ?? null;
}

/**
 * Parses a commit chunk (from git log --format=%H%x1f%B%x1f%D) into a CommitContext.
 * Prefers branch name from merge message over decorations for issue tracking.
 */
function parseCommitChunk(chunk: string): CommitContext {
  const [sha, rawMessage, rawDecorations] = chunk.split("\x1f");
  // Collapse runs of horizontal whitespace, but keep newlines so downstream
  // extractors can tell the title from the body and skip nested commit blocks.
  const message = (rawMessage ?? "").trim().replace(/[ \t]+/g, " ");
  const branchName = extractBranchNameFromMergeMessage(message) ?? extractBranchName(rawDecorations);

  return { sha: sha.trim(), branchName, message };
}

/**
 * Returns the commit context for a single commit without path filtering.
 */
export function getCommitContext(sha: string, cwd: string = process.cwd()): CommitContext | null {
  if (!SHA_PATTERN.test(sha)) {
    warn(`Invalid commit SHA format "${sha}"`);
    return null;
  }
  try {
    return runLog(`-1 ${sha}`, cwd)[0] ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Failed to read commit ${sha.slice(0, 7)}: ${message}`);
    return null;
  }
}

/**
 * Ensures a commit is available in the local repository.
 * For shallow clones, progressively fetches more history until the commit is found.
 * Throws if the commit cannot be made available (e.g., not on the current branch).
 */
export function ensureCommitAvailable(sha: string, cwd: string = process.cwd()): void {
  if (commitExists(sha, cwd)) {
    return;
  }

  verbose(`Commit ${sha} not in local history (likely shallow clone)`);

  if (deepenUntil(cwd, () => commitExists(sha, cwd))) {
    verbose(`Found commit ${sha}`);
    return;
  }

  const currentBranch = getCurrentGitInfo(cwd).branch ?? "unknown";
  throw new Error(
    `Commit ${sha} not reachable from branch "${currentBranch}" even after fetching full history. ` +
      `Ensure the commit exists on branch "${currentBranch}".`,
  );
}

// A wide commit range outgrows Node's 1 MB default; keep a finite ceiling
// rather than Infinity to bound memory.
const RUN_LOG_MAX_BUFFER = 256 * 1024 * 1024;

function runLog(rangeArgs: string, cwd: string): CommitContext[] {
  const output = execSync(`git log --format=%H%x1f%B%x1f%D%x1e ${rangeArgs}`, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: RUN_LOG_MAX_BUFFER,
  });
  return output
    .split("\x1e")
    .filter((chunk) => chunk.trim().length > 0)
    .map(parseCommitChunk);
}

/**
 * Returns commits between two SHAs, optionally filtered by file paths.
 *
 * `--full-history` (only when `includePaths` is set): a non-evil merge's
 * tree equals one of its parents' trees, so under a pathspec it's TREESAME
 * and git's default simplification drops it. That's true of every provider's
 * merge commit (GitHub, GitLab MR, Bitbucket PR, plain `git merge --no-ff`)
 * and would lose the issue keys encoded in their feature-branch names.
 *
 * `--no-walk` (only when `fromSha === toSha`): without it, `git log -1 <sha>
 * -- <paths>` walks back from `<sha>` to the first ancestor matching the
 * pathspec — silently returning an unrelated commit when `<sha>` itself
 * doesn't match. Callers that need true `sha..sha` empty-range semantics can
 * pass `inspectSingleCommit: false`.
 *
 * @param fromSha - Starting commit SHA (exclusive)
 * @param toSha - Ending commit SHA (inclusive)
 * @param options.includePaths - Glob patterns to filter commits by file paths (relative to repo root)
 * @param options.inspectSingleCommit - When SHAs match, inspect that one commit instead of treating it as an empty range
 * @param options.cwd - Working directory for git commands (defaults to process.cwd())
 */
export function getCommitContextsBetweenShas(
  fromSha: string,
  toSha: string,
  options: { includePaths?: string[] | null; inspectSingleCommit?: boolean; cwd?: string } = {},
): CommitContext[] {
  const { includePaths = null, inspectSingleCommit = true, cwd = process.cwd() } = options;

  if (!SHA_PATTERN.test(fromSha)) {
    warn(`Invalid "from" SHA format "${fromSha}"`);
    return [];
  }
  if (!SHA_PATTERN.test(toSha)) {
    warn(`Invalid "to" SHA format "${toSha}"`);
    return [];
  }

  const inspectingSingleCommit = fromSha === toSha && inspectSingleCommit;
  const args = [
    includePaths?.length ? "--full-history" : "",
    inspectingSingleCommit ? `--no-walk ${toSha}` : `${fromSha}..${toSha}`,
    buildPathspecArgs(includePaths),
  ]
    .filter(Boolean)
    .join(" ");
  const commits = runLog(args, cwd);

  if (commits.length === 0) {
    if (inspectingSingleCommit) {
      const pathFilter = includePaths?.length ? ` include paths: ${includePaths.join(", ")}` : "";
      verbose(`Commit ${toSha.slice(0, 7)} did not match${pathFilter}`);
    } else {
      const pathFilter = includePaths?.length ? ` matching include paths: ${includePaths.join(", ")}` : "";
      verbose(`No commits found between ${fromSha.slice(0, 7)}..${toSha.slice(0, 7)}${pathFilter}`);
    }
  }

  return commits;
}

function hostToProvider(host: string): string | null {
  if (host === "gitlab.com" || host.includes("gitlab")) {
    return "gitlab";
  }
  if (host === "github.com" || host.endsWith(".ghe.com") || host.includes("github")) {
    return "github";
  }
  if (host === "bitbucket.org" || host.includes("bitbucket")) {
    return "bitbucket";
  }
  return null;
}

/**
 * Parses a git remote URL (HTTPS or SSH) into repo information.
 *
 * @param remoteUrl The raw git remote URL string.
 * @returns Parsed repo info, or null if the URL could not be parsed.
 */
export function parseRepoUrl(remoteUrl: string): RepoInfo | null {
  // GitLab nested groups: split on the first slash so subgroup paths fold
  // into the name segment (e.g. owner=group, name=subgroup/repo).
  const httpsMatch = remoteUrl.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const owner = httpsMatch[2] || null;
    const name = httpsMatch[3]?.replace(/\.git$/, "") || null;
    return {
      owner,
      name,
      provider: hostToProvider(host),
      url: owner && name ? `https://${host}/${owner}/${name}` : null,
    };
  }

  // Handle SSH URLs: git@github.com:owner/repo.git (GitLab nested groups
  // follow the same first-slash split as the HTTPS case above).
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const owner = sshMatch[2] || null;
    const name = sshMatch[3]?.replace(/\.git$/, "") || null;
    return {
      owner,
      name,
      provider: hostToProvider(host),
      url: owner && name ? `https://${host}/${owner}/${name}` : null,
    };
  }

  return null;
}

export function getRepoInfo(remote: string = "origin", cwd: string = process.cwd()): RepoInfo | null {
  try {
    const url = execSync(`git remote get-url ${remote}`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    return parseRepoUrl(url);
  } catch (error) {
    logError(`Failed to read repo info: ${error instanceof Error ? error.message : String(error)}`);
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
        verbose(`Found pull request number ${prNumber} in commit ${commit.sha}`);
        prNumbers.add(prNumber);
      }
    }
  }

  return Array.from(prNumbers);
}
