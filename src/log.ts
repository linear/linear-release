export enum LogLevel {
  Quiet = 0,
  Default = 1,
  Verbose = 2,
  Debug = 3,
}

let currentLevel: LogLevel = LogLevel.Default;
let useStderr = false;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setStderr(value: boolean) {
  useStderr = value;
}

function write(message: string) {
  if (process.env.NODE_ENV === "test") return;
  if (useStderr) {
    process.stderr.write(`=> ${message}\n`);
  } else {
    console.log(`=> ${message}`);
  }
}

/** Always printed to stderr, no prefix. */
export function error(message: string) {
  if (process.env.NODE_ENV === "test") return;
  process.stderr.write(`${message}\n`);
}

/** Printed at Default level and above. */
export function warn(message: string) {
  if (currentLevel >= LogLevel.Default) write(message);
}

/** Printed at Default level and above. Replaces the old `log()`. */
export function info(message: string) {
  if (currentLevel >= LogLevel.Default) write(message);
}

/** Printed at Verbose level and above. */
export function verbose(message: string) {
  if (currentLevel >= LogLevel.Verbose) write(message);
}

/** Printed at Debug level only. */
export function debug(message: string) {
  if (currentLevel >= LogLevel.Debug) write(message);
}
