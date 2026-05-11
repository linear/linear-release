import { verbose } from "./log";
import type { Release } from "./types";

export type BaseShaResult = { kind: "found"; sha: string } | { kind: "fallback" };

export type FindBaseShaDeps = {
  isAncestor: (sha: string, headSha: string) => boolean;
  commitExists: (sha: string) => boolean;
  ensureCommitAvailable: (sha: string) => void;
};

/**
 * Picks the base SHA for `git log <base>..<HEAD>` from a list of recent
 * release candidates (most-relevant first). Returns the first candidate whose
 * `commitSha` is reachable from `headSha` — the API can't disambiguate
 * concurrent release trains via SQL alone, so we use git as ground truth.
 *
 * `commitExists` gates `ensureCommitAvailable` so a shallow clone doesn't pay
 * a `git fetch` per candidate when the SHAs are already local.
 */
export function findBaseSha(candidates: Release[], headSha: string, deps: FindBaseShaDeps): BaseShaResult {
  for (const candidate of candidates) {
    const sha = candidate.commitSha;
    if (!sha) {
      verbose(`findBaseSha: skipping ${candidate.name}: no commitSha`);
      continue;
    }
    if (!deps.commitExists(sha)) {
      try {
        deps.ensureCommitAvailable(sha);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        verbose(`findBaseSha: skipping ${candidate.name} (${sha}): ${message}`);
        continue;
      }
    }
    if (!deps.isAncestor(sha, headSha)) {
      verbose(`findBaseSha: skipping ${candidate.name} (${sha}): not an ancestor of ${headSha}`);
      continue;
    }
    verbose(`findBaseSha: using ${candidate.name} (${sha})`);
    return { kind: "found", sha };
  }
  return { kind: "fallback" };
}
