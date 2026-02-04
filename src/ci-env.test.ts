import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectCIEnvironment } from "./ci-env";

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
