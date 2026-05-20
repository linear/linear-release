import { parseArgs } from "node:util";
import { LogLevel } from "./log";

export type ReleaseLink = {
  label?: string;
  url: string;
};

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  baseRef?: string;
  includePaths: string[];
  links: ReleaseLink[];
  jsonOutput: boolean;
  timeoutSeconds: number;
  logLevel: LogLevel;
};

function parseReleaseLink(value: string): ReleaseLink {
  const bareUrl = parseAbsoluteUrl(value.trim());
  if (bareUrl) {
    return { url: bareUrl.href };
  }

  const separatorIndex = value.indexOf("=");
  if (separatorIndex === -1) {
    throw new Error(`Invalid --link value: "${value}". Expected "https://example.com" or "Label=https://example.com".`);
  }
  const label = value.slice(0, separatorIndex).trim();
  const url = value.slice(separatorIndex + 1).trim();
  if (!label) {
    throw new Error(`Invalid --link value: "${value}". Link label must not be empty.`);
  }
  if (!url) {
    throw new Error(`Invalid --link value: "${value}". Link URL must not be empty.`);
  }

  const parsedUrl = parseAbsoluteUrl(url);
  if (!parsedUrl) {
    throw new Error(`Invalid --link URL: "${url}". Expected an absolute URL with a scheme (e.g. https://example.com).`);
  }

  return { label, url: parsedUrl.href };
}

function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function parseCLIArgs(argv: string[]): ParsedCLIArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "release-version": { type: "string" },
      stage: { type: "string" },
      "base-ref": { type: "string" },
      "include-paths": { type: "string" },
      link: { type: "string", multiple: true },
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

  const command = positionals[0] || "sync";
  const links = (values.link ?? []).map(parseReleaseLink);

  return {
    command,
    releaseName: values.name,
    releaseVersion: values["release-version"],
    stageName: values.stage,
    baseRef: values["base-ref"],
    includePaths: values["include-paths"]
      ? values["include-paths"]
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [],
    links,
    jsonOutput: values.json ?? false,
    timeoutSeconds,
    logLevel,
  };
}

export function getCLIWarnings(_args: ParsedCLIArgs): string[] {
  return [];
}
