let useStderr = false;

export function setStderr(value: boolean) {
  useStderr = value;
}

export function log(message: string) {
  if (process.env.NODE_ENV !== "test") {
    if (useStderr) {
      process.stderr.write(`=> ${message}\n`);
    } else {
      console.log(`=> ${message}`);
    }
  }
}
