import { parseArgs } from "node:util";
import { LogLevel } from "./log";

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  includePaths: string[];
  jsonOutput: boolean;
  timeoutSeconds: number;
  logLevel: LogLevel;
  issueIdPattern?: RegExp;
};

export function parseCLIArgs(argv: string[]): ParsedCLIArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "release-version": { type: "string" },
      stage: { type: "string" },
      "include-paths": { type: "string" },
      json: { type: "boolean", default: false },
      timeout: { type: "string" },
      quiet: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      "issue-id-pattern": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const DEFAULT_TIMEOUT_SECONDS = 60;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (values.timeout !== undefined) {
    const parsed = Number(values.timeout);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid --timeout value: "${values.timeout}". Must be a positive number of seconds.`);
    }
    timeoutSeconds = parsed;
  }

  if (values.quiet && values.verbose) {
    throw new Error("Conflicting log level flags: --quiet, --verbose. Use only one.");
  }

  let logLevel = LogLevel.Default;
  if (values.quiet) logLevel = LogLevel.Quiet;
  else if (values.verbose) logLevel = LogLevel.Verbose;

  let issueIdPattern: RegExp | undefined;
  const rawPattern = values["issue-id-pattern"];
  if (rawPattern !== undefined && rawPattern.length > 0) {
    // Reject `/source/flags` literal-regex syntax: `new RegExp("/foo/i")` would
    // silently match the text `/foo/i`, not what the user meant. The value is
    // always treated as the pattern source; flags can't be configured.
    if (/^\/.+\/[gimsuy]*$/.test(rawPattern)) {
      throw new Error(
        `Invalid --issue-id-pattern: pass the pattern source directly (e.g. '^\\[(.+?)\\]'), ` +
          `not as a /.../flags literal. Flags inside the value are not supported.`,
      );
    }
    try {
      issueIdPattern = new RegExp(rawPattern);
    } catch (error) {
      throw new Error(`Invalid --issue-id-pattern: ${(error as Error).message}`);
    }
    const groupCount = countCaptureGroups(issueIdPattern);
    if (groupCount !== 1) {
      throw new Error(
        `Invalid --issue-id-pattern: expected exactly one capture group, found ${groupCount}. ` +
          `Example: '^\\[(.+?)\\]' to detect '[LIN-123] My title'.`,
      );
    }
  }

  return {
    command: positionals[0] || "sync",
    releaseName: values.name,
    releaseVersion: values["release-version"],
    stageName: values.stage,
    includePaths: values["include-paths"]
      ? values["include-paths"]
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [],
    jsonOutput: values.json ?? false,
    timeoutSeconds,
    logLevel,
    issueIdPattern,
  };
}

/**
 * Count the capture groups in a regex by appending an empty alternative — the
 * resulting match against "" returns `groupCount + 1` elements.
 */
function countCaptureGroups(re: RegExp): number {
  // Append `|` so the empty string always matches; `exec` then returns one
  // entry per capture group plus the full match.
  const probe = new RegExp(`${re.source}|`);
  return probe.exec("")!.length - 1;
}

export function getCLIWarnings(_args: ParsedCLIArgs): string[] {
  return [];
}
