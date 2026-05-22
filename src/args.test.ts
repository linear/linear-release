import { describe, expect, it } from "vitest";
import { parseCLIArgs } from "./args";
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

  it("defaults --include-subjects to null", () => {
    const result = parseCLIArgs([]);
    expect(result.includeSubjects).toBeNull();
  });

  it("returns --include-subjects as the raw pattern string", () => {
    const result = parseCLIArgs(["--include-subjects", "^(feat|fix):"]);
    expect(result.includeSubjects).toBe("^(feat|fix):");
  });

  it("treats empty --include-subjects as no filter", () => {
    const result = parseCLIArgs(["--include-subjects", ""]);
    expect(result.includeSubjects).toBeNull();
  });

  it("throws a helpful error on invalid --include-subjects regex", () => {
    expect(() => parseCLIArgs(["--include-subjects", "([unclosed"])).toThrow(/Invalid --include-subjects regex/);
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

  describe("--document / --document-file", () => {
    it("parses --document with Title=content", () => {
      const result = parseCLIArgs(["sync", "--document", "Changelog=# v1.0.0\n\n- first release"]);
      expect(result.documents).toEqual([
        { title: "Changelog", source: { kind: "inline", content: "# v1.0.0\n\n- first release" } },
      ]);
    });

    it("parses multiple repeatable --document values", () => {
      const result = parseCLIArgs([
        "sync",
        "--document",
        "Changelog=# v1.0.0",
        "--document=Deploy=Deployed to production.",
      ]);
      expect(result.documents).toEqual([
        { title: "Changelog", source: { kind: "inline", content: "# v1.0.0" } },
        { title: "Deploy", source: { kind: "inline", content: "Deployed to production." } },
      ]);
    });

    it("preserves whitespace and equals signs in --document content", () => {
      const result = parseCLIArgs(["sync", "--document", "Args=key1=value1\n  key2 = value2"]);
      expect(result.documents).toEqual([
        { title: "Args", source: { kind: "inline", content: "key1=value1\n  key2 = value2" } },
      ]);
    });

    it("parses --document-file with Title=path", () => {
      const result = parseCLIArgs(["sync", "--document-file", "Changelog=./CHANGELOG.md"]);
      expect(result.documents).toEqual([{ title: "Changelog", source: { kind: "file", path: "./CHANGELOG.md" } }]);
    });

    it("trims title and path on --document-file", () => {
      const result = parseCLIArgs(["sync", "--document-file", " Changelog = ./CHANGELOG.md "]);
      expect(result.documents).toEqual([{ title: "Changelog", source: { kind: "file", path: "./CHANGELOG.md" } }]);
    });

    it("infers title from filename when --document-file is given a bare path", () => {
      const result = parseCLIArgs(["sync", "--document-file", "./CHANGELOG.md"]);
      expect(result.documents).toEqual([{ title: "CHANGELOG", source: { kind: "file", path: "./CHANGELOG.md" } }]);
    });

    it("infers title from basename when --document-file path has nested directories", () => {
      const result = parseCLIArgs(["sync", "--document-file", "./docs/deploy-log.md"]);
      expect(result.documents).toEqual([
        { title: "deploy-log", source: { kind: "file", path: "./docs/deploy-log.md" } },
      ]);
    });

    it("infers title from bare path with no extension", () => {
      const result = parseCLIArgs(["sync", "--document-file", "./NOTES"]);
      expect(result.documents).toEqual([{ title: "NOTES", source: { kind: "file", path: "./NOTES" } }]);
    });

    it("strips only the final extension when inferring title", () => {
      const result = parseCLIArgs(["sync", "--document-file", "./release.notes.md"]);
      expect(result.documents).toEqual([
        { title: "release.notes", source: { kind: "file", path: "./release.notes.md" } },
      ]);
    });

    it("throws when --document-file is bare '-' (stdin needs an explicit title)", () => {
      expect(() => parseCLIArgs(["sync", "--document-file", "-"])).toThrow("Title=-");
    });

    it("combines --document and --document-file", () => {
      const result = parseCLIArgs([
        "sync",
        "--document",
        "Changelog=# v1.0.0",
        "--document-file",
        "Deploy log=./deploy.md",
      ]);
      expect(result.documents).toEqual([
        { title: "Changelog", source: { kind: "inline", content: "# v1.0.0" } },
        { title: "Deploy log", source: { kind: "file", path: "./deploy.md" } },
      ]);
    });

    it("throws on --document without =", () => {
      expect(() => parseCLIArgs(["sync", "--document", "no-separator"])).toThrow(
        'Invalid --document value: "no-separator"',
      );
    });

    it("throws on --document with empty title", () => {
      expect(() => parseCLIArgs(["sync", "--document", "=content"])).toThrow("Document title must not be empty");
    });

    it("throws on --document with empty value", () => {
      expect(() => parseCLIArgs(["sync", "--document", "Title="])).toThrow("Document value must not be empty");
    });

    it("throws on --document-file with empty path", () => {
      expect(() => parseCLIArgs(["sync", "--document-file", "Title=   "])).toThrow();
    });
  });

  describe("--release-notes / --release-notes-file", () => {
    it("parses inline --release-notes", () => {
      const result = parseCLIArgs(["sync", "--release-notes", "## v1.0.0\n\nFirst release."]);
      expect(result.releaseNotes).toEqual({
        source: { kind: "inline", content: "## v1.0.0\n\nFirst release." },
      });
    });

    it("parses --release-notes-file", () => {
      const result = parseCLIArgs(["sync", "--release-notes-file", "./notes.md"]);
      expect(result.releaseNotes).toEqual({ source: { kind: "file", path: "./notes.md" } });
    });

    it("last-wins across multiple --release-notes occurrences", () => {
      const result = parseCLIArgs([
        "sync",
        "--release-notes",
        "first",
        "--release-notes",
        "second",
        "--release-notes-file",
        "./notes.md",
      ]);
      expect(result.releaseNotes).toEqual({ source: { kind: "file", path: "./notes.md" } });
    });

    it("throws on empty --release-notes-file path", () => {
      expect(() => parseCLIArgs(["sync", "--release-notes-file", "  "])).toThrow();
    });

    it("leaves releaseNotes undefined when no flag is passed", () => {
      const result = parseCLIArgs(["sync"]);
      expect(result.releaseNotes).toBeUndefined();
    });

    it("preserves argv order across --release-notes-file then --release-notes", () => {
      // Regression: previously the parser grouped values by flag name, so a later inline note
      // could be overridden by an earlier file note. Last on the command line should always win.
      const result = parseCLIArgs([
        "sync",
        "--release-notes-file",
        "./generated.md",
        "--release-notes",
        "manual override",
      ]);
      expect(result.releaseNotes).toEqual({ source: { kind: "inline", content: "manual override" } });
    });

    it("preserves argv order across --release-notes then --release-notes-file", () => {
      const result = parseCLIArgs(["sync", "--release-notes", "manual", "--release-notes-file", "./final.md"]);
      expect(result.releaseNotes).toEqual({ source: { kind: "file", path: "./final.md" } });
    });
  });

  describe("argv order across --document / --document-file", () => {
    it("preserves argv order so same-title last-wins works across flag types", () => {
      // The API upserts documents by title with later entries winning. The CLI must therefore send
      // documents in the order the user wrote them on the command line, not bucketed by flag type.
      const result = parseCLIArgs([
        "sync",
        "--document-file",
        "Changelog=./from-file.md",
        "--document",
        "Changelog=inline override",
      ]);
      expect(result.documents).toEqual([
        { title: "Changelog", source: { kind: "file", path: "./from-file.md" } },
        { title: "Changelog", source: { kind: "inline", content: "inline override" } },
      ]);
    });

    it("interleaves inline and file documents in argv order", () => {
      const result = parseCLIArgs([
        "sync",
        "--document",
        "A=inline-a",
        "--document-file",
        "B=./b.md",
        "--document",
        "C=inline-c",
      ]);
      expect(result.documents.map((d) => d.title)).toEqual(["A", "B", "C"]);
    });
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseCLIArgs(["--unknown-flag"])).toThrow();
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
