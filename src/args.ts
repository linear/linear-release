import { parseArgs } from "node:util";

export function parseCLIArgs(argv: string[]) {
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
