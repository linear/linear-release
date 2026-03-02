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
      debug: { type: "boolean", default: false },
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

  const levelFlags = [values.quiet && "quiet", values.verbose && "verbose", values.debug && "debug"].filter(Boolean);
  if (levelFlags.length > 1) {
    throw new Error(`Conflicting log level flags: --${levelFlags.join(", --")}. Use only one.`);
  }

  let logLevel = LogLevel.Default;
  if (values.quiet) logLevel = LogLevel.Quiet;
  else if (values.verbose) logLevel = LogLevel.Verbose;
  else if (values.debug) logLevel = LogLevel.Debug;

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
  };
}

export function getCLIWarnings(args: ParsedCLIArgs): string[] {
  const warnings: string[] = [];

  if (args.releaseName && args.command !== "sync") {
    warnings.push(`--name is ignored for "${args.command}" command; it only applies to "sync"`);
  }

  return warnings;
}
