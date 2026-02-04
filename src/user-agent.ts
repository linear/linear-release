import { getCliVersion } from "./version";
import { detectCIEnvironment } from "./ci-env";

/**
 * Builds the User-Agent string for HTTP requests.
 * Format: linear-release/{version} ({ci-platform})
 */
export function buildUserAgent(): string {
  const version = getCliVersion();
  const ciEnv = detectCIEnvironment();
  const ciName = ciEnv?.name ?? "local";
  return `linear-release/${version} (${ciName})`;
}
