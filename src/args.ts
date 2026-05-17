import { parseArgs } from "node:util";
import { LogLevel } from "./log";

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  includePaths: string[];
  includeMessages: string | null;
  jsonOutput: boolean;
  timeoutSeconds: number;
  logLevel: LogLevel;
};

export function parseCLIArgs(argv: string[]): ParsedCLIArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "release-version": { type: "string" },
      stage: { type: "string" },
      "include-paths": { type: "string" },
      "include-messages": { type: "string" },
      json: { type: "boolean", default: false },
      timeout: { type: "string" },
      quiet: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
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

  let includeMessages: string | null = null;
  const rawIncludeMessages = values["include-messages"];
  if (rawIncludeMessages !== undefined && rawIncludeMessages.length > 0) {
    try {
      new RegExp(rawIncludeMessages);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid --include-messages regex: ${detail}`);
    }
    includeMessages = rawIncludeMessages;
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
    includeMessages,
    jsonOutput: values.json ?? false,
    timeoutSeconds,
    logLevel,
  };
}

export function getCLIWarnings(_args: ParsedCLIArgs): string[] {
  return [];
}
