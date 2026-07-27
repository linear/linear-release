import type { RepoInfo, RepositoryProvider, ResolvedRepoInfo } from "./types";

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

function parseProvider(value: string | null | undefined): RepositoryProvider | null {
  const provider = value?.trim().toLowerCase();
  return provider === "github" || provider === "gitlab" || provider === "bitbucket" ? provider : null;
}

function remoteHost(repoInfo: RepoInfo): string | null {
  if (!repoInfo.url) {
    return null;
  }
  try {
    return new URL(repoInfo.url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function inferProviderFromCI(env: Record<string, string | undefined>, repoInfo: RepoInfo): RepositoryProvider | null {
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

export function resolveRepoInfo(
  repoInfo: RepoInfo,
  env: Record<string, string | undefined> = process.env,
): ResolvedRepoInfo {
  const override = env.LINEAR_VCS_PROVIDER;
  if (override !== undefined) {
    const provider = parseProvider(override);
    if (!provider) {
      throw new ConfigurationError(
        `Invalid LINEAR_VCS_PROVIDER value "${override}". Expected github, gitlab, or bitbucket.`,
        "invalid-provider-override",
        { value: override },
      );
    }
    return { ...repoInfo, provider };
  }
  const provider = parseProvider(repoInfo.provider) ?? inferProviderFromCI(env, repoInfo);
  if (!provider) {
    const host = remoteHost(repoInfo) ?? repoInfo.url ?? "unknown";
    throw new ConfigurationError(
      `Could not determine the VCS provider for remote host "${host}".\nSet LINEAR_VCS_PROVIDER=github|gitlab|bitbucket in your CI environment.`,
      "unknown-provider",
      { host },
    );
  }
  return { ...repoInfo, provider };
}
