export function log(message: string) {
  if (process.env.NODE_ENV !== "test") {
    console.log(`=> ${message}`);
  }
}
