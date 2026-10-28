const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    }, { once: true });
  });

// Exponential backoff with jitter. Only errors marked retryable are retried.
export async function withRetry(fn, { retries = 2, baseDelayMs = 600, maxDelayMs = 30_000, signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !error.retryable || signal?.aborted) throw error;
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt + Math.random() * 250);
      const delay = error.retryAfterMs ?? exponentialDelay;
      onRetry?.(error, attempt + 1, delay);
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}
