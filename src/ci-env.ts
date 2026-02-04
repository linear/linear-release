export interface CIEnvironment {
  name: string;
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
  if (process.env.CI === "true") {
    return { name: "ci" };
  }
  return null;
}
