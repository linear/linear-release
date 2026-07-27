import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const tsxLoader = join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs");

type GraphQLRequest = {
  query: string;
  variables?: {
    input?: Record<string, unknown>;
  };
};

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

let requests: GraphQLRequest[] = [];
const repositories: string[] = [];
let mockDirectory: string;
let registerMock: string;
let requestLogSequence = 0;

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function createRepository(options: { remote?: string; message?: string } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "linear-release-index-"));
  repositories.push(cwd);
  runGit(cwd, "init");
  runGit(cwd, "config", "user.email", "test@example.com");
  runGit(cwd, "config", "user.name", "Test User");
  writeFileSync(join(cwd, "file.txt"), "content");
  runGit(cwd, "add", ".");
  runGit(cwd, "commit", "-m", options.message ?? "Initial commit");
  if (options.remote) {
    runGit(cwd, "remote", "add", "origin", options.remote);
  }
  return cwd;
}

function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const requestLog = join(mockDirectory, `requests-${requestLogSequence++}.jsonl`);
    const child = spawn(
      process.execPath,
      ["--import", registerMock, "--import", tsxLoader, join(repositoryRoot, "src", "index.ts"), ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "development",
          NODE_NO_WARNINGS: "1",
          LINEAR_ACCESS_KEY: "test-access-key",
          LINEAR_RELEASE_TEST_REQUESTS: requestLog,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      requests = existsSync(requestLog)
        ? readFileSync(requestLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as GraphQLRequest)
        : [];
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(() => {
  mockDirectory = mkdtempSync(join(tmpdir(), "linear-release-sdk-mock-"));
  registerMock = join(mockDirectory, "register.mjs");
  writeFileSync(
    registerMock,
    `import { registerHooks } from "node:module";
const stub = new URL("./sdk.cjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@linear/sdk") return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`,
  );
  writeFileSync(
    join(mockDirectory, "sdk.cjs"),
    `const { appendFileSync } = require("node:fs");
class LinearError extends Error {}
class RatelimitedLinearError extends LinearError {}
const LinearErrorType = {
  AuthenticationError: "AuthenticationError",
  Forbidden: "Forbidden",
  FeatureNotAccessible: "FeatureNotAccessible",
  GraphqlError: "GraphqlError",
  InvalidInput: "InvalidInput",
  UserError: "UserError",
  UsageLimitExceeded: "UsageLimitExceeded",
};
class LinearClient {
  constructor() {
    this.client = {
      setHeader() {},
      rawRequest: async (query, variables) => {
        appendFileSync(process.env.LINEAR_RELEASE_TEST_REQUESTS, JSON.stringify({ query, variables }) + "\\n");
        if (query.includes("pipelineSettingsByAccessKey")) {
          return { data: { releasePipelineByAccessKey: { includePathPatterns: [] } } };
        }
        if (query.includes("recentReleasesByAccessKey")) {
          return { data: { recentReleasesByAccessKey: [] } };
        }
        return {
          data: {
            releaseSyncByAccessKey: {
              success: true,
              release: {
                id: "release-id",
                name: "test-release",
                version: "1.0.0",
                url: "https://linear.app/release",
                commitSha: variables?.input?.commitSha,
                createdAt: "2026-07-27T00:00:00.000Z",
              },
            },
          },
        };
      },
    };
  }
}
module.exports = { LinearClient, LinearError, LinearErrorType, RatelimitedLinearError };
`,
  );
});

beforeEach(() => {
  requests = [];
});

afterAll(() => {
  for (const repository of repositories) {
    rmSync(repository, { recursive: true, force: true });
  }
  rmSync(mockDirectory, { recursive: true, force: true });
});

describe("provider detection", () => {
  it("infers gitlab on GitLab CI for a custom-domain remote", async () => {
    const cwd = createRepository({ remote: "git@git.example.com:group/repo.git" });
    const result = await runCli(cwd, ["sync"], {
      GITLAB_CI: "true",
      CI_SERVER_HOST: "git.example.com",
      CI_PROJECT_PATH: "group/repo",
    });
    const mutation = requests.find((request) => request.query.includes("mutation syncReleaseByAccessKey"));

    expect(result.code).toBe(0);
    expect(mutation?.variables?.input?.repository).toEqual({
      owner: "group",
      name: "repo",
      provider: "gitlab",
      url: "https://git.example.com/group/repo",
    });
  });

  it("uses the override ahead of detection", async () => {
    const cwd = createRepository({ remote: "https://git.example.com/group/repo.git" });
    const result = await runCli(cwd, ["sync"], {
      LINEAR_RELEASE_REPOSITORY_PROVIDER: "gitlab",
    });
    const mutation = requests.find((request) => request.query.includes("mutation syncReleaseByAccessKey"));

    expect(result.code).toBe(0);
    expect((mutation?.variables?.input?.repository as Record<string, unknown>)?.provider).toBe("gitlab");
  });
});

describe("provider configuration errors", () => {
  it("exits 2 with actionable copy before the mutation for an unknown provider", async () => {
    const cwd = createRepository({ remote: "https://git.example.com/acme/repo.git" });
    const result = await runCli(cwd, ["sync"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'Error: Could not determine the VCS provider for remote host "git.example.com".\n' +
        "Set LINEAR_RELEASE_REPOSITORY_PROVIDER=github|gitlab|bitbucket in your CI environment.\n",
    );
    expect(requests.some((request) => request.query.includes("mutation syncReleaseByAccessKey"))).toBe(false);
  });

  it("exits 2 for an invalid override", async () => {
    const cwd = createRepository({ remote: "https://github.com/acme/repo.git" });
    const result = await runCli(cwd, ["sync"], {
      LINEAR_RELEASE_REPOSITORY_PROVIDER: "gitea",
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid LINEAR_RELEASE_REPOSITORY_PROVIDER");
    expect(requests.some((request) => request.query.includes("mutation syncReleaseByAccessKey"))).toBe(false);
  });

  it("emits the machine-readable error code on stderr with --json", async () => {
    const cwd = createRepository({ remote: "https://git.example.com/acme/repo.git" });
    const result = await runCli(cwd, ["sync", "--json"]);
    const errorLine = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.error === "unknown-provider");

    expect(result.code).toBe(2);
    expect(errorLine).toEqual({ error: "unknown-provider", host: "git.example.com" });
    expect(result.stdout).toBe("");
  });

  it("still validates provider detection during a dry run", async () => {
    const cwd = createRepository({ remote: "https://git.example.com/acme/repo.git" });
    const result = await runCli(cwd, ["sync", "--dry-run"]);

    expect(result.code).toBe(2);
    expect(requests.some((request) => request.query.includes("mutation syncReleaseByAccessKey"))).toBe(false);
  });
});

describe("existing exit behavior and no-origin compatibility", () => {
  it("lists the provider override in help", async () => {
    const cwd = createRepository();
    const result = await runCli(cwd, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Environment:");
    expect(result.stdout).toContain("LINEAR_RELEASE_REPOSITORY_PROVIDER");
  });

  it("keeps existing errors on exit code 1", async () => {
    const cwd = createRepository();
    const result = await runCli(cwd, ["not-a-command"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown command "not-a-command"');
  });

  it("omits repository data and syncs when origin is absent", async () => {
    const cwd = createRepository();
    const result = await runCli(cwd, ["sync"]);
    const mutation = requests.find((request) => request.query.includes("mutation syncReleaseByAccessKey"));

    expect(result.code).toBe(0);
    expect(mutation).toBeDefined();
    expect(mutation?.variables?.input).not.toHaveProperty("repository");
  });

  it("omits repository data and syncs when the remote URL is unparseable", async () => {
    const cwd = createRepository({ remote: "/srv/git/repo.git" });
    const result = await runCli(cwd, ["sync"]);
    const mutation = requests.find((request) => request.query.includes("mutation syncReleaseByAccessKey"));

    expect(result.code).toBe(0);
    expect(mutation).toBeDefined();
    expect(mutation?.variables?.input).not.toHaveProperty("repository");
  });

  it("keeps the pull-request reference error when origin is absent", async () => {
    const cwd = createRepository({ message: "Fix regression (#42)" });
    const result = await runCli(cwd, ["sync"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Repository info is required to sync a release with pull request references");
    expect(requests.some((request) => request.query.includes("mutation syncReleaseByAccessKey"))).toBe(false);
  });
});
