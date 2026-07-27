import type { RepoInfo, RepositoryProvider } from "./types";

export interface CIEnvironment {
  name: string;
}

export type ConfigurationErrorCode = "invalid-provider-override" | "unknown-provider";

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: ConfigurationErrorCode,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function parseProvider(value: string | null | undefined): RepositoryProvider | null {
  const provider = value?.trim().toLowerCase();
  return provider === "github" || provider === "gitlab" || provider === "bitbucket" ? provider : null;
}

export function remoteHost(repoInfo: RepoInfo): string | null {
  if (!repoInfo.url) {
    return null;
  }
  try {
    return new URL(repoInfo.url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function inferProviderFromCI(
  env: Record<string, string | undefined>,
  repoInfo: RepoInfo,
): RepositoryProvider | null {
  if (env.GITLAB_CI !== "true") {
    return null;
  }
  const host = remoteHost(repoInfo);
  const serverHost = env.CI_SERVER_HOST?.trim().toLowerCase();
  const hostMatched = host !== null && !!serverHost && host === serverHost;
  const projectPath = env.CI_PROJECT_PATH?.trim().replace(/^\/+|\/+$/g, "");
  const remotePath = repoInfo.owner && repoInfo.name ? `${repoInfo.owner}/${repoInfo.name}` : null;
  const pathMatched =
    !!projectPath && remotePath !== null && (remotePath === projectPath || remotePath.endsWith(`/${projectPath}`));
  // Host OR path suffices: GitLab runner clone_url rewrites the origin host
  // while preserving the project path. Both mismatching means a foreign checkout.
  return hostMatched || pathMatched ? "gitlab" : null;
}

/**
 * Detects the CI environment based on environment variables.
 * Returns null if not running in a recognized CI environment.
 */
export function detectCIEnvironment(): CIEnvironment | null {
  if (process.env.GITHUB_ACTIONS === "true") {
    return { name: "github-actions" };
  }
  if (process.env.GITLAB_CI === "true") {
    return { name: "gitlab-ci" };
  }
  if (process.env.CIRCLECI === "true") {
    return { name: "circleci" };
  }
  if (process.env.BUILD_TAG?.startsWith("jenkins-")) {
    return { name: "jenkins" };
  }
  if (process.env.TRAVIS === "true") {
    return { name: "travis-ci" };
  }
  if (process.env.TF_BUILD === "True") {
    return { name: "azure-pipelines" };
  }
  if (process.env.BUILDKITE === "true") {
    return { name: "buildkite" };
  }
  if (process.env.TEAMCITY_VERSION) {
    return { name: "teamcity" };
  }
  if (process.env.RWX === "true") {
    return { name: "rwx" };
  }
  if (process.env.CI === "true") {
    return { name: "ci" };
  }
  return null;
}
