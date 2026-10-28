import { SourceError } from '../errors.js';
import { withRetry } from './retry.js';

// JSON requests to fixed, trusted API hosts (Apify, Graph API, Anthropic).
export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000, retries = 2, signal, label = 'api', logger, classifyError } = {}) {
  return withRetry(
    async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: combined,
        });
      } catch (error) {
        if (signal?.aborted) throw new SourceError('ABORTED', `${label}: aborted`);
        const timedOut = error.name === 'TimeoutError';
        throw new SourceError(timedOut ? 'TIMEOUT' : 'NETWORK', `${label}: ${timedOut ? `timed out after ${timeoutMs} ms` : error.message}`, { retryable: true });
      }

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 300) };
      }
      if (!response.ok) {
        const detail = data?.error?.message || data?.error?.type || data?.message || data?.raw || '';
        const defaultCode = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`;
        const classification = classifyError?.({ status: response.status, data, detail, defaultCode }) || {};
        const error = new SourceError(classification.code || defaultCode, classification.message || `${label}: HTTP ${response.status} ${detail}`.trim(), {
          retryable: classification.retryable ?? (response.status === 429 || response.status >= 500),
          status: response.status,
        });
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter?.trim() ? Number(retryAfter) : Number.NaN;
        const retryAt = Date.parse(retryAfter || '');
        const retryAfterMs = Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
        if (retryAfterMs !== null) error.retryAfterMs = Math.min(retryAfterMs, 300_000);
        else if (classification.retryAfterMs) error.retryAfterMs = Math.min(classification.retryAfterMs, 300_000);
        // Provider-specific hints (e.g. how long to park a quota-limited model) travel with the error.
        if (classification.blockMs) error.blockMs = classification.blockMs;
        if (classification.modelProblem) error.modelProblem = true;
        throw error;
      }
      return data;
    },
    { retries, signal, onRetry: (error, attempt, delay) => logger?.warn({ label, attempt, delay: Math.round(delay), err: error.message }, 'retrying request') },
  );
}
