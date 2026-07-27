import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigurationError, detectCIEnvironment, inferProviderFromCI } from "./ci-env";
import { parseRepoUrl } from "./git";

function remote(url: string) {
  const parsed = parseRepoUrl(url);
  if (!parsed) {
    throw new Error(`Could not parse test remote ${url}`);
  }
  return parsed;
}

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
  it("infers when the CI host matches even if the project path differs", () => {
    expect(
      inferProviderFromCI(
        { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/other-repo" },
        remote("https://git.example.com/group/checked-out-repo.git"),
      ),
    ).toEqual({ provider: "gitlab" });
  });

  it("infers when clone_url rewrites the host but the project path matches", () => {
    expect(
      inferProviderFromCI(
        {
          GITLAB_CI: "true",
          CI_SERVER_HOST: "gitlab.example.com",
          CI_PROJECT_PATH: "group/project",
          CI_PROJECT_URL: "https://gitlab.example.com/group/project",
        },
        remote("https://clone.internal/group/project.git"),
      ),
    ).toEqual({
      provider: "gitlab",
      owner: "group",
      name: "project",
      url: "https://gitlab.example.com/group/project",
    });
  });

  it("does not infer for a foreign clone when both host and path mismatch", () => {
    expect(
      inferProviderFromCI(
        { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com", CI_PROJECT_PATH: "group/project" },
        remote("https://foreign.example.com/other/repository.git"),
      ),
    ).toBeNull();
  });

  describe("GitLab", () => {
    it("preserves nested-group repository identity", () => {
      expect(
        inferProviderFromCI(
          {
            GITLAB_CI: "true",
            CI_PROJECT_PATH: "org/group/subgroup/repo",
            CI_PROJECT_URL: "https://git.example.com/org/group/subgroup/repo",
          },
          remote("https://clone.internal/org/group/subgroup/repo.git"),
        ),
      ).toMatchInlineSnapshot(`
        {
          "name": "group/subgroup/repo",
          "owner": "org",
          "provider": "gitlab",
          "url": "https://git.example.com/org/group/subgroup/repo",
        }
      `);
    });

    it("corrects a relative-URL install with the canonical project URL", () => {
      expect(
        inferProviderFromCI(
          {
            GITLAB_CI: "true",
            CI_PROJECT_PATH: "group/repo",
            CI_PROJECT_URL: "https://example.com/gitlab/group/repo",
          },
          remote("https://example.com/gitlab/group/repo.git"),
        ),
      ).toEqual({
        provider: "gitlab",
        owner: "group",
        name: "repo",
        url: "https://example.com/gitlab/group/repo",
      });
    });

    it("binds token-bearing runner URLs by path", () => {
      expect(
        inferProviderFromCI(
          {
            GITLAB_CI: "true",
            CI_PROJECT_PATH: "group/repo",
            CI_PROJECT_URL: "https://git.example.com/group/repo",
          },
          remote("https://gitlab-ci-token:secret@runner.internal/group/repo.git"),
        ),
      ).toEqual({
        provider: "gitlab",
        owner: "group",
        name: "repo",
        url: "https://git.example.com/group/repo",
      });
    });

    it("uses CI_SERVER_SHELL_SSH_HOST as a binding host", () => {
      expect(
        inferProviderFromCI(
          { GITLAB_CI: "true", CI_SERVER_SHELL_SSH_HOST: "ssh.git.example.com" },
          remote("ssh://git@ssh.git.example.com:2222/group/repo.git"),
        ),
      ).toEqual({ provider: "gitlab" });
    });

    it("matches CI_PROJECT_PATH literally when it contains regex metacharacters", () => {
      expect(
        inferProviderFromCI(
          {
            GITLAB_CI: "true",
            CI_PROJECT_PATH: "group[one]/repo.+",
            CI_PROJECT_URL: "https://git.example.com/group[one]/repo.+",
          },
          remote("https://clone.internal/group[one]/repo.+.git"),
        ),
      ).toEqual({
        provider: "gitlab",
        owner: "group[one]",
        name: "repo.+",
        url: "https://git.example.com/group[one]/repo.+",
      });
    });

    it("infers without enrichment when pre-15.11 variables are absent", () => {
      expect(
        inferProviderFromCI(
          { GITLAB_CI: "true", CI_SERVER_HOST: "git.example.com" },
          remote("https://git.example.com/group/repo.git"),
        ),
      ).toEqual({ provider: "gitlab" });
    });
  });

  it("enriches GitHub Actions repositories from the bound repository path", () => {
    expect(
      inferProviderFromCI(
        {
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.enterprise.example",
          GITHUB_REPOSITORY: "octo/project",
        },
        remote("https://clone.internal/octo/project.git"),
      ),
    ).toEqual({
      provider: "github",
      owner: "octo",
      name: "project",
      url: "https://github.enterprise.example/octo/project",
    });
  });

  it("infers Bitbucket from a bound Pipelines origin", () => {
    expect(
      inferProviderFromCI(
        { BITBUCKET_GIT_HTTP_ORIGIN: "https://bitbucket.internal/workspace/repo.git" },
        remote("https://clone.internal/workspace/repo.git"),
      ),
    ).toEqual({ provider: "bitbucket" });
  });

  describe("Buildkite", () => {
    it("accepts enterprise provider variants at the documented boundary", () => {
      expect(
        inferProviderFromCI(
          { BUILDKITE_PIPELINE_PROVIDER: " github_enterprise ", BUILDKITE_REPO: "git@code.example.com:team/repo.git" },
          remote("https://clone.internal/team/repo.git"),
        ),
      ).toEqual({ provider: "github" });
    });

    it("does not match provider prefixes outside the boundary", () => {
      expect(
        inferProviderFromCI(
          { BUILDKITE_PIPELINE_PROVIDER: "githubish", BUILDKITE_REPO: "https://code.example.com/team/repo.git" },
          remote("https://code.example.com/team/repo.git"),
        ),
      ).toBeNull();
    });
  });

  describe("Azure Pipelines", () => {
    it("raises the Azure Repos configuration error for a bound TfsGit repository", () => {
      expect(() =>
        inferProviderFromCI(
          { BUILD_REPOSITORY_PROVIDER: "TfsGit", BUILD_REPOSITORY_URI: "https://dev.azure.com/org/project/_git/repo" },
          remote("https://dev.azure.com/org/project/_git/repo.git"),
        ),
      ).toThrow(ConfigurationError);
      try {
        inferProviderFromCI(
          { BUILD_REPOSITORY_PROVIDER: "TfsGit", BUILD_REPOSITORY_URI: "https://dev.azure.com/org/project/_git/repo" },
          remote("https://dev.azure.com/org/project/_git/repo.git"),
        );
      } catch (error) {
        expect(error).toMatchObject({ code: "unsupported-azure-repos" });
      }
    });

    it("only infers observed Bitbucket support with URI corroboration", () => {
      expect(
        inferProviderFromCI(
          { BUILD_REPOSITORY_PROVIDER: "Bitbucket", BUILD_REPOSITORY_URI: "https://bitbucket.example/team/repo.git" },
          remote("https://foreign.example/other/repo.git"),
        ),
      ).toBeNull();
      expect(
        inferProviderFromCI(
          { BUILD_REPOSITORY_PROVIDER: "Bitbucket", BUILD_REPOSITORY_URI: "https://bitbucket.example/team/repo.git" },
          remote("https://clone.internal/team/repo.git"),
        ),
      ).toEqual({ provider: "bitbucket" });
    });
  });

  it("maps AppVeyor provider prefixes when the repository path is bound", () => {
    expect(
      inferProviderFromCI(
        { APPVEYOR_REPO_PROVIDER: "gitLabEnterprise", APPVEYOR_REPO_NAME: "group/repo" },
        remote("https://clone.internal/group/repo.git"),
      ),
    ).toEqual({ provider: "gitlab" });
    expect(
      inferProviderFromCI(
        { APPVEYOR_REPO_PROVIDER: "stash", APPVEYOR_REPO_NAME: "team/repo" },
        remote("https://clone.internal/team/repo.git"),
      ),
    ).toEqual({ provider: "bitbucket" });
  });

  it("infers Semaphore's documented providers only for a bound repository", () => {
    expect(
      inferProviderFromCI(
        { SEMAPHORE_GIT_PROVIDER: "github", SEMAPHORE_GIT_URL: "https://github.example/team/repo.git" },
        remote("https://clone.internal/team/repo.git"),
      ),
    ).toEqual({ provider: "github" });
    expect(
      inferProviderFromCI(
        { SEMAPHORE_GIT_PROVIDER: "gitlab", SEMAPHORE_GIT_URL: "https://gitlab.example/team/repo.git" },
        remote("https://clone.internal/team/repo.git"),
      ),
    ).toBeNull();
  });

  it("falls through unknown values and signal-less CI platforms", () => {
    expect(
      inferProviderFromCI(
        {
          CIRCLECI: "true",
          BUILDKITE_PIPELINE_PROVIDER: "forgejo",
          BUILD_REPOSITORY_PROVIDER: "Git",
          APPVEYOR_REPO_PROVIDER: "unknown",
        },
        remote("https://code.example/team/repo.git"),
      ),
    ).toBeNull();
  });

  it("falls through when simultaneous CI signals infer different providers", () => {
    expect(
      inferProviderFromCI(
        {
          GITLAB_CI: "true",
          CI_SERVER_HOST: "gitlab.example",
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.example",
        },
        remote("https://gitlab.example/team/repo.git"),
      ),
    ).toEqual({ provider: "gitlab" });

    expect(
      inferProviderFromCI(
        {
          GITLAB_CI: "true",
          CI_PROJECT_PATH: "team/repo",
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "team/repo",
        },
        remote("https://clone.example/team/repo.git"),
      ),
    ).toBeNull();
  });
});
