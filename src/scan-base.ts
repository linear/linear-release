import { findBaseSha, FindBaseShaDeps } from "./base-sha";
import { resolveFirstSyncBoundary } from "./git";
import { warn } from "./log";
import type { Release } from "./types";

export type ScanBase =
  | { kind: "release"; sha: string }
  | { kind: "first-sync"; sha: string; candidatesConsidered: number }
  | { kind: "base-ref"; sha: string; ref: string };

export const BROAD_SCAN_COMMIT_THRESHOLD = 100;

export const SCAN_COMMIT_HARD_LIMIT = 10_000;

/**
 * Judges a scan range's commit count before the (potentially heavy) log scan
 * runs. Automatic ranges above the hard limit degrade to current-commit-only —
 * an anchor that far back is stale or from another repository, and syncing it
 * would link months of shipped work to one release. Explicit --base-ref ranges
 * are trusted but warned. A null count (couldn't determine) never blocks.
 */
export function evaluateScanRangeSize(
  commitCount: number | null,
  scanBase: ScanBase,
): { degradeToCurrentCommit: boolean; warning?: string } {
  if (commitCount === null || commitCount <= SCAN_COMMIT_HARD_LIMIT) {
    return { degradeToCurrentCommit: false };
  }

  if (scanBase.kind === "base-ref") {
    return {
      degradeToCurrentCommit: false,
      warning: `Scanning ${commitCount} commits from --base-ref ${scanBase.ref} (${scanBase.sha.slice(0, 7)}), above the ${SCAN_COMMIT_HARD_LIMIT}-commit safety limit. Proceeding because this range was explicitly requested.`,
    };
  }

  const range = scanBase.kind === "release" ? `release anchor ${scanBase.sha.slice(0, 7)}` : "the first-sync fallback";
  return {
    degradeToCurrentCommit: true,
    warning: `Scan range from ${range} spans ${commitCount} commits, above the ${SCAN_COMMIT_HARD_LIMIT}-commit safety limit — the anchor is likely stale or from another repository. Syncing only the current commit. Pass --base-ref to scan an explicit range.`,
  };
}

export function selectAutomaticScanBase(
  candidates: Release[],
  currentSha: string,
  deps: FindBaseShaDeps,
  cwd: string = process.cwd(),
  syncingVersion?: string,
): ScanBase {
  const result = findBaseSha(candidates, currentSha, deps, syncingVersion);
  if (result.kind === "found") {
    return { kind: "release", sha: result.sha };
  }

  const shaBearingCandidates = candidates.filter((candidate) => Boolean(candidate.commitSha)).length;
  if (shaBearingCandidates > 0) {
    warn(
      `None of the last ${shaBearingCandidates} synced releases' commit SHAs exist in this repository's history. Syncing only the current commit until a scan base can be established. If this pipeline receives syncs from multiple repositories, use one pipeline per repository; otherwise pass --base-ref to pin the scan range.`,
    );
  } else if (candidates.length > 0) {
    warn(
      `None of the last ${candidates.length} releases carry a commit SHA (they were likely created manually). Syncing only the current commit until a scan base can be established. If this pipeline receives syncs from multiple repositories, use one pipeline per repository; otherwise pass --base-ref to pin the scan range.`,
    );
  }

  if (candidates.length > 0) {
    return {
      kind: "first-sync",
      sha: currentSha,
      candidatesConsidered: candidates.length,
    };
  }

  return {
    kind: "first-sync",
    sha: resolveFirstSyncBoundary(currentSha, cwd),
    candidatesConsidered: candidates.length,
  };
}

export type AnchorComparisonDeps = FindBaseShaDeps & {
  isAncestor: (sha: string, headSha: string) => boolean;
};

/**
 * Returns the newest stored release anchor when the current HEAD is strictly behind it — the
 * rollback case, where syncing HEAD as the release commit would rewind the pipeline's scan
 * baseline and make the next sync re-scan (and re-attach) work that already shipped. Returns
 * undefined when HEAD is at or ahead of the anchor, when no candidate carries a commit SHA, or
 * when ancestry cannot be established (unrelated history, unreachable anchor).
 */
export function findAnchorAheadOfHead(
  candidates: Release[],
  headSha: string,
  deps: AnchorComparisonDeps,
): string | undefined {
  const anchorSha = candidates.find((candidate) => candidate.commitSha)?.commitSha;
  if (!anchorSha || anchorSha === headSha) {
    return undefined;
  }
  // Cheap forward check first: an anchor that is an ancestor of HEAD means HEAD is at or ahead of
  // it — the common case, answered without deepening a shallow clone.
  if (deps.isAncestor(anchorSha, headSha)) {
    return undefined;
  }
  return deps.verifyAncestorReachable(headSha, anchorSha) ? anchorSha : undefined;
}

export function assertBaseRefIsAncestor(
  baseRef: string,
  resolvedSha: string,
  currentSha: string,
  deps: FindBaseShaDeps,
): void {
  if (deps.verifyAncestorReachable(resolvedSha, currentSha)) {
    return;
  }

  throw new Error(
    `--base-ref ${baseRef} (${resolvedSha.slice(0, 7)}) is not an ancestor of HEAD ${currentSha.slice(
      0,
      7,
    )}. Choose a ref on the current branch history.`,
  );
}

export function shouldCreateReleaseForScan(commitsLength: number, scanBase: ScanBase): boolean {
  return commitsLength > 0 || scanBase.kind === "base-ref";
}

export function getBroadScanWarning(commitsLength: number, scanBase: ScanBase): string | undefined {
  if (commitsLength <= BROAD_SCAN_COMMIT_THRESHOLD) {
    return undefined;
  }

  if (scanBase.kind === "base-ref") {
    return `Scanning ${commitsLength} commits from --base-ref ${scanBase.ref} (${scanBase.sha.slice(0, 7)}). Issues referenced anywhere in this range, including work already shipped, will be linked to the target release. This range was explicitly requested.`;
  }

  const range = scanBase.kind === "release" ? `release anchor ${scanBase.sha.slice(0, 7)}` : "first-sync fallback";

  return `Scanning ${commitsLength} commits from ${range}. Issues referenced anywhere in this range, including work already shipped, will be linked to the target release. This range was selected automatically. Pass --version and verify the scan base.`;
}
