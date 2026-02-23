import { LinearError, LinearErrorType, RatelimitedLinearError } from "@linear/sdk";
import { log } from "./log";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

const NON_RETRYABLE_TYPES = new Set<LinearErrorType>([
  LinearErrorType.AuthenticationError,
  LinearErrorType.Forbidden,
  LinearErrorType.FeatureNotAccessible,
  LinearErrorType.GraphqlError,
  LinearErrorType.InvalidInput,
  LinearErrorType.UserError,
  LinearErrorType.UsageLimitExceeded,
]);

function isRetryable(error: unknown): boolean {
  if (error instanceof LinearError) {
    if (error.type && NON_RETRYABLE_TYPES.has(error.type)) {
      return false;
    }
    // 4xx (except 429 rate limit) are not retryable
    if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
      return false;
    }
  }
  return true;
}

function getDelayMs(error: unknown, attempt: number): number {
  if (error instanceof RatelimitedLinearError) {
    const retryAfterSeconds = error.retryAfter;
    if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds * 1000);
    }
  }

  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) {
        throw error;
      }
      const delay = getDelayMs(error, attempt);
      log(`Request failed, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Unreachable — the loop always returns or throws
  throw new Error("Retry logic error");
}
