declare const CLI_VERSION: string;

/**
 * Returns the CLI version, injected at build time via Bun's --define flag.
 * Returns "dev" when running in development without a compiled build.
 */
export function getCliVersion(): string {
  if (typeof CLI_VERSION !== "undefined") {
    return CLI_VERSION;
  }
  return "dev";
}
