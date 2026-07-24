import { findBaseSha, FindBaseShaDeps } from "./base-sha";
import { resolveFirstSyncBoundary } from "./git";
import { warn } from "./log";
import type { Release } from "./types";

export type ScanBase =
  | { kind: "release"; sha: string }
  | { kind: "first-sync"; sha: string; candidatesConsidered: number }
  | { kind: "base-ref"; sha: string; ref: string };

export const BROAD_SCAN_COMMIT_THRESHOLD = 100;

export function selectAutomaticScanBase(
  candidates: Release[],
  currentSha: string,
  deps: FindBaseShaDeps,
  cwd: string = process.cwd(),
): ScanBase {
  const result = findBaseSha(candidates, currentSha, deps);
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
