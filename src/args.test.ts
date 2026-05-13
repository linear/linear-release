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

  it("defaults --issue-id-pattern to undefined", () => {
    const result = parseCLIArgs([]);
    expect(result.issueIdPattern).toBeUndefined();
  });

  it("parses --issue-id-pattern into a RegExp", () => {
    const result = parseCLIArgs(["--issue-id-pattern=^\\[(.+?)\\]"]);
    expect(result.issueIdPattern).toBeInstanceOf(RegExp);
    expect(result.issueIdPattern!.test("[LIN-1] foo")).toBe(true);
  });

  it("throws on invalid --issue-id-pattern regex", () => {
    expect(() => parseCLIArgs(["--issue-id-pattern=["])).toThrow("Invalid --issue-id-pattern");
  });

  it("throws on --issue-id-pattern with no capture group", () => {
    expect(() => parseCLIArgs(["--issue-id-pattern=^\\[.+?\\]"])).toThrow("exactly one capture group");
  });

  it("throws on --issue-id-pattern with multiple capture groups", () => {
    expect(() => parseCLIArgs(["--issue-id-pattern=^(\\[)(.+?)\\]"])).toThrow("exactly one capture group");
  });

  it("treats --issue-id-pattern='' as absent", () => {
    const result = parseCLIArgs(["--issue-id-pattern="]);
    expect(result.issueIdPattern).toBeUndefined();
  });

  it("rejects --issue-id-pattern passed as /source/flags literal", () => {
    expect(() => parseCLIArgs(["--issue-id-pattern=/^\\[(.+?)\\]/i"])).toThrow("pass the pattern source directly");
  });

  it("rejects --issue-id-pattern passed as /source/ literal with no flags", () => {
    expect(() => parseCLIArgs(["--issue-id-pattern=/^\\[(.+?)\\]/"])).toThrow("pass the pattern source directly");
  });
});
