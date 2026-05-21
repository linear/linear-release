import { findBaseSha, FindBaseShaDeps } from "./base-sha";
import { resolveFirstSyncBoundary } from "./git";
import type { Release } from "./types";

export type ScanBase =
  | { kind: "release"; sha: string }
  | { kind: "first-sync"; sha: string; candidatesConsidered: number }
  | { kind: "base-ref"; sha: string; ref: string };

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
