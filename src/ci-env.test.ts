import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectCIEnvironment, inferProviderFromCI, parseProvider } from "./ci-env";

describe("detectCIEnvironment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.BUILD_TAG;
    delete process.env.TRAVIS;
    delete process.env.TF_BUILD;
    delete process.env.BUILDKITE;
    delete process.env.TEAMCITY_VERSION;
    delete process.env.RWX;
    delete process.env.CI;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("detects GitHub Actions", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(detectCIEnvironment()).toEqual({ name: "github-actions" });
  });

  it("detects GitLab CI", () => {
    process.env.GITLAB_CI = "true";
    expect(detectCIEnvironment()).toEqual({ name: "gitlab-ci" });
  });

  it("detects CircleCI", () => {
    process.env.CIRCLECI = "true";
    expect(detectCIEnvironment()).toEqual({ name: "circleci" });
  });

  it("detects Jenkins", () => {
    process.env.BUILD_TAG = "jenkins-my-job-123";
    expect(detectCIEnvironment()).toEqual({ name: "jenkins" });
  });

  it("detects Travis CI", () => {
    process.env.TRAVIS = "true";
    expect(detectCIEnvironment()).toEqual({ name: "travis-ci" });
  });

  it("detects Azure Pipelines", () => {
    process.env.TF_BUILD = "True";
    expect(detectCIEnvironment()).toEqual({ name: "azure-pipelines" });
  });

  it("detects Buildkite", () => {
    process.env.BUILDKITE = "true";
    expect(detectCIEnvironment()).toEqual({ name: "buildkite" });
  });

  it("detects TeamCity", () => {
    process.env.TEAMCITY_VERSION = "2023.05";
    expect(detectCIEnvironment()).toEqual({ name: "teamcity" });
  });

  it("detects RWX", () => {
    process.env.RWX = "true";
    expect(detectCIEnvironment()).toEqual({ name: "rwx" });
  });

  it("detects generic CI", () => {
    process.env.CI = "true";
    expect(detectCIEnvironment()).toEqual({ name: "ci" });
  });

  it("returns null when not in CI", () => {
    expect(detectCIEnvironment()).toBeNull();
  });

  it("prioritizes GitHub Actions over generic CI", () => {
    process.env.CI = "true";
    process.env.GITHUB_ACTIONS = "true";
    expect(detectCIEnvironment()).toEqual({ name: "github-actions" });
  });
});

describe("inferProviderFromCI", () => {
  const repoInfo = {
    owner: "group",
    name: "subgroup/repo",
    provider: null,
    url: "https://git.example.com/group/subgroup/repo",
  };

  it("infers gitlab when the remote host matches CI_SERVER_HOST", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    expect(inferProviderFromCI(env, repoInfo)).toBe("gitlab");
  });

  it("infers gitlab when clone_url rewrites the host but the project path matches", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const rewritten = { ...repoInfo, url: "https://192.168.1.23/group/subgroup/repo" };
    expect(inferProviderFromCI(env, rewritten)).toBe("gitlab");
  });

  it("does not infer for a foreign clone when both host and path mismatch", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/subgroup/repo" };
    const foreign = { owner: "acme", name: "other", provider: null, url: "https://git.other.example/acme/other" };
    expect(inferProviderFromCI(env, foreign)).toBeNull();
  });

  it("matches hosts case-insensitively and ignores the port", () => {
    const env = { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" };
    const withPort = { ...repoInfo, url: "https://Git.Example.com:8443/group/subgroup/repo" };
    expect(inferProviderFromCI(env, withPort)).toBe("gitlab");
  });

  it("does not infer outside GitLab CI", () => {
    expect(inferProviderFromCI({ CI_SERVER_HOST: "git.example.com" }, repoInfo)).toBeNull();
  });
});

describe("parseProvider", () => {
  it("accepts the three providers case-insensitively", () => {
    expect(parseProvider("GitLab")).toBe("gitlab");
    expect(parseProvider(" github ")).toBe("github");
    expect(parseProvider("bitbucket")).toBe("bitbucket");
  });

  it("rejects anything else", () => {
    expect(parseProvider("gitea")).toBeNull();
    expect(parseProvider(null)).toBeNull();
    expect(parseProvider(undefined)).toBeNull();
  });
});
