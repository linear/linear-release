import { verbose } from "./log";
import type { Release } from "./types";

export type BaseShaResult = { kind: "found"; sha: string } | { kind: "fallback" };

export type FindBaseShaDeps = {
  verifyAncestorReachable: (sha: string, headSha: string) => boolean;
};

/**
 * Picks the base SHA for `git log <base>..<HEAD>` from a list of recent
 * release candidates (most-relevant first). Returns the first candidate whose
 * `commitSha` is reachable from `headSha` — the API can't disambiguate
 * concurrent release trains via SQL alone, so we use git as ground truth.
 */
export function findBaseSha(candidates: Release[], headSha: string, deps: FindBaseShaDeps): BaseShaResult {
  for (const candidate of candidates) {
    const sha = candidate.commitSha;
    if (!sha) {
      verbose(`Skipping base SHA candidate "${candidate.name}": no commit SHA`);
      continue;
    }
    if (!deps.verifyAncestorReachable(sha, headSha)) {
      verbose(
        `Skipping base SHA candidate "${candidate.name}" (${sha.slice(0, 7)}): not an ancestor of ${headSha.slice(0, 7)}`,
      );
      continue;
    }
    verbose(`Using base SHA from release "${candidate.name}" (${sha.slice(0, 7)})`);
    return { kind: "found", sha };
  }
  return { kind: "fallback" };
}
