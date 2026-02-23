import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearError, LinearErrorType, RatelimitedLinearError } from "@linear/sdk";
import { withRetry } from "./retry";

function makeLinearError(type: LinearErrorType, status?: number): LinearError {
  const error = new LinearError();
  error.type = type;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function makeRateLimitedError(retryAfterSeconds?: number): RatelimitedLinearError {
  const error = new RatelimitedLinearError();
  error.type = LinearErrorType.Ratelimited;
  error.status = 429;
  if (retryAfterSeconds !== undefined) {
    error.retryAfter = retryAfterSeconds;
  }
  return error;
}

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const promise = withRetry(fn);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeLinearError(LinearErrorType.NetworkError, 500))
      .mockResolvedValue("ok");

    const promise = withRetry(fn);

    // Advance past the 1s delay for the first retry
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries twice then succeeds on third attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeLinearError(LinearErrorType.NetworkError, 500))
      .mockRejectedValueOnce(makeLinearError(LinearErrorType.InternalError, 500))
      .mockResolvedValue("ok");

    const promise = withRetry(fn);

    // First retry after 1s
    await vi.advanceTimersByTimeAsync(1000);
    // Second retry after 2s
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all attempts", async () => {
    const error = makeLinearError(LinearErrorType.NetworkError, 500);
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn);
    // Attach rejection handler immediately to prevent unhandled rejection
    const resultPromise = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const caught = await resultPromise;
    expect(caught).toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const error = makeLinearError(LinearErrorType.AuthenticationError, 401);
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry GraphQL errors", async () => {
    const error = makeLinearError(LinearErrorType.GraphqlError, 200);
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry 4xx errors", async () => {
    const error = makeLinearError(LinearErrorType.InvalidInput, 400);
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries rate limit errors (429) when retryAfter is missing", async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeRateLimitedError()).mockResolvedValue("ok");

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses retryAfter for rate limit errors when provided", async () => {
    const fn = vi.fn().mockRejectedValueOnce(makeRateLimitedError(3)).mockResolvedValue("ok");

    const promise = withRetry(fn);

    await vi.advanceTimersByTimeAsync(2999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries non-LinearError exceptions", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue("ok");

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
