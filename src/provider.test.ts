import { describe, expect, it } from "vitest";
import { ConfigurationError, resolveRepoInfo } from "./provider";
import type { RepoInfo } from "./types";

const selfHosted: RepoInfo = {
  owner: "group",
  name: "subgroup/repo",
  provider: null,
  url: "https://git.example.com/group/subgroup/repo",
};

function captureError(fn: () => unknown): ConfigurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error;
    }
  }
  throw new Error("Expected a ConfigurationError");
}

describe("resolveRepoInfo", () => {
  it("keeps hostname-detected providers", () => {
    const detected: RepoInfo = { owner: "acme", name: "repo", provider: "github", url: "https://github.com/acme/repo" };
    expect(resolveRepoInfo(detected, {})).toEqual(detected);
  });

  it("prefers the override over detection", () => {
    const detected: RepoInfo = { owner: "acme", name: "repo", provider: "github", url: "https://github.com/acme/repo" };
    expect(resolveRepoInfo(detected, { LINEAR_VCS_PROVIDER: "GitLab" }).provider).toBe("gitlab");
  });

  it("throws on an invalid override", () => {
    const error = captureError(() => resolveRepoInfo(selfHosted, { LINEAR_VCS_PROVIDER: "gitea" }));
    expect(error.code).toBe("invalid-provider-override");
    expect(error.details).toEqual({ value: "gitea" });
  });

  it("infers gitlab on GitLab CI when the remote host matches CI_SERVER_HOST", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    expect(resolveRepoInfo(selfHosted, env).provider).toBe("gitlab");
  });

  it("infers gitlab when clone_url rewrites the host but the project path matches", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const rewritten = { ...selfHosted, url: "https://192.168.1.23/group/subgroup/repo" };
    expect(resolveRepoInfo(rewritten, env).provider).toBe("gitlab");
  });

  it("matches hosts case-insensitively and ignores the port", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    const withPort = { ...selfHosted, url: "https://Git.Example.com:8443/group/subgroup/repo" };
    expect(resolveRepoInfo(withPort, env).provider).toBe("gitlab");
  });

  it("throws for a foreign clone when both host and project path mismatch", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const foreign: RepoInfo = {
      owner: "acme",
      name: "other",
      provider: null,
      url: "https://git.other.example/acme/other",
    };
    expect(captureError(() => resolveRepoInfo(foreign, env)).code).toBe("unknown-provider");
  });

  it("throws an actionable error outside CI for an unknown host", () => {
    const error = captureError(() => resolveRepoInfo(selfHosted, {}));
    expect(error.code).toBe("unknown-provider");
    expect(error.details).toEqual({ host: "git.example.com" });
    expect(error.message).toContain('Could not determine the VCS provider for remote host "git.example.com"');
    expect(error.message).toContain("Set LINEAR_VCS_PROVIDER=github|gitlab|bitbucket");
  });
});
