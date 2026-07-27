import { describe, expect, it } from "vitest";
import { ConfigurationError, parseRepoUrl, resolveRepoInfo } from "./provider";
import type { RepoInfo } from "./types";

const selfHosted: RepoInfo = {
  owner: "group",
  name: "subgroup/repo",
  host: "git.example.com",
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

describe("parseRepoUrl", () => {
  it("parses HTTPS URLs with and without .git suffix", () => {
    const expected = {
      owner: "linear",
      name: "linear-app",
      host: "github.com",
      url: "https://github.com/linear/linear-app",
    };
    expect(parseRepoUrl("https://github.com/linear/linear-app.git")).toEqual(expected);
    expect(parseRepoUrl("https://github.com/linear/linear-app")).toEqual(expected);
  });

  it("parses SSH URLs with and without .git suffix", () => {
    const expected = {
      owner: "myorg",
      name: "myrepo",
      host: "gitlab.com",
      url: "https://gitlab.com/myorg/myrepo",
    };
    expect(parseRepoUrl("git@gitlab.com:myorg/myrepo.git")).toEqual(expected);
    expect(parseRepoUrl("git@gitlab.com:myorg/myrepo")).toEqual(expected);
  });

  it("folds nested groups into the name segment", () => {
    for (const url of [
      "https://gitlab.com/org/group/subgroup/repo.git",
      "git@gitlab.com:org/group/subgroup/repo.git",
    ]) {
      expect(parseRepoUrl(url)).toEqual({
        owner: "org",
        name: "group/subgroup/repo",
        host: "gitlab.com",
        url: "https://gitlab.com/org/group/subgroup/repo",
      });
    }
  });

  it("strips credentials from HTTPS URLs", () => {
    expect(parseRepoUrl("https://token@github.com/linear/linear-app.git")).toEqual({
      owner: "linear",
      name: "linear-app",
      host: "github.com",
      url: "https://github.com/linear/linear-app",
    });
  });

  it("keeps custom hosts verbatim", () => {
    expect(parseRepoUrl("git@git.example.com:group/repo.git")).toEqual({
      owner: "group",
      name: "repo",
      host: "git.example.com",
      url: "https://git.example.com/group/repo",
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseRepoUrl("not-a-url")).toBeNull();
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl(null)).toBeNull();
  });
});

describe("resolveRepoInfo", () => {
  it("returns null without a repo", () => {
    expect(resolveRepoInfo(null, {})).toBeNull();
  });

  it.each([
    ["https://github.com/acme/repo.git", "github"],
    ["https://github.mycompany.com/acme/repo.git", "github"],
    ["https://tenant.ghe.com/acme/repo.git", "github"],
    ["git@gitlab.com:acme/repo.git", "gitlab"],
    ["https://gitlab.internal.io/acme/repo.git", "gitlab"],
    ["https://bitbucket.org/acme/repo.git", "bitbucket"],
    ["https://bitbucket.mycompany.com/acme/repo.git", "bitbucket"],
  ])("detects the provider from the hostname of %s", (url, provider) => {
    expect(resolveRepoInfo(parseRepoUrl(url), {})?.provider).toBe(provider);
  });

  it.each(["https://ghe.com/acme/repo.git", "https://evil-ghe.com.attacker.com/acme/repo.git"])(
    "does not treat %s as GitHub Enterprise Cloud",
    (url) => {
      expect(captureError(() => resolveRepoInfo(parseRepoUrl(url), {})).code).toBe("unknown-provider");
    },
  );

  it("prefers the override over detection", () => {
    const detected = parseRepoUrl("https://github.com/acme/repo.git");
    expect(resolveRepoInfo(detected, { LINEAR_VCS_PROVIDER: "GitLab" })?.provider).toBe("gitlab");
  });

  it("treats an empty override as unset", () => {
    const detected = parseRepoUrl("https://github.com/acme/repo.git");
    expect(resolveRepoInfo(detected, { LINEAR_VCS_PROVIDER: "" })?.provider).toBe("github");
  });

  it("throws on an invalid override", () => {
    const error = captureError(() => resolveRepoInfo(selfHosted, { LINEAR_VCS_PROVIDER: "gitea" }));
    expect(error.code).toBe("invalid-provider-override");
    expect(error.message).toContain('Invalid LINEAR_VCS_PROVIDER value "gitea"');
  });

  it("infers gitlab on GitLab CI when the remote host matches CI_SERVER_HOST", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    expect(resolveRepoInfo(selfHosted, env)?.provider).toBe("gitlab");
  });

  it("infers gitlab when clone_url rewrites the host but the project path matches", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const rewritten = { ...selfHosted, host: "192.168.1.23", url: "https://192.168.1.23/group/subgroup/repo" };
    expect(resolveRepoInfo(rewritten, env)?.provider).toBe("gitlab");
  });

  it("matches hosts case-insensitively and ignores the port", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    const withPort = {
      ...selfHosted,
      host: "Git.Example.com:8443",
      url: "https://Git.Example.com:8443/group/subgroup/repo",
    };
    expect(resolveRepoInfo(withPort, env)?.provider).toBe("gitlab");
  });

  it("throws for a foreign clone when both host and project path mismatch", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const foreign = parseRepoUrl("https://git.other.example/acme/other.git");
    expect(captureError(() => resolveRepoInfo(foreign, env)).code).toBe("unknown-provider");
  });

  it("throws an actionable error outside CI for an unknown host", () => {
    const error = captureError(() => resolveRepoInfo(selfHosted, {}));
    expect(error.code).toBe("unknown-provider");
    expect(error.message).toContain('Could not determine the VCS provider for remote host "git.example.com"');
    expect(error.message).toContain("Set LINEAR_VCS_PROVIDER=github|gitlab|bitbucket");
  });
});
