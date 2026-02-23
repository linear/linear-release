import { parseArgs } from "node:util";

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  includePaths: string[];
  jsonOutput: boolean;
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
    },
    allowPositionals: true,
    strict: true,
  });

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
  };
}

export function getCLIWarnings(args: ParsedCLIArgs): string[] {
  const warnings: string[] = [];

  if (args.releaseName && args.command !== "sync") {
    warnings.push(`--name is ignored for "${args.command}" command; it only applies to "sync"`);
  }

  return warnings;
}
