import { describe, expect, it } from "vitest";
import { getCLIWarnings, parseCLIArgs } from "./args";
import { LogLevel } from "./log";

describe("parseCLIArgs", () => {
  it("defaults command to sync when no positional given", () => {
    const result = parseCLIArgs([]);
    expect(result.command).toBe("sync");
  });

  it("parses explicit sync command", () => {
    const result = parseCLIArgs(["sync"]);
    expect(result.command).toBe("sync");
  });

  it("parses explicit complete command", () => {
    const result = parseCLIArgs(["complete"]);
    expect(result.command).toBe("complete");
  });

  it("parses explicit update command", () => {
    const result = parseCLIArgs(["update"]);
    expect(result.command).toBe("update");
  });

  it("parses --release-version", () => {
    const result = parseCLIArgs(["--release-version", "1.2.0"]);
    expect(result.releaseVersion).toBe("1.2.0");
  });

  it("parses --release-version with = syntax", () => {
    const result = parseCLIArgs(["--release-version=1.2.0"]);
    expect(result.releaseVersion).toBe("1.2.0");
  });

  it("parses --name", () => {
    const result = parseCLIArgs(["--name", "Release 1.2.0"]);
    expect(result.releaseName).toBe("Release 1.2.0");
  });

  it("parses --stage", () => {
    const result = parseCLIArgs(["--stage", "production"]);
    expect(result.stageName).toBe("production");
  });

  it("parses --base-ref", () => {
    const result = parseCLIArgs(["--base-ref", "v1.2.3"]);
    expect(result.baseRef).toBe("v1.2.3");
  });

  it("parses --base-ref with = syntax", () => {
    const result = parseCLIArgs(["--base-ref=main~5"]);
    expect(result.baseRef).toBe("main~5");
  });

  it("defaults --json to false", () => {
    const result = parseCLIArgs([]);
    expect(result.jsonOutput).toBe(false);
  });

  it("parses --json to true when passed", () => {
    const result = parseCLIArgs(["--json"]);
    expect(result.jsonOutput).toBe(true);
  });

  it("splits --include-paths by comma and trims whitespace", () => {
    const result = parseCLIArgs(["--include-paths", "apps/web/** , packages/** , libs/core/**"]);
    expect(result.includePaths).toEqual(["apps/web/**", "packages/**", "libs/core/**"]);
  });

  it("returns empty array for --include-paths with empty string", () => {
    const result = parseCLIArgs(["--include-paths", ""]);
    expect(result.includePaths).toEqual([]);
  });

  it("returns empty array when --include-paths is not provided", () => {
    const result = parseCLIArgs([]);
    expect(result.includePaths).toEqual([]);
  });

  it("parses command combined with multiple options", () => {
    const result = parseCLIArgs(["update", "--stage=production", "--release-version", "1.2.0", "--json"]);
    expect(result.command).toBe("update");
    expect(result.stageName).toBe("production");
    expect(result.releaseVersion).toBe("1.2.0");
    expect(result.jsonOutput).toBe(true);
  });

  it("strips empty entries from --include-paths with trailing/leading commas", () => {
    const result = parseCLIArgs(["--include-paths", ",apps/web/**,packages/**,"]);
    expect(result.includePaths).toEqual(["apps/web/**", "packages/**"]);
  });

  it("parses repeatable --link values", () => {
    const result = parseCLIArgs([
      "sync",
      "--link",
      "Pipeline=https://ci.example.com/run/123?attempt=1",
      "--link=GitHub release=https://github.com/acme/app/releases/tag/v1.2.0",
    ]);

    expect(result.links).toEqual([
      { label: "Pipeline", url: "https://ci.example.com/run/123?attempt=1" },
      { label: "GitHub release", url: "https://github.com/acme/app/releases/tag/v1.2.0" },
    ]);
  });

  it("parses --link with a bare URL and derives the label", () => {
    const result = parseCLIArgs(["sync", "--link", "https://github.com/acme/app/actions/runs/123"]);

    expect(result.links).toEqual([{ url: "https://github.com/acme/app/actions/runs/123" }]);
  });

  it("parses --link with a bare URL containing equals signs", () => {
    const result = parseCLIArgs(["sync", "--link", "https://ci.example.com/run?id=123&attempt=1"]);

    expect(result.links).toEqual([{ url: "https://ci.example.com/run?id=123&attempt=1" }]);
  });

  it("trims --link labels and URLs", () => {
    const result = parseCLIArgs(["sync", "--link", " Pipeline = https://ci.example.com/run/123 "]);

    expect(result.links).toEqual([{ label: "Pipeline", url: "https://ci.example.com/run/123" }]);
  });

  it("throws on --link with neither URL nor label separator", () => {
    expect(() => parseCLIArgs(["sync", "--link", "not-a-url"])).toThrow('Invalid --link value: "not-a-url"');
  });

  it("throws on --link with empty label", () => {
    expect(() => parseCLIArgs(["sync", "--link", "=https://ci.example.com/run/123"])).toThrow(
      "Link label must not be empty",
    );
  });

  it("throws on --link with empty URL", () => {
    expect(() => parseCLIArgs(["sync", "--link", "Pipeline="])).toThrow("Link URL must not be empty");
  });

  it("accepts non-http URL schemes and defers protocol validation to the server", () => {
    const result = parseCLIArgs(["sync", "--link", "Pipeline=ftp://ci.example.com/run/123"]);

    expect(result.links).toEqual([{ label: "Pipeline", url: "ftp://ci.example.com/run/123" }]);
  });

  it("parses --link with complete", () => {
    const result = parseCLIArgs(["complete", "--link", "Pipeline=https://ci.example.com/run/123"]);

    expect(result.links).toEqual([{ label: "Pipeline", url: "https://ci.example.com/run/123" }]);
  });

  it("parses --link with update", () => {
    const result = parseCLIArgs(["update", "--stage", "production", "--link", "https://ci.example.com/run/123"]);

    expect(result.links).toEqual([{ url: "https://ci.example.com/run/123" }]);
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseCLIArgs(["--unknown-flag"])).toThrow();
  });

  it("returns no warning when --name is used with update", () => {
    const result = parseCLIArgs(["update", "--name", "Release 1.2.0"]);
    expect(getCLIWarnings(result)).toEqual([]);
  });

  it("returns no warning when --name is used with complete", () => {
    const result = parseCLIArgs(["complete", "--name", "Release 1.2.0"]);
    expect(getCLIWarnings(result)).toEqual([]);
  });

  it("returns no warning when --name is used with sync", () => {
    const result = parseCLIArgs(["sync", "--name", "Release 1.2.0"]);
    expect(getCLIWarnings(result)).toEqual([]);
  });

  it("defaults --timeout to 60 seconds", () => {
    const result = parseCLIArgs([]);
    expect(result.timeoutSeconds).toBe(60);
  });

  it("parses --timeout with space syntax", () => {
    const result = parseCLIArgs(["--timeout", "120"]);
    expect(result.timeoutSeconds).toBe(120);
  });

  it("parses --timeout with = syntax", () => {
    const result = parseCLIArgs(["--timeout=30"]);
    expect(result.timeoutSeconds).toBe(30);
  });

  it("throws on non-numeric --timeout", () => {
    expect(() => parseCLIArgs(["--timeout", "abc"])).toThrow('Invalid --timeout value: "abc"');
  });

  it("throws on zero --timeout", () => {
    expect(() => parseCLIArgs(["--timeout", "0"])).toThrow('Invalid --timeout value: "0"');
  });

  it("throws on negative --timeout", () => {
    expect(() => parseCLIArgs(["--timeout=-5"])).toThrow('Invalid --timeout value: "-5"');
  });

  it("defaults logLevel to Default", () => {
    const result = parseCLIArgs([]);
    expect(result.logLevel).toBe(LogLevel.Default);
  });

  it("parses --quiet to LogLevel.Quiet", () => {
    const result = parseCLIArgs(["--quiet"]);
    expect(result.logLevel).toBe(LogLevel.Quiet);
  });

  it("parses --verbose to LogLevel.Verbose", () => {
    const result = parseCLIArgs(["--verbose"]);
    expect(result.logLevel).toBe(LogLevel.Verbose);
  });

  it("throws when --quiet and --verbose are both passed", () => {
    expect(() => parseCLIArgs(["--quiet", "--verbose"])).toThrow("Conflicting log level flags");
  });
});
