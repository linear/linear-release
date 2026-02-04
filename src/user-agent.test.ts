import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildUserAgent } from "./user-agent";

// Mock the version module
vi.mock("./version", () => ({
  getCliVersion: vi.fn(() => "1.2.3"),
}));

const originalEnv = process.env;

describe("buildUserAgent", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    // Ensure our CI environment is not detected
    delete process.env.GITHUB_ACTIONS;
    delete process.env.CI;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds user agent for local environment", () => {
    const userAgent = buildUserAgent();
    expect(userAgent).toBe("linear-release/1.2.3 (local)");
  });

  it("builds user agent for GitHub Actions", () => {
    process.env.GITHUB_ACTIONS = "true";
    const userAgent = buildUserAgent();
    expect(userAgent).toBe("linear-release/1.2.3 (github-actions)");
  });

  it("builds user agent for GitLab CI", () => {
    process.env.GITLAB_CI = "true";
    const userAgent = buildUserAgent();
    expect(userAgent).toBe("linear-release/1.2.3 (gitlab-ci)");
  });
});
