import type { RepoInfo, RepositoryProvider } from "./types";

export interface CIEnvironment {
  name: string;
}

export type ConfigurationErrorCode = "invalid-provider-override" | "unknown-provider" | "unsupported-azure-repos";

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

export type CIProviderInference = {
  provider: RepositoryProvider;
  owner?: string;
  name?: string;
  url?: string;
};

type Environment = Record<string, string | undefined>;

type Binding = {
  hosts: string[];
  paths: string[];
};

function normalizeHost(value: string): string {
  let authority = value.trim();
  const userinfoIndex = authority.lastIndexOf("@");
  if (userinfoIndex !== -1) {
    authority = authority.slice(userinfoIndex + 1);
  }
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end !== -1) {
      return authority.slice(1, end).toLowerCase().replace(/\.$/, "");
    }
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon !== -1 && authority.indexOf(":") === lastColon && /^\d+$/.test(authority.slice(lastColon + 1))) {
    authority = authority.slice(0, lastColon);
  }
  return authority.toLowerCase().replace(/\.$/, "");
}

function normalizeDeclaredHost(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return normalizeHost(new URL(value).host);
  } catch {
    return normalizeHost(value);
  }
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function parseBindingUrl(value: string | undefined): { host: string; path: string } | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return {
      host: normalizeHost(parsed.host),
      path: normalizePath(parsed.pathname),
    };
  } catch {
    const scpMatch = value.trim().match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!scpMatch?.[1] || !scpMatch[2]) {
      return null;
    }
    return {
      host: normalizeHost(scpMatch[1]),
      path: normalizePath(scpMatch[2]),
    };
  }
}

function pathMatches(remotePath: string, declaredPath: string): boolean {
  const normalizedRemote = normalizePath(remotePath);
  const normalizedDeclared = normalizePath(declaredPath);
  return (
    normalizedDeclared.length > 0 &&
    (normalizedRemote === normalizedDeclared || normalizedRemote.endsWith(`/${normalizedDeclared}`))
  );
}

function getBinding(remote: RepoInfo, binding: Binding): { bound: boolean; pathMatched: boolean } {
  const hostMatched = binding.hosts.some((host) => host === remote.host);
  const pathMatched = binding.paths.some((path) => pathMatches(remote.path, path));
  // Host OR path suffices: GitLab runner clone_url rewrites the origin host
  // while preserving the project path, so a host mismatch alone must not
  // block inference. Both mismatching means a foreign checkout.
  return { bound: hostMatched || pathMatched, pathMatched };
}

// Splits CI_PROJECT_PATH-style values on the first slash, mirroring
// createRepoInfo — NOT CI_PROJECT_NAMESPACE, which contains the whole
// subgroup chain and would change repository identity for nested groups.
function splitProjectPath(path: string): { owner: string; name: string } | null {
  const normalized = normalizePath(path);
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) {
    return null;
  }
  return {
    owner: normalized.slice(0, slash),
    name: normalized.slice(slash + 1),
  };
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

export function inferProviderFromCI(env: Environment, remote: RepoInfo): CIProviderInference | null {
  const candidates: CIProviderInference[] = [];
  let azureReposBound = false;

  if (env.GITLAB_CI === "true") {
    const projectPath = env.CI_PROJECT_PATH;
    const binding = getBinding(remote, {
      hosts: compact([normalizeDeclaredHost(env.CI_SERVER_HOST), normalizeDeclaredHost(env.CI_SERVER_SHELL_SSH_HOST)]),
      paths: projectPath ? [projectPath] : [],
    });
    if (binding.bound) {
      const project = binding.pathMatched && projectPath ? splitProjectPath(projectPath) : null;
      candidates.push({
        provider: "gitlab",
        ...(project ?? {}),
        ...(project && env.CI_PROJECT_URL ? { url: env.CI_PROJECT_URL.trim().replace(/\/+$/, "") } : {}),
      });
    }
  }

  if (env.GITHUB_ACTIONS === "true") {
    const repository = env.GITHUB_REPOSITORY;
    const binding = getBinding(remote, {
      hosts: compact([normalizeDeclaredHost(env.GITHUB_SERVER_URL)]),
      paths: repository ? [repository] : [],
    });
    if (binding.bound) {
      const project = binding.pathMatched && repository ? splitProjectPath(repository) : null;
      const serverUrl = env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, "");
      candidates.push({
        provider: "github",
        ...(project ?? {}),
        ...(project && serverUrl ? { url: `${serverUrl}/${normalizePath(repository!)}` } : {}),
      });
    }
  }

  if (env.BITBUCKET_GIT_HTTP_ORIGIN || env.BITBUCKET_REPO_FULL_NAME) {
    const origin = parseBindingUrl(env.BITBUCKET_GIT_HTTP_ORIGIN);
    const binding = getBinding(remote, {
      hosts: origin ? [origin.host] : [],
      paths: compact([origin?.path ?? null, env.BITBUCKET_REPO_FULL_NAME ?? null]),
    });
    if (binding.bound) {
      candidates.push({ provider: "bitbucket" });
    }
  }

  const buildkiteMatch = env.BUILDKITE_PIPELINE_PROVIDER?.trim()
    .toLowerCase()
    .match(/^(github|gitlab|bitbucket)(?:_|$)/);
  if (buildkiteMatch?.[1]) {
    const repository = parseBindingUrl(env.BUILDKITE_REPO);
    if (repository && getBinding(remote, { hosts: [repository.host], paths: [repository.path] }).bound) {
      candidates.push({ provider: buildkiteMatch[1] as RepositoryProvider });
    }
  }

  const azureProvider = env.BUILD_REPOSITORY_PROVIDER?.trim().toLowerCase();
  if (azureProvider) {
    const repository = parseBindingUrl(env.BUILD_REPOSITORY_URI);
    const bound =
      repository !== null && getBinding(remote, { hosts: [repository.host], paths: [repository.path] }).bound;
    if (bound && azureProvider === "github") {
      candidates.push({ provider: "github" });
    } else if (bound && azureProvider === "bitbucket") {
      candidates.push({ provider: "bitbucket" });
    } else if (bound && azureProvider === "tfsgit") {
      azureReposBound = true;
    }
  }

  const appVeyorProvider = env.APPVEYOR_REPO_PROVIDER?.trim().toLowerCase();
  const appVeyorPath = env.APPVEYOR_REPO_NAME;
  if (appVeyorProvider && appVeyorPath && pathMatches(remote.path, appVeyorPath)) {
    if (appVeyorProvider.startsWith("github")) {
      candidates.push({ provider: "github" });
    } else if (appVeyorProvider.startsWith("gitlab")) {
      candidates.push({ provider: "gitlab" });
    } else if (appVeyorProvider.startsWith("bitbucket") || appVeyorProvider.startsWith("stash")) {
      candidates.push({ provider: "bitbucket" });
    }
  }

  const semaphoreProvider = env.SEMAPHORE_GIT_PROVIDER?.trim().toLowerCase();
  if (semaphoreProvider === "github" || semaphoreProvider === "bitbucket") {
    const repository = parseBindingUrl(env.SEMAPHORE_GIT_URL);
    if (repository && getBinding(remote, { hosts: [repository.host], paths: [repository.path] }).bound) {
      candidates.push({ provider: semaphoreProvider });
    }
  }

  const providers = new Set(candidates.map((candidate) => candidate.provider));
  if (providers.size > 1 || (azureReposBound && candidates.length > 0)) {
    return null;
  }
  if (azureReposBound) {
    throw new ConfigurationError(
      "Azure Repos repositories are not supported because the Linear API has no Azure Repos provider value.",
      "unsupported-azure-repos",
    );
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.find((candidate) => candidate.owner || candidate.name || candidate.url) ?? candidates[0]!;
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
