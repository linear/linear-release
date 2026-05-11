export enum LogLevel {
  Quiet = 0,
  Default = 1,
  Verbose = 2,
}

type LevelName = "error" | "warn" | "info" | "verbose";

let currentLevel: LogLevel = LogLevel.Default;
let useStderr = false;
let jsonMode = false;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setStderr(value: boolean) {
  useStderr = value;
}

export function setJsonMode(value: boolean) {
  jsonMode = value;
}

function formatLine(level: LevelName, message: string): string {
  if (jsonMode) return JSON.stringify({ level, msg: message });
  const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
  if (level === "error") {
    return inGitHubActions ? `::error::${message}` : message;
  }
  if (level === "warn") {
    return inGitHubActions ? `::warning::${message}` : `warning: ${message}`;
  }
  return message;
}

function write(level: LevelName, message: string) {
  if (process.env.NODE_ENV === "test") return;
  const line = formatLine(level, message);
  if (useStderr || level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    console.log(line);
  }
}

/** Always printed to stderr. */
export function error(message: string) {
  write("error", message);
}

/** Warnings print at all levels, including under --quiet. */
export function warn(message: string) {
  write("warn", message);
}

/** Printed at Default level and above. */
export function info(message: string) {
  if (currentLevel >= LogLevel.Default) write("info", message);
}

/** Printed at Verbose level and above. */
export function verbose(message: string) {
  if (currentLevel >= LogLevel.Verbose) write("verbose", message);
}
