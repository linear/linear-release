import type { RepoInfo, RepositoryProvider, ResolvedRepoInfo } from "./types";

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-provider-override" | "unknown-provider",
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseProvider(value: string): RepositoryProvider | null {
  const provider = value.toLowerCase();
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

function inferProviderFromCI(
  env: Record<string, string | undefined>,
  repoInfo: RepoInfo,
  host: string | null,
): RepositoryProvider | null {
  if (env.GITLAB_CI !== "true") {
    return null;
  }
  const serverHost = env.CI_SERVER_HOST?.trim().toLowerCase();
  const hostMatched = host !== null && host === serverHost;
  const projectPath = env.CI_PROJECT_PATH?.trim().replace(/^\/+|\/+$/g, "");
  const remotePath = repoInfo.owner && repoInfo.name ? `${repoInfo.owner}/${repoInfo.name}` : null;
  const pathMatched = !!projectPath && (remotePath === projectPath || !!remotePath?.endsWith(`/${projectPath}`));
  // Host OR path suffices: GitLab runner clone_url rewrites the origin host
  // while preserving the project path. Both mismatching means a foreign checkout.
  return hostMatched || pathMatched ? "gitlab" : null;
}

function resolveProvider(repoInfo: RepoInfo, env: Record<string, string | undefined>): RepositoryProvider {
  const override = env.LINEAR_VCS_PROVIDER?.trim();
  if (override) {
    const provider = parseProvider(override);
    if (!provider) {
      throw new ConfigurationError(
        `Invalid LINEAR_VCS_PROVIDER value "${override}". Expected github, gitlab, or bitbucket.`,
        "invalid-provider-override",
      );
    }
    return provider;
  }
  const host = remoteHost(repoInfo);
  const provider = repoInfo.provider ?? inferProviderFromCI(env, repoInfo, host);
  if (!provider) {
    throw new ConfigurationError(
      `Could not determine the VCS provider for remote host "${host ?? repoInfo.url ?? "unknown"}".\nSet LINEAR_VCS_PROVIDER=github|gitlab|bitbucket in your CI environment.`,
      "unknown-provider",
    );
  }
  return provider;
}

export function resolveRepoInfo(
  repoInfo: RepoInfo | null,
  env: Record<string, string | undefined> = process.env,
): ResolvedRepoInfo | null {
  return repoInfo ? { ...repoInfo, provider: resolveProvider(repoInfo, env) } : null;
}
