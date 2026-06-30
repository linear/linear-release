import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { LogLevel } from "./log";

export type ReleaseLink = {
  label?: string;
  url: string;
};

/** Where the markdown body for a document or release notes comes from. */
export type ReleaseContentSource = { kind: "inline"; content: string } | { kind: "file"; path: string };

export type ReleaseDocumentSpec = {
  title: string;
  source: ReleaseContentSource;
};

export type ReleaseNoteSpec = {
  source: ReleaseContentSource;
};

export type ParsedCLIArgs = {
  command: string;
  releaseName?: string;
  releaseVersion?: string;
  stageName?: string;
  baseRef?: string;
  includePaths: string[];
  includeSubjects: string | null;
  issuePattern: string | null;
  links: ReleaseLink[];
  documents: ReleaseDocumentSpec[];
  releaseNotes?: ReleaseNoteSpec;
  jsonOutput: boolean;
  dryRun: boolean;
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

/** Splits `Title=value` once on `=`. Title is trimmed; value is returned verbatim so markdown whitespace survives. */
function splitTitleAndValue(raw: string, flag: string): { title: string; value: string } {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex === -1) {
    throw new Error(`Invalid ${flag} value: "${raw}". Expected "Title=<value>".`);
  }
  const title = raw.slice(0, separatorIndex).trim();
  const value = raw.slice(separatorIndex + 1);
  if (!title) {
    throw new Error(`Invalid ${flag} value: "${raw}". Document title must not be empty.`);
  }
  if (!value) {
    throw new Error(`Invalid ${flag} value: "${raw}". Document value must not be empty.`);
  }
  return { title, value };
}

function parseReleaseDocumentInline(raw: string): ReleaseDocumentSpec {
  const { title, value } = splitTitleAndValue(raw, "--document");
  return { title, source: { kind: "inline", content: value } };
}

function parseReleaseDocumentFile(raw: string): ReleaseDocumentSpec {
  // Two accepted shapes, matching `kubectl --from-file=[key=]source`:
  //   --document-file Title=./path.md   (explicit title)
  //   --document-file ./path.md         (title inferred from basename, sans extension)
  if (raw.includes("=")) {
    const { title, value } = splitTitleAndValue(raw, "--document-file");
    const path = value.trim();
    if (!path) {
      throw new Error(`Invalid --document-file value: "${raw}". Path must not be empty.`);
    }
    return { title, source: { kind: "file", path } };
  }
  const path = raw.trim();
  if (!path) {
    throw new Error(`Invalid --document-file value: "${raw}". Path must not be empty.`);
  }
  if (path === "-") {
    throw new Error(
      `Invalid --document-file value: "-". A title is required when reading from stdin; use --document-file Title=-`,
    );
  }
  const title = basename(path, extname(path)).trim();
  if (!title) {
    throw new Error(
      `Invalid --document-file value: "${raw}". Could not infer title from path; use --document-file Title=${path}`,
    );
  }
  return { title, source: { kind: "file", path } };
}

export function parseCLIArgs(argv: string[]): ParsedCLIArgs {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "release-version": { type: "string" },
      stage: { type: "string" },
      "base-ref": { type: "string" },
      "include-paths": { type: "string" },
      "include-subjects": { type: "string" },
      "issue-pattern": { type: "string" },
      link: { type: "string", multiple: true },
      document: { type: "string", multiple: true },
      "document-file": { type: "string", multiple: true },
      "release-notes": { type: "string", multiple: true },
      "release-notes-file": { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      timeout: { type: "string" },
      quiet: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
    tokens: true,
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

  let includeSubjects: string | null = null;
  const rawIncludeSubjects = values["include-subjects"];
  if (rawIncludeSubjects !== undefined && rawIncludeSubjects.length > 0) {
    try {
      new RegExp(rawIncludeSubjects);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid --include-subjects regex: ${detail}`);
    }
    includeSubjects = rawIncludeSubjects;
  }
  let issuePattern: string | null = null;
  const rawIssuePattern = values["issue-pattern"];
  if (rawIssuePattern !== undefined && rawIssuePattern.length > 0) {
    try {
      new RegExp(rawIssuePattern);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid --issue-pattern regex: ${detail}`);
    }
    issuePattern = rawIssuePattern;
  }

  const command = positionals[0] || "sync";
  const links = (values.link ?? []).map(parseReleaseLink);

  // Walk tokens in argv order so cross-flag last-wins and same-title overrides work correctly
  // (parseArgs's `values` map groups by flag name and loses cross-flag ordering — see
  // https://github.com/cli/cli/issues/595 for prior art on why argv order matters here).
  const documents: ReleaseDocumentSpec[] = [];
  const noteSpecs: ReleaseNoteSpec[] = [];
  for (const token of tokens) {
    if (token.kind !== "option" || token.value === undefined) continue;
    switch (token.name) {
      case "document":
        documents.push(parseReleaseDocumentInline(token.value));
        break;
      case "document-file":
        documents.push(parseReleaseDocumentFile(token.value));
        break;
      case "release-notes":
        if (!token.value) {
          throw new Error('Invalid --release-notes value: "". Release notes content must not be empty.');
        }
        noteSpecs.push({ source: { kind: "inline", content: token.value } });
        break;
      case "release-notes-file": {
        const path = token.value.trim();
        if (!path) {
          throw new Error(`Invalid --release-notes-file value: "${token.value}". Path must not be empty.`);
        }
        noteSpecs.push({ source: { kind: "file", path } });
        break;
      }
    }
  }
  const releaseNotes = noteSpecs.length > 0 ? noteSpecs[noteSpecs.length - 1] : undefined;

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
    includeSubjects,
    issuePattern,
    links,
    documents,
    releaseNotes,
    jsonOutput: values.json ?? false,
    dryRun: values["dry-run"] ?? false,
    timeoutSeconds,
    logLevel,
  };
}

export function getCLIWarnings(_args: ParsedCLIArgs): string[] {
  return [];
}
