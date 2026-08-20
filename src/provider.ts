import type { RepoInfo, RepositoryProvider, ResolvedRepoInfo } from "./types";

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-provider-override" | "unknown-provider" | "invalid-path-filter",
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Parses a git remote URL (HTTPS or SSH) into repository facts. Provider
 * identification is `resolveRepoInfo`'s job.
 */
export function parseRepoUrl(remoteUrl: string | null): RepoInfo | null {
  if (!remoteUrl) {
    return null;
  }

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
      host,
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
      host,
      url: owner && name ? `https://${host}/${owner}/${name}` : null,
    };
  }

  return null;
}

function normalizeHost(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

function hostToProvider(host: string): RepositoryProvider | null {
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

function parseProvider(value: string): RepositoryProvider | null {
  const provider = value.toLowerCase();
  return provider === "github" || provider === "gitlab" || provider === "bitbucket" ? provider : null;
}

function inferProviderFromCI(
  env: Record<string, string | undefined>,
  repoInfo: RepoInfo,
  host: string,
): RepositoryProvider | null {
  if (env.GITLAB_CI !== "true") {
    return null;
  }
  const serverHost = env.CI_SERVER_HOST?.trim().toLowerCase();
  const hostMatched = host === serverHost;
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
  const host = normalizeHost(repoInfo.host);
  const provider = hostToProvider(host) ?? inferProviderFromCI(env, repoInfo, host);
  if (!provider) {
    throw new ConfigurationError(
      `Could not determine the VCS provider for remote host "${host}".\nSet LINEAR_VCS_PROVIDER=github|gitlab|bitbucket in your CI environment.`,
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
