import { parseArgs } from "node:util";

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  includePaths: string[];
  jsonOutput: boolean;
  timeoutSeconds: number;
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
  };
}

export function getCLIWarnings(args: ParsedCLIArgs): string[] {
  const warnings: string[] = [];

  if (args.releaseName && args.command !== "sync") {
    warnings.push(`--name is ignored for "${args.command}" command; it only applies to "sync"`);
  }

  return warnings;
}
